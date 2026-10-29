import {createDecisionTree} from './tree.mjs';
import {primaryGraph,chapters,answerText} from './topics.mjs';
import {publicError} from './presentation.mjs';

const card=document.querySelector('#card'),dialog=document.querySelector('#node-dialog');
const drafts=new Map(),working=new Map();
let state,documentState={phase:'idle'},currentId=null,busy=false,waitingSince=null,documentSince=null,documentKey=null,stopped=false,returnFocus=null,rendering=false,renderFailed=false,refreshSequence=0,appliedRefresh=0,messageTimer;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const message=(text,error=false)=>{const n=document.querySelector('#message');clearTimeout(messageTimer);n.textContent=text?publicError(text):'';n.setAttribute('role',error?'alert':'status');if(text)messageTimer=setTimeout(()=>{n.textContent='';},8000);};
const view=createDecisionTree(document.querySelector('#decision-tree'),{onNode:openNode,onFruit:openFruit});
const ready=n=>n.depends_on.every(id=>state.nodes.find(n=>n.id===id)?.status==='answered');
const valid=(n,a)=>Boolean(a)&&ready(n)&&(n.input==='text'?a.option_ids.length===0&&a.text.trim().length>0:a.option_ids.length===1&&n.options.some(o=>o.id===a.option_ids[0]));
const openQuestions=()=>state.nodes.filter(n=>n.round===state.current_round&&n.status==='pending');
const reviews=()=>state.nodes.filter(n=>n.status==='needs_review');
const isWaiting=()=>state?.status==='active'&&state.nodes.every(n=>n.status==='answered');
const allConfirmed=()=>Boolean(state?.nodes.length)&&state.nodes.every(n=>n.status==='answered'&&n.answer!==null);
const documentMatches=()=>documentState.source?.session_id===state.session_id&&documentState.source?.revision===state.revision;

