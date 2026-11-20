import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import { basename, dirname, join } from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateTree,publishRound} from '../scripts/model.mjs';
import {checkOnce} from '../scripts/check.mjs';
import { startService, startWithWmi } from '../scripts/start.mjs';
import {assistantConnection} from '../assets/presentation.mjs';
import {fingerprint} from '../scripts/document.mjs';
import {chapters} from '../assets/topics.mjs';
import {recommendationDigest} from '../scripts/recommendations.mjs';
import {isBrowserRestrictedPort,selectBrowserPort} from '../scripts/server.mjs';

const run=promisify(execFile),server=fileURLToPath(new URL('../scripts/server.mjs',import.meta.url)),checker=fileURLToPath(new URL('../scripts/check.mjs',import.meta.url));
const options=[{id:'a',label:'邮件通知'},{id:'b',label:'站内通知'},{id:'none',label:'都不需要',exclusive:true}];
const node=(id='delivery',extra={})=>({id,question:'需要哪些通知方式？',rationale:'决定首版需要开发和验收哪些通知渠道。',input:'multi_choice',options:structuredClone(options),answer:null,depends_on:[],status:'pending',round:1,...extra});
const tree=(nodes=[node()])=>({schema_version:2,session_id:'v2-regression',topic:'通知范围',revision:0,current_round:1,status:'active',nodes});
async function service(t,seed=tree(),{clock=false,waitMs=25000,imports=[]}={}){
  const root=mkdtempSync(join(tmpdir(),'grow-v2-')),file=join(root,'tree.json'),document=join(root,'task.html');writeFileSync(file,JSON.stringify(seed)+'\n');
  const clockFile=join(root,'clock-offset'),preload=join(root,'test-clock.mjs');
  if(clock){writeFileSync(clockFile,'0');writeFileSync(preload,`import {readFileSync} from 'node:fs';const realNow=Date.now;Date.now=()=>realNow()+Number(readFileSync(${JSON.stringify(clockFile)},'utf8'));`);}
  const children=[],detached=[];
  async function start(){const child=spawn(process.execPath,[...imports.flatMap(specifier=>['--import',specifier]),...(clock?['--import',pathToFileURL(preload).href]:[]),server,'--state',file,'--document',document,'--wait-ms',String(waitMs)]);children.push(child);let errors='';child.stderr.on('data',d=>errors+=d);return{child,...await Promise.race([once(child.stdout,'data').then(([d])=>JSON.parse(String(d))),once(child,'exit').then(()=>{throw Error(errors);})])};}
  const started=await start();
  t.after(async()=>{
    for(const pid of detached){try{process.kill(pid);}catch{}for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}}
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
    // Windows can retain the killed process's cwd handle briefly after process.kill(0) stops seeing it.
    for(let i=0;i<50;i++){try{rmSync(root,{recursive:true,force:true});break;}catch(error){if(i===49||!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;await new Promise(r=>setTimeout(r,30));}}
  });
  return{...started,root,file,document,start,setClockOffset:offset=>writeFileSync(clockFile,String(offset)),track:pid=>detached.push(pid),async state(){return(await fetch(this.url+'/state')).json();},async post(path,data){return fetch(this.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_session_id:seed.session_id,...data})});}};
}

test('browser port check excludes automatic selection and ordinary ports', () => {
  assert.equal(isBrowserRestrictedPort(6566), true);
  assert.equal(isBrowserRestrictedPort(10080), true);
  assert.equal(isBrowserRestrictedPort(0), false);
  assert.equal(isBrowserRestrictedPort(8080), false);
});

test('automatic port selection stops after repeated restricted assignments', async () => {
  let bindCount = 0, closeCount = 0;
  await assert.rejects(selectBrowserPort(async () => {
    assert.equal(bindCount, closeCount);
    bindCount++;
    return 6566;
  }, async () => { closeCount++; }), /自动选端口连续 10 次.*请重试/);
  assert.equal(bindCount, 10);
  assert.equal(closeCount, bindCount);
});

test('server retries the injected restricted port and reports the live port', async t => {
  const source = `
    import {Server} from 'node:http';
    const realListen = Server.prototype.listen, realAddress = Server.prototype.address;
    let listenCount = 0;
    Server.prototype.listen = function (...args) {
      listenCount++;
      return realListen.apply(this, args);
    };
    Server.prototype.address = function () {
      const address = realAddress.call(this);
      return listenCount === 1 && address ? {...address, port: 6566} : address;
    };
  `;
  const started = await service(t, tree(), {
    imports: ['data:text/javascript,' + encodeURIComponent(source)]
  });
  assert.equal(isBrowserRestrictedPort(started.port), false);
  assert.equal(Number(new URL(started.url).port), started.port);
  assert.equal((await started.state()).session_id, started.session_id);
});

test('server rejects an explicitly requested restricted port without a startup receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grow-port-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = join(root, 'tree.json');
  writeFileSync(file, JSON.stringify(tree()));
  await assert.rejects(run(process.execPath, [server, '--state', file, '--port', '6566'], {
    timeout: 3000
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /浏览器会拒绝打开这个端口.*请换一个/);
    assert.equal(error.stdout, '');
    return true;
  });
});

test('detached service startup reports an occupied port without changing the tree', async t => {
  const running = await service(t);
  const bytes = readFileSync(running.file);
  await assert.rejects(
    startService({ stateFile: running.file, sessionId: running.session_id, port: running.port }),
    { code: 'EADDRINUSE' }
  );
  assert.equal((await running.state()).session_id, running.session_id);
  assert.deepEqual(readFileSync(running.file), bytes);
});

