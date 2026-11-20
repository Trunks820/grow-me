import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateTree,publishRound} from '../scripts/model.mjs';
import {checkOnce} from '../scripts/check.mjs';
import {fingerprint} from '../scripts/document.mjs';
import {renderChapter} from '../scripts/render-chapter.mjs';
import {composeDocument} from '../scripts/compose-document.mjs';
import {chapters} from '../assets/topics.mjs';
import {recommendationDigest} from '../scripts/recommendations.mjs';

const run=promisify(execFile),server=fileURLToPath(new URL('../scripts/server.mjs',import.meta.url)),checker=fileURLToPath(new URL('../scripts/check.mjs',import.meta.url));
const options=[{id:'a',label:'邮件通知'},{id:'b',label:'站内通知'},{id:'none',label:'都不需要',exclusive:true}];
const node=(id='delivery',extra={})=>({id,question:'需要哪些通知方式？',rationale:'决定首版需要开发和验收哪些通知渠道。',input:'multi_choice',options:structuredClone(options),answer:null,depends_on:[],status:'pending',round:1,...extra});
const tree=(nodes=[node()])=>({schema_version:2,session_id:'v2-regression',topic:'通知范围',revision:0,current_round:1,status:'active',nodes});
async function service(t,seed=tree()){
  const root=mkdtempSync(join(tmpdir(),'grow-v2-')),file=join(root,'tree.json'),document=join(root,'task.html');writeFileSync(file,JSON.stringify(seed)+'\n');
  const children=[],detached=[];
  async function start(){const child=spawn(process.execPath,[server,'--state',file,'--document',document]);children.push(child);let errors='';child.stderr.on('data',d=>errors+=d);return{child,...await Promise.race([once(child.stdout,'data').then(([d])=>JSON.parse(String(d))),once(child,'exit').then(()=>{throw Error(errors);})])};}
  const started=await start();
  t.after(async()=>{
    for(const pid of detached){try{process.kill(pid);}catch{}for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}}
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
    // Windows can retain the killed process's cwd handle briefly after process.kill(0) stops seeing it.
    for(let i=0;i<50;i++){try{rmSync(root,{recursive:true,force:true});break;}catch(error){if(i===49||!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;await new Promise(r=>setTimeout(r,30));}}
  });
  return{...started,root,file,document,start,track:pid=>detached.push(pid),async state(){return(await fetch(this.url+'/state')).json();},async post(path,data){return fetch(this.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_session_id:seed.session_id,...data})});}};
}

function legacyV2() {
  return JSON.parse(readFileSync(new URL('fixtures/legacy-v2.tree.json', import.meta.url), 'utf8'));
}

test('v2 validates optional mascot replies without changing the answer source digest', () => {
  const seed = tree([
    node('single', { input: 'single_choice', options: [{ id: 'a', label: '邮件通知' }],
      answer: { option_ids: ['a'], text: '' }, status: 'answered' }),
    node('multi', { answer: { option_ids: ['a', 'b'], text: '' }, status: 'answered' }),
    node('text', { input: 'text', options: [], answer: { option_ids: [], text: '七天' }, status: 'answered' })
  ]);
  validateTree(seed);
  const sources = seed.nodes.map(node => node.id), digest = recommendationDigest(seed, sources);
  seed.nodes[0].options[0].reply = '好';
  seed.nodes[1].options[0].reply = '收到';
  seed.nodes[1].reply = '这几项都记下啦。';
  seed.nodes[2].reply = '🌱'.repeat(40);
  validateTree(seed);
  assert.equal(recommendationDigest(seed, sources), digest);

  for (const target of [seed.nodes[0].options[0], seed.nodes[1], seed.nodes[2]]) {
    const original = target.reply;
    for (const invalid of ['', '  ', '🌱'.repeat(41), 42, null]) {
      target.reply = invalid;
      assert.throws(() => validateTree(seed), /reply must be a nonblank string of 1–40 characters/);
    }
    target.reply = original;
  }
  seed.nodes[0].reply = '这句应写在选项里。';
  assert.throws(() => validateTree(seed), /single_choice uses option replies/);
});

