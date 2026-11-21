import{test}from'node:test';import assert from'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import{mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,realpathSync,existsSync,readdirSync}from'node:fs';
import { EOL, tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import{createServer}from'node:net';import{fingerprint}from'../scripts/document.mjs';import{chapters}from'../assets/topics.mjs';
import { readTaskText } from '../scripts/read-task.mjs';
import { validateTask } from '../scripts/validate-task.mjs';
const server=fileURLToPath(new URL('../scripts/server.mjs',import.meta.url));
const run=promisify(execFile),composer=fileURLToPath(new URL('../scripts/compose-document.mjs',import.meta.url));
const answer=(id,deps=[])=>({id,question:id+' 的真实问题',rationale:'受控测试：核对文档来源和复核边界。',input:'text',options:[],answer:{option_ids:[],text:'原答案'},depends_on:deps,status:'answered',round:1});
const tree=()=>({schema_version:2,session_id:'document-fixture',topic:'文档交接测试',revision:0,current_round:1,status:'active',nodes:[answer('a'),answer('b'),answer('joint',['a','b'])]});
const post=async(url,route,data,extra={})=>{const tree=await(await fetch(url+'/state')).json();return fetch(url+route,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify({expected_session_id:tree.session_id,...data})});};
async function start(t,seed=tree(),root=null,port=0){
 const own=!root;root??=mkdtempSync(join(tmpdir(),'grill-document-test-'));if(own)writeFileSync(join(root,'tree.json'),JSON.stringify(seed));
 const child=spawn(process.execPath,[server,'--state',join(root,'tree.json'),'--port',String(port),'--wait-ms','120']);let error='';child.stderr.on('data',x=>error+=x);
 const ready=await Promise.race([once(child.stdout,'data').then(([d])=>JSON.parse(String(d))),once(child,'exit').then(()=>{throw Error(error);})]);
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}if(own){const p=realpathSync(root);assert.equal(dirname(p).toLowerCase(),realpathSync(tmpdir()).toLowerCase());assert.ok(basename(p).startsWith('grill-document-test-'));rmSync(p,{recursive:true,force:true});}});return{...ready,root,child};
}
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
async function writer(t){
 const s=await start(t),control=data=>post(s.url,'/document/control',data);
 await control({action:'offer',expected_revision:0});
 const requested=await(await control({action:'save',expected_revision:0})).json();
 const status=await(await control({action:'claim',expected_revision:1,job_id:requested.job_id})).json();
 const context=join(s.root,'status.json'),parts=join(s.root,'parts');mkdirSync(parts);writeFileSync(context,JSON.stringify(status));
 return{...s,status,parts,control,put(id){writeFileSync(join(parts,id+'.json'),JSON.stringify({source:{...status.source,job_id:status.job_id},view:'chapter',chapter_id:id,html:'<p>已完成的 '+id+' 章正文</p>'}));},
  async preview(online=true){const args=[composer,'--context',context,'--tree',s.state_file,'--parts',parts,'--preview'];if(online)args.push('--url',s.url);const result=await run(process.execPath,args,{timeout:15000,windowsHide:true});return{...result,data:JSON.parse(result.stdout)};},
  timings(){return readFileSync(status.chapter_timing_file,'utf8').trim().split('\n').map(line=>JSON.parse(line));}};
}
function documentFixture(tree,job){return`<!doctype html><html lang="zh-CN"><main data-task-record data-revision="test-r1" data-source-session="${esc(tree.session_id)}" data-source-revision="${tree.revision}" data-source-digest="${fingerprint(tree)}" data-source-job="${job}"><section id="design-view">${chapters(tree).map(c=>`<article id="${c.anchor}">${esc(c.title)}</article>`).join('')}<article id="R1" data-kind="requirement">测试需求</article><p data-node-id="R1">原文含 id="AC1"</p><p data-node-id="R1">引用同一源题</p></section><section id="plan-view"><article id="W1" data-kind="work">测试开发项</article></section><section id="acceptance-view"><article id="AC1" data-kind="criterion">测试验收项</article></section></main></html>`;}
test('document offer is revision-bound; edits invalidate it and review blocks saving',async t=>{
 const s=await start(t);const control=data=>post(s.url,'/document/control',data);
 assert.equal((await control({action:'save',expected_revision:0})).status,409);
 assert.equal((await control({action:'offer',expected_revision:0})).status,200);
 await post(s.url,'/reopen',{id:'a',expected_revision:0});
 assert.equal((await control({action:'save',expected_revision:0})).status,409);
 assert.equal((await control({action:'offer',expected_revision:1})).status,409);
 assert.equal((await control({action:'save',expected_revision:1})).status,409);
 assert.equal((await(await fetch(s.url+'/state')).json()).status,'active');
});
test('freeze once; failed generation retries same data; stale jobs rejected; validated HTML served; close releases port',async t=>{
 const s=await start(t),control=data=>post(s.url,'/document/control',data);
 await control({action:'offer',expected_revision:0});
 const requested=await(await control({action:'save',expected_revision:0})).json();assert.equal(requested.phase,'requested');
 const frozen=JSON.parse(readFileSync(s.state_file,'utf8')),bytes=readFileSync(s.state_file,'utf8');assert.equal(frozen.revision,1);assert.equal(frozen.status,'complete');
 assert.equal((await control({action:'save',expected_revision:0})).status,409);
 assert.equal((await post(s.url,'/decision',{id:'a',expected_revision:1,answer:{option_ids:[],text:'改'}})).status,409);
 const oldJob=requested.job_id;await control({action:'claim',expected_revision:1,job_id:oldJob});
 await control({action:'failed',expected_revision:1,job_id:oldJob,error:'受控测试失败'});
 const retry=await(await control({action:'retry',expected_revision:1})).json();assert.notEqual(retry.job_id,oldJob);
 const stale = await control({ action: 'ready', expected_revision: 1, job_id: oldJob });
 assert.equal(stale.status, 409);
 assert.match((await stale.json()).error, /生成请求已过期.*GET \/document\/status/);
 await control({action:'claim',expected_revision:1,job_id:retry.job_id});mkdirSync(dirname(s.document_file),{recursive:true});
 writeFileSync(s.document_file,documentFixture({...frozen,revision:2},retry.job_id));assert.equal((await control({action:'ready',expected_revision:1,job_id:retry.job_id})).status,422);
 assert.equal((await fetch(s.url+'/document')).status,409);
 writeFileSync(join(dirname(s.document_file),'report.json'),JSON.stringify({passed:true}));writeFileSync(join(dirname(s.document_file),'unlinked.json'),'private');writeFileSync(s.document_file,documentFixture(frozen,retry.job_id).replace('</main>','<a href="report.json">报告</a><a href="../tree.json">越界引用</a></main>'));assert.equal((await control({action:'ready',expected_revision:1,job_id:retry.job_id})).status,200);
 const doc=await fetch(s.url+'/document');assert.equal(doc.status,200);const rendered=await doc.text();assert.match(rendered,/测试开发项/);assert.match(rendered,/resource=report.json/);assert.deepEqual(await(await fetch(s.url+'/document?resource=report.json')).json(),{passed:true});assert.equal((await fetch(s.url+'/document?resource=unlinked.json')).status,404);assert.equal((await fetch(s.url+'/document?resource=..%2Ftree.json')).status,404);
 assert.equal(readFileSync(s.state_file,'utf8'),bytes,'retry never writes canonical data');
 assert.equal((await post(s.url,'/document/control',{action:'close',expected_revision:1},{origin:'https://foreign.invalid'})).status,403);
 const status=await(await fetch(s.url+'/document/status')).json(),pending=await(await fetch(s.url+'/document/wait?after='+status.sequence)).json();assert.equal(pending.status,'pending');
 const exited=once(s.child,'exit');await control({action:'close',expected_revision:1});assert.equal((await exited)[0],0);
 const listener=createServer();await new Promise((resolve,reject)=>listener.once('error',reject).listen(s.port,'127.0.0.1',resolve));await new Promise(resolve=>listener.close(resolve));
 const restored=await start(t,null,s.root,s.port);assert.equal((await(await fetch(restored.url+'/document/status')).json()).phase,'ready');
 const { ai } = await (await fetch(restored.url + '/progress')).json();
 assert.equal(ai.work_active, false);
 assert.equal(ai.work_until, null);
});

