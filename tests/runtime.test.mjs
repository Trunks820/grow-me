import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateTree,publishRound} from '../scripts/model.mjs';
import {checkOnce} from '../scripts/check.mjs';
import {fingerprint} from '../scripts/document.mjs';
import {chapters} from '../assets/topics.mjs';
import {recommendationDigest} from '../scripts/recommendations.mjs';

const run=promisify(execFile),server=fileURLToPath(new URL('../scripts/server.mjs',import.meta.url)),checker=fileURLToPath(new URL('../scripts/check.mjs',import.meta.url));
const options=[{id:'a',label:'邮件通知'},{id:'b',label:'站内通知'},{id:'none',label:'都不需要',exclusive:true}];
const node=(id='delivery',extra={})=>({id,question:'需要哪些通知方式？',rationale:'决定首版需要开发和验收哪些通知渠道。',input:'multi_choice',options:structuredClone(options),answer:null,depends_on:[],status:'pending',round:1,...extra});
const tree=(nodes=[node()])=>({schema_version:2,session_id:'v2-regression',topic:'通知范围',revision:0,current_round:1,status:'active',nodes});
async function service(t,seed=tree(),{clock=false}={}){
  const root=mkdtempSync(join(tmpdir(),'grow-v2-')),file=join(root,'tree.json'),document=join(root,'task.html');writeFileSync(file,JSON.stringify(seed)+'\n');
  const clockFile=join(root,'clock-offset'),preload=join(root,'test-clock.mjs');
  if(clock){writeFileSync(clockFile,'0');writeFileSync(preload,`import {readFileSync} from 'node:fs';const realNow=Date.now;Date.now=()=>realNow()+Number(readFileSync(${JSON.stringify(clockFile)},'utf8'));`);}
  const children=[],detached=[];
  async function start(){const child=spawn(process.execPath,[...(clock?['--import',pathToFileURL(preload).href]:[]),server,'--state',file,'--document',document]);children.push(child);let errors='';child.stderr.on('data',d=>errors+=d);return{child,...await Promise.race([once(child.stdout,'data').then(([d])=>JSON.parse(String(d))),once(child,'exit').then(()=>{throw Error(errors);})])};}
  const started=await start();
  t.after(async()=>{
    for(const pid of detached){try{process.kill(pid);}catch{}for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}}
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
    // Windows can retain the killed process's cwd handle briefly after process.kill(0) stops seeing it.
    for(let i=0;i<50;i++){try{rmSync(root,{recursive:true,force:true});break;}catch(error){if(i===49||!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;await new Promise(r=>setTimeout(r,30));}}
  });
  return{...started,root,file,document,start,setClockOffset:offset=>writeFileSync(clockFile,String(offset)),track:pid=>detached.push(pid),async state(){return(await fetch(this.url+'/state')).json();},async post(path,data){return fetch(this.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_session_id:seed.session_id,...data})});}};
}

import {startHeartbeat,stopHeartbeat} from '../scripts/heartbeat.mjs';
import {runtimePost} from '../scripts/runtime-client.mjs';
import {InterviewProgress,SHORT_QUERY_TIMEOUT_MS,HEARTBEAT_LEASE_MS} from '../scripts/progress.mjs';
import {renderChapter} from '../scripts/render-chapter.mjs';
import {composeDocument} from '../scripts/compose-document.mjs';
import {validateDocument} from '../scripts/document.mjs';
import {timedCodeRead} from '../scripts/work.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const logs=s=>readFileSync(s.file+'.runtime-timings.jsonl','utf8').trim().split('\n').map(JSON.parse);
const opts=s=>({url:s.url,sessionId:'v2-regression'});
const control=async(s,action,extra={})=>{const response=await s.post('/document/control',{action,expected_revision:(await s.state()).revision,...extra});assert.equal(response.status,200,await response.clone().text());return response.json();};
const submit=async s=>{assert.equal((await s.post('/submit',{round:1,expected_revision:0,answers:[{id:'delivery',answer:{option_ids:['none'],text:'用户真正原话'}}]})).status,200);};

