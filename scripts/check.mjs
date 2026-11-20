import { isMain } from './entry.mjs';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startService } from './start.mjs';
import { CheckError, localUrl } from './runtime-client.mjs';
import { startHeartbeat, stopHeartbeat } from './heartbeat.mjs';
import { HEARTBEAT_INTERVAL_MS } from './progress.mjs';
export { localUrl } from './runtime-client.mjs';

const REQUEST_TIMEOUT_MS = 3000;
const jsonPost = body => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function requestJson(url, path, { instanceId, waiting, ...options }) {
  const unavailable = () =>
    new CheckError(
      waiting && options.signal.aborted ? 'timeout' : 'offline',
      '本机服务不可达；保留原文件，按原路径恢复服务。'
    );
  let response;
  try {
    response = await fetch(url + path, options);
  } catch {
    throw unavailable();
  }
  const instance = response.headers.get('x-grow-me-instance');
  if (instanceId && instance !== instanceId)
    throw new CheckError('identity', '等待期间服务实例已变；请先短查核对。');
  if (response.status === 409) throw new CheckError('changed', '查询期间状态已变，请重新短查询。');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new CheckError('protocol', '服务响应异常；先核对地址，未继续写入。');
  try {
    return { data: await response.json(), instance };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw unavailable();
    throw new CheckError('protocol', '服务响应异常；未继续写入。');
  }
}

export async function checkOnce({
  url,
  sessionId,
  afterRevision,
  afterSequence,
  afterInstance,
  timeoutMs = REQUEST_TIMEOUT_MS,
  ownerPid,
  instanceId,
  waiting = false
}) {
  url = localUrl(url);
  if (!sessionId)
    throw new CheckError('identity', '--session is required; a port is not a session identity.');
  const signal = AbortSignal.timeout(timeoutMs),
    instances = [];
  async function get(path, options = {}) {
    const result = await requestJson(url, path, { ...options, signal, instanceId, waiting });
    instances.push(result.instance);
    return result.data;
  }
  // Identity must be checked against /state before any recovery metadata is trusted.
  const state = await get('/state');
  if (state.session_id !== sessionId)
    throw new CheckError('identity', '此地址属于另一个访谈；未写入、未启动替代访谈。');
  const [doc, progress, recovery] = await Promise.all([
    get('/document/status'),
    get('/progress'),
    get('/recovery')
  ]);
  if (
    doc.source?.session_id !== sessionId ||
    progress.session_id !== sessionId ||
    recovery.session_id !== sessionId ||
    doc.source.revision !== state.revision ||
    progress.revision !== state.revision ||
    recovery.revision !== state.revision ||
    instances.some(id => !id || id !== recovery.instance_id)
  )
    throw new CheckError('changed', '查询期间状态已变，请重新短查询。');
  const cursorFile = recovery.state_file + '.cursor.json';
  let cursor = null;
  if (existsSync(cursorFile)) {
    try {
      cursor = JSON.parse(readFileSync(cursorFile, 'utf8'));
    } catch {
      throw new CheckError('cursor', '本地游标损坏；先核对原会话，不自动跳过提交。');
    }
    if (
      cursor.session_id !== sessionId ||
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < 0
    )
      throw new CheckError('cursor', '本地游标身份不匹配。');
  }
  const sequence = afterSequence ?? cursor?.sequence ?? 0;
  const observed = Date.now(),
    submission =
      progress.last_submission?.revision === state.revision ? progress.last_submission : null;
  const activity = await get(
    '/ai/check',
    jsonPost({
      expected_session_id: sessionId,
      expected_revision: state.revision,
      expected_instance_id: recovery.instance_id,
      after_sequence: sequence,
      after_revision: afterRevision,
      owner_pid: ownerPid
    })
  );
  if (
    activity.session_id !== sessionId ||
    activity.revision !== state.revision ||
    instances.at(-1) !== recovery.instance_id
  )
    throw new CheckError('changed', '查询期间状态已变，请重新短查询。');
  const next = {
    session_id: sessionId,
    revision: state.revision,
    sequence: activity.sequence,
    instance: recovery.instance_id
  };
  // Concurrent short checks may repeat an event but must never move the cursor backwards.
  if (existsSync(cursorFile)) {
    const latest = JSON.parse(readFileSync(cursorFile, 'utf8'));
    if (latest.session_id === sessionId && latest.sequence > next.sequence)
      throw new CheckError('changed', '另一短查询已更新游标，请重新查询。');
  }
  const temp = cursorFile + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(next) + '\n', 'utf8');
  renameSync(temp, cursorFile);
  return {
    status:
      state.schema_version === 1
        ? 'legacy_read_only'
        : state.status === 'complete'
          ? 'document'
          : activity.stage === 'waiting_for_save'
            ? 'waiting_for_save'
            : activity.stage === 'thinking'
              ? 'ready_for_ai'
              : activity.stage === 'review'
                ? 'review'
                : 'waiting_for_user',
    changed: activity.events.length > 0,
    events: activity.events.map(({ kind, sequence, revision, round, at }) => ({
      kind,
      sequence,
      revision,
      round,
      at
    })),
    sequence: activity.sequence,
    plan_requested: activity.plan_requested,
    instance_changed: Boolean(
      (afterInstance ?? cursor?.instance) &&
        (afterInstance ?? cursor?.instance) !== recovery.instance_id
    ),
    cursor_file: cursorFile,
    session_id: sessionId,
    schema_version: state.schema_version,
    revision: state.revision,
    current_round: state.current_round,
    url,
    instance_id: recovery.instance_id,
    document: {
      phase: doc.phase,
      sequence: doc.sequence,
      job_id: doc.job_id,
      stage: doc.stage,
      ready_chapters: doc.chapters.filter(c => c.status === 'ready').length
    },
    timing: {
      observed_at: observed,
      submission_at: activity.stage === 'waiting_for_save' ? null : (submission?.at ?? null),
      discovery_delay_ms: activity.discovery_delay_ms,
      submission_kind: activity.stage === 'waiting_for_save' ? null : (submission?.cause ?? null),
      timing_file: recovery.timing_file,
      note: 'Discovery is recorded once per user submission; waiting_for_save does not accrue delay.'
    }
  };
}