test('document controls distinguish a missing job ID, a mismatch and a phase conflict', async t => {
  const s = await start(t);
  const control = data => post(s.url, '/document/control', { expected_revision: 1, ...data });
  assert.equal((await control({ action: 'offer', expected_revision: 0 })).status, 200);
  const saved = await control({ action: 'save', expected_revision: 0 });
  assert.equal(saved.status, 200);
  const { job_id } = await saved.json();

  const expectConflict = async (body, pattern) => {
    const response = await control(body);
    assert.equal(response.status, 409);
    const { error } = await response.json();
    assert.match(error, pattern);
    assert.doesNotMatch(error, /已过期/);
  };
  for (const action of ['claim', 'progress', 'chapter', 'ready', 'failed']) {
    await expectConflict({ action }, /缺少 job_id.*GET \/document\/status/);
    await expectConflict({ action, job_id: 'unknown' }, /job_id 与当前生成任务不符/);
    if (action !== 'claim')
      await expectConflict({ action, job_id }, new RegExp(`当前阶段是 requested，不能 ${action}`));
  }
  assert.equal((await control({ action: 'claim', job_id })).status, 200);
  await expectConflict({ action: 'claim', job_id }, /当前阶段是 generating，不能 claim/);
});

test('preview records increasing first publication times, preserves them on repeat, and does not time offline assembly',async t=>{
 const s=await writer(t),frozen=readFileSync(s.state_file);s.put('a');
 const offline=await s.preview(false);assert.deepEqual(offline.data.newly_published_chapters,[]);assert.equal(offline.data.chapter_timing_file,null);assert.equal(existsSync(s.status.chapter_timing_file),false);
 const first=await s.preview();assert.equal(first.stderr,'');assert.deepEqual(first.data.newly_published_chapters,['a']);assert.deepEqual(first.data.warnings,[]);
 const firstTime=first.data.chapter_timings.find(c=>c.id==='a').first_published_at;assert.ok(firstTime>=s.status.started_at);assert.equal(first.data.chapter_timings.find(c=>c.id==='b').first_published_at,null);
 assert.equal((await fetch(s.url+'/document?chapter=a')).status,200);assert.equal((await fetch(s.url+'/document?chapter=b')).status,409);
 await new Promise(resolve=>setTimeout(resolve,10));s.put('b');const second=await s.preview();
 assert.equal(second.stderr,'');assert.deepEqual(second.data.newly_published_chapters,['b']);assert.deepEqual(second.data.warnings,[]);assert.equal(second.data.chapter_timings[0].first_published_at,firstTime);assert.ok(second.data.chapter_timings[1].first_published_at>firstTime);
 const again=await s.preview();assert.deepEqual(again.data.newly_published_chapters,[]);assert.deepEqual(again.data.chapter_timings,second.data.chapter_timings);assert.equal(again.stderr,'');
 const entries=s.timings();assert.equal(entries.length,2);assert.deepEqual(entries.map(e=>e.chapter_id),['a','b']);
 for(const e of entries){assert.equal(e.event,'chapter_first_published');assert.equal(e.session_id,s.status.source.session_id);assert.equal(e.revision,s.status.source.revision);assert.equal(e.digest,s.status.source.digest);assert.equal(e.job_id,s.status.job_id);assert.equal(e.first_published_at_iso,new Date(e.first_published_at).toISOString());assert.equal(e.elapsed_ms,e.first_published_at-s.status.started_at);assert.equal(e.generation_started_at,s.status.started_at);}
 assert.deepEqual(readFileSync(s.state_file),frozen,'publication timing never changes interview data');
 const exited=once(s.child,'exit');await s.control({action:'close',expected_revision:1});await exited;assert.deepEqual(s.timings(),entries,'publication evidence survives service shutdown');
});