import {findAiOwnerPid,startHeartbeat,stopHeartbeat} from '../scripts/heartbeat.mjs';
import {runtimePost} from '../scripts/runtime-client.mjs';
import {
  InterviewProgress,
  SHORT_QUERY_TIMEOUT_MS,
  HEARTBEAT_LEASE_MS,
  WORK_LEASE_MS
} from '../scripts/progress.mjs';
import {renderChapter} from '../scripts/render-chapter.mjs';
import {composeDocument} from '../scripts/compose-document.mjs';
import {validateDocument} from '../scripts/document.mjs';
import {timedCodeRead} from '../scripts/work.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const logs=s=>readFileSync(s.file+'.runtime-timings.jsonl','utf8').trim().split('\n').map(JSON.parse);
const opts=s=>({url:s.url,sessionId:'v2-regression'});
const control=async(s,action,extra={})=>{const response=await s.post('/document/control',{action,expected_revision:(await s.state()).revision,...extra});assert.equal(response.status,200,await response.clone().text());return response.json();};
const submit=async s=>{assert.equal((await s.post('/submit',{round:1,expected_revision:0,answers:[{id:'delivery',answer:{option_ids:['none'],text:'用户真正原话'}}]})).status,200);};
const getAi=async running=>(await (await fetch(running.url+'/progress')).json()).ai;

function waitCommand(context, running, sessionId = opts(running).sessionId) {
  const child = spawn(process.execPath, [checker, '--url', running.url, '--session', sessionId, '--wait'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', text => stdout += text);
  child.stderr.setEncoding('utf8').on('data', text => stderr += text);
  const result = once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await result;
  });
  return { child, result, get stdout() { return stdout; } };
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for the server state');
}

function pidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

test(
  'Windows service and heartbeat survive a kill-on-close host Job',
  { timeout: 65000 },
  async t => {
    if (process.platform !== 'win32') {
      t.diagnostic('Windows Job Objects are available only on Windows.');
      t.skip();
      return;
    }
    if ((await startWithWmi(['-e', 'process.exit(0)'])) === null) {
      t.diagnostic('WMI could not create a Node process in this environment.');
      t.skip('WMI process creation unavailable');
      return;
    }

    const root = mkdtempSync(join(tmpdir(), 'grow-w11 路径 & '));
    const stateFile = join(root, 'tree.json');
    const fakeAgy = join(root, 'agy.exe');
    const receipt = name => {
      const file = join(root, name);
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    };
    let owner, ownerExit, jobPid, jobResult;
    t.after(async () => {
      if (owner?.connected) owner.disconnect();
      if (ownerExit) await ownerExit;
      owner?.stderr.destroy();
      const pids = new Set([
        jobPid,
        receipt('control-pid'),
        receipt('service.json')?.pid,
        receipt('heartbeat.json')?.pid
      ]);
      for (const log of readdirSync(root).filter(name => /^\.grow-me-server-.*\.log$/.test(name))) {
        // A startup receipt can have reached the log before the Job records the CLI's stdout.
        for (const line of readFileSync(join(root, log), 'utf8').split(/\r?\n/)) {
          try {
            const entry = JSON.parse(line);
            if (entry.state_file === stateFile) pids.add(entry.pid);
          } catch {
            /* The log can also contain startup errors. */
          }
        }
      }
      for (const pid of pids) {
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        if (pidRunning(pid)) process.kill(pid);
        await until(() => !pidRunning(pid));
      }
      const target = realpathSync(root);
      assert.equal(dirname(target).toLowerCase(), realpathSync(tmpdir()).toLowerCase());
      assert.match(basename(target), /^grow-w11 /);
      rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    const seed = tree();
    writeFileSync(stateFile, JSON.stringify(seed));
    copyFileSync(process.execPath, fakeAgy);
    const jobScript = readFileSync(
      new URL('./fixtures/windows-kill-job.ps1', import.meta.url),
      'utf8'
    );
    const hostScript = `
    const { spawn } = require('node:child_process');
    const job = spawn('powershell.exe', process.argv.slice(1), {
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
    });
    job.on('spawn', () => process.send({ pid: job.pid }));
    job.on('error', error => process.send({ error: error.message }));
    job.on('close', code => { if (process.connected) process.send({ code }); });
    process.on('disconnect', () => job.kill());
  `;
    owner = spawn(
      fakeAgy,
      [
        '-e',
        hostScript,
        '--',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(jobScript, 'utf16le').toString('base64')
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
        cwd: root,
        env: {
          ...process.env,
          GROW_ME_JOB_NODE: process.execPath,
          GROW_ME_JOB_ROOT: root,
          GROW_ME_JOB_SESSION: seed.session_id,
          GROW_ME_JOB_START: fileURLToPath(new URL('../scripts/start.mjs', import.meta.url)),
          GROW_ME_JOB_CHECK: checker
        }
      }
    );
    let errorOutput = '';
    owner.stderr.setEncoding('utf8').on('data', chunk => (errorOutput += chunk));
    owner.on('message', message => {
      if (message.pid) jobPid = message.pid;
      else jobResult ??= message;
    });
    owner.on('error', error => (jobResult ??= { error: error.message }));
    ownerExit = new Promise(resolve => {
      owner.once('exit', resolve);
      owner.once('error', resolve);
    });
    await until(() => jobResult, 45000);
    const controlPid = receipt('control-pid');
    if (controlPid) await until(() => !pidRunning(controlPid));
    const started = receipt('service.json');
    const heartbeat = receipt('heartbeat.json');
    assert.equal(jobResult.code, 0, errorOutput || heartbeat?.error || jobResult.error);
    assert.ok(controlPid, 'The detached control process must have run inside the Job');
    assert.equal(started.launch, 'wmi');
    assert.equal(heartbeat.launch, 'wmi');
    assert.equal(heartbeat.owner_pid, owner.pid);
    assert.ok(pidRunning(started.pid));
    assert.ok(pidRunning(heartbeat.pid));
    const logged = JSON.parse(readFileSync(started.log_file, 'utf8'));
    assert.equal(logged.pid, started.pid);
    assert.equal(logged.session_id, seed.session_id);

    const { stdout } = await run(
      process.execPath,
      [checker, '--url', started.url, '--session', seed.session_id],
      { timeout: 5000, windowsHide: true }
    );
    const checked = JSON.parse(stdout);
    assert.equal(checked.status, 'waiting_for_user');
    assert.equal(checked.session_id, seed.session_id);
    assert.equal(checked.instance_id, started.instance_id);
    const get = async path =>
      (await fetch(started.url + path, { signal: AbortSignal.timeout(3000) })).json();
    assert.deepEqual(await get('/state'), seed);
    const recovery = await get('/recovery');
    const activeHeartbeat = recovery.heartbeats.find(entry => entry.id === heartbeat.heartbeat_id);
    assert.equal(activeHeartbeat?.owner_pid, owner.pid);
    const lastPulse = recovery.ai.last_heartbeat_at;
    await until(
      async () => (await get('/progress')).ai.last_heartbeat_at > lastPulse,
      heartbeat.interval_ms + 5000
    );
  }
);

test('requesting a plan submits the remaining round and wakes the wait command', {timeout: 15000}, async t => {
  const confirmed = {option_ids: ['a'], text: '用户已提交'};
  const draft = {option_ids: ['b'], text: '保留这份草稿'};
  const deferred = {option_ids: [], text: '', deferred: true};
  const initial = tree([
    node('prior', {answer: confirmed, status: 'answered'}),
    node('delivery'),
    node('followup', {depends_on: ['schedule']}),
    node('schedule')
  ]);
  const s = await service(t, initial);
  const waiting = waitCommand(t, s);
  await until(async () => (await getAi(s)).last_check_at !== null);
  const request = {
    round: 1, expected_revision: 0, answers: [{id: 'delivery', answer: draft}]
  };

  const invalid = {...request, answers: [{id: 'prior', answer: draft}]};
  assert.equal((await s.post('/request-plan', invalid)).status, 400);
  assert.deepEqual(await s.state(), initial);
  assert.equal((await s.post('/request-plan', request)).status, 200);

  const result = await waiting.result;
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'ready_for_ai');
  assert.equal(receipt.plan_requested, true);
  assert.deepEqual(receipt.events.map(({kind, revision, round}) => ({kind, revision, round})), [
    {kind: 'request_plan', revision: 1, round: 1}
  ]);
  assert.ok(!result.stdout.includes(draft.text));
  const saved = await s.state();
  assert.equal(saved.status, 'active');
  assert.equal(saved.schema_version, 2);
  assert.equal(saved.revision, 1);
  assert.ok(saved.nodes.every(n => n.status === 'answered'));
  assert.deepEqual(saved.nodes.map(n => n.answer), [confirmed, draft, deferred, deferred]);
  assert.equal((await s.post('/round', {
    expected_revision: 1, round: 2, nodes: [node('extra', {round: 2})]
  })).status, 409);
  assert.equal((await s.post('/request-plan', {...request, expected_revision: 1, answers: []})).status, 409);
  assert.deepEqual(await s.state(), saved);
});

test('a plan request with no unanswered questions is returned by short check and survives recovery', async t => {
  const s = await service(t);
  await submit(s);
  await checkOnce(opts(s));
  const answered = await s.state();
  assert.equal((await s.post('/request-plan', {
    round: 1, expected_revision: answered.revision, answers: []
  })).status, 200);

  const {stdout} = await run(process.execPath, [
    checker, '--url', s.url, '--session', s.session_id, '--after-revision', String(answered.revision)
  ]);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.changed, true);
  assert.equal(receipt.plan_requested, true);
  assert.deepEqual(receipt.events.map(e => e.kind), ['request_plan']);
  assert.deepEqual(await s.state(), {...answered, revision: answered.revision + 1});

  const stopped = once(s.child, 'exit');
  s.child.kill();
  await stopped;
  const restarted = await s.start();
  const recovered = await checkOnce(opts(restarted));
  assert.equal(recovered.instance_changed, true);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.plan_requested, true);
  const postRestart = {...s, ...restarted};
  await control(postRestart, 'offer');
  assert.equal((await checkOnce(opts(restarted))).status, 'waiting_for_save');
  await control(postRestart, 'save');
  assert.equal((await checkOnce(opts(restarted))).plan_requested, false);
});