test('check CLI through a directory symlink enters main and matches direct calls, including live user events',async t=>{
 const s=await service(t),link=join(s.root,'linked-skill'),target=fileURLToPath(new URL('..',import.meta.url));
 // Junctions are the Windows directory symlink used by ~/.claude/skills.
 symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
 const via=join(link,'scripts','check.mjs'),viaFile=join(s.root,'check-link.mjs');symlinkSync(checker,viaFile,'file');
 const directHelp=await run(process.execPath,[checker,'--help']),linkedHelp=await run(process.execPath,[via,'--help']);
 assert.equal((await run(process.execPath,[viaFile,'--help'])).stdout,directHelp.stdout);assert.ok(linkedHelp.stdout.length>40);assert.equal(linkedHelp.stdout,directHelp.stdout);assert.equal((await run(process.execPath,['--preserve-symlinks-main',via,'--help'])).stdout,directHelp.stdout);
 await submit(s);
 const args=['--url',s.url,'--session','v2-regression','--after-sequence','0'];
 const direct=JSON.parse((await run(process.execPath,[checker,...args])).stdout),linked=JSON.parse((await run(process.execPath,[via,...args])).stdout);
 const fileLinked=JSON.parse((await run(process.execPath,[viaFile,...args])).stdout);
 for(const key of ['status','session_id','revision','sequence','instance_id','events']){assert.deepEqual(linked[key],direct[key]);assert.deepEqual(fileLinked[key],direct[key]);}
 assert.equal(linked.changed,true);assert.equal(linked.status,'ready_for_ai');
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

test('detached heartbeat renews activity every 10s without reading or consuming submissions; stop records end',async t=>{
 const s=await service(t);await checkOnce(opts(s));const cursor=readFileSync(s.file+'.cursor.json');
 const started=Date.now(),hb=JSON.parse((await run(process.execPath,[checker,'--url',s.url,'--session','v2-regression','--heartbeat'])).stdout);s.track(hb.pid);
 assert.equal(hb.status,'heartbeat_started');assert.equal(hb.interval_ms,10000);assert.ok(Date.now()-started<3000);
 const first=(await(await fetch(s.url+'/progress')).json()).ai.last_activity_at;
 await submit(s);const bytes=readFileSync(s.file);
 await delay(10500);const ai=(await(await fetch(s.url+'/progress')).json()).ai;
 assert.equal(ai.last_check_at,first);assert.equal(ai.last_activity_at,first);assert.equal(ai.source,'check');assert.ok(ai.seconds_since_last_check>=10);assert.ok(ai.seconds_since_last_heartbeat<3);assert.equal(hb.owner_pid,process.pid);assert.equal(hb.lease_ms,180000);
 assert.deepEqual(readFileSync(s.file+'.cursor.json'),cursor);assert.deepEqual(readFileSync(s.file),bytes);assert.equal(logs(s).filter(e=>e.event==='submission_discovered').length,0);
 const found=await checkOnce(opts(s));assert.deepEqual(found.events.map(e=>e.kind),['submit']);assert.ok(found.timing.discovery_delay_ms>=10000);
 await stopHeartbeat(opts(s),hb.heartbeat_id);assert.equal((await runtimePost(opts(s),'/ai/heartbeat',{heartbeat_id:hb.heartbeat_id})).active,false);
 const events=logs(s);assert.equal(events.filter(e=>e.event==='heartbeat_start').length,1);assert.equal(events.filter(e=>e.event==='heartbeat_end').length,1);
});

test('heartbeat validates session/revision/instance and exits when service instance disappears',async t=>{
 const s=await service(t);for(const override of [{expected_session_id:'wrong'},{expected_revision:99},{expected_instance_id:'old'}]){
  const response=await s.post('/ai/heartbeat',{heartbeat_id:'rejected',expected_revision:0,expected_instance_id:s.instance_id,...override});assert.equal(response.status,409);
 }
 assert.equal((await(await fetch(s.url+'/progress')).json()).ai.last_activity_at,null);
 const hb=await startHeartbeat(opts(s));s.track(hb.pid);s.child.kill();await once(s.child,'exit');
 const until=Date.now()+13000;let alive=true;while(alive&&Date.now()<until){try{process.kill(hb.pid,0);await delay(100);}catch{alive=false;}}assert.equal(alive,false);
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

test('CLI short checks renew the default or explicitly matching owner, and recovery exposes both clocks',async t=>{
 const s=await service(t),common=['--url',s.url,'--session','v2-regression'];
 const hb=JSON.parse((await run(process.execPath,[checker,...common,'--heartbeat'])).stdout);s.track(hb.pid);assert.equal(hb.owner_pid,process.pid);
 const first=await(await fetch(s.url+'/recovery')).json();assert.equal(first.ai.last_check_at,null);assert.equal(first.ai.seconds_since_last_check,null);assert.ok(first.ai.seconds_since_last_heartbeat>=0);
 await delay(20);await run(process.execPath,[checker,...common]);let rec=await(await fetch(s.url+'/recovery')).json();const renewed=rec.heartbeats.find(h=>h.id===hb.heartbeat_id).lease_until;assert.ok(renewed>hb.lease_until);assert.equal(rec.ai.last_heartbeat_at,first.ai.last_heartbeat_at);
 await run(process.execPath,[checker,...common,'--owner-pid',String(process.ppid)]);rec=await(await fetch(s.url+'/recovery')).json();assert.equal(rec.heartbeats.find(h=>h.id===hb.heartbeat_id).lease_until,renewed);
 const explicit=JSON.parse((await run(process.execPath,[checker,...common,'--heartbeat','--owner-pid',String(process.ppid)])).stdout);s.track(explicit.pid);assert.equal(explicit.owner_pid,process.ppid);
 await delay(20);await run(process.execPath,[checker,...common,'--owner-pid',String(process.ppid)]);rec=await(await fetch(s.url+'/recovery')).json();assert.ok(rec.heartbeats.find(h=>h.id===explicit.heartbeat_id).lease_until>explicit.lease_until);
 assert.equal(rec.ai.last_check_at,(await(await fetch(s.url+'/progress')).json()).ai.last_check_at);
});

test('default parent owner exit stops a live heartbeat within one cycle and logs owner_exited',async t=>{
 const s=await service(t),hostScript=join(s.root,'host.mjs');
 writeFileSync(hostScript,`import {execFileSync} from 'node:child_process';console.log(execFileSync(process.execPath,${JSON.stringify([checker,'--url',s.url,'--session','v2-regression','--heartbeat'])},{encoding:'utf8'}).trim());setInterval(()=>{},1000);`);
 const host=spawn(process.execPath,[hostScript],{stdio:['ignore','pipe','pipe'],windowsHide:true});t.after(()=>host.kill());
 const hb=JSON.parse(String((await once(host.stdout,'data'))[0]));s.track(hb.pid);assert.equal(hb.owner_pid,host.pid);
 await delay(1200);process.kill(hb.pid,0);const endedAt=Date.now();host.kill();await once(host,'exit');let alive=true;while(alive&&Date.now()-endedAt<10000){try{process.kill(hb.pid,0);await delay(50);}catch{alive=false;}}
 assert.equal(alive,false);assert.ok(Date.now()-endedAt<10000);assert.equal(logs(s).filter(e=>e.event==='heartbeat_end').at(-1).reason,'owner_exited');
});

test('server lease expiry stops the real worker and logs lease_expired (controlled service clock)',async t=>{
 const s=await service(t,tree(),{clock:true}),hb=await startHeartbeat(opts(s));s.track(hb.pid);const bytes=readFileSync(s.file);
 // Advance server time only: no shorter production constants or fake heartbeat worker.
 s.setClockOffset(HEARTBEAT_LEASE_MS+1);let alive=true;const until=Date.now()+12000;
 while(alive&&Date.now()<until){try{process.kill(hb.pid,0);await delay(100);}catch{alive=false;}}
 assert.equal(alive,false);const ends=logs(s).filter(e=>e.event==='heartbeat_end');assert.equal(ends.length,1);assert.equal(ends[0].reason,'lease_expired');assert.deepEqual(readFileSync(s.file),bytes);
 assert.equal((await(await fetch(s.url+'/recovery')).json()).heartbeats.length,0);
});