test('one preview publishing multiple new chapters warns clearly without blocking publication',async t=>{
 const s=await writer(t);s.put('a');s.put('b');const result=await s.preview();
 assert.deepEqual(result.data.newly_published_chapters,['a','b']);assert.equal(result.data.warnings.length,1);assert.match(result.stderr,/警告.*一次新发布了 2 章/);assert.match(result.stderr,/不得攒多章一起发布/);assert.ok(result.stderr.includes(result.data.warnings[0]));
 assert.equal(s.timings().length,2);for(const id of ['a','b'])assert.equal((await fetch(s.url+'/document?chapter='+id)).status,200);
 const repeat=await s.preview();assert.deepEqual(repeat.data.warnings,[]);assert.equal(repeat.stderr,'');assert.equal(s.timings().length,2);
});

test('a JSON sidecar in --parts identifies the file and missing source before publishing', async t => {
  const s = await writer(t);
  s.put('a');
  const sidecar = join(s.parts, 'a.metadata.json');
  writeFileSync(sidecar, JSON.stringify({ encoding: 'utf8' }));
  await assert.rejects(s.preview(), {
    code: 1,
    stderr: /a\.metadata\.json.*source 必须是分片来源对象/
  });
  assert.equal(existsSync(s.document_file + '.preview.html'), false);
  rmSync(sidecar);
  const assembled = await s.preview();
  assert.deepEqual(assembled.data.newly_published_chapters, ['a']);
});

function handoffFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grill-handoff-test-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target).toLowerCase(), realpathSync(tmpdir()).toLowerCase());
    assert.ok(basename(target).startsWith('grill-handoff-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  const frozen = { ...tree(), status: 'complete', revision: 7 };
  frozen.nodes[1].question = '邮件 & 短信用哪种？';
  frozen.nodes[2].id = '待定 % 时间';
  frozen.nodes[2].question = '几点开始通知？';
  for (const node of frozen.nodes.slice(1)) node.answer = { option_ids: [], text: '', deferred: true };
  const file = join(root, 'plan', 'custom-plan.html');
  const source = { session_id: frozen.session_id, revision: frozen.revision, digest: fingerprint(frozen), job_id: 'handoff-job' };
  const chapterList = chapters(frozen).map(({ id, anchor, title, nodes }) => ({ id, anchor, title, node_ids: nodes.map(node => node.id) }));
  const status = { phase: 'generating', job_id: source.job_id, source: { ...source, chapters: chapterList, document_file: file } };
  const context = join(root, 'status.json'), state = join(root, 'tree.json'), parts = join(root, 'parts');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')
  );
  env.PATH = '';
  mkdirSync(parts);
  writeFileSync(context, JSON.stringify(status));
  writeFileSync(state, JSON.stringify(frozen));
  const put = (name, view, html, extra = {}) => writeFileSync(join(parts, name + '.json'), JSON.stringify({ source, view, html, ...extra }));
  for (const chapter of chapterList) {
    const questions = frozen.nodes.filter(node => chapter.node_ids.includes(node.id) && node.answer.deferred).map(node => node.question);
    put(`chapter-${chapter.id}`, 'chapter', '<p>可阅读的章节正文</p>', { chapter_id: chapter.id, deferred_questions: questions });
  }
  put('design', 'design', `<p data-kind="requirement" id="R1">报名后发送通知</p>
    <ul><li data-kind="question" id="Q1">谁维护<strong>通知模板</strong>？</li><li data-kind="question" id="Q2">谁确认交付日期？</li></ul>`);
  const plan = `<div data-kind="work" id="W2" data-requirements="R1" data-criteria="AC2" data-depends="W1" data-questions="deferred-b Q1">
      <div data-field="effects"><h3>撤不回的动作</h3><ul>
        <li>写线上数据库：执行&nbsp; <code>add_xxx</code><span hidden>隐藏文字</span></li>
        <li><strong>对外</strong>发通知<template>模板文字</template></li>
        <li></li><li>&nbsp;</li>
      </ul></div>
      <p>报名后发送<strong>一条</strong>通知。</p><span data-field="status">planned</span>
    </div><article data-kind="phase" id="W1" data-requirements="R1" data-criteria="AC1">
      <h3>记录报名</h3><p data-field="goal">保存报名回执。</p>
      <ul data-field="effects"><li>　无&nbsp;</li></ul>
    </article><p data-kind="work" id="W3">整理操作说明</p>
    <article data-kind="phase" id="W4"><p>核对上线窗口</p>
      <ul data-field="effects"><li>暂无</li><li>没有</li></ul>
    </article><article data-kind="work" id="W5"><p>整理回执模板</p>
      <div data-field="effects">撤不回的动作</div>
    </article>`;
  put('plan', 'plan', plan);
  const acceptance = `<article data-kind="criterion" id="AC1" data-requirements="R1"><p>报名成功后收到 <strong>回执</strong>。</p><span data-field="status">unverified</span></article>
    <article data-kind="criterion" id="AC2" data-requirements="R1"><p>确认 A &amp; B。</p><div data-field="effects"><ul><li>只发送一次。</li></ul></div><span data-field="status">unverified</span></article>`;
  put('acceptance', 'acceptance', acceptance);
  return {
    file, manifest: join(dirname(file), 'task.manifest.json'), frozen, plan, acceptance, put,
    assemble(...flags) {
      const input = flags.includes('--existing') ? [] : ['--parts', parts];
      return run(process.execPath, [composer, '--context', context, '--tree', state, ...input, ...flags], {
        env,
        timeout: 15000,
        windowsHide: true
      });
    }
  };
}

