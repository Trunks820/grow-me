import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CheckError, runtimePost } from './runtime-client.mjs';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_LEASE_MS } from './progress.mjs';
import { isMain } from './entry.mjs';

// A detached helper must not conceal an abandoned host forever.
export { HEARTBEAT_LEASE_MS } from './progress.mjs';
const run = promisify(execFile);
const AI_TOOL_PROCESSES = new Set([
  'claude', 'claude-code', 'codex', 'codex-cli', 'cursor', 'cursor-agent', 'antigravity', 'agy'
]);

async function readProcessTable() {
  const options = { encoding: 'utf8', timeout: 5000, windowsHide: true };
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
    ], options);
    return [JSON.parse(stdout)].flat().map(row => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      name: row.Name
    }));
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='], options);
  return Array.from(stdout.matchAll(/^[ \t]*(\d+)[ \t]+(\d+)[ \t]+(.+)$/gm), ([, pid, ppid, name]) => ({
    pid: Number(pid),
    ppid: Number(ppid),
    name: name.trim()
  }));
}

export function findAiOwnerPid(processes, pid = process.pid) {
  const byPid = new Map(processes.map(row => [row.pid, row]));
  const seen = new Set([pid]);
  let parent = byPid.get(byPid.get(pid)?.ppid);
  while (parent && !seen.has(parent.pid)) {
    const name = parent.name.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, '');
    if (AI_TOOL_PROCESSES.has(name)) return parent.pid;
    seen.add(parent.pid);
    parent = byPid.get(parent.ppid);
  }
  return null;
}

export async function stopHeartbeat(options, id, reason = 'requested') {
  return runtimePost(options, '/ai/heartbeat', { heartbeat_id: id, action: 'stop', reason });
}
export async function startHeartbeat(
  options,
  { ownerPid = options.ownerPid, loadProcessTable = readProcessTable } = {}
) {
  if (ownerPid === undefined) {
    try {
      ownerPid = findAiOwnerPid(await loadProcessTable());
    } catch {
      throw new CheckError('owner', '无法读取父进程链；请显式传 --owner-pid <AI 工具 PID>。');
    }
    if (ownerPid === null)
      throw new CheckError('owner', '未找到已知 AI 工具进程；请显式传 --owner-pid <AI 工具 PID>。');
  }
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0)
    throw Error('owner-pid must be a positive integer');
  const id = randomUUID(),
    first = await runtimePost(options, '/ai/heartbeat', {
      heartbeat_id: id,
      action: 'pulse',
      owner_pid: ownerPid
    });
  if (!first.active) return { status: 'session_finished', heartbeat_id: id };
  const args = [
    fileURLToPath(import.meta.url),
    '--url',
    options.url,
    '--session',
    options.sessionId,
    '--instance',
    first.instance_id,
    '--id',
    id,
    '--owner-pid',
    String(ownerPid)
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    await stopHeartbeat(options, id).catch(() => {});
    throw error;
  }
  child.unref();
  return {
    status: 'heartbeat_started',
    heartbeat_id: id,
    pid: child.pid,
    instance_id: first.instance_id,
    interval_ms: HEARTBEAT_INTERVAL_MS,
    lease_ms: HEARTBEAT_LEASE_MS,
    lease_until: first.lease_until,
    owner_pid: ownerPid
  };
}
async function worker(options, id, ownerPid) {
  let ended = false,
    wake,
    reason = 'requested';
  const controller = new AbortController();
  const stop = why => {
    reason = why;
    ended = true;
    controller.abort();
    wake?.();
  };
  process.on('SIGTERM', () => stop('terminated'));
  process.on('SIGINT', () => stop('terminated'));
  const watchOwner = () => {
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      if (error.code !== 'EPERM') stop('owner_exited');
    }
  };
  const ownerWatch = setInterval(watchOwner, 1000);
  watchOwner();
  try {
    while (!ended) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, HEARTBEAT_INTERVAL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (ended) break;
      if (
        !(
          await runtimePost({ ...options, signal: controller.signal }, '/ai/heartbeat', {
            heartbeat_id: id,
            action: 'pulse',
            owner_pid: ownerPid
          })
        ).active
      )
        break;
    }
  } catch (error) {
    if (!ended) throw error;
  } finally {
    clearInterval(ownerWatch);
    await stopHeartbeat(options, id, reason).catch(() => {});
  }
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2),
    value = name => args[args.indexOf(name) + 1];
  if (args.includes('--help'))
    console.log('Internal heartbeat worker. Use check.mjs --heartbeat / --heartbeat-stop <id>.');
  else
    worker(
      { url: value('--url'), sessionId: value('--session'), instanceId: value('--instance') },
      value('--id'),
      args.includes('--owner-pid') ? Number(value('--owner-pid')) : null
    ).catch(() => {
      process.exitCode = 2;
    });
}