test('check CLI through a directory symlink enters main and matches direct calls, including live user events',async t=>{
 const s=await service(t),link=join(s.root,'linked-skill'),target=fileURLToPath(new URL('..',import.meta.url));
 // Junctions are the Windows directory symlink used by ~/.claude/skills.
 symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
 const via=join(link,'scripts','check.mjs');
 const directHelp=await run(process.execPath,[checker,'--help']),linkedHelp=await run(process.execPath,[via,'--help']);
 assert.ok(linkedHelp.stdout.length>40);
 assert.equal(linkedHelp.stdout,directHelp.stdout);
 assert.equal((await run(process.execPath,['--preserve-symlinks-main',via,'--help'])).stdout,directHelp.stdout);
 await submit(s);
 const args=['--url',s.url,'--session','v2-regression','--after-sequence','0'];
 const direct=JSON.parse((await run(process.execPath,[checker,...args])).stdout),linked=JSON.parse((await run(process.execPath,[via,...args])).stdout);
 const keys=['status','session_id','revision','sequence','instance_id','events'];
 for(const key of keys) assert.deepEqual(linked[key],direct[key]);
 assert.equal(linked.changed,true);assert.equal(linked.status,'ready_for_ai');

 const viaFile=join(s.root,'check-link.mjs');
 try{
  symlinkSync(checker,viaFile,'file');
 }catch(error){
  if(process.platform!=='win32'||error.code!=='EPERM') throw error;
  t.diagnostic('Skipped file symlink checks because Windows denied permission to create the file symlink (EPERM).');
  return;
 }
 assert.equal((await run(process.execPath,[viaFile,'--help'])).stdout,directHelp.stdout);
 const fileLinked=JSON.parse((await run(process.execPath,[viaFile,...args])).stdout);
 for(const key of keys) assert.deepEqual(fileLinked[key],direct[key]);
});