test('AC7 final assembly exports ordered packs and question assignments with an empty PATH', async t => {
  const s = handoffFixture(t);
  await s.assemble('--preview');
  assert.equal(existsSync(s.manifest), false);
  const { stdout } = await s.assemble();
  assert.equal(JSON.parse(stdout).manifest_file, s.manifest);
  assert.ok(existsSync(s.file));
  const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
  const empty = { scope_files: [], tags: [] };
  assert.deepEqual(manifest, {
    project: s.frozen.topic,
    upstream_source: `grow-me session ${s.frozen.session_id} / revision ${s.frozen.revision}`,
    packs: [
      { id: 'W2', title: '报名后发送一条通知。', goal: '报名后发送一条通知。', depends_on: ['W1'], acceptance_criteria: ['AC2 · 确认 A & B。 只发送一次。'], open_questions: ['邮件 & 短信用哪种？', '谁维护通知模板？'], external_effects: ['写线上数据库：执行 add_xxx', '对外发通知'], ...empty },
      { id: 'W1', title: '记录报名', goal: '保存报名回执。', depends_on: [], acceptance_criteria: ['AC1 · 报名成功后收到 回执。'], open_questions: ['几点开始通知？', '谁确认交付日期？'], external_effects: [], ...empty },
      { id: 'W3', title: '整理操作说明', goal: '整理操作说明', depends_on: [], acceptance_criteria: [], open_questions: [], external_effects: [], ...empty },
      { id: 'W4', title: '核对上线窗口', goal: '核对上线窗口', depends_on: [], acceptance_criteria: [], open_questions: [], external_effects: ['暂无', '没有'], ...empty },
      { id: 'W5', title: '整理回执模板', goal: '整理回执模板', depends_on: [], acceptance_criteria: [], open_questions: [], external_effects: [], ...empty }
    ]
  });
  const finalHtml = readFileSync(s.file);
  await s.assemble('--existing');
  assert.deepEqual(readFileSync(s.file), finalHtml);
  assert.deepEqual(JSON.parse(readFileSync(s.manifest, 'utf8')), manifest);
});

test('task commands name their own scripts in help and errors', () => {
  for (const name of ['validate-task.mjs', 'read-task.mjs']) {
    const script = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true });
    assert.equal(help.status, 0);
    assert.ok(help.stdout.startsWith(`usage: ${name} `), help.stdout);
    const missing = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(missing.status, 0);
    assert.ok(missing.stderr.includes(`${name}: error:`), missing.stderr);
    assert.doesNotMatch(help.stdout + missing.stderr, /\.py\b/);
  }
});

test('AC7 invalid question references and acceptance status prevent final publication', async t => {
  const s = handoffFixture(t);
  for (const [question, error] of [['Q-missing', /missing reference Q-missing/], ['AC2', /wrong reference type AC2/]]) {
    s.put('plan', 'plan', s.plan.replace('deferred-b Q1', question));
    await assert.rejects(s.assemble(), { stderr: error });
  }
  s.put('plan', 'plan', s.plan);
  s.put('acceptance', 'acceptance', s.acceptance.replace('unverified', 'invalid'));
  await assert.rejects(s.assemble(), { stderr: /AC1: missing\/invalid criterion status/ });
  assert.deepEqual(readdirSync(dirname(s.file)), []);

  s.put('acceptance', 'acceptance', s.acceptance);
  await s.assemble();
  const finalHtml = readFileSync(s.file), manifest = readFileSync(s.manifest);
  s.put('plan', 'plan', s.plan.replace('deferred-b Q1', 'Q-missing'));
  await assert.rejects(s.assemble(), { stderr: /missing reference Q-missing/ });
  assert.deepEqual(readFileSync(s.file), finalHtml);
  assert.deepEqual(readFileSync(s.manifest), manifest);
  assert.deepEqual(readdirSync(dirname(s.file)).sort(), [basename(s.file), basename(s.manifest)].sort());
});

