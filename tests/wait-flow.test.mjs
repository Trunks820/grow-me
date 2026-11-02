import {test} from 'node:test';import assert from 'node:assert/strict';
import {AI_CHECK_TIMEOUT_MS} from '../scripts/progress.mjs';import {assistantConnection} from '../assets/presentation.mjs';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DocumentBridge,validateDocument} from '../scripts/document.mjs';import {composeDocument} from '../scripts/compose-document.mjs';import {InterviewProgress} from '../scripts/progress.mjs';import {interviewContext} from '../scripts/context.mjs';import {publicError} from '../assets/presentation.mjs';import {publishRound,reopenDecision,editDecision} from '../scripts/model.mjs';
const node=(id,deps=[],round=1)=>({id,question:id+' 的问题',rationale:'受控测试：验证章节与等待边界。',input:'text',options:[],answer:{option_ids:[],text:'原文\n <>& event: message data: {}'},depends_on:deps,status:'answered',round});
const seed=()=>({schema_version:2,session_id:'wait-flow-fixture',topic:'等待与章节',revision:0,current_round:2,status:'active',nodes:[node('a'),node('b'),node('c',['a'],2)]});
function setup(t,initial=seed()){const root=mkdtempSync(join(tmpdir(),'grow-wait-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let tree=initial;const bridge=new DocumentBridge({getTree:()=>tree,save:next=>{tree=next;bridge.onMutation();},file:join(root,'task.html'),stop:()=>{}});const control=body=>bridge.control({expected_revision:tree.revision,job_id:bridge.jobId,...body});control({action:'offer'});control({action:'save'});control({action:'claim'});return{bridge,control,tree:()=>tree,root};}
const part=(status,view,html,extra={})=>({source:{session_id:status.source.session_id,revision:status.source.revision,digest:status.source.digest,job_id:status.job_id},view,html,...extra});

test('operational protocol output is suppressed without changing interview answers',()=>{
 for(const raw of ['event: message','data: {"text":"stream"}','{"error":"raw"}','x'.repeat(1000),'Error\nat fn (...)','<html>upstream</html>'])assert.equal(publicError(raw,'safe'),'safe');
 assert.equal(publicError('文档暂时生成失败，请重试。'),'文档暂时生成失败，请重试。');const tree=seed(),bytes=JSON.stringify(tree);interviewContext(tree);assert.equal(JSON.stringify(tree),bytes);
});

test('AI check age is memory-only, distinguishes never connected, and honors threshold and page-open grace',t=>{
 const tree=seed(),before=JSON.stringify(tree);let now=100000;t.mock.method(Date,'now',()=>now);const progress=new InterviewProgress(()=>tree);
 assert.equal(AI_CHECK_TIMEOUT_MS,30000);now+=120000;assert.deepEqual(progress.status().ai,{last_check_at:null,last_activity_at:null,source:null,seconds_since_last_check:null,timeout_ms:30000});assert.equal(assistantConnection(progress.status().ai,120000),'connecting');
 const checked=progress.checkIn().ai.last_check_at;now+=AI_CHECK_TIMEOUT_MS;assert.equal(progress.status().ai.last_check_at,checked);assert.equal(progress.status().ai.seconds_since_last_check,30);assert.equal(assistantConnection(progress.status().ai,120000),'connected');
 now++;assert.equal(assistantConnection(progress.status().ai,120000),'paused');assert.equal(assistantConnection(progress.status().ai,0),'connected','a freshly opened page gets a grace period');
 progress.checkIn();assert.equal(assistantConnection(progress.status().ai,120000),'connected');assert.equal(JSON.stringify(tree),before);
 assert.equal(assistantConnection(new InterviewProgress(()=>tree).status().ai,120000),'connecting','restart loses liveness, not saved answers');
});
test('compact context retains full recent text, all dependency/status ids and flags abridgement',()=>{
 const tree=seed();tree.nodes[0].answer.text='旧'.repeat(1000);const bytes=JSON.stringify(tree),context=interviewContext(tree);assert.equal(context.source.revision,0);assert.deepEqual(context.decision_index.at(-1).depends_on,['a']);assert.equal(context.recent_answers[0].answer.text,tree.nodes[2].answer.text);assert.equal(context.earlier_decisions[0].abridged,true);assert.equal(JSON.stringify(tree),bytes);assert.ok(JSON.stringify(context).length<bytes.length);
});
test('review exit starts a wait, polling and unrelated revisions do not reset it; no empty rounds',()=>{
 let tree=seed();const progress=new InterviewProgress(()=>tree),initial=progress.status().started_at;assert.ok(initial);
 tree=reopenDecision(tree,{id:'a',expected_revision:0});progress.onMutation();assert.equal(progress.status().stage,'review');assert.equal(progress.status().started_at,null);
 tree=editDecision(tree,{id:'a',expected_revision:1,answer:tree.nodes[0].answer});progress.onMutation();assert.equal(progress.status().stage,'review');tree=editDecision(tree,{id:'c',expected_revision:2,answer:tree.nodes[2].answer});progress.onMutation();const since=progress.status().started_at;assert.ok(since);assert.equal(progress.status().started_at,since);
 const bytes=JSON.stringify(tree);assert.throws(()=>publishRound(tree,{expected_revision:3,round:3,nodes:[]}),/round needs nodes/);assert.equal(JSON.stringify(tree),bytes);
});
test('a completed chapter opens before the other views; unfinished, stale and protocol fragments cannot publish',t=>{
 const s=setup(t),status=s.bridge.status(),a=status.source.chapters[0],b=status.source.chapters[1],p=part(status,'chapter','<p>已经写好的主题正文</p>',{chapter_id:a.id,title:'已完成主题'});
 const preview=composeDocument(status,[p],{preview:true});
 const chapterHtml=preview.html.match(new RegExp('<article id="'+a.anchor+'"[\\s\\S]*?<\\/article>'))[0];
 writeFileSync(s.bridge.file+'.preview.html',preview.html.replace(chapterHtml,'').replace('<section id="plan-view"',chapterHtml+'<section id="plan-view"'));assert.throws(()=>s.control({action:'chapter',chapter_id:a.id}),/设计方案/);
 writeFileSync(s.bridge.file+'.preview.html',preview.html);
 assert.throws(()=>s.bridge.read(a.id),/还在生成/);s.control({action:'chapter',chapter_id:a.id});assert.match(s.bridge.read(a.id),/已经写好的主题正文/);assert.equal(s.bridge.status().chapters[0].status,'ready');assert.equal(s.bridge.status().chapters[1].status,'generating');assert.throws(()=>s.bridge.read(b.id),/还在生成/);assert.throws(()=>s.bridge.read(),/尚不可阅读/);
 const snapshot=s.bridge.read(a.id);writeFileSync(s.bridge.file+'.preview.html','event: message\ndata: {}');assert.equal(s.bridge.read(a.id),snapshot,'published snapshots are immutable');assert.throws(()=>s.control({action:'chapter',chapter_id:b.id}),/writer/);
 assert.throws(()=>composeDocument(status,[{...p,source:{...p.source,job_id:'stale'}}],{preview:true}),/过期/);assert.throws(()=>composeDocument(status,[{...p,html:'event: message'}],{preview:true}),/HTML/);assert.throws(()=>composeDocument(status,[p]),/全部章节/);
 s.control({action:'failed',error:'event: message\ndata: {"huge":"'+('x'.repeat(500))+'"}'});assert.equal(s.bridge.status().error,'文档生成遇到问题，请重试。');assert.match(s.bridge.read(a.id),/已经写好/);
 const oldJob=s.bridge.jobId;s.control({action:'retry'});s.control({action:'claim'});assert.throws(()=>s.control({action:'chapter',chapter_id:a.id,job_id:oldJob}),/过期/);assert.throws(()=>s.control({action:'chapter',chapter_id:a.id}),/writer/);assert.equal(s.bridge.status().chapters[0].status,'generating');
 const oldLog=readFileSync(s.bridge.timingFile,'utf8').trim().split('\n').map(JSON.parse);assert.equal(oldLog.length,1,'invalid publications append no success event');assert.equal(oldLog[0].job_id,oldJob);assert.equal(s.bridge.status().chapters[0].first_published_at,null);
 const retried=s.bridge.status();writeFileSync(s.bridge.file+'.preview.html',composeDocument(retried,[part(retried,'chapter','<p>重试后已完成正文</p>',{chapter_id:a.id})],{preview:true}).html);s.control({action:'chapter',chapter_id:a.id});
 const newLog=readFileSync(s.bridge.timingFile,'utf8').trim().split('\n').map(JSON.parse);assert.equal(newLog.length,2);assert.deepEqual(newLog[0],oldLog[0]);assert.equal(newLog[1].job_id,retried.job_id);assert.equal(newLog[1].generation_started_at,retried.started_at);assert.equal(newLog[1].elapsed_ms,newLog[1].first_published_at-retried.started_at);
});

test('legacy and partially annotated v2 data assemble; explicit root membership overrides primary-parent inference',t=>{
 for(const mode of ['legacy','partial','explicit']){
  const input=seed();input.nodes[2].depends_on=['a','b'];if(mode==='explicit'){input.nodes[0].chapter_id='a';input.nodes[1].chapter_id='b';}if(mode!=='legacy')input.nodes[2].chapter_id='a';
  const before=structuredClone(input),s=setup(t,input),status=s.bridge.status(),expected=mode==='legacy'?[['a'],['b','c']]:[['a','c'],['b']];
  assert.deepEqual(status.source.chapters.map(c=>c.node_ids),expected);assert.deepEqual(input,before,'projection and freeze do not backfill the source');
  const context=interviewContext(s.tree());assert.equal(context.decision_index.find(n=>n.id==='c').chapter_id,mode==='legacy'?'b':'a');assert.equal(context.recent_answers[0].chapter_id,mode==='legacy'?'b':'a');
  const parts=status.source.chapters.map(c=>part(status,'chapter','<p>已确认题目：'+c.node_ids.join(',')+'</p>',{chapter_id:c.id}));
  parts.push(part(status,'design','<article id="R1" data-kind="requirement">确认需求</article>'),part(status,'plan','<article id="W1" data-kind="work">开发项</article>'),part(status,'acceptance','<article id="AC1" data-kind="criterion">验收项</article>'));
  const html=composeDocument(status,parts).html;writeFileSync(s.bridge.file,html);validateDocument(s.bridge.file,s.tree(),status.job_id);
  for(let i=0;i<expected.length;i++){const body=html.match(new RegExp('<article id="'+status.source.chapters[i].anchor+'"[\\s\\S]*?<\\/article>'))[0];assert.ok(body.includes('已确认题目：'+expected[i].join(',')));}
 }
});
test('three independently written views and chapter pieces assemble deterministically into one validated HTML',t=>{
 const s=setup(t),status=s.bridge.status(),parts=status.source.chapters.map(c=>part(status,'chapter','<p>该主题的正式方案</p>',{chapter_id:c.id}));
 parts.push(part(status,'design','<article id="R1" data-kind="requirement"><h3>需求定义</h3><p>确认需求</p></article>'),part(status,'plan','<article id="W1" data-kind="work" data-requirements="R1" data-criteria="AC1"><h3>开发项</h3><span data-field="status">planned</span><a href="#R1">需求</a><a href="#AC1">验收</a></article>'),part(status,'acceptance','<article id="AC1" data-kind="criterion" data-requirements="R1"><h3>验收定义</h3><span data-field="status">unverified</span><a href="#R1">需求</a></article>'));
 const content=composeDocument(status,parts).html;assert.equal(composeDocument(status,[...parts].reverse()).html,content);writeFileSync(s.bridge.file,content);validateDocument(s.bridge.file,s.tree(),status.job_id);s.control({action:'ready'});assert.equal(s.bridge.status().phase,'ready');assert.ok(s.bridge.status().chapters.every(c=>c.status==='ready'));assert.match(s.bridge.read(),/data-kind="criterion"/);
 writeFileSync(s.bridge.file,content.replace('data-source-job="'+status.job_id+'"','data-source-job="expired-job"'));assert.throws(()=>s.bridge.read(),/生成任务已过期/,'a late writer cannot silently replace the current ready job');
});