test('cursor automatically follows only user events across AI publication, offer, save, retry and restart',async t=>{
 const s=await service(t);let result=await checkOnce(opts(s));assert.equal(result.changed,false);
 await submit(s);result=await checkOnce(opts(s));assert.deepEqual(result.events.map(e=>e.kind),['submit']);assert.ok(result.timing.discovery_delay_ms>=0);
 assert.equal((await checkOnce(opts(s))).changed,false);
 assert.equal((await s.post('/round',{expected_revision:1,round:2,nodes:[node('follow',{round:2,depends_on:['delivery']})]})).status,200);
 result=await checkOnce(opts(s));assert.equal(result.changed,false);assert.equal(result.status,'waiting_for_user');
 assert.equal((await s.post('/submit',{round:2,expected_revision:2,answers:[{id:'follow',answer:{option_ids:['a'],text:''}}]})).status,200);
 result=await checkOnce(opts(s));assert.equal(result.events.length,1);assert.equal(result.sequence,2);
 const rewind=await checkOnce({...opts(s),afterSequence:0,afterRevision:1});assert.equal(rewind.events.length,1);assert.equal(rewind.events[0].revision,3);assert.equal(rewind.timing.discovery_delay_ms,null);
 await control(s,'offer');result=await checkOnce(opts(s));assert.equal(result.status,'waiting_for_save');assert.equal(result.changed,false);assert.equal(result.timing.discovery_delay_ms,null);
 let job=await control(s,'save');result=await checkOnce(opts(s));assert.deepEqual(result.events.map(e=>e.kind),['save']);
 await control(s,'claim',{job_id:job.job_id});assert.equal((await checkOnce(opts(s))).changed,false);
 await control(s,'failed',{job_id:job.job_id,error:'受控失败'});job=await control(s,'retry');result=await checkOnce(opts(s));assert.deepEqual(result.events.map(e=>e.kind),['retry']);
 const cursor=JSON.parse(readFileSync(s.file+'.cursor.json','utf8'));assert.equal(cursor.sequence,4);assert.equal(cursor.instance,s.instance_id);
 s.child.kill();await once(s.child,'exit');const restored=await s.start();s.url=restored.url;result=await checkOnce(opts(s));assert.equal(result.changed,false);assert.equal(result.instance_changed,true);assert.equal(result.sequence,4);
 await control(s,'retry');result=await checkOnce(opts(s));assert.equal(result.sequence,5);assert.deepEqual(result.events.map(e=>e.kind),['retry']);
 assert.equal(logs(s).filter(e=>e.event==='submission_discovered').length,2);
});

test('offer before discovery reports waiting_for_save without ever recording discovery delay',async t=>{
 const s=await service(t);await submit(s);await delay(20);await control(s,'offer');
 for(let i=0;i<3;i++){const r=await checkOnce(opts(s));assert.equal(r.status,'waiting_for_save');assert.equal(r.timing.discovery_delay_ms,null);assert.equal(r.timing.submission_at,null);}
 assert.equal(logs(s).filter(e=>e.event==='submission_discovered').length,0);
});

test('wait CLI stays silent across idle deadlines, reports activity and returns user events with the short-check cursor', {timeout:15000}, async context => {
  const running = await service(context, tree(), { waitMs: 100 });
  const startupDeadline = (await getAi(running)).work_until;
  const waiting = waitCommand(context, running);
  await until(async () => (await getAi(running)).last_check_at !== null);
  const first = (await getAi(running)).last_check_at;
  await until(async () => (await getAi(running)).last_check_at > first + 200);
  assert.equal(waiting.child.exitCode, null);
  assert.equal(waiting.stdout, '');
  const idle = await getAi(running);
  assert.equal(idle.work_until, startupDeadline);
  assert.equal(assistantConnection(idle, 90_000), 'connected');

  await submit(running);
  const submitted = await waiting.result;
  assert.equal(submitted.code, 0, submitted.stderr || submitted.stdout);
  assert.equal(submitted.stdout.includes('用户真正原话'), false);
  const result = JSON.parse(submitted.stdout);
  const replay = await checkOnce({ ...opts(running), afterSequence: 0 });
  assert.deepEqual({ ...result, timing: null }, { ...replay, timing: null });
  assert.deepEqual(result.events.map(event => event.kind), ['submit']);
  assert.equal((await checkOnce(opts(running))).changed, false);

  const review = waitCommand(context, running);
  assert.equal((await running.post('/decision', {
    expected_revision: 1, id: 'delivery', answer: { option_ids: ['a'], text: '' }
  })).status, 200);
  const reviewed = await review.result;
  assert.equal(reviewed.code, 0, reviewed.stderr || reviewed.stdout);
  assert.deepEqual(JSON.parse(reviewed.stdout).events.map(event => event.kind), ['review']);

  const save = waitCommand(context, running);
  await control(running, 'offer');
  await control(running, 'save');
  const saved = await save.result;
  assert.equal(saved.code, 0, saved.stderr || saved.stdout);
  assert.deepEqual(JSON.parse(saved.stdout).events.map(event => event.kind), ['save']);
  const afterSave = await checkOnce(opts(running));
  assert.equal(afterSave.sequence, 3);
  assert.equal(afterSave.changed, false);
});

