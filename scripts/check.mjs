import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startService} from './start.mjs';

class CheckError extends Error{constructor(kind,message){super(message);this.kind=kind;}}
export function localUrl(value){
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new CheckError('identity','Use the exact http://127.0.0.1:<port> service origin.');
  return url.origin;
}

export async function checkOnce({url,sessionId,afterRevision,afterSequence,afterInstance,timeoutMs=3000}){
  url=localUrl(url);
  if(!sessionId)throw new CheckError('identity','--session is required; a port is not a session identity.');
  const signal=AbortSignal.timeout(timeoutMs),instances=[];
  async function get(path){
    let response;try{response=await fetch(url+path,{signal});}catch{throw new CheckError('offline','本机服务不可达；保留原文件，按原路径恢复服务。');}
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
  const observed=Date.now(),submission=progress.last_submission?.revision===state.revision?progress.last_submission:null;
  return{status:state.schema_version===1?'legacy_read_only':state.status==='complete'?'document':progress.stage==='thinking'?'ready_for_ai':progress.stage==='review'?'review':'waiting_for_user',
    changed:afterRevision!==state.revision||afterSequence!==doc.sequence||afterInstance!==recovery.instance_id,
    session_id:sessionId,schema_version:state.schema_version,revision:state.revision,current_round:state.current_round,url,instance_id:recovery.instance_id,
    document:{phase:doc.phase,sequence:doc.sequence,job_id:doc.job_id,stage:doc.stage,ready_chapters:doc.chapters.filter(c=>c.status==='ready').length},
    timing:{observed_at:observed,submission_at:submission?.at??null,discovery_delay_ms:submission?Math.max(0,observed-submission.at):null,
      submission_kind:submission?.cause??null,note:submission?'First observation after a new submission is the discovery measurement.':'No in-memory submission timestamp; never invent one after a restart.'}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  if(args.includes('--help'))console.log('node scripts/check.mjs --url <origin> --session <id> [--after-revision R --after-sequence S --after-instance ID] [--timeout-ms 3000]\nOne short check; no answers are printed. For an offline service: add --restart --state <original-tree.json> --document <original-task.html>.');
  else try{
    const number=name=>{const value=arg(name);if(value===undefined)return undefined;const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid '+name);return n;};
    const options={url:arg('--url'),sessionId:arg('--session'),afterRevision:number('--after-revision'),afterSequence:number('--after-sequence'),afterInstance:arg('--after-instance'),timeoutMs:number('--timeout-ms')??3000};
    if(options.timeoutMs<10||options.timeoutMs>3000)throw Error('timeout-ms must be 10..3000');
    try{console.log(JSON.stringify(await checkOnce(options)));}
    catch(error){
      if(error.kind!=='offline'||!args.includes('--restart'))throw error;
      if(!arg('--state')||!arg('--document'))throw new CheckError('recovery','恢复需要原 tree.json 和文档路径；从原启动回执取得，不能创建新访谈。');
      let started;try{started=await startService({stateFile:arg('--state'),documentFile:arg('--document'),sessionId:options.sessionId,port:Number(new URL(options.url).port)});}
      catch(startError){if(startError.code!=='EADDRINUSE')throw startError;throw new CheckError('recovery','原端口仍被占用；先核对占用服务，未自动启动第二个写入进程。');}
      console.log(JSON.stringify({...await checkOnce({...options,url:started.url}),restarted:true,recovered_from_file:true,service:started}));
    }
  }catch(error){console.log(JSON.stringify({status:'attention',kind:error.kind??'recovery',error:error.message}));process.exitCode=2;}
}