export async function waitForUser({ timeoutMs = REQUEST_TIMEOUT_MS, ...options }) {
  const url = localUrl(options.url);
  let receipt,
    instanceId,
    instanceChanged = false;
  for (;;) {
    try {
      if (!receipt) {
        receipt = await checkOnce({ ...options, url, timeoutMs, instanceId, waiting: true });
        instanceId ??= receipt.instance_id;
        instanceChanged ||= receipt.instance_changed;
        if (receipt.changed) return { ...receipt, instance_changed: instanceChanged };
      }
      const { data } = await requestJson(url, '/ai/wait', {
        ...jsonPost({
          expected_session_id: receipt.session_id,
          expected_revision: receipt.revision,
          expected_instance_id: instanceId,
          after_sequence: options.afterSequence ?? receipt.sequence,
          after_revision: options.afterRevision,
          owner_pid: options.ownerPid
        }),
        signal: AbortSignal.timeout(HEARTBEAT_INTERVAL_MS + timeoutMs),
        instanceId,
        waiting: true
      });
      if (data?.status === 'pending') continue;
      if (data?.status === 'event') {
        receipt = null;
        continue;
      }
      if (data?.status === 'session_finished')
        throw new CheckError('session_finished', '访谈已结束。');
      if (data?.status === 'service_closed')
        throw new CheckError('service_closed', '本机服务已关闭。');
      throw new CheckError('protocol', '等待回执异常；请先短查核对。');
    } catch (error) {
      if (error.kind === 'offline') throw new CheckError('service_closed', error.message);
      if (error.kind === 'changed') receipt = null;
      else if (error.kind !== 'timeout') throw error;
      await sleep(100);
    }
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2),
    waiting = args.includes('--wait'),
    arg = (name, fallback) => {
      const i = args.indexOf(name);
      return i < 0 ? fallback : args[i + 1];
    };
  if (args.includes('--help'))
    console.log(
      [
        'node scripts/check.mjs --url <origin> --session <id> [--wait | --heartbeat | --heartbeat-stop <id>]' +
          ' [--owner-pid PID] [--after-revision R --after-sequence S --after-instance ID] [--timeout-ms 3000]',
        '--wait reports activity and waits for a user event, reusing the short-check cursor and JSON format.',
        'Idle deadlines renew the wait without output.',
        'Checks and waits that return user events renew the three-minute work lease.',
        '--heartbeat resolves the AI tool ancestor before launch unless --owner-pid is supplied.',
        'Checks and waits with a matching --owner-pid renew the three-minute heartbeat lease.',
        'To restore an offline service, add --restart --state <original-tree.json> --document <original-task.html> to a short check.'
      ].join('\n')
    );
  else
    try {
      const number = name => {
        const value = arg(name);
        if (value === undefined) return undefined;
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid ' + name);
        return n;
      };
      const options = {
        url: arg('--url'),
        sessionId: arg('--session'),
        afterRevision: number('--after-revision'),
        afterSequence: number('--after-sequence'),
        afterInstance: arg('--after-instance'),
        timeoutMs: number('--timeout-ms') ?? REQUEST_TIMEOUT_MS,
        ownerPid: number('--owner-pid')
      };
      if (options.timeoutMs < 10 || options.timeoutMs > 3000)
        throw Error('timeout-ms must be 10..3000');
      try {
        if (waiting) console.log(JSON.stringify(await waitForUser(options)));
        else if (args.includes('--heartbeat'))
          console.log(JSON.stringify(await startHeartbeat(options)));
        else if (args.includes('--heartbeat-stop'))
          console.log(JSON.stringify(await stopHeartbeat(options, arg('--heartbeat-stop'))));
        else console.log(JSON.stringify(await checkOnce(options)));
      } catch (error) {
        if (waiting || error.kind !== 'offline' || !args.includes('--restart')) throw error;
        if (!arg('--state') || !arg('--document'))
          throw new CheckError(
            'recovery',
            '恢复需要原 tree.json 和文档路径；从原启动回执取得，不能创建新访谈。'
          );
        let started;
        try {
          started = await startService({
            stateFile: arg('--state'),
            documentFile: arg('--document'),
            sessionId: options.sessionId,
            port: Number(new URL(options.url).port)
          });
        } catch (startError) {
          if (startError.code !== 'EADDRINUSE') throw startError;
          throw new CheckError(
            'recovery',
            '原端口仍被占用；先核对占用服务，未自动启动第二个写入进程。'
          );
        }
        console.log(
          JSON.stringify({
            ...(await checkOnce({ ...options, url: started.url })),
            restarted: true,
            recovered_from_file: true,
            service: started
          })
        );
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          status:
            error.kind === 'offline'
              ? 'service_closed'
              : waiting && ['service_closed', 'session_finished', 'identity'].includes(error.kind)
                ? error.kind
                : 'attention',
          kind: error.kind ?? 'recovery',
          error: error.message
        })
      );
      process.exitCode = 2;
    }
}