async function post(path,body){
  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('本机服务返回格式异常，请重试。');
  let result;try{result=await response.json();}catch{throw Error('本机服务返回格式异常，请重试。');}
  if(!response.ok)throw Error(publicError(result.error,'提交暂时失败，请重试。'));return result;
}
async function act(action){
  if(busy)return;busy=true;card.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{await action();message('');if(!stopped)await refresh(true);}
  catch(error){message(publicError(error.message)+'；已保留仍有效的草稿。',true);await refresh(true).catch(()=>{});}
  finally{busy=false;if(!stopped)render();}
}
function button(label,action,primary=false){const b=el('button',label,primary?'primary':'');b.type='button';b.addEventListener('click',action);return b;}
function docAction(action){return act(async()=>{await post('/document/control',{action,expected_revision:state.revision,job_id:documentState.job_id});});}
function updateMeta(){
  const done=state.nodes.filter(n=>n.status==='answered').length;
  const roundLabel=state.status==='complete'?`共完成 ${new Set(state.nodes.map(n=>n.round)).size} 轮`:`第 ${state.current_round} 轮 · 总轮数随回答确定`;
  document.querySelector('#meta').textContent=`${roundLabel} · ${state.topic}\n已确认 ${done} / ${state.nodes.length}${drafts.size?` · 本轮未提交 ${drafts.size}`:''}${reviews().length?` · 待复核 ${reviews().length}`:''}`;
  document.querySelector('#meta').dataset.revision=String(state.revision);card.dataset.revision=String(state.revision);
}
function updateTree(){const finished=documentState.phase==='offered'&&documentState.offered_revision===state.revision;view.update(state,{drafts,currentId,waiting:isWaiting()&&!finished,finished,fruitStates:new Map(chapters(state).map(c=>[c.id,documentMatches()?(documentState.chapters?.find(x=>x.id===c.id)?.status??(documentState.phase==='ready'?'ready':'generating')):'generating']))});updateMeta();}
function chooseCurrent(){
  const review=reviews();
  if(review.length){if(!review.some(n=>n.id===currentId&&ready(n)))currentId=(review.find(ready)||review[0]).id;return state.nodes.find(n=>n.id===currentId);}
  const pending=openQuestions();
  if(!pending.some(n=>n.id===currentId&&!drafts.has(n.id)))currentId=pending.find(n=>!drafts.has(n.id))?.id??null;
  return state.nodes.find(n=>n.id===currentId);
}
function sourceLine(n){
  if(!n.depends_on.length)return;
  const line=el('p','追问来自：','source');
  n.depends_on.forEach(id=>{const parent=state.nodes.find(n=>n.id===id);line.append(button(parent.question,()=>view.focusNode(id)));});card.append(line);
}
function inputs(n){
  const value=working.get(n.id)??drafts.get(n.id)??n.answer??{option_ids:[],text:''};
  const form=el('form',undefined,'question-form');let read;
  if(n.input==='single_choice'){
    const group=el('fieldset',undefined,'choice-group'),legend=el('legend','选择一项','sr-only');group.append(legend);
    n.options.forEach((o,i)=>{const label=el('label',undefined,'option'),radio=document.createElement('input');radio.type='radio';radio.name='answer';radio.value=o.id;radio.checked=value.option_ids.includes(o.id);label.append(radio,el('span',o.label));group.append(label);radio.dataset.shortcut=String(i+1);});
    const notes=el('details',undefined,'notes'),summary=el('summary','补充说明（可选）'),label=el('label','补充说明（可选）','sr-only'),area=el('textarea',undefined,'field');area.id='answer-note';label.htmlFor=area.id;area.value=value.text;notes.open=Boolean(value.text);notes.append(summary,label,area);form.append(group,notes);
    read=()=>({option_ids:[...group.querySelectorAll('input:checked')].map(n=>n.value),text:area.value});
  }else{
    const label=el('label',n.question,'sr-only'),area=el('textarea',undefined,'field');area.id='answer-text';label.htmlFor=area.id;area.value=value.text;area.placeholder='写下你的想法';form.append(label,area);read=()=>({option_ids:[],text:area.value});
  }
  const toolbar=el('div',undefined,'actions'),confirm=el('button',n.status==='needs_review'?'保存并确认此题':'确认并下一题','primary');confirm.type='submit';confirm.id='confirm-answer';toolbar.append(confirm);form.append(toolbar);
  const update=()=>{if(rendering||!form.isConnected)return;working.set(n.id,read());confirm.disabled=busy||!valid(n,read());};
  form.addEventListener('input',update);form.addEventListener('change',update);confirm.disabled=busy||!valid(n,read());
  if(!ready(n)){form.querySelectorAll('input,textarea').forEach(x=>x.disabled=true);card.append(el('p','请先确认上游答案。','review-note'));}
  form.addEventListener('submit',event=>{event.preventDefault();if(confirm.disabled)return;const answer=read();
    if(n.status==='needs_review')act(async()=>{await post('/decision',{id:n.id,expected_revision:state.revision,answer});currentId=null;});
    else{drafts.set(n.id,structuredClone(answer));working.delete(n.id);currentId=null;message('');render();card.querySelector('input,textarea,button')?.focus({preventScroll:true});}
  });
  card.append(form);
  if(n.status==='needs_review'&&n.answer!==null){const keep=button('仍然有效',()=>act(async()=>{await post('/decision',{id:n.id,expected_revision:state.revision,answer:n.answer});currentId=null;}));keep.disabled=busy||!ready(n);card.append(keep);}
  card.append(el('p',n.input==='text'?'Ctrl + Enter 确认':'按数字键选择，Enter 确认','help'));
  if(n.status!=='needs_review')card.append(el('p','花已开在本页；提交整轮后才保存。','draft-hint'));
}
function renderSummary(){
  const list=el('ul',undefined,'summary-list');
  openQuestions().forEach(n=>{const row=el('li');row.append(el('div',n.question),el('div',answerText(n,drafts.get(n.id)),'answer'),button('修改',()=>editDraft(n.id)));list.append(row);});
  card.append(el('p','本轮汇总','k'),el('h2','这一轮，先看看。','q'),list,el('p','本轮未提交 · 刷新或关闭会丢失这些草稿。','draft-hint'));
  const submit=button('提交本轮答案',()=>act(async()=>{
    const round=state.current_round,revision=state.revision,answers=openQuestions().map(n=>({id:n.id,answer:drafts.get(n.id)}));
    if(!answers.every(a=>valid(state.nodes.find(n=>n.id===a.id),a.answer)))throw Error('请完整回答本轮问题');
    await post('/submit',{round,expected_revision:revision,answers});waitingSince=performance.now();currentId=null;
  }),true);submit.disabled=busy;card.append(submit);
}
function renderWaiting(){
  card.append(el('p',`第 ${state.current_round} 轮 · 已确认`,'k'),el('h2','正在想下一轮的问题…','q'),el('p','生长中','growth-status'),elapsedLine(waitingSince),el('p','可以点已答的花回看或修改。','w'));
  const late=el('p','还在想，可以先回看已答的花','w');late.id='long-wait';late.hidden=waitingSince===null||performance.now()-waitingSince<=60000;card.append(late);
  if(documentState.phase==='offered'&&documentState.offered_revision===state.revision){card.replaceChildren(el('p','需求已问清','k'),el('h2','这一棵树，可以结果了。','q'),el('p','保存后这次访谈只读，接下来生成方案、开发清单与验收标准。','w'),button('保存并生成任务文档',()=>docAction('save'),true));}
}
function elapsedLine(since){const line=el('p','', 'wait-elapsed');line.id='wait-elapsed';line.setAttribute('aria-live','off');line.dataset.since=String(since??performance.now());line.textContent=`已等待 ${Math.max(0,Math.floor((performance.now()-Number(line.dataset.since))/1000))} 秒`;return line;}
function chapterList(){
  const list=el('ul',undefined,'chapters');
  chapters(state).forEach(c=>{const li=el('li'),ready=documentMatches()&&(documentState.phase==='ready'||documentState.chapters?.some(x=>x.id===c.id&&x.status==='ready'));
    if(ready){const a=el('a',c.title+' · 可阅读');a.href='/document'+(documentState.phase==='ready'?'':'?chapter='+encodeURIComponent(c.id))+'#'+c.anchor;a.target='_blank';a.rel='noopener';li.append(a);}
    else li.append(el('span',c.title),el('span',documentState.phase==='failed'?' · 待重试':' · 生成中','chapter-pending'));list.append(li);
  });return list;
}
function renderDocument(){
  const phase=documentState.phase;card.append(el('p','已保存 · 只读','k'));
  if(phase==='ready'){
    if(!documentMatches()){card.append(el('h2','正在同步任务文档…','q'),el('p','正在核对当前访谈与文档的版本。','w'));return;}
    card.append(el('h2','问过的，都结成了果。','q'),el('p',`${state.nodes.length} 个问题已确认 · ${chapters(state).length} 颗果子，点击打开对应章节。`,'w'));
    card.append(chapterList());
    const link=el('a','打开完整任务文档','doc-link');link.href='/document';link.target='_blank';link.rel='noopener';card.append(link);
    const download=el('a','保存 HTML 文件'),downloadLine=el('p');download.href='/document?download=1';download.download='task.html';downloadLine.append(download);card.append(downloadLine);
    card.append(button('结束预览',()=>act(async()=>{await post('/document/control',{action:'close',expected_revision:state.revision});stopped=true;document.querySelector('#connection').textContent='预览已结束；任务 HTML 已保存在本机。';}),false));
  }else if(phase==='failed'){
    card.append(el('h2','文档暂时没生成。','q'),el('p',publicError(documentState.error,'文档生成遇到问题，请重试。'),'w'),chapterList(),button('重试生成文档',()=>docAction('retry'),true),el('p','答案已经保存，不用重新答。','w'));
  }else{
    const stage={queued:'等待当前对话接手',drafting:'正在整理三个视图',design:'正在整理设计方案',plan:'正在整理开发清单',acceptance:'正在整理验收标准',checking:'正在校验章节、引用和来源'}[documentState.stage]??'正在整理三个视图';
    const done=documentState.chapters?.filter(c=>c.status==='ready').length??0;
    card.append(el('h2','正在生成任务文档…','q'),el('p','生长中 · '+stage,'growth-status'),elapsedLine(documentSince),el('p',`已完成 ${done} / ${chapters(state).length} 章；完成的章节可以先读。`,'w'),chapterList(),el('p','答案已保存。若当前对话已中断，请回到原对话说“继续”。','w'));
  }
}
function render(){
  if(!state)return;rendering=true;renderFailed=false;try{const hadText=document.activeElement?.matches('textarea,input');
  card.replaceChildren();
  if(state.status==='complete'){currentId=null;if(allConfirmed())renderDocument();else card.append(el('p','状态待核对','k'),el('h2','保存状态与答案不一致。','q'),el('p',`当前只有 ${state.nodes.filter(n=>n.status==='answered').length} / ${state.nodes.length} 个问题已确认；请回到原对话核对 tree.json。`,'w'));}
  else{
    const n=chooseCurrent();
    if(n){const roundNodes=state.nodes.filter(x=>x.round===n.round);card.append(el('p',`第 ${n.round} 轮 · 本轮第 ${roundNodes.indexOf(n)+1} 题，共 ${roundNodes.length} 题${n.status==='needs_review'?' · 需复核':''}`,'k'));sourceLine(n);card.append(el('h2',n.question,'q'));
      if(n.status==='needs_review')card.append(el('p','本题或其上游已重新打开。请确认旧答案是否仍然有效。','review-note'));
      inputs(n);
    }else if(openQuestions().length)renderSummary();
    else renderWaiting();
  }
  card.dataset.currentId=currentId??'';updateTree();if(hadText&&!busy)card.querySelector('input:checked,textarea,input')?.focus({preventScroll:true});
  }catch(error){renderFailed=true;card.replaceChildren(el('h2','正在同步生长状态…','q'),el('p','生长中','growth-status'),elapsedLine(state.status==='complete'?documentSince:waitingSince),el('p','已提交答案仍在本机，将自动重新读取。','w'));message('页面状态正在同步，稍后会自动恢复。',true);console.error('State rendering failed');}finally{rendering=false;}
}
function editDraft(id){const value=drafts.get(id);if(value)working.set(id,structuredClone(value));drafts.delete(id);currentId=id;dialog.close();render();}
function openNode(id,trigger){
  const n=state.nodes.find(n=>n.id===id);if(!n)return;returnFocus=trigger;
  const body=document.querySelector('#node-body'),actions=document.querySelector('#node-actions');body.replaceChildren();actions.replaceChildren();
  const rootId=primaryGraph(state).find(e=>e.node.id===id).rootId,root=state.nodes.find(n=>n.id===rootId);
  body.append(el('p',`第 ${n.round} 轮 · ${root.question}${n.status==='needs_review'?' · 需复核':''}`,'k'));
  const heading=el('h2',n.question);heading.id='node-question';body.append(heading,el('p',answerText(n,drafts.get(id)??n.answer),'answer'));
  if(drafts.has(id))body.append(el('p','本轮未提交','draft-hint'));
  if(n.depends_on.length)body.append(el('p','依据：'+n.depends_on.map(id=>state.nodes.find(n=>n.id===id).question).join('；'),'w'));
  if(state.status==='active'&&(n.answer!==null||drafts.has(id)||n.status==='needs_review'))actions.append(button('修改回答',()=>{
    if(drafts.has(id))return editDraft(id);
    dialog.close();act(async()=>{if(n.status!=='needs_review')await post('/reopen',{id,expected_revision:state.revision});currentId=id;});
  }));
  if(state.status==='active'&&n.status==='needs_review'&&n.answer!==null){const keep=button('仍然有效',()=>{dialog.close();act(async()=>{await post('/decision',{id,expected_revision:state.revision,answer:n.answer});currentId=null;});});keep.disabled=!ready(n);actions.append(keep);}
  if(!dialog.open)dialog.showModal();
}
function openFruit(fruit){const ready=documentMatches()&&(documentState.phase==='ready'||documentState.chapters?.some(c=>c.id===fruit.id&&c.status==='ready'));if(!allConfirmed()||!ready){message('这个章节还在生成，完成后果子会成熟。');return;}window.open('/document'+(documentState.phase==='ready'?'':'?chapter='+encodeURIComponent(fruit.id))+'#'+fruit.anchor,'_blank','noopener');}
document.querySelector('#close-node').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>returnFocus?.focus({preventScroll:true}));
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
window.addEventListener('beforeunload',event=>{if(state?.status==='active'&&(drafts.size||working.size)){event.preventDefault();event.returnValue='';}});
document.addEventListener('keydown',event=>{
  if(dialog.open||!state||busy)return;const inText=event.target.matches('textarea,input[type=text]');
  if(inText){if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();card.querySelector('#confirm-answer')?.click();}return;}
  if(/^[1-9]$/.test(event.key)){const radio=card.querySelector(`[data-shortcut="${event.key}"]`);if(radio&&!radio.disabled){event.preventDefault();radio.checked=true;radio.dispatchEvent(new Event('change',{bubbles:true}));radio.focus();}}
  else if(event.key==='Enter'&&event.target.matches('input[type=radio]')){event.preventDefault();card.querySelector('#confirm-answer')?.click();}
});