test('localized status, question labels and criterion rows preserve the manifest', async t => {
  const s = handoffFixture(t);
  const requirement = '<article id="R1" data-kind="requirement"><h3>报名回执</h3></article>';
  const work = 'id="W1" data-kind="work" data-requirements="R1" data-criteria="AC1" data-questions="deferred-b Q1"';
  const goal = '<p data-field="goal">保存报名回执。</p>';
  const effects = '<ul data-field="effects"><li>写线上数据库：保存报名回执</li></ul>';
  const criterion = 'id="AC1" data-kind="criterion" data-requirements="R1"';
  const scope = '报名人收到回执', action = '提交有效报名。', result = '能找到报名回执。';
  s.put('design', 'design', requirement + '<p id="Q1" data-kind="question">谁维护模板？</p>');
  s.put('plan', 'plan', `<article ${work}><h3>记录报名</h3>${goal}${effects}<span data-field="status">planned</span></article>`);
  s.put('acceptance', 'acceptance', `<article ${criterion}><h3>${scope}</h3><p>${action}</p><p>${result}</p><span data-field="status">unverified</span></article>`);
  await s.assemble();
  const manifest = readFileSync(s.manifest);

  s.put('design', 'design', requirement, {
    position: '方案定好了，开发还没开始。',
    next: '先保存报名回执。',
    open_questions: [{ id: 'Q1', text: '谁维护模板？', origin: 'user' }]
  });
  s.put('plan', 'plan', `<article ${work} class="work-item" data-number="1">
    <div class="work-heading"><h3>记录报名</h3><span data-field="status" data-status="planned">还没开始</span></div>
    ${goal}<p class="work-meta">做完能看到报名回执。</p>${effects}
    <details class="work-details"><summary>关联需求和验收</summary><a href="#AC1">${scope}</a></details>
    </article>`);
  const row = `<tr ${criterion}><th scope="row">${scope}</th><td>${action}</td><td>${result}</td>
    <td><span data-field="status" data-status="unverified"><strong>还没验</strong></span></td></tr>`;
  s.put('acceptance', 'acceptance', row);
  await s.assemble();
  assert.deepEqual(readFileSync(s.manifest), manifest);
  const page = readFileSync(s.file, 'utf8');
  assert.match(page, /现在到哪了<\/span><p>方案定好了，开发还没开始。/);
  assert.match(page, /下一步<\/span><p>先保存报名回执。/);
  assert.match(page, /还没定的（3 件）/);
  assert.match(page, /data-question-origin="user"><span [^>]*>你提的<\/span> 谁维护模板？/);
  assert.match(page, /<tbody><tr id="AC1"/);
  assert.match(page, /<details id="record-info" class="record-info">/);
  assert.match(page, /<code>AC1<\/code> <a href="#AC1">报名人收到回执<\/a>/);
  assert.equal(readTaskText(page, { section: 'AC1' }), `${scope} | ${action} | ${result}\nunverified`);
  const invalidStatus = page.replace('data-status="unverified"><strong>还没验</strong>', 'data-status="">unverified');
  assert.deepEqual(validateTask(invalidStatus).errors, ['AC1: missing/invalid criterion status']);
});

// Expected bytes were captured from the original CLIs, with LF in the fixtures.
const taskFormatFixtures = fileURLToPath(new URL('./fixtures/task-format/', import.meta.url));
for (const name of readdirSync(taskFormatFixtures).sort()) {
  test(`task format matches the original output for ${name}`, () => {
    const directory = join(taskFormatFixtures, name);
    const page = join(directory, 'task.html');
    const html = readFileSync(page, 'utf8');
    const { section, questions, codes } = JSON.parse(readFileSync(join(directory, 'input.json')));
    for (const [file, script, args, call, input] of [
      ['validate.json', 'validate-task', [], () => JSON.stringify(validateTask(html), null, 2)],
      [
        'handoff.json',
        'validate-task',
        ['--handoff'],
        () =>
          JSON.stringify(validateTask(html, { handoff: true, expectedQuestions: questions }), null, 2),
        JSON.stringify(questions)
      ],
      ['read.txt', 'read-task', [], () => readTaskText(html)],
      ['section.txt', 'read-task', ['--section', section], () => readTaskText(html, { section })]
    ]) {
      const expected = readFileSync(join(directory, file), 'utf8').replaceAll('\r\n', '\n');
      const code = codes[file];
      if (code === 2) assert.throws(call, { message: expected.slice(0, -1) });
      else assert.equal(call() + '\n', expected, file);
      const cli = fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url));
      const actual = spawnSync(process.execPath, [cli, page, ...args], { input, windowsHide: true });
      assert.ifError(actual.error);
      assert.equal(actual.status, code, file);
      const bytes = Buffer.from(expected.replaceAll('\n', EOL));
      assert.deepEqual(actual.stdout, code === 2 ? Buffer.alloc(0) : bytes, file);
      assert.deepEqual(actual.stderr, code === 2 ? bytes : Buffer.alloc(0), file);
    }
  });
}
