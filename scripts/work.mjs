import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {runtimePost} from './runtime-client.mjs';
import {startHeartbeat,stopHeartbeat} from './heartbeat.mjs';
import {isMain} from './entry.mjs';

export async function timedCodeRead(options,command,args=[]){
  if(!options.finalRound)throw Error('Code reading requires --final-round while the user is answering.');
  const heartbeat=await startHeartbeat(options,{ownerPid:process.pid});
  if(heartbeat.status!=='heartbeat_started')throw Error('The session has finished');
  const bound={...options,instanceId:heartbeat.instance_id},operationId=randomUUID();let started=false,exitCode=null;
  try{
    await runtimePost(bound,'/ai/work',{action:'start',operation_id:operationId,final_round:true});started=true;
    exitCode=await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',windowsHide:true,shell:false});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
    return exitCode;
  }finally{
    try{if(started)await runtimePost(bound,'/ai/work',{action:'end',operation_id:operationId,exit_code:exitCode});}
    finally{await stopHeartbeat(bound,heartbeat.heartbeat_id).catch(()=>{});}
  }
}
if(isMain(import.meta.url)){
  const args=process.argv.slice(2),at=args.indexOf('--'),value=name=>args[args.indexOf(name)+1];
  if(args.includes('--help'))console.log('node scripts/work.mjs --url <origin> --session <id> --final-round -- <executable> [args...]\nWrap each project-code read command; logs start/end and owns a heartbeat. No shell interpolation.');
  else try{if(at<0||!args[at+1])throw Error('A command after -- is required');process.exitCode=await timedCodeRead({url:value('--url'),sessionId:value('--session'),finalRound:args.includes('--final-round')},args[at+1],args.slice(at+2));}
  catch(error){console.error(error.message);process.exitCode=2;}
}
