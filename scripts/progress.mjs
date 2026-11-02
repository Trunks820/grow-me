// Runtime metadata only. Answers remain solely in tree.json.
export const AI_CHECK_TIMEOUT_MS=30_000;
export const HEARTBEAT_INTERVAL_MS=10_000;
export class InterviewProgress{
  constructor(getTree,{log=null,getPhase=()=>null}={}){Object.assign(this,{getTree,log,getPhase});this.startedAt=null;this.revision=null;this.lastSubmission=null;this.lastAiCheckAt=null;this.heartbeats=new Map();this.ended=new Set();this.work=new Map();this.events=[];this.sequence=0;this.status();}
  record(event,detail={}){this.log?.append(event,{revision:this.getTree().revision,...detail});}
  touch(source){const now=Date.now();if(this.lastAiCheckAt!==null&&now-this.lastAiCheckAt>AI_CHECK_TIMEOUT_MS)this.record('ai_resumed',{source,silence_ms:now-this.lastAiCheckAt});this.lastAiCheckAt=now;this.activitySource=source;}
  checkIn({afterSequence=0,afterRevision}={}){
    this.touch('check');const events=this.log?this.log.after(afterSequence,afterRevision):this.events.filter(e=>e.sequence>afterSequence&&(afterRevision===undefined||e.revision>afterRevision));
    const submission=this.getPhase()!=='offered'?events.findLast(e=>e.ready_for_ai&&e.revision===this.getTree().revision&&['submit','review'].includes(e.kind)):null;
    let delay=null;
    if(submission&&!this.log?.discovered.has(submission.sequence)){delay=Math.max(0,Date.now()-submission.at);this.record('submission_discovered',{sequence:submission.sequence,submission_at:submission.at,discovery_delay_ms:delay});this.log?.discovered.set(submission.sequence,Date.now());}
    return{...this.status(),events,discovery_delay_ms:delay};
  }
  heartbeat(id,action='pulse'){
    this.sweep();if(action==='stop'){this.endHeartbeat(id,'requested');return false;}
    if(this.ended.has(id))return false;
    if(!this.heartbeats.has(id))this.record('heartbeat_start',{heartbeat_id:id});
    this.heartbeats.set(id,Date.now());this.touch('heartbeat');return true;
  }
  endHeartbeat(id,reason){if(this.heartbeats.has(id)){this.record('heartbeat_end',{heartbeat_id:id,reason,last_pulse_at:this.heartbeats.get(id)});this.heartbeats.delete(id);}this.ended.add(id);}
  sweep(){for(const[id,at]of this.heartbeats)if(Date.now()-at>AI_CHECK_TIMEOUT_MS)this.endHeartbeat(id,'expired_observed');}
  close(){for(const id of this.heartbeats.keys())this.endHeartbeat(id,'session_closed');}
  userEvent(kind){const tree=this.getTree(),e=this.log?this.log.user(kind,tree):{kind,at:Date.now(),sequence:++this.sequence,revision:tree.revision,round:tree.current_round,ready_for_ai:tree.status==='active'&&tree.nodes.every(n=>n.status==='answered')};if(!this.log)this.events.push(e);}
  status(){
    this.sweep();const tree=this.getTree(),now=Date.now(),offered=this.getPhase()==='offered',waiting=tree.schema_version!==1&&tree.status==='active'&&!offered&&tree.nodes.every(n=>n.status==='answered');
    if(waiting&&this.startedAt===null)this.startedAt=now;if(!waiting)this.startedAt=null;this.revision=tree.revision;
    return{session_id:tree.session_id,revision:tree.revision,sequence:this.log?.sequence??this.sequence,stage:offered?'waiting_for_save':waiting?'thinking':tree.status==='complete'?'saved':tree.nodes.some(n=>n.status==='needs_review')?'review':'questions',started_at:this.startedAt,last_submission:this.lastSubmission,server_now:now,ai:{last_check_at:this.lastAiCheckAt,last_activity_at:this.lastAiCheckAt,source:this.activitySource??null,seconds_since_last_check:this.lastAiCheckAt===null?null:Math.max(0,now-this.lastAiCheckAt)/1000,timeout_ms:AI_CHECK_TIMEOUT_MS},round:tree.current_round,rounds_completed:[...new Set(tree.nodes.map(n=>n.round))].filter(r=>tree.nodes.filter(n=>n.round===r).every(n=>n.status==='answered')).length};
  }
  onMutation(cause){const tree=this.getTree();if(['submit','review'].includes(cause)&&tree.nodes.every(n=>n.status==='answered'))this.lastSubmission={revision:tree.revision,round:tree.current_round,at:Date.now(),cause};if(['submit','review','reopen'].includes(cause))this.userEvent(cause);this.status();}
}