async function generateTask(s, revision) {
  const control = body => s.post('/document/control', body);
  assert.equal((await control({ action: 'offer', expected_revision: revision })).status, 200);
  const saved = await control({ action: 'save', expected_revision: revision });
  assert.equal(saved.status, 200);
  const requested = await saved.json();
  const job = { expected_revision: revision + 1, job_id: requested.job_id };
  const claimed = await control({ action: 'claim', ...job });
  assert.equal(claimed.status, 200);
  const status = await claimed.json(),
    frozen = JSON.parse(readFileSync(s.file, 'utf8'));
  assert.equal(frozen.status, 'complete');
  assert.equal(frozen.revision, revision + 1);
  const chapter = renderChapter(status, frozen, 'signup', '<p>统一报名入口的方案说明。</p>');
  const source = chapter.source;
  const parts = [
    chapter,
    { source, view: 'design', html: '<article id="R1" data-kind="requirement">统一报名入口</article>' },
    { source, view: 'plan', html: '<article id="W1" data-kind="work" data-requirements="R1" data-criteria="AC1"><span data-field="status">planned</span>提供报名入口</article>' },
    { source, view: 'acceptance', html: '<article id="AC1" data-kind="criterion" data-requirements="R1"><span data-field="status">unverified</span>可以从统一入口报名</article>' }
  ];
  writeFileSync(s.document, composeDocument(status, parts).html, 'utf8');
  assert.equal((await control({ action: 'ready', ...job })).status, 200);
  const output = await fetch(s.url + '/document');
  assert.equal(output.status, 200);
  return { frozen, chapter, html: await output.text() };
}

test('AC3 a deferred round submits and renders unresolved questions in all three document views', async t => {
  const seed = legacyV2(),
    note = '  还要核对 <发送时间>\n保留原话  ',
    deferred = { option_ids: [], text: '', deferred: true };
  seed.nodes.push(
    node('timing', { question: '哪天开放报名？', input: 'text', options: [], depends_on: ['signup'], round: 2 }),
    node('delivery', { depends_on: ['signup'], round: 2 })
  );
  const s = await service(t, seed),
    submit = answers => s.post('/submit', { round: 2, expected_revision: seed.revision, answers }),
    answers = [
      { id: 'confirmation', answer: deferred },
      { id: 'timing', answer: { ...deferred, text: note } },
      { id: 'delivery', answer: { ...deferred, option_ids: ['a'] } }
    ];
  const before = readFileSync(s.file);
  for (const answer of [{ ...deferred, deferred: 'true' }, { ...deferred, deferred: false }]) {
    assert.equal((await submit([{ id: 'confirmation', answer }, ...answers.slice(1)])).status, 400);
    assert.deepEqual(readFileSync(s.file), before);
  }
  assert.equal((await submit(answers)).status, 200);
  const round = await (await fetch(s.url + '/wait?round=2')).json();
  assert.equal(round.status, 'answered');
  assert.deepEqual(round.answers.map(({ id, answer }) => ({ id, answer })), answers);

  const { frozen, chapter, html } = await generateTask(s, seed.revision + 1);
  assert.equal(frozen.schema_version, 2);
  const [confirmedBody, deferredBody] = chapter.html.split('<section class="deferred-answers">');
  assert.match(confirmedBody, /data-source-node="signup"/);
  assert.doesNotMatch(confirmedBody, /data-source-node="(?:confirmation|timing|delivery)"/);
  assert.match(deferredBody, /^<h3>待确认<\/h3>/);
  assert.match(deferredBody, /暂选<\/p><ul><li>邮件通知<\/li>/);
  assert.match(deferredBody, /  还要核对 &lt;发送时间&gt;\n保留原话  /);
  const [, ...views] = html.split(/<section id="(?:design|plan|acceptance)-view"/);
  assert.equal(views.length, 3);
  for (const view of views) {
    const list = view.match(/<section class="deferred-questions">[\s\S]*?<\/section>/)?.[0];
    assert.match(list, /class="deferred-questions"><h3>待确认<\/h3>/);
    for (const n of seed.nodes.slice(1)) assert.ok(list.includes(`>${n.question}</a>`), n.question);
  }
});

