import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runtimePost} from './runtime-client.mjs';
import {HEARTBEAT_INTERVAL_MS} from './progress.mjs';
import {isMain} from './entry.mjs';

// A detached helper must not conceal an abandoned host forever.
export const HEARTBEAT_LEASE_MS=15*60_000;
export async function stopHeartbeat(options,id){return runtimePost(options,'/ai/heartbeat',{heartbeat_id:id,action:'stop'});}
export async function startHeartbeat(options,{ownerPid}={}){
  const id=randomUUID(),first=await runtimePost(options,'/ai/heartbeat',{heartbeat_id:id,action:'pulse'});
  if(!first.active)return{status:'session_finished',heartbeat_id:id};
  const args=[fileURLToPath(import.meta.url),'--url',options.url,'--session',options.sessionId,'--instance',first.instance_id,'--id',id];
  if(ownerPid)args.push('--owner-pid',String(ownerPid));
  const child=spawn(process.execPath,args,{detached:true,windowsHide:true,stdio:'ignore'});
  try{await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
  catch(error){await stopHeartbeat(options,id).catch(()=>{});throw error;}
  child.unref();return{status:'heartbeat_started',heartbeat_id:id,pid:child.pid,instance_id:first.instance_id,interval_ms:HEARTBEAT_INTERVAL_MS,lease_ms:HEARTBEAT_LEASE_MS};
}
async function worker(options,id,ownerPid){
  let ended=false,wake;
  const stop=()=>{ended=true;wake?.();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const until=Date.now()+HEARTBEAT_LEASE_MS;
  try{
    while(!ended&&Date.now()<until){
      await new Promise(resolve=>{const timer=setTimeout(resolve,HEARTBEAT_INTERVAL_MS);wake=()=>{clearTimeout(timer);resolve();};});
      if(ended)break;
      if(ownerPid){try{process.kill(ownerPid,0);}catch{break;}}
      if(!(await runtimePost(options,'/ai/heartbeat',{heartbeat_id:id,action:'pulse'})).active)break;
    }
  }finally{await stopHeartbeat(options,id).catch(()=>{});}
}
if(isMain(import.meta.url)){
  const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
  if(args.includes('--help'))console.log('Internal heartbeat worker. Use check.mjs --heartbeat / --heartbeat-stop <id>.');
  else worker({url:value('--url'),sessionId:value('--session'),instanceId:value('--instance')},value('--id'),args.includes('--owner-pid')?Number(value('--owner-pid')):null).catch(()=>{process.exitCode=2;});
}