async function refresh(force=false){
  const sequence=++refreshSequence;
  const [response,docResponse,progressResponse]=await Promise.all([fetch('/state',{cache:'no-store'}),fetch('/document/status',{cache:'no-store'}),fetch('/progress',{cache:'no-store'})]);
  if(!response.ok||!docResponse.ok)throw Error('读取本机状态失败');
  const next=await response.json(),doc=await docResponse.json(),progress=progressResponse.ok?await progressResponse.json():null;
  if(stopped)return;
  if(sequence<appliedRefresh||(state&&next.revision<state.revision))return;
  appliedRefresh=sequence;
  const changed=!state||next.revision!==state.revision,docChanged=JSON.stringify({...doc,server_now:0})!==JSON.stringify({...documentState,server_now:0});
  if(changed){
    const old=state;
    const invalidated=new Set();
    for(const n of next.nodes){const previous=old?.nodes.find(p=>p.id===n.id);if(previous&&(JSON.stringify(previous.answer)!==JSON.stringify(n.answer)||(n.status==='needs_review'&&previous.status!=='needs_review')))invalidated.add(n.id);}
    let count;do{count=invalidated.size;for(const n of next.nodes)if(n.depends_on.some(id=>invalidated.has(id)))invalidated.add(n.id);}while(count!==invalidated.size);
    for(const n of next.nodes)if(n.status==='answered'||invalidated.has(n.id)){drafts.delete(n.id);working.delete(n.id);}
    if(old&&old.current_round!==next.current_round){currentId=null;waitingSince=null;}
    state=next;
  }
  documentState=doc;
  if(isWaiting()){if(waitingSince===null)waitingSince=performance.now()-(progress?.session_id===state.session_id&&progress.revision===state.revision&&progress.started_at!==null?Math.max(0,progress.server_now-progress.started_at):0);}else waitingSince=null;
  const key=['requested','generating'].includes(doc.phase)?state.session_id+'/'+doc.job_id:null;
  if(key!==documentKey){documentKey=key;documentSince=key?performance.now()-Math.max(0,(doc.server_now??Date.now())-(doc.started_at??Date.now())):null;}
  document.querySelector('#connection').textContent=state.status==='complete'?(allConfirmed()?'已保存 · 本机文档预览':'保存状态与答案待核对'):'已连接本机';
  if(changed||docChanged||force||renderFailed)render();
}
async function poll(){if(stopped)return;try{await refresh();}catch(error){if(!stopped){document.querySelector('#connection').textContent='连接已断开，正在重连；已提交答案仍在本机。';if(!state)message('暂时读不到问题，将自动重连。',true);}}if(!stopped)setTimeout(poll,1000);}
setInterval(()=>{const late=document.querySelector('#long-wait');if(late)late.hidden=waitingSince===null||performance.now()-waitingSince<=60000;const elapsed=document.querySelector('#wait-elapsed');if(elapsed)elapsed.textContent=`已等待 ${Math.max(0,Math.floor((performance.now()-Number(elapsed.dataset.since))/1000))} 秒`;},500);
poll();