test('wait CLI distinguishes a closed service, a finished session and the wrong identity', {timeout:15000}, async context => {
  const running = await service(context);
  const wrong = await waitCommand(context, running, 'different-session').result;
  assert.equal(wrong.code, 2);
  assert.equal(JSON.parse(wrong.stdout).status, 'identity');
  assert.equal((await getAi(running)).last_check_at, null);

  const waiting = waitCommand(context, running);
  await until(async () => (await getAi(running)).last_check_at !== null);
  const stopped = once(running.child, 'exit');
  running.child.kill();
  await stopped;
  const offline = await waiting.result;
  assert.equal(offline.code, 2);
  assert.equal(JSON.parse(offline.stdout).status, 'service_closed');
  await assert.rejects(
    run(process.execPath, [checker, '--url', running.url, '--session', running.session_id]),
    error => {
      assert.equal(error.code, 2);
      const receipt = JSON.parse(error.stdout);
      assert.equal(receipt.status, 'service_closed');
      assert.equal(receipt.kind, 'offline');
      return true;
    }
  );

  const resumed = await running.start();
  running.url = resumed.url;
  await submit(running);
  await control(running, 'offer');
  await control(running, 'save');
  await checkOnce(opts(running));
  const lastCheck = (await getAi(running)).last_check_at;
  const stillWaiting = waitCommand(context, running);
  await until(async () => (await getAi(running)).last_check_at > lastCheck);
  await control(running, 'close');
  const finished = await stillWaiting.result;
  assert.equal(finished.code, 2);
  assert.equal(JSON.parse(finished.stdout).status, 'session_finished');
});

test('work leases cover startup and AI events and reset on restart', async t => {
  const startedAfter = Date.now();
  const running = await service(t, tree(), { clock: true });
  const initial = await getAi(running);
  assert.equal(initial.last_check_at, null);
  assert.equal(initial.last_heartbeat_at, null);
  assert.equal(initial.work_active, true);
  assert.ok(initial.work_until >= startedAfter + WORK_LEASE_MS);
  assert.ok(initial.work_until <= Date.now() + WORK_LEASE_MS);
  assert.equal((await checkOnce(opts(running))).changed, false);
  const lastCheck = (await getAi(running)).last_check_at;

  const cursor = { expected_revision: 0, expected_instance_id: running.instance_id };
  running.setClockOffset(1000);
  const waiting = running.post('/ai/wait', cursor);
  await until(async () => (await getAi(running)).last_check_at > lastCheck);
  assert.equal((await getAi(running)).work_until, initial.work_until);
  await submit(running);
  assert.deepEqual(await (await waiting).json(), { status: 'event' });
  const woken = await getAi(running);
  assert.ok(woken.work_active);
  assert.ok(woken.work_until > initial.work_until);

  running.setClockOffset(2000);
  assert.equal((await checkOnce(opts(running))).changed, true);
  const discovered = await getAi(running);
  assert.ok(discovered.work_until > woken.work_until);
  running.setClockOffset(3000);
  assert.equal((await checkOnce(opts(running))).changed, false);
  assert.equal((await getAi(running)).work_until, discovered.work_until);

  running.setClockOffset(94_000);
  const thinking = await getAi(running);
  assert.ok(thinking.seconds_since_last_check >= 90);
  assert.equal(thinking.heartbeat_active, false);
  assert.equal(assistantConnection(thinking, 90_000), 'connected');
  const pause = await running.post('/ai/telemetry', {
    ...cursor,
    expected_revision: 1,
    event: 'pause_shown',
    page_id: 'work-lease',
    last_check_at: thinking.last_check_at
  });
  assert.deepEqual(await pause.json(), { recorded: false });

  for (const [path, fields] of [
    ['/ai/check', { expected_revision: 1, expected_session_id: 'wrong' }],
    ['/ai/check', { expected_revision: 1, expected_instance_id: 'old' }],
    ['/ai/wait', { expected_revision: 0 }],
    ['/round', { expected_revision: 0, round: 2, nodes: [node('follow', { round: 2 })] }]
  ]) {
    assert.equal((await running.post(path, { ...cursor, ...fields })).status, 409);
  }
  assert.equal((await getAi(running)).work_until, discovered.work_until);

  const published = await running.post('/round', {
    expected_revision: 1,
    round: 2,
    nodes: [node('follow', { round: 2, depends_on: ['delivery'] })]
  });
  assert.equal(published.status, 200);
  const restartOffset = 200_000;
  running.setClockOffset(restartOffset);
  const nextRound = await getAi(running);
  assert.ok(nextRound.work_until > discovered.work_until && nextRound.work_active);

  const bytes = readFileSync(running.file);
  const exited = once(running.child, 'exit');
  running.child.kill();
  await exited;
  const restartedAfter = Date.now() + restartOffset;
  const restored = await running.start();
  const restarted = await getAi(restored);
  assert.notEqual(restored.instance_id, running.instance_id);
  assert.equal(restarted.last_check_at, null);
  assert.equal(restarted.last_heartbeat_at, null);
  assert.equal(restarted.work_active, true);
  assert.ok(restarted.work_until > nextRound.work_until);
  assert.ok(restarted.work_until >= restartedAfter + WORK_LEASE_MS);
  assert.ok(restarted.work_until <= Date.now() + restartOffset + WORK_LEASE_MS);
  assert.equal(assistantConnection(restarted, 90_000), 'connected');
  assert.deepEqual(readFileSync(running.file), bytes);
});

