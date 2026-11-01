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

test('service loss recovers from the same tree through a detached short command; no new interview or answers',async t=>{
  const s=await service(t);await s.post('/submit',{round:1,expected_revision:0,answers:[{id:'delivery',answer:{option_ids:['none'],text:'保留原来的确认'}}]});
  const before=readFileSync(s.file),old=await s.state();s.child.kill();await once(s.child,'exit');
  const{stdout}=await run(process.execPath,[checker,'--url',s.url,'--session',old.session_id,'--restart','--state',s.file,'--document',s.document],{timeout:10000,windowsHide:true});
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
  assert.equal((await s.post('/document/control',{action:'close',expected_revision:0})).status,200);await exit;assert.deepEqual(readFileSync(s.file),bytes);
});