test('AC6 a half-answered v0.2 v2 tree resumes, saves and generates a validated document', async t => {
  const seed = legacyV2(), s = await service(t, seed);
  assert.deepEqual(await s.state(), seed);
  const answer = { option_ids: ['page'], text: '页面要显示活动日期。' };
  assert.equal((await s.post('/submit', {
    round: seed.current_round,
    expected_revision: seed.revision,
    answers: [{ id: 'confirmation', answer }]
  })).status, 200);
  const { frozen, html } = await generateTask(s, seed.revision + 1);
  assert.deepEqual(frozen.nodes, [seed.nodes[0], { ...seed.nodes[1], answer, status: 'answered' }]);
  assert.equal(frozen.session_id, seed.session_id);
  assert.equal(frozen.schema_version, seed.schema_version);
  assert.match(html, /  统一报名入口\n方便读者找到报名页  /);
  assert.match(html, /在页面显示成功/);
  assert.match(html, /页面要显示活动日期。/);
  assert.doesNotMatch(html, /class="deferred-questions"/);
});

test('v2 multi-choice preserves several selections and exact notes; invalid/exclusive combinations never write',async t=>{
  const s=await service(t),bytes=readFileSync(s.file),text='  原文\n都不需要不是未回答：<>&" 🌱  ';
  for(const ids of [[],['a','a'],['missing'],['none','a'],['none','b','a']]){
    const response=await s.post('/submit',{round:1,expected_revision:0,answers:[{id:'delivery',answer:{option_ids:ids,text}}]});assert.equal(response.status,400);assert.deepEqual(readFileSync(s.file),bytes);
  }
  assert.equal((await s.post('/submit',{round:1,expected_revision:0,answers:[{id:'delivery',answer:{option_ids:['a','b'],text}}]})).status,200);
  const current=await s.state();assert.deepEqual(current.nodes[0].answer,{option_ids:['a','b'],text});
  const context=await(await fetch(s.url+'/context')).json();assert.deepEqual(context.recent_answers[0].selected_options.map(o=>o.label),['邮件通知','站内通知']);assert.equal(context.recent_answers[0].answer.text,text);
  assert.equal((await s.post('/decision',{id:'delivery',expected_revision:1,answer:{option_ids:['none'],text:'明确都不要'}})).status,200);
  assert.deepEqual((await s.state()).nodes[0].answer.option_ids,['none']);
});

test('initial and follow-up rationale must be nonblank; single choice and text limits remain specific',()=>{
  for(const rationale of [undefined,null,'',' \n '])assert.throws(()=>validateTree(tree([node('delivery',{rationale})])),/rationale/);
  const source=node('source',{input:'text',options:[],answer:{option_ids:[],text:'已提交原文'},status:'answered'}),base=tree([source]),before=JSON.stringify(base);
  assert.throws(()=>publishRound(base,{expected_revision:0,round:2,nodes:[node('follow',{round:2,rationale:'',depends_on:['source']})]}),/rationale/);assert.equal(JSON.stringify(base),before);
  assert.throws(()=>validateTree(tree([node('single',{input:'single_choice',options:options.slice(0,2),status:'answered',answer:{option_ids:['a','b'],text:''}})])),/exactly one/);
  assert.throws(()=>validateTree(tree([node('text',{input:'text',options:[],status:'answered',answer:{option_ids:['a'],text:'原文'}})])),/text answer/);
});

test('missing follow-up rationale is rejected by the HTTP publish path without changing the file',async t=>{
  const s=await service(t,tree([node('delivery',{status:'answered',answer:{option_ids:['a'],text:''}})])),before=readFileSync(s.file);
  const response=await s.post('/round',{expected_revision:0,round:2,nodes:[node('follow',{round:2,rationale:' ',depends_on:['delivery']})]});
  assert.equal(response.status,400);assert.deepEqual(readFileSync(s.file),before);
});