test('validated document actions and chapter publication renew work without checks or heartbeats', async t => {
  const answered = id =>
    node(id, { status: 'answered', answer: { option_ids: ['none'], text: '' } });
  const running = await service(t, tree([answered('a'), answered('b')]), { clock: true });
  await control(running, 'offer');
  const offered = await getAi(running);
  assert.ok(offered.work_active);

  running.setClockOffset(1000);
  const { job_id } = await control(running, 'save');
  assert.equal((await getAi(running)).work_until, offered.work_until);
  const claimed = await control(running, 'claim', { job_id });
  const claimedUntil = (await getAi(running)).work_until;
  assert.ok(claimedUntil > offered.work_until);

  running.setClockOffset(2000);
  const documentAction = fields =>
    running.post('/document/control', {
      expected_revision: claimed.source.revision,
      job_id,
      ...fields
    });
  assert.equal(
    (await documentAction({ action: 'progress', job_id: 'old', stage: 'design' })).status,
    409
  );
  assert.equal((await documentAction({ action: 'progress', stage: 'invalid' })).status, 400);
  assert.equal((await documentAction({ action: 'chapter', chapter_id: 'a' })).status, 404);
  assert.equal((await documentAction({ action: 'ready' })).status, 404);
  assert.equal((await getAi(running)).work_until, claimedUntil);

  await control(running, 'progress', { job_id, stage: 'design' });
  let workUntil = (await getAi(running)).work_until;
  assert.ok(workUntil > claimedUntil);
  const frozen = await running.state();
  const bytes = readFileSync(running.file);
  const parts = [];
  for (const [index, chapter] of claimed.source.chapters.entries()) {
    running.setClockOffset(100_000 * (index + 1));
    const writing = await getAi(running);
    assert.equal(writing.heartbeat_active, false);
    assert.equal(writing.last_check_at, null);
    assert.equal(assistantConnection(writing, 90_000), 'connected');
    parts.push(renderChapter(claimed, frozen, chapter.id, '<p>已完成章节</p>'));
    writeFileSync(
      running.document + '.preview.html',
      composeDocument(claimed, parts, { preview: true }).html
    );
    await control(running, 'chapter', { job_id, chapter_id: chapter.id });
    const published = await getAi(running);
    assert.ok(published.work_until > workUntil);
    workUntil = published.work_until;
  }

  const source = parts[0].source;
  parts.push(
    { source, view: 'design', html: '<article id="R1" data-kind="requirement">需求</article>' },
    { source, view: 'plan', html: '<article id="W1" data-kind="work">开发</article>' },
    { source, view: 'acceptance', html: '<article id="AC1" data-kind="criterion">验收</article>' }
  );
  writeFileSync(running.document, composeDocument(claimed, parts).html);
  running.setClockOffset(210_000);
  assert.equal((await control(running, 'ready', { job_id })).phase, 'ready');
  assert.ok((await getAi(running)).work_until > workUntil);
  assert.deepEqual(readFileSync(running.file), bytes);
});

test('detached heartbeat renews activity every 10s without reading or consuming submissions; stop records end', async t => {
  const s = await service(t);
  await checkOnce(opts(s));
  const cursor = readFileSync(s.file + '.cursor.json');
  const hb = JSON.parse(
    (
      await run(
        process.execPath,
        [
          checker,
          '--url',
          s.url,
          '--session',
          'v2-regression',
          '--heartbeat',
          '--owner-pid',
          String(process.pid)
        ],
        { timeout: process.platform === 'win32' ? 20000 : 3000 }
      )
    ).stdout
  );
  s.track(hb.pid);
  assert.equal(hb.status, 'heartbeat_started');
  assert.equal(hb.interval_ms, 10000);
  const first = (await (await fetch(s.url + '/progress')).json()).ai.last_activity_at;
  await submit(s);
  const bytes = readFileSync(s.file);
  await delay(10500);
  const ai = (await (await fetch(s.url + '/progress')).json()).ai;
  assert.equal(ai.last_check_at, first);
  assert.equal(ai.last_activity_at, first);
  assert.equal(ai.source, 'check');
  assert.ok(ai.seconds_since_last_check >= 10);
  assert.ok(ai.seconds_since_last_heartbeat < 3);
  assert.equal(hb.owner_pid, process.pid);
  assert.equal(hb.lease_ms, 180000);
  assert.deepEqual(readFileSync(s.file + '.cursor.json'), cursor);
  assert.deepEqual(readFileSync(s.file), bytes);
  assert.equal(logs(s).filter(e => e.event === 'submission_discovered').length, 0);
  const found = await checkOnce(opts(s));
  assert.deepEqual(
    found.events.map(e => e.kind),
    ['submit']
  );
  assert.ok(found.timing.discovery_delay_ms >= 10000);
  await stopHeartbeat(opts(s), hb.heartbeat_id);
  assert.equal(
    (await runtimePost(opts(s), '/ai/heartbeat', { heartbeat_id: hb.heartbeat_id })).active,
    false
  );
  const events = logs(s);
  assert.equal(events.filter(e => e.event === 'heartbeat_start').length, 1);
  assert.equal(events.filter(e => e.event === 'heartbeat_end').length, 1);
});

