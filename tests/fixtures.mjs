// Deliberately synthetic layout evidence. Never loaded by production assets.
export function specimen28(status='answered'){
  const questions=[['谁会每天用这个页面？',0],['一次拷打大概多少题？',0],['最怕哪种体验？',1],['要不要多人协作？',0],['每轮几个问题？',0],['答完后谁来推进？',4],['AI 等待时显示什么？',4],['能否跳过某题？',5],['超时怎么提示？',6],['tree.json 存哪里？',0],['depends_on 如何定义？',9],['修订冲突怎么处理？',10],['需要历史版本吗？',9],['状态有哪几种？',10],['首屏长什么样？',0],['花开要多快？',14],['树干每轮长多少？',15],['选项用卡片还是列表？',14],['移动端要支持吗？',17],['服务断开怎么办？',0],['答案前后矛盾？',19],['needs_review 谁来确认？',20],['题目超过 30 题？',19],['果实对应哪一章？',0],['保存后触发什么？',23],['验收标准写在哪？',24],['要导出 .md 吗？',24],['如何测量等待秒数？',23]];
  const rounds=[3,6,4,5,7,3].flatMap((count,index)=>Array(count).fill(index+1));
  return{schema_version:2,session_id:'synthetic-v7-28',topic:'28 题布局样例',revision:0,current_round:6,status:'active',nodes:questions.map(([question,dep],index)=>({id:'q'+String(index+1).padStart(2,'0'),question,rationale:"合成布局测试：检验节点可辨识与依赖关系。",input:'text',options:[],answer:status==='pending'?null:{option_ids:[],text:'布局测试答案'},depends_on:dep?['q'+String(dep).padStart(2,'0')]:[],status,round:rounds[index]}))};
}

export function specimen28FourRounds(){
 const tree=specimen28();tree.session_id='synthetic-claude-28-v1';tree.current_round=4;
 const parents=[[],[],[],[],[],[],[],[1],[1],[2],[2],[4],[5],[6],[3],[8],[9],[10],[10],[11],[13],[14],[15],[16],[17],[20],[21],[2,18]];
 tree.nodes.forEach((n,i)=>{n.round=i<7?1:i<15?2:i<23?3:4;n.depends_on=parents[i].map(j=>'q'+String(j).padStart(2,'0'));});
 tree.nodes[0].input='single_choice';tree.nodes[0].options=[{id:'option','label':'布局样例的选项'}];tree.nodes[0].answer={option_ids:['option'],text:'布局样例的补充说明'};return tree;
}
