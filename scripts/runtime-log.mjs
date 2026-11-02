import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';

export class RuntimeLog{
  constructor(file,sessionId,instanceId){
    Object.assign(this,{file,sessionId,instanceId});
    this.events=[];this.discovered=new Map();
    const content=existsSync(file)?readFileSync(file,'utf8'):'';
    if(content&&!content.endsWith('\n'))appendFileSync(file,'\n','utf8');
    for(const line of content.split(/\r?\n/)){
      try{const e=JSON.parse(line);if(e.session_id!==sessionId)continue;if(e.event==='user_event'&&Number.isSafeInteger(e.sequence))this.events.push(e);if(e.event==='submission_discovered')this.discovered.set(e.sequence,e.at);}catch{/* A truncated final log line is not interview state. */}
    }
    this.sequence=Math.max(0,...this.events.map(e=>e.sequence));
  }
  append(event,detail={},at=Date.now()){
    const entry={...detail,event,at,at_iso:new Date(at).toISOString(),session_id:this.sessionId,instance_id:this.instanceId};
    mkdirSync(dirname(this.file),{recursive:true});appendFileSync(this.file,JSON.stringify(entry)+'\n','utf8');return entry;
  }
  user(kind,tree){
    const e=this.append('user_event',{kind,sequence:++this.sequence,revision:tree.revision,round:tree.current_round,ready_for_ai:tree.status==='active'&&tree.nodes.every(n=>n.status==='answered')});
    this.events.push(e);return e;
  }
  after(sequence,revision){return this.events.filter(e=>e.sequence>sequence&&(revision===undefined||e.revision>revision));}
}
