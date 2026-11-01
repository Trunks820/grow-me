// Transient UI timing. No answers, decisions or model output are persisted here.
export class InterviewProgress{
  constructor(getTree){this.getTree=getTree;this.startedAt=null;this.revision=null;this.lastSubmission=null;this.status();}
  status(){
    const tree=this.getTree(),waiting=tree.schema_version!==1&&tree.status==='active'&&tree.nodes.every(n=>n.status==='answered');
    if(waiting&&this.startedAt===null)this.startedAt=Date.now();
    if(!waiting)this.startedAt=null;
    this.revision=tree.revision;
    return{session_id:tree.session_id,revision:tree.revision,stage:waiting?'thinking':tree.status==='complete'?'saved':tree.nodes.some(n=>n.status==='needs_review')?'review':'questions',started_at:this.startedAt,last_submission:this.lastSubmission,server_now:Date.now(),round:tree.current_round,rounds_completed:[...new Set(tree.nodes.map(n=>n.round))].filter(r=>tree.nodes.filter(n=>n.round===r).every(n=>n.status==='answered')).length};
  }
  onMutation(cause){
    const tree=this.getTree();
    if(['submit','review'].includes(cause)&&tree.nodes.every(n=>n.status==='answered'))this.lastSubmission={revision:tree.revision,round:tree.current_round,at:Date.now(),cause};
    this.status();
  }
}
