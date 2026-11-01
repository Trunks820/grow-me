import {spawn} from 'node:child_process';
import {readFileSync,openSync,closeSync,mkdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validateTree} from './model.mjs';

export async function startService({stateFile,documentFile,port=0,sessionId}) {
  stateFile=resolve(stateFile);documentFile=resolve(documentFile??join(dirname(stateFile),'outputs','task.html'));
  const tree=validateTree(JSON.parse(readFileSync(stateFile,'utf8')));
  if(!sessionId||tree.session_id!==sessionId)throw Error('原文件的会话身份不匹配，未启动服务。');
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
  mkdirSync(dirname(stateFile),{recursive:true});
  const logFile=join(dirname(stateFile),'.grow-me-server-'+randomUUID()+'.log'),fd=openSync(logFile,'wx');
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url)),'--state',stateFile,'--document',documentFile,'--port',String(port)],
    {cwd:dirname(stateFile),detached:true,windowsHide:true,stdio:['ignore',fd,fd]});
  closeSync(fd);let launchError;child.on('error',error=>{launchError=error;});
  const until=Date.now()+3000;
  while(Date.now()<until){
    const output=readFileSync(logFile,'utf8');
    for(const line of output.split(/\r?\n/)){
      try{const started=JSON.parse(line);if(started.session_id===sessionId&&started.url&&started.pid===child.pid){child.unref();return{...started,log_file:logFile};}}catch{/* The startup receipt is one complete JSON line. */}
    }
    if(launchError||child.exitCode!==null){const error=Error(/EADDRINUSE/.test(output)?'Port already in use':'本机服务未启动，请查看本地启动日志。');error.code=/EADDRINUSE/.test(output)?'EADDRINUSE':'START_FAILED';throw error;}
    await new Promise(r=>setTimeout(r,25));
  }
  child.kill();throw Error('本机服务启动超时；原文件未改动。');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  if(args.includes('--help'))console.log('node scripts/start.mjs --state <tree.json> --session <session_id> [--document <task.html>] [--port 0]\nStarts a separate local service and exits after its receipt. Never creates/replaces tree.json.');
  else try{if(!arg('--state'))throw Error('--state required');console.log(JSON.stringify(await startService({stateFile:arg('--state'),documentFile:arg('--document'),sessionId:arg('--session'),port:Number(arg('--port',0))})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
