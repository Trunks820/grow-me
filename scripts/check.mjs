import {isMain} from './entry.mjs';
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {startService} from './start.mjs';
import {CheckError,localUrl} from './runtime-client.mjs';
import {startHeartbeat,stopHeartbeat} from './heartbeat.mjs';
export {localUrl} from './runtime-client.mjs';

export async function checkOnce({url,sessionId,afterRevision,afterSequence,afterInstance,timeoutMs=3000}){
  url=localUrl(url);
  if(!sessionId)throw new CheckError('identity','--session is required; a port is not a session identity.');
  const signal=AbortSignal.timeout(timeoutMs),instances=[];
  async function get(path,options={}){
    let response;try{response=await fetch(url+path,{...options,signal});}catch{throw new CheckError('offline','本机服务不可达；保留原文件，按原路径恢复服务。');}
    if(response.status===409)throw new CheckError('changed','查询期间状态已变，请重新短查询。');
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw new CheckError('protocol','服务响应异常；先核对地址，未继续写入。');
    instances.push(response.headers.get('x-grow-me-instance'));
    try{return await response.json();}catch{throw new CheckError('protocol','服务响应异常；未继续写入。');}
  }
  // Identity must be checked against /state before any recovery metadata is trusted.
  const state=await get('/state');
  if(state.session_id!==sessionId)throw new CheckError('identity','此地址属于另一个访谈；未写入、未启动替代访谈。');
  const [doc,progress,recovery]=await Promise.all([get('/document/status'),get('/progress'),get('/recovery')]);
  if(doc.source?.session_id!==sessionId||progress.session_id!==sessionId||recovery.session_id!==sessionId||
      doc.source.revision!==state.revision||progress.revision!==state.revision||recovery.revision!==state.revision||
      instances.some(id=>!id||id!==recovery.instance_id))throw new CheckError('changed','查询期间状态已变，请重新短查询。');
  const cursorFile=recovery.state_file+'.cursor.json';
  let cursor=null;
  if(existsSync(cursorFile)){
    try{cursor=JSON.parse(readFileSync(cursorFile,'utf8'));}catch{throw new CheckError('cursor','本地游标损坏；先核对原会话，不自动跳过提交。');}
    if(cursor.session_id!==sessionId||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0)throw new CheckError('cursor','本地游标身份不匹配。');
  }
  const sequence=afterSequence??cursor?.sequence??0;
  const observed=Date.now(),submission=progress.last_submission?.revision===state.revision?progress.last_submission:null;
  const activity=await get('/ai/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_session_id:sessionId,expected_revision:state.revision,expected_instance_id:recovery.instance_id,after_sequence:sequence,after_revision:afterRevision})});
  if(activity.session_id!==sessionId||activity.revision!==state.revision||instances.at(-1)!==recovery.instance_id)throw new CheckError('changed','查询期间状态已变，请重新短查询。');
  const next={session_id:sessionId,revision:state.revision,sequence:activity.sequence,instance:recovery.instance_id};
  // Concurrent short checks may repeat an event but must never move the cursor backwards.
  if(existsSync(cursorFile)){const latest=JSON.parse(readFileSync(cursorFile,'utf8'));if(latest.session_id===sessionId&&latest.sequence>next.sequence)throw new CheckError('changed','另一短查询已更新游标，请重新查询。');}
  const temp=cursorFile+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(next)+'\n','utf8');renameSync(temp,cursorFile);
  return{status:state.schema_version===1?'legacy_read_only':state.status==='complete'?'document':activity.stage==='waiting_for_save'?'waiting_for_save':activity.stage==='thinking'?'ready_for_ai':activity.stage==='review'?'review':'waiting_for_user',
    changed:activity.events.length>0,events:activity.events.map(({kind,sequence,revision,round,at})=>({kind,sequence,revision,round,at})),sequence:activity.sequence,
    instance_changed:Boolean((afterInstance??cursor?.instance)&&(afterInstance??cursor?.instance)!==recovery.instance_id),cursor_file:cursorFile,
    session_id:sessionId,schema_version:state.schema_version,revision:state.revision,current_round:state.current_round,url,instance_id:recovery.instance_id,
    document:{phase:doc.phase,sequence:doc.sequence,job_id:doc.job_id,stage:doc.stage,ready_chapters:doc.chapters.filter(c=>c.status==='ready').length},
    timing:{observed_at:observed,submission_at:activity.stage==='waiting_for_save'?null:submission?.at??null,discovery_delay_ms:activity.discovery_delay_ms,
      submission_kind:activity.stage==='waiting_for_save'?null:submission?.cause??null,timing_file:recovery.timing_file,note:'Discovery is recorded once per user submission; waiting_for_save does not accrue delay.'}};
}

if(isMain(import.meta.url)){
  const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  if(args.includes('--help'))console.log('node scripts/check.mjs --url <origin> --session <id> [--heartbeat | --heartbeat-stop <id>] [--owner-pid PID] [--after-revision R --after-sequence S --after-instance ID] [--timeout-ms 3000]\nOne short check with a persistent local cursor; no answers are printed. Heartbeat is a detached 10-second metadata-only pulse (15-minute lease). For an offline service: add --restart --state <original-tree.json> --document <original-task.html>.');
  else try{
    const number=name=>{const value=arg(name);if(value===undefined)return undefined;const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid '+name);return n;};
    const options={url:arg('--url'),sessionId:arg('--session'),afterRevision:number('--after-revision'),afterSequence:number('--after-sequence'),afterInstance:arg('--after-instance'),timeoutMs:number('--timeout-ms')??3000};
    if(options.timeoutMs<10||options.timeoutMs>3000)throw Error('timeout-ms must be 10..3000');
    try{
      if(args.includes('--heartbeat'))console.log(JSON.stringify(await startHeartbeat(options,{ownerPid:number('--owner-pid')})));
      else if(args.includes('--heartbeat-stop'))console.log(JSON.stringify(await stopHeartbeat(options,arg('--heartbeat-stop'))));
      else console.log(JSON.stringify(await checkOnce(options)));
    }
    catch(error){
      if(error.kind!=='offline'||!args.includes('--restart'))throw error;
      if(!arg('--state')||!arg('--document'))throw new CheckError('recovery','恢复需要原 tree.json 和文档路径；从原启动回执取得，不能创建新访谈。');
      let started;try{started=await startService({stateFile:arg('--state'),documentFile:arg('--document'),sessionId:options.sessionId,port:Number(new URL(options.url).port)});}
      catch(startError){if(startError.code!=='EADDRINUSE')throw startError;throw new CheckError('recovery','原端口仍被占用；先核对占用服务，未自动启动第二个写入进程。');}
      console.log(JSON.stringify({...await checkOnce({...options,url:started.url}),restarted:true,recovered_from_file:true,service:started}));
    }
  }catch(error){console.log(JSON.stringify({status:'attention',kind:error.kind??'recovery',error:error.message}));process.exitCode=2;}
}
