import{test}from'node:test';import assert from'node:assert/strict';
import{spawn}from'node:child_process';import{once}from'node:events';
import{mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,realpathSync}from'node:fs';
import{tmpdir}from'node:os';import{join,dirname,basename}from'node:path';import{fileURLToPath}from'node:url';
import{createServer}from'node:net';import{fingerprint}from'../scripts/document.mjs';import{chapters}from'../assets/topics.mjs';
const server=fileURLToPath(new URL('../scripts/server.mjs',import.meta.url));
const answer=(id,deps=[])=>({id,question:id+' 的真实问题',input:'text',options:[],answer:{option_ids:[],text:'原答案'},depends_on:deps,status:'answered',round:1});
const tree=()=>({schema_version:1,session_id:'document-fixture',topic:'文档交接测试',revision:0,current_round:1,status:'active',nodes:[answer('a'),answer('b'),answer('joint',['a','b'])]});
const post=(url,route,data,extra={})=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(data)});
async function start(t,seed=tree(),root=null,port=0){
 const own=!root;root??=mkdtempSync(join(tmpdir(),'grill-document-test-'));if(own)writeFileSync(join(root,'tree.json'),JSON.stringify(seed));
 const child=spawn(process.execPath,[server,'--state',join(root,'tree.json'),'--port',String(port),'--wait-ms','120']);let error='';child.stderr.on('data',x=>error+=x);
 const ready=await Promise.race([once(child.stdout,'data').then(([d])=>JSON.parse(String(d))),once(child,'exit').then(()=>{throw Error(error);})]);
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}if(own){const p=realpathSync(root);assert.equal(dirname(p).toLowerCase(),realpathSync(tmpdir()).toLowerCase());assert.ok(basename(p).startsWith('grill-document-test-'));rmSync(p,{recursive:true,force:true});}});return{...ready,root,child};
}
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
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
 assert.equal((await control({action:'ready',expected_revision:1,job_id:oldJob})).status,409);
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
});
