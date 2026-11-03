// Runtime metadata only. Answers remain solely in tree.json.
export const AI_CHECK_TIMEOUT_MS=30_000;
export const HEARTBEAT_INTERVAL_MS=10_000;
export const SHORT_QUERY_TIMEOUT_MS=60_000;
export const HEARTBEAT_LEASE_MS=3*60_000;
export class InterviewProgress{
  constructor(getTree,{log=null,getPhase=()=>null}={}){Object.assign(this,{getTree,log,getPhase});this.startedAt=null;this.revision=null;this.lastSubmission=null;this.lastCheckAt=null;this.lastHeartbeatAt=null;this.heartbeats=new Map();this.ended=new Set();this.work=new Map();this.events=[];this.sequence=0;this.status();}
  record(event,detail={}){this.log?.append(event,{revision:this.getTree().revision,...detail});}
  checkIn({afterSequence=0,afterRevision,ownerPid}={}){
    this.sweep();const now=Date.now();
    if(this.lastCheckAt!==null&&now-this.lastCheckAt>SHORT_QUERY_TIMEOUT_MS)this.record('ai_resumed',{source:'check',silence_ms:now-this.lastCheckAt});
    this.lastCheckAt=now;
    for(const heartbeat of this.heartbeats.values())if(heartbeat.ownerPid===ownerPid)heartbeat.leaseUntil=now+HEARTBEAT_LEASE_MS;
    const events=this.log?this.log.after(afterSequence,afterRevision):this.events.filter(e=>e.sequence>afterSequence&&(afterRevision===undefined||e.revision>afterRevision));
    const submission=this.getPhase()!=='offered'?events.findLast(e=>e.ready_for_ai&&e.revision===this.getTree().revision&&['submit','review'].includes(e.kind)):null;
    let delay=null;
    if(submission&&!this.log?.discovered.has(submission.sequence)){delay=Math.max(0,Date.now()-submission.at);this.record('submission_discovered',{sequence:submission.sequence,submission_at:submission.at,discovery_delay_ms:delay});this.log?.discovered.set(submission.sequence,Date.now());}
    return{...this.status(),events,discovery_delay_ms:delay};
  }
  heartbeat(id,action='pulse',{ownerPid,reason='requested'}={}){
    this.sweep();if(action==='stop'){this.endHeartbeat(id,reason);return false;}
    if(this.ended.has(id))return false;
    let heartbeat=this.heartbeats.get(id);
    if(!heartbeat){
      heartbeat={ownerPid,lastPulseAt:Date.now(),leaseUntil:Date.now()+HEARTBEAT_LEASE_MS};
      this.heartbeats.set(id,heartbeat);this.record('heartbeat_start',{heartbeat_id:id,owner_pid:ownerPid,lease_until:heartbeat.leaseUntil});
    }
    heartbeat.lastPulseAt=Date.now();this.lastHeartbeatAt=heartbeat.lastPulseAt;return true;
  }
  endHeartbeat(id,reason){const heartbeat=this.heartbeats.get(id);if(heartbeat){this.record('heartbeat_end',{heartbeat_id:id,reason,owner_pid:heartbeat.ownerPid,last_pulse_at:heartbeat.lastPulseAt,lease_until:heartbeat.leaseUntil});this.heartbeats.delete(id);}this.ended.add(id);}
  sweep(){const now=Date.now();for(const[id,h]of this.heartbeats){if(now>=h.leaseUntil)this.endHeartbeat(id,'lease_expired');else if(now-h.lastPulseAt>AI_CHECK_TIMEOUT_MS)this.endHeartbeat(id,'expired_observed');}}
  close(){for(const id of this.heartbeats.keys())this.endHeartbeat(id,'session_closed');}
  userEvent(kind){const tree=this.getTree(),e=this.log?this.log.user(kind,tree):{kind,at:Date.now(),sequence:++this.sequence,revision:tree.revision,round:tree.current_round,ready_for_ai:tree.status==='active'&&tree.nodes.every(n=>n.status==='answered')};if(!this.log)this.events.push(e);}
  status(){
    this.sweep();const tree=this.getTree(),now=Date.now(),offered=this.getPhase()==='offered',waiting=tree.schema_version!==1&&tree.status==='active'&&!offered&&tree.nodes.every(n=>n.status==='answered');
    if(waiting&&this.startedAt===null)this.startedAt=now;if(!waiting)this.startedAt=null;this.revision=tree.revision;
    return{session_id:tree.session_id,revision:tree.revision,sequence:this.log?.sequence??this.sequence,stage:offered?'waiting_for_save':waiting?'thinking':tree.status==='complete'?'saved':tree.nodes.some(n=>n.status==='needs_review')?'review':'questions',started_at:this.startedAt,last_submission:this.lastSubmission,server_now:now,ai:{last_check_at:this.lastCheckAt,last_heartbeat_at:this.lastHeartbeatAt,last_activity_at:this.lastCheckAt,source:this.lastCheckAt===null?null:'check',seconds_since_last_check:this.lastCheckAt===null?null:Math.max(0,now-this.lastCheckAt)/1000,seconds_since_last_heartbeat:this.lastHeartbeatAt===null?null:Math.max(0,now-this.lastHeartbeatAt)/1000,heartbeat_active:this.heartbeats.size>0,heartbeat_activity:this.heartbeats.size?(this.work.size?'code':tree.status==='complete'?'document':'questions'):null,timeout_ms:AI_CHECK_TIMEOUT_MS,short_query_timeout_ms:SHORT_QUERY_TIMEOUT_MS},round:tree.current_round,rounds_completed:[...new Set(tree.nodes.map(n=>n.round))].filter(r=>tree.nodes.filter(n=>n.round===r).every(n=>n.status==='answered')).length};
  }
  onMutation(cause){const tree=this.getTree();if(['submit','review'].includes(cause)&&tree.nodes.every(n=>n.status==='answered'))this.lastSubmission={revision:tree.revision,round:tree.current_round,at:Date.now(),cause};if(['submit','review','reopen'].includes(cause))this.userEvent(cause);this.status();}
}
