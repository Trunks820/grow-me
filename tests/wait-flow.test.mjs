import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DocumentBridge,validateDocument} from '../scripts/document.mjs';import {composeDocument} from '../scripts/compose-document.mjs';import {InterviewProgress} from '../scripts/progress.mjs';import {interviewContext} from '../scripts/context.mjs';import {publicError} from '../assets/presentation.mjs';import {publishRound,reopenDecision,editDecision} from '../scripts/model.mjs';
const node=(id,deps=[],round=1)=>({id,question:id+' 的问题',input:'text',options:[],answer:{option_ids:[],text:'原文\n <>& event: message data: {}'},depends_on:deps,status:'answered',round});
const seed=()=>({schema_version:1,session_id:'wait-flow-fixture',topic:'等待与章节',revision:0,current_round:2,status:'active',nodes:[node('a'),node('b'),node('c',['a'],2)]});
function setup(t){const root=mkdtempSync(join(tmpdir(),'grow-wait-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let tree=seed();const bridge=new DocumentBridge({getTree:()=>tree,save:next=>{tree=next;bridge.onMutation();},file:join(root,'task.html'),stop:()=>{}});const control=body=>bridge.control({expected_revision:tree.revision,job_id:bridge.jobId,...body});control({action:'offer'});control({action:'save'});control({action:'claim'});return{bridge,control,tree:()=>tree,root};}
const part=(status,view,html,extra={})=>({source:{session_id:status.source.session_id,revision:status.source.revision,digest:status.source.digest,job_id:status.job_id},view,html,...extra});

test('operational protocol output is suppressed without changing interview answers',()=>{
 for(const raw of ['event: message','data: {"text":"stream"}','{"error":"raw"}','x'.repeat(1000),'Error\nat fn (...)','<html>upstream</html>'])assert.equal(publicError(raw,'safe'),'safe');
 assert.equal(publicError('文档暂时生成失败，请重试。'),'文档暂时生成失败，请重试。');const tree=seed(),bytes=JSON.stringify(tree);interviewContext(tree);assert.equal(JSON.stringify(tree),bytes);
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
});
test('three independently written views and chapter pieces assemble deterministically into one validated HTML',t=>{
 const s=setup(t),status=s.bridge.status(),parts=status.source.chapters.map(c=>part(status,'chapter','<p>该主题的正式方案</p>',{chapter_id:c.id}));
 parts.push(part(status,'design','<article id="R1" data-kind="requirement"><h3>需求定义</h3><p>确认需求</p></article>'),part(status,'plan','<article id="W1" data-kind="work" data-requirements="R1" data-criteria="AC1"><h3>开发项</h3><span data-field="status">planned</span><a href="#R1">需求</a><a href="#AC1">验收</a></article>'),part(status,'acceptance','<article id="AC1" data-kind="criterion" data-requirements="R1"><h3>验收定义</h3><span data-field="status">unverified</span><a href="#R1">需求</a></article>'));
 const content=composeDocument(status,parts).html;assert.equal(composeDocument(status,[...parts].reverse()).html,content);writeFileSync(s.bridge.file,content);validateDocument(s.bridge.file,s.tree(),status.job_id);s.control({action:'ready'});assert.equal(s.bridge.status().phase,'ready');assert.ok(s.bridge.status().chapters.every(c=>c.status==='ready'));assert.match(s.bridge.read(),/data-kind="criterion"/);
 writeFileSync(s.bridge.file,content.replace('data-source-job="'+status.job_id+'"','data-source-job="expired-job"'));assert.throws(()=>s.bridge.read(),/生成任务已过期/,'a late writer cannot silently replace the current ready job');
});