test('heartbeat validates session/revision/instance and exits when service instance disappears', async t => {
  const s = await service(t);
  const startupDeadline = (await getAi(s)).work_until;
  for (const override of [
    { expected_session_id: 'wrong' },
    { expected_revision: 99 },
    { expected_instance_id: 'old' }
  ]) {
    const response = await s.post('/ai/heartbeat', {
      heartbeat_id: 'rejected',
      expected_revision: 0,
      expected_instance_id: s.instance_id,
      ...override
    });
    assert.equal(response.status, 409);
  }
  const rejected = await getAi(s);
  assert.equal(rejected.last_activity_at, null);
  assert.equal(rejected.work_until, startupDeadline);
  const hb = await startHeartbeat({ ...opts(s), ownerPid: process.pid });
  s.track(hb.pid);
  s.child.kill();
  await once(s.child, 'exit');
  const until = Date.now() + 13000;
  let alive = true;
  while (alive && Date.now() < until) {
    try {
      process.kill(hb.pid, 0);
      await delay(100);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
});

test('only short checks clear silence; heartbeat expiry logs remain truthful without modifying the tree',()=>{
 const original=Date.now,events=[];let now=1000;Date.now=()=>now;
 try{const state=tree(),p=new InterviewProgress(()=>state,{log:{sequence:0,after:()=>[],append:(event,detail)=>events.push({event,...detail})}});
 p.checkIn();p.heartbeat('first','pulse',{ownerPid:7});now+=31000;p.status();p.heartbeat('second','pulse',{ownerPid:7});
 assert.deepEqual(events.map(e=>e.event),['heartbeat_start','heartbeat_end','heartbeat_start']);assert.equal(events[1].reason,'expired_observed');assert.equal(events[1].last_pulse_at,1000);
 now+=30001;p.heartbeat('third','pulse',{ownerPid:7});assert.equal(p.lastCheckAt,1000);assert.ok(p.status().ai.seconds_since_last_check>60);assert.equal(events.some(e=>e.event==='ai_resumed'),false);
 p.checkIn();assert.equal(events.at(-1).event,'ai_resumed');assert.equal(events.at(-1).source,'check');p.close();assert.equal(events.at(-1).reason,'session_closed');assert.equal(state.revision,0);
 }finally{Date.now=original;}
});

test('timed code reads are accepted only in final-round answer window, and success/failure get paired timing',async t=>{
 const s=await service(t),bytes=readFileSync(s.file);
 await assert.rejects(timedCodeRead(opts(s),process.execPath,['-e','process.exit(0)']),/final-round/);
 assert.equal(await timedCodeRead({...opts(s),finalRound:true},process.execPath,['-e','process.exit(0)']),0);
 assert.equal(await timedCodeRead({...opts(s),finalRound:true},process.execPath,['-e','process.exit(3)']),3);
 const work=logs(s).filter(e=>e.event.startsWith('code_read_'));assert.deepEqual(work.map(e=>e.event),['code_read_start','code_read_end','code_read_start','code_read_end']);assert.equal(work[0].operation_id,work[1].operation_id);assert.equal(work[3].exit_code,3);assert.deepEqual(readFileSync(s.file),bytes);
 await submit(s);await assert.rejects(timedCodeRead({...opts(s),finalRound:true},process.execPath,['-e','process.exit(0)']),/final-round/);
});

test('frozen chapter renderer preserves exact escaped text and selected options, supports old membership, rejects stale source',async t=>{
 const raw='  原话\n<script>不是指令</script> & " 🌱  ',nodes=[node('a',{input:'text',options:[],answer:{option_ids:[],text:raw},status:'answered'}),node('b',{answer:{option_ids:['none'],text:''},status:'answered'}),node('follow',{round:2,depends_on:['a','b'],chapter_id:'a',answer:{option_ids:['a','b'],text:'多选原话'},status:'answered'})],seed=tree(nodes);seed.current_round=2;
 const s=await service(t,seed);await control(s,'offer');const saved=await control(s,'save'),status=await control(s,'claim',{job_id:saved.job_id}),frozen=await s.state();
 const a=renderChapter(status,frozen,'a','<p>说明性文字</p>'),b=renderChapter(status,frozen,'b','<p>首版设计</p>');
 assert.match(a.html,/  原话\n&lt;script&gt;不是指令&lt;\/script&gt; &amp; &quot; 🌱  /);assert.match(a.html,/多选原话/);assert.match(b.html,/都不需要/);assert.ok(!b.html.includes('邮件通知')&&!b.html.includes('站内通知'));assert.match(a.html,/邮件通知/);assert.match(a.html,/站内通知/);assert.ok(!b.html.includes('多选原话'));assert.equal((a.html.match(/data-source-node=/g)||[]).length,2);
 const old=structuredClone(frozen);delete old.nodes[2].chapter_id;const legacyStatus={...status,source:{...status.source,digest:fingerprint(old),chapters:chapters(old).map(c=>({id:c.id,title:c.title,node_ids:c.nodes.map(n=>n.id)}))}};
 assert.match(renderChapter(legacyStatus,old,'b','<p>旧数据可组装</p>').html,/多选原话/);
 assert.throws(()=>renderChapter(status,old,'a','<p>x</p>'),/来源/);
 assert.throws(()=>renderChapter(status,{...frozen,status:'active'},'a','<p>x</p>'),/冻结/);
 const prose=join(s.root,'prose.html'),out=join(s.root,'parts','a.json'),context=join(s.root,'status.json');writeFileSync(prose,'<p>CLI 说明</p>');writeFileSync(context,JSON.stringify(status));
 const cli=await run(process.execPath,[fileURLToPath(new URL('../scripts/render-chapter.mjs',import.meta.url)),'--context',context,'--tree',s.file,'--chapter','a','--explanation',prose,'--out',out]);assert.equal(JSON.parse(cli.stdout).chapter_id,'a');assert.match(JSON.parse(readFileSync(out,'utf8')).html,/用户原话/);
 const assembled=composeDocument(status,[a,b],{preview:true});writeFileSync(s.document+'.preview.html',assembled.html);validateDocument(s.document+'.preview.html',frozen,status.job_id,{partial:true,chapterId:'a'});
 await control(s,'chapter',{job_id:status.job_id,chapter_id:'a'});await delay(5);await control(s,'chapter',{job_id:status.job_id,chapter_id:'b'});await control(s,'chapter',{job_id:status.job_id,chapter_id:'a'});
 const published=logs(s).filter(e=>e.event==='chapter_first_published');assert.equal(published.length,2);assert.ok(published[1].first_published_at>published[0].first_published_at);
});


test('three-minute leases renew only on a short check from their owner; pulses and other owners cannot renew',()=>{
 const original=Date.now,events=[];let now=1000;Date.now=()=>now;
 try{const p=new InterviewProgress(()=>tree(),{log:{sequence:0,after:()=>[],append:(event,detail)=>events.push({event,...detail})}});
 assert.equal(HEARTBEAT_LEASE_MS,180000);assert.equal(SHORT_QUERY_TIMEOUT_MS,60000);
 p.heartbeat('a','pulse',{ownerPid:7});p.heartbeat('b','pulse',{ownerPid:8});const initial=p.heartbeats.get('a').leaseUntil;
 for(let i=0;i<17;i++){now+=10000;p.heartbeat('a','pulse',{ownerPid:7});p.heartbeat('b','pulse',{ownerPid:8});}
 assert.equal(p.lastCheckAt,null);assert.equal(p.heartbeats.get('a').leaseUntil,initial);
 p.checkIn({ownerPid:7});assert.equal(p.heartbeats.get('a').leaseUntil,now+HEARTBEAT_LEASE_MS);assert.equal(p.heartbeats.get('b').leaseUntil,initial);
 now+=10000;p.sweep();assert.ok(p.heartbeats.has('a'));assert.equal(p.heartbeats.has('b'),false);assert.equal(events.at(-1).reason,'lease_expired');
 assert.equal(p.heartbeat('b','pulse',{ownerPid:8}),false);const lastHeartbeat=p.lastHeartbeatAt;p.checkIn({ownerPid:7});assert.equal(p.lastHeartbeatAt,lastHeartbeat);
 }finally{Date.now=original;}
});

test('CLI short checks renew only an explicitly matching owner, and recovery exposes both clocks',async t=>{
 const s=await service(t),common=['--url',s.url,'--session','v2-regression'];
 const hb=JSON.parse((await run(process.execPath,[checker,...common,'--heartbeat','--owner-pid',String(process.pid)])).stdout);s.track(hb.pid);assert.equal(hb.owner_pid,process.pid);
 const first=await(await fetch(s.url+'/recovery')).json();assert.equal(first.ai.last_check_at,null);assert.equal(first.ai.seconds_since_last_check,null);assert.ok(first.ai.seconds_since_last_heartbeat>=0);
 await run(process.execPath,[checker,...common]);let rec=await(await fetch(s.url+'/recovery')).json();assert.equal(rec.heartbeats[0].lease_until,hb.lease_until);assert.equal(rec.ai.last_heartbeat_at,first.ai.last_heartbeat_at);
 await run(process.execPath,[checker,...common,'--owner-pid',String(process.ppid)]);rec=await(await fetch(s.url+'/recovery')).json();assert.equal(rec.heartbeats[0].lease_until,hb.lease_until);
 await run(process.execPath,[checker,...common,'--owner-pid',String(process.pid)]);rec=await(await fetch(s.url+'/recovery')).json();assert.ok(rec.heartbeats[0].lease_until>hb.lease_until);
 assert.equal(rec.ai.last_check_at,(await(await fetch(s.url+'/progress')).json()).ai.last_check_at);
});

test('heartbeat owner lookup skips shells, recognizes the four tools and chooses the closest ancestor', () => {
  const descendants = [{ pid: 70, ppid: 60, name: 'node' }, { pid: 60, ppid: 50, name: 'pwsh.exe' }];
  for (const name of ['C:\\Apps\\Claude.EXE', '/opt/codex', 'cursor-agent', 'Antigravity.exe']) {
    assert.equal(findAiOwnerPid([
      ...descendants, { pid: 50, ppid: 40, name }, { pid: 40, ppid: 1, name: 'claude' }
    ], 70), 50);
  }
  assert.equal(findAiOwnerPid([
    ...descendants, { pid: 50, ppid: 60, name: 'claude-helper.exe' },
    { pid: 40, ppid: 1, name: 'codex' }
  ], 70), null);
});

test(
  'owner exit removes the inferred heartbeat and work lease expiry permits pause telemetry',
  { timeout: 15000 },
  async context => {
    const running = await service(context, tree(), { clock: true });
    await submit(running);
    await checkOnce(opts(running));
    running.setClockOffset(SHORT_QUERY_TIMEOUT_MS + 1000);

    await assert.rejects(
      startHeartbeat(opts(running), {
        loadProcessTable: async () => [{ pid: process.pid, ppid: 1, name: 'node' }]
      }),
      /--owner-pid/
    );
    const host = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    const hostExit = once(host, 'exit');
    context.after(async () => {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await hostExit;
    });
    const shellPid = Math.max(process.pid, host.pid) + 1;
    const hb = await startHeartbeat(opts(running), {
      loadProcessTable: async () => [
        { pid: process.pid, ppid: shellPid, name: 'node' },
        { pid: shellPid, ppid: host.pid, name: 'pwsh' },
        { pid: host.pid, ppid: 1, name: 'claude.exe' }
      ]
    });
    running.track(hb.pid);
    assert.equal(hb.owner_pid, host.pid);
    const active = await getAi(running);
    assert.ok(active.seconds_since_last_check > 60);
    assert.equal(active.heartbeat_active, true);
    assert.equal(assistantConnection(active, 90000), 'connected');
    const pause = () =>
      running
        .post('/ai/telemetry', {
          expected_revision: 1,
          expected_instance_id: running.instance_id,
          event: 'pause_shown',
          page_id: 'owner-exit',
          last_check_at: active.last_check_at
        })
        .then(response => response.json());
    assert.deepEqual(await pause(), { recorded: false });

    await delay(1200);
    process.kill(hb.pid, 0);
    host.kill();
    await hostExit;
    await until(async () => !(await getAi(running)).heartbeat_active, 10000);
    assert.equal(
      logs(running)
        .filter(event => event.event === 'heartbeat_end')
        .at(-1).reason,
      'owner_exited'
    );
    assert.equal(assistantConnection(await getAi(running), 90_000), 'connected');
    assert.deepEqual(await pause(), { recorded: false });

    running.setClockOffset(SHORT_QUERY_TIMEOUT_MS + WORK_LEASE_MS + 2000);
    assert.equal((await getAi(running)).work_active, false);
    assert.equal(assistantConnection(await getAi(running), 90000), 'paused');
    assert.deepEqual(await pause(), { recorded: true });
  }
);

test('server lease expiry stops the real worker and logs lease_expired (controlled service clock)',async t=>{
 const s=await service(t,tree(),{clock:true}),hb=await startHeartbeat({...opts(s),ownerPid:process.pid});s.track(hb.pid);const bytes=readFileSync(s.file);
 // Advance server time only: no shorter production constants or fake heartbeat worker.
 s.setClockOffset(HEARTBEAT_LEASE_MS+1);let alive=true;const until=Date.now()+12000;
 while(alive&&Date.now()<until){try{process.kill(hb.pid,0);await delay(100);}catch{alive=false;}}
 assert.equal(alive,false);const ends=logs(s).filter(e=>e.event==='heartbeat_end');assert.equal(ends.length,1);assert.equal(ends[0].reason,'lease_expired');assert.deepEqual(readFileSync(s.file),bytes);
 assert.equal((await(await fetch(s.url+'/recovery')).json()).heartbeats.length,0);
});