test('round publication identifies each invalid field on the new question', async t => {
  const source = node('delivery', { status: 'answered', answer: { option_ids: ['a'], text: '' } });
  const s = await service(t, tree([source]));
  const before = readFileSync(s.file);
  const follow = node('follow', { round: 2, depends_on: ['delivery'] });
  for (const [overrides, error] of [
    [{ round: 1 }, /new question follow: round must be 2/],
    [{ status: 'answered' }, /new question follow: status must be "pending"/],
    [{ answer: undefined }, /new question follow: missing answer field\. Write "answer": null/],
    [{ answer: {} }, /new question follow: answer must be null/],
    [{ recommendation: {} }, /new question follow: recommendation\.source_ids must be an array/]
  ]) {
    const response = await s.post('/round', {
      expected_revision: 0,
      round: 2,
      nodes: [{ ...follow, ...overrides }]
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, error);
    assert.deepEqual(readFileSync(s.file), before);
  }
  const accepted = await s.post('/round', { expected_revision: 0, round: 2, nodes: [follow] });
  assert.equal(accepted.status, 200);
});

test('optional chapter_id validates dependency roots and survives HTTP publication without altering answers',async t=>{
 const roots=['a','b'].map(id=>node(id,{input:'text',options:[],status:'answered',answer:{option_ids:[],text:id+' 原答案'},chapter_id:id})),s=await service(t,tree(roots)),before=readFileSync(s.file);
 for(const chapter_id of [null,'',' ','missing','follow','b']){
  const response=await s.post('/round',{expected_revision:0,round:2,nodes:[node('follow',{round:2,depends_on:['a'],chapter_id})]});assert.equal(response.status,400);assert.deepEqual(readFileSync(s.file),before);
 }
 assert.throws(()=>validateTree(tree([node('a',{chapter_id:'b'}),node('b',{chapter_id:'b'})])),/chapter_id/,'a root must identify itself');
 const legacy=tree([node('a',{input:'text',options:[],chapter_id:'a'})]);legacy.schema_version=1;delete legacy.nodes[0].rationale;assert.throws(()=>validateTree(legacy),/unknown node field/,'v1 has no new field');
 assert.equal((await s.post('/round',{expected_revision:0,round:2,nodes:[node('follow',{round:2,depends_on:['a','b'],chapter_id:'a'})]})).status,200);
 const current=await s.state();assert.equal(current.nodes[2].chapter_id,'a');assert.equal(current.nodes[2].answer,null);assert.deepEqual(current.nodes.slice(0,2),roots);
 const context=await(await fetch(s.url+'/context')).json();assert.equal(context.decision_index[2].chapter_id,'a');
 const doc=await(await fetch(s.url+'/document/status')).json();assert.deepEqual(doc.source.chapters.map(c=>c.node_ids),[['a','follow'],['b']]);
 const beforeConflict=readFileSync(s.file);assert.equal((await s.post('/round',{expected_revision:0,round:3,nodes:[node('late',{round:3,depends_on:['a'],chapter_id:'a'})]})).status,409);assert.deepEqual(readFileSync(s.file),beforeConflict);
});

test('recommendation is source-bound by the service, never an answer, and expires after source changes or review',async t=>{
  const source=node('source',{input:'text',options:[],answer:{option_ids:[],text:'只能站内用，不发邮件。'},status:'answered'}),s=await service(t,tree([source]));
  const follow=node('follow',{round:2,depends_on:['source'],recommendation:{option_ids:['b'],reason:'根据已提交的站内使用边界建议站内通知。',source_ids:['source'],source_digest:'0'.repeat(64)}});
  assert.equal((await s.post('/round',{expected_revision:0,round:2,nodes:[follow]})).status,200);
  let current=await s.state();assert.equal(current.nodes[1].recommendation.source_digest,recommendationDigest(current,['source']));assert.equal(current.nodes[1].answer,null);
  let guidance=await(await fetch(s.url+'/guidance')).json();assert.equal(guidance.recommendations.follow.stale,false);assert.equal(guidance.recommendations.follow.sources[0].round,1);
  await s.post('/submit',{round:2,expected_revision:1,answers:[{id:'follow',answer:{option_ids:['a'],text:'用户实际选邮件'}}]});
  const context=await(await fetch(s.url+'/context')).json();assert.deepEqual(context.recent_answers[0].selected_options.map(o=>o.id),['a']);assert.equal(context.recent_answers[0].recommendation.not_confirmed_by_user,true);
  await s.post('/reopen',{id:'source',expected_revision:2});guidance=await(await fetch(s.url+'/guidance')).json();assert.equal(guidance.recommendations.follow.stale,true);assert.deepEqual(guidance.recommendations.follow.option_ids,[]);
  await s.post('/decision',{id:'source',expected_revision:3,answer:{option_ids:[],text:'现在改成可以发邮件。'}});guidance=await(await fetch(s.url+'/guidance')).json();assert.equal(guidance.recommendations.follow.stale,true);assert.deepEqual((await s.state()).nodes[1].answer.option_ids,['a']);
});

test('invalid recommendation reason, options, source identity or future source cannot publish',()=>{
  const source=node('source',{input:'text',options:[],answer:{option_ids:[],text:'已答'},status:'answered'}),base=tree([source]);
  for(const recommendation of [
    {option_ids:['a'],reason:' ',source_ids:[]},{option_ids:['missing'],reason:'理由',source_ids:[]},
    {option_ids:['a'],reason:'理由',source_ids:['missing']},{option_ids:['a'],reason:'理由',source_ids:['follow']},
    {option_ids:['a','none'],reason:'理由',source_ids:[]}
  ])assert.throws(()=>publishRound(base,{expected_revision:0,round:2,nodes:[node('follow',{round:2,recommendation})]}));
});

test('wrong session and stale revision fail before writing; short check never prints answers',async t=>{
  const s=await service(t),before=readFileSync(s.file);
  assert.equal((await s.post('/submit',{expected_session_id:'other',expected_revision:0,round:1,answers:[]})).status,409);assert.deepEqual(readFileSync(s.file),before);
  await assert.rejects(checkOnce({url:s.url,sessionId:'other'}),/另一个访谈/);
  const check=await checkOnce({url:s.url,sessionId:'v2-regression'});assert.equal(check.status,'waiting_for_user');
  const next=await checkOnce({url:s.url,sessionId:check.session_id,afterRevision:check.revision,afterSequence:check.document.sequence,afterInstance:check.instance_id});assert.equal(next.changed,false);assert.ok(JSON.stringify(next).length<1300);assert.equal(JSON.stringify(next).includes('需要哪些通知'),false);
  await s.post('/submit',{expected_revision:0,round:1,answers:[{id:'delivery',answer:{option_ids:['none'],text:'PRIVATE_RAW_ANSWER'}}]});
  const found=await checkOnce({url:s.url,sessionId:check.session_id,afterRevision:check.revision,afterSequence:check.document.sequence,afterInstance:check.instance_id});assert.equal(found.changed,true);assert.equal(found.status,'ready_for_ai');assert.ok(found.timing.discovery_delay_ms>=0&&found.timing.discovery_delay_ms<3000);assert.equal(JSON.stringify(found).includes('PRIVATE_RAW_ANSWER'),false);
});

test('one-shot request has a bounded timeout and rejects nonlocal origins',async t=>{
  await assert.rejects(checkOnce({url:'https://example.com',sessionId:'id'}),/exact http/);
  const hung=createServer(()=>{});await new Promise(resolve=>hung.listen(0,'127.0.0.1',resolve));t.after(()=>{hung.closeAllConnections();hung.close();});
  const start=performance.now();await assert.rejects(checkOnce({url:'http://127.0.0.1:'+hung.address().port,sessionId:'id',timeoutMs:80}),/不可达/);assert.ok(performance.now()-start<700,'a nonresponsive server cannot leave a long command hanging');
});

test('only valid AI queries update the check clock, which resets on restart', async t => {
 const s=await service(t),bytes=readFileSync(s.file),progress=async url=>(await(await fetch(url+'/progress')).json()).ai;
 for(const path of ['/state','/progress','/recovery','/document/status'])assert.equal((await fetch(s.url+path)).status,200);
 assert.equal((await progress(s.url)).last_check_at,null);
 await assert.rejects(checkOnce({url:s.url,sessionId:'wrong'}),/另一个访谈/);
 for(const override of [{expected_session_id:'wrong'},{expected_revision:99},{expected_instance_id:'old'}]){
  assert.equal((await s.post('/ai/check',{expected_revision:0,expected_instance_id:s.instance_id,...override})).status,409);assert.equal((await progress(s.url)).last_check_at,null);
 }
 const foreign=await fetch(s.url+'/ai/check',{method:'POST',headers:{'content-type':'application/json',origin:'https://foreign.invalid'},body:JSON.stringify({expected_session_id:'v2-regression',expected_revision:0,expected_instance_id:s.instance_id})});assert.equal(foreign.status,403);assert.equal((await progress(s.url)).last_check_at,null);
 await checkOnce({url:s.url,sessionId:'v2-regression'});const first=await progress(s.url);assert.ok(first.last_check_at>0);assert.ok(first.seconds_since_last_check>=0);assert.equal(first.timeout_ms,30000);
 await new Promise(resolve=>setTimeout(resolve,10));for(const path of ['/state','/progress','/document/status'])await fetch(s.url+path);assert.equal((await progress(s.url)).last_check_at,first.last_check_at);
 await checkOnce({url:s.url,sessionId:'v2-regression'});assert.ok((await progress(s.url)).last_check_at>first.last_check_at);assert.deepEqual(readFileSync(s.file),bytes);
 s.child.kill();await once(s.child,'exit');const restored=await s.start();assert.equal((await progress(restored.url)).last_check_at,null);assert.equal((await progress(restored.url)).seconds_since_last_check,null);assert.deepEqual(readFileSync(s.file),bytes);
 assert.equal((await fetch(restored.url+'/ai/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_session_id:'v2-regression',expected_revision:0,expected_instance_id:s.instance_id})})).status,409);
 await checkOnce({url:restored.url,sessionId:'v2-regression'});assert.ok((await progress(restored.url)).last_check_at>0);assert.deepEqual(readFileSync(s.file),bytes);
});

test('service loss recovers from the same tree through a detached short command; no new interview or answers',async t=>{
  const s=await service(t);await s.post('/submit',{round:1,expected_revision:0,answers:[{id:'delivery',answer:{option_ids:['none'],text:'保留原来的确认'}}]});
  const before=readFileSync(s.file),old=await s.state();s.child.kill();await once(s.child,'exit');
  const { stdout } = await run(
    process.execPath,
    [
      checker,
      '--url',
      s.url,
      '--session',
      old.session_id,
      '--restart',
      '--state',
      s.file,
      '--document',
      s.document
    ],
    { timeout: process.platform === 'win32' ? 30000 : 10000, windowsHide: true }
  );
  const restored=JSON.parse(stdout);s.track(restored.service.pid);
  assert.equal(restored.restarted,true);assert.equal(restored.session_id,old.session_id);assert.equal(restored.revision,old.revision);assert.notEqual(restored.instance_id,s.instance_id);assert.deepEqual(readFileSync(s.file),before);
  assert.deepEqual(await(await fetch(restored.url+'/state')).json(),old);assert.equal(restored.timing.submission_at,null,'restart does not invent submission timestamps');
});

test('v1 remains byte-identical and read-only, including source-bound existing HTML',async t=>{
  const legacy=tree([node('old',{input:'text',options:[],status:'answered',answer:{option_ids:[],text:'旧版原文'}})]);legacy.schema_version=1;legacy.status='complete';delete legacy.nodes[0].rationale;
  const s=await service(t,legacy),before=readFileSync(s.file),anchor=chapters(legacy)[0].anchor;
  writeFileSync(s.document,`<main data-task-record data-source-session="${legacy.session_id}" data-source-revision="0" data-source-digest="${fingerprint(legacy)}"><section id="design-view"><article id="${anchor}">旧章节</article><p id="R1" data-kind="requirement">旧需求</p></section><section id="plan-view"><p id="W1" data-kind="work">旧任务</p></section><section id="acceptance-view"><p id="AC1" data-kind="criterion">旧验收</p></section></main>`);
  s.child.kill();await once(s.child,'exit');const restored=await s.start();
  for(const route of ['/submit','/decision','/reopen','/round','/finish','/document/control']){
    const response=await fetch(restored.url+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:0,action:'retry'})});assert.equal(response.status,409);assert.deepEqual(readFileSync(s.file),before);
  }
  assert.equal((await fetch(restored.url+'/document')).status,200);assert.equal((await(await fetch(restored.url+'/recovery')).json()).read_only,true);assert.equal((await checkOnce({url:restored.url,sessionId:legacy.session_id})).status,'legacy_read_only');assert.deepEqual(readFileSync(s.file),before);
});

test('an active v1 history preview can close without finishing or modifying the old interview',async t=>{
  const legacy=tree([node('old',{input:'text',options:[]})]);legacy.schema_version=1;delete legacy.nodes[0].rationale;
  const s=await service(t,legacy),bytes=readFileSync(s.file),exit=once(s.child,'exit');
  const { ai } = await (await fetch(s.url + '/progress')).json();
  assert.equal(ai.work_active, false);
  assert.equal(ai.work_until, null);
  assert.equal((await s.post('/document/control',{action:'close',expected_revision:0})).status,200);await exit;assert.deepEqual(readFileSync(s.file),bytes);
});
