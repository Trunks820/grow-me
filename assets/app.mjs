import {createDecisionTree} from './tree.mjs';
import {chapters,answerText} from './topics.mjs';
import {publicError,assistantConnection} from './presentation.mjs';
import {selectionValid} from './answers.mjs';

const card=document.querySelector('#card'),dialog=document.querySelector('#node-dialog'),questionHeading=document.querySelector('#question-heading'),budGuide=document.querySelector('#bud-guide');
const drafts=new Map(),working=new Map();
let noteId=null,noteMode='read',noteRevision=null,noteBusy=false,noteFrame=0,noteMotion=null,advanceId=null,lastAnsweredId=null,guideSeen=false;
try{guideSeen=sessionStorage.getItem('grow-me:bud-guide-seen')==='1';}catch{}
let guidance={};
let aiActivity=null,aiInstance=null,aiOpenedAt=performance.now(),aiObservedAt=performance.now(),assistantDisplay='inactive',reportedPause=false;
const pageId=crypto.randomUUID();
const pauseText=()=>`已 ${Math.max(0,Math.floor((aiActivity?.seconds_since_last_check??0)+(performance.now()-aiObservedAt)/1000))} 秒没收到 AI 回应，回聊天窗口发\"继续\"`;
let state,documentState={phase:'idle'},currentId=null,busy=false,waitingSince=null,documentSince=null,documentKey=null,stopped=false,returnFocus=null,rendering=false,renderFailed=false,refreshSequence=0,appliedRefresh=0,messageTimer;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const message=(text,error=false)=>{const n=document.querySelector('#message');clearTimeout(messageTimer);n.textContent=text?publicError(text):'';n.setAttribute('role',error?'alert':'status');if(text)messageTimer=setTimeout(()=>{n.textContent='';},8000);};
const view=createDecisionTree(document.querySelector('#decision-tree'),{onNode:openNode,onFruit:openFruit});
// A visible, half-open question bud; branch geometry and the seeded renderer stay unchanged.
document.querySelector('#tree-bud').innerHTML=`<path d="M0 6 Q1 3 0 1" fill="none" stroke="#827d58" stroke-width=".9"/>
<path d="M0 4 C-3 1 -3 -4 0 -7 C3 -4 3 1 0 4Z" fill="#f8eed9" stroke="#9b8663" stroke-width=".65"/>
<path d="M0 5 C-5 3 -6 -1 -5 -4 C-2 -4 0 0 0 5Z" fill="#c9b78d" stroke="#8e7e5e" stroke-width=".7"/>
<path d="M0 5 C5 3 6 -1 5 -4 C2 -4 0 0 0 5Z" fill="#e4d3ae" stroke="#8e7e5e" stroke-width=".7"/>
<path d="M-3 4 Q0 7 3 4" fill="none" stroke="#898261" stroke-width=".8"/>`;
const ready=n=>n.depends_on.every(id=>state.nodes.find(n=>n.id===id)?.status==='answered');
const valid=(n,a)=>ready(n)&&selectionValid(n,a);
const openQuestions=()=>state.nodes.filter(n=>n.round===state.current_round&&n.status==='pending');
const reviews=()=>state.nodes.filter(n=>n.status==='needs_review');
const isWaiting=()=>state?.schema_version===2&&state.status==='active'&&state.nodes.every(n=>n.status==='answered');
const allConfirmed=()=>Boolean(state?.nodes.length)&&state.nodes.every(n=>n.status==='answered'&&n.answer!==null);
const documentMatches=()=>documentState.source?.session_id===state.session_id&&documentState.source?.revision===state.revision;
function navigationTarget(){
  if(state?.schema_version!==2||state.status!=='active')return null;
  const review=reviews(),active=state.nodes.find(n=>n.id===advanceId&&ready(n));
  if(review.length)return active?.status==='needs_review'?active:review.find(ready)??null;
  if(active?.status==='pending'&&active.round===state.current_round&&(!drafts.has(active.id)||working.has(active.id)))return active;
  return openQuestions().find(n=>!drafts.has(n.id)&&ready(n))??null;
}
function guideText(target){
  if(!guideSeen)return '点这里开始';
  const pending=openQuestions(),draftCount=pending.filter(n=>drafts.has(n.id)).length,remaining=pending.length-draftCount;
  if(draftCount===1)return '接着聊这朵';
  if(remaining===1)return '就差这朵了';
  const phrases=['顺便定下这个','这块你怎么想？','还有个细节','看下这块怎么定','这规矩定一下'];
  const hash=[...(target?.id??'')].reduce((s,c)=>s+c.charCodeAt(0),0);
  return phrases[hash%phrases.length];
}
function updateNavigation(){
  const target=navigationTarget();
  for(const flower of document.querySelectorAll('.tree-node')){
    const current=flower.dataset.nodeId===target?.id;flower.classList.toggle('is-next',current);
    if(current)flower.setAttribute('aria-current','step');else flower.removeAttribute('aria-current');
  }
  const next=document.querySelector('#next-question');if(next){next.disabled=busy||!target;next.dataset.target=target?.id??'';}
  budGuide.hidden=!target||dialog.open||stopped;budGuide.disabled=busy;
  budGuide.dataset.target=target?.id??'';
  budGuide.textContent=target?.status==='needs_review'?'这片叶子，再看看':guideText(target);
  budGuide.setAttribute('aria-label',`${budGuide.textContent}${target?'：'+target.question:''}`);
  syncNotePosition();
}
function nextQuestion(){
  if(busy||stopped)return;const n=navigationTarget();if(!n)return;
  const target=nodeTarget(n.id),box=target?.getBoundingClientRect(),frame=document.querySelector('.tree-viewport').getBoundingClientRect();
  // Keep the current framing unless a manual zoom has put the destination outside the canvas.
  if(box&&(box.left<frame.left||box.right>frame.right||box.top<frame.top||box.bottom>frame.bottom))document.querySelector('[data-tree-zoom=fit]').click();
  openNode(n.id,target,n.id===advanceId&&working.has(n.id)?'edit':undefined);
}
function confirmed(id){
  lastAnsweredId=id;
  guideSeen=true;try{sessionStorage.setItem('grow-me:bud-guide-seen','1');}catch{}
  if(advanceId===id)advanceId=null;
}
function assistantStatus(){
  const offered=documentState.phase==='offered'&&documentState.offered_revision===state?.revision;
  const writing=state?.status==='complete'&&documentMatches()&&['requested','generating'].includes(documentState.phase);
  if(state?.schema_version!==2||!(isWaiting()&&!offered||writing))return 'inactive';
  return assistantConnection(aiActivity,performance.now()-aiOpenedAt);
}
function heartbeatNote(){
  const text=aiActivity?.heartbeat_active?{questions:'AI 正在出题',code:'AI 正在查代码',document:'AI 正在写文档'}[aiActivity.heartbeat_activity]:null;
  return text?'心跳报告：'+text+'（不代表对话仍在继续）':'';
}
function waitingHeader(title,progress){
  if(['paused','connecting'].includes(assistantDisplay)){
    const paused=assistantDisplay==='paused',notice=el('p',paused?pauseText():'请回到聊天窗口让 AI 继续，或点「复制提醒」粘贴过去。你的答案已保存。','ai-wait-notice');notice.id='ai-wait-notice';
    card.append(el('h2',paused?'等待 AI 对话续接':'等待 AI 对话连接','q'),notice);if(paused)card.append(el('p','也可以点「复制提醒」粘贴过去。你的答案已保存，不会丢。','w'));
  }else card.append(el('h2',title,'q'),el('p',progress,'growth-status'));
  const note=el('p',heartbeatNote(),'w');note.id='heartbeat-work';note.hidden=!note.textContent;card.append(note);
}

async function post(path,body){
  if(stopped)throw Error('请先恢复原访谈，再继续操作。');
  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,expected_session_id:state.session_id})});
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('本机服务返回格式异常，请重试。');
  let result;try{result=await response.json();}catch{throw Error('本机服务返回格式异常，请重试。');}
  if(!response.ok)throw Error(publicError(result.error,'提交暂时失败，请重试。'));return result;
}
async function act(action){
  if(busy)return false;busy=true;document.querySelectorAll('#card button,#node-dialog button').forEach(b=>b.disabled=true);
  try{await action();message('');if(!stopped)await refresh(true);return true;}
  catch(error){message(publicError(error.message)+'；已保留仍有效的草稿。',true);await refresh(true).catch(()=>{});return false;}
  finally{busy=false;if(!stopped)render();}
}
function button(label,action,primary=false){const b=el('button',label,primary?'primary':'');b.type='button';b.addEventListener('click',action);return b;}
function docAction(action){return act(async()=>{await post('/document/control',{action,expected_revision:state.revision,job_id:documentState.job_id});});}
function updateMeta(){
  const meta=document.querySelector('#meta'),total=state.nodes.length,done=state.nodes.filter(n=>n.status==='answered').length,review=reviews().length,complete=state.status==='complete';
  // Topic first (what this tree is about), then where we are, then a hairline of progress.
  const progress=el('span',undefined,'meta-progress');
  progress.append(el('span',complete?`共完成 ${new Set(state.nodes.map(n=>n.round)).size} 轮`:`第 ${state.current_round} 轮`,'meta-round'));
  if(!complete)progress.append(el('span',' · 总轮数随回答确定','meta-note'));
  progress.append(el('span',` · 已确认 ${done} / ${total}`));
  if(drafts.size)progress.append(el('span',` · 本轮未提交 ${drafts.size}`,'meta-draft'));
  if(review)progress.append(el('span',` · 待复核 ${review}`,'meta-review'));
  const bar=el('span',undefined,'meta-bar');bar.setAttribute('aria-hidden','true');
  bar.style.setProperty('--done',String(total?done/total:0));bar.style.setProperty('--reach',String(total?Math.min(1,(done+drafts.size)/total):0));
  meta.replaceChildren(el('span',state.topic,'meta-topic'),progress,bar);meta.title=state.topic;
  meta.dataset.revision=String(state.revision);card.dataset.revision=String(state.revision);
}
function updateTree(){const finished=documentState.phase==='offered'&&documentState.offered_revision===state.revision;view.update(state,{drafts,currentId,waiting:isWaiting()&&!finished&&assistantDisplay==='connected',finished,fruitStates:new Map(chapters(state).map(c=>[c.id,documentMatches()?(documentState.chapters?.find(x=>x.id===c.id)?.status??(documentState.phase==='ready'?'ready':'generating')):'generating']))});updateMeta();updateNavigation();}
function inputs(n,host){
  const value=working.get(n.id)??drafts.get(n.id)??n.answer??{option_ids:[],text:''};
  const form=el('form',undefined,'question-form');let read;
  if(n.input!=='text'){
    const multiple=n.input==='multi_choice',advice=guidance[n.id];let recommendation;
    if(advice){
      const info=el('details',undefined,'recommendation-info');recommendation=info;info.append(el('summary','查看推荐'));
      if(advice.stale)info.append(el('p','推荐依据已变／待复核，旧推荐已隐藏。','w'));
      else{
        info.append(el('p','AI 建议，不是你的决定','recommendation-label'),el('p',advice.reason.replace(/^AI 建议[，,]不是你的决定[：:，,。\s]*/,''),'w'));
        const choices=el('ul',undefined,'recommended-options');for(const option of n.options.filter(o=>advice.option_ids.includes(o.id)))choices.append(el('li',option.label));info.append(choices);
        for(const source of advice.sources){const line=el('p',undefined,'recommendation-source');line.append(el('span',`根据你第 ${source.round} 轮说的“${source.answer}”，不对请改。`),button('回看依据',event=>openNode(source.id,event?.currentTarget)));info.append(line);}
      }
      form.append(info);
    }
    const group=el('fieldset',undefined,'choice-group'),legend=el('legend',multiple?'选择一项或多项':'选择一项','sr-only');group.append(legend);
    n.options.forEach((o,i)=>{const label=el('label',undefined,'option'),input=document.createElement('input');input.type=multiple?'checkbox':'radio';input.name='answer';input.value=o.id;input.checked=value.option_ids.includes(o.id);input.setAttribute('aria-label',o.label);input.dataset.exclusive=String(Boolean(o.exclusive));const copy=el('span',o.label,'option-copy');
      if(advice&&!advice.stale&&advice.option_ids.includes(o.id)){const badge=el('span','推荐','recommendation-badge');badge.hidden=true;copy.append(badge);}
      if(o.exclusive)copy.append(el('span','与其他选项互斥','exclusive-hint'));
      label.append(input,copy);group.append(label);input.dataset.shortcut=String(i+1);
    });
    recommendation?.addEventListener('toggle',()=>{for(const badge of group.querySelectorAll('.recommendation-badge'))badge.hidden=!recommendation.open;});
    group.addEventListener('change',event=>{const input=event.target;if(!multiple||!input.checked)return;for(const other of group.querySelectorAll('input'))if(other!==input&&(input.dataset.exclusive==='true'||other.dataset.exclusive==='true'))other.checked=false;});
    const notes=el('details',undefined,'notes'),summary=el('summary','补一句'),label=el('label','补充说明（可选）','sr-only'),area=el('textarea',undefined,'field');area.id='answer-note';label.htmlFor=area.id;area.value=value.text;notes.open=Boolean(value.text);notes.append(summary,label,area);form.append(group,notes);
    read=()=>({option_ids:[...group.querySelectorAll('input:checked')].map(n=>n.value),text:area.value});
  }else{
    const label=el('label',n.question,'sr-only'),area=el('textarea',undefined,'field');area.id='answer-text';label.htmlFor=area.id;area.value=value.text;area.placeholder='写下你的想法';form.append(label,area);read=()=>({option_ids:[],text:area.value});
  }
  const tools=el('div',undefined,'note-tools');for(const selector of ['.notes','.recommendation-info']){const detail=form.querySelector(selector);if(detail)tools.append(detail);}form.append(tools);
  const toolbar=el('div',undefined,'actions'),confirm=el('button','就这么定','primary');confirm.type='submit';confirm.id='confirm-answer';toolbar.append(el('span',n.status==='needs_review'?'保存修改 · 下游需复核':'整轮提交后保存','draft-hint'),confirm);form.append(toolbar);
  const update=()=>{if(rendering||!form.isConnected)return;working.set(n.id,read());confirm.disabled=busy||!valid(n,read());};
  form.addEventListener('input',update);form.addEventListener('change',update);confirm.disabled=busy||!valid(n,read());
  if(!ready(n)){form.querySelectorAll('input,textarea').forEach(x=>x.disabled=true);host.append(el('p','请先确认上游的黄叶，再回来回答这一句。','review-note'));}
  form.addEventListener('submit',event=>{event.preventDefault();if(confirm.disabled)return;const answer=read();
    if(n.status==='needs_review')act(async()=>{await post('/decision',{id:n.id,expected_revision:state.revision,answer});confirmed(n.id);closeNote();});
    else{drafts.set(n.id,structuredClone(answer));working.delete(n.id);confirmed(n.id);closeNote();message('');render();}
  });
  host.append(form);
}
function renderSummary(host){
  const list=el('ul',undefined,'summary-list');
  openQuestions().filter(n=>drafts.has(n.id)).forEach(n=>{const row=el('li');row.append(el('div',n.question),el('div',answerText(n,drafts.get(n.id)),'answer'),button('回看这朵花',()=>openNode(n.id,nodeTarget(n.id))));list.append(row);});
  const title=el('h2',`第 ${state.current_round} 轮 · 答案核对`,'q');title.id='node-question';host.append(title,list,el('p','本轮未提交 · 刷新或关闭会丢失这些草稿。','draft-hint'));
  const submit=button('提交本轮答案',()=>act(async()=>{
    const round=state.current_round,revision=state.revision,answers=openQuestions().map(n=>({id:n.id,answer:drafts.get(n.id)}));
    if(!answers.every(a=>valid(state.nodes.find(n=>n.id===a.id),a.answer)))throw Error('请完整回答本轮问题');
    await post('/submit',{round,expected_revision:revision,answers});waitingSince=performance.now();closeNote();
  }),true);
  submit.className='primary seal-btn';
  submit.setAttribute('aria-label','提交本轮答案');
  submit.innerHTML='<span class="seal-mark">盖章</span><span class="seal-text">定了 · 接着长 ↗</span>';
  submit.disabled=busy||reviews().length>0||openQuestions().some(n=>!drafts.has(n.id));host.append(submit);
}
function renderWaiting(){
  card.append(el('p',`第 ${state.current_round} 轮 · 已确认`,'k'));waitingHeader('正在想下一轮的问题…','生长中');card.append(elapsedLine(waitingSince),el('p','可以点已答的花回看或修改。','w'));
  if(assistantDisplay==='connected'){const late=el('p','还在想，可以先回看已答的花','w');late.id='long-wait';late.hidden=waitingSince===null||performance.now()-waitingSince<=60000;card.append(late);}
  if(documentState.phase==='offered'&&documentState.offered_revision===state.revision){card.replaceChildren(el('p','需求已问清','k'),el('h2','这一棵树，可以结果了。','q'),el('p','保存后这次访谈只读，接下来生成方案、开发清单与验收标准。','w'),button('保存并生成任务文档',()=>docAction('save'),true));}
}
function elapsedLine(since){const line=el('p','', 'wait-elapsed');line.id='wait-elapsed';line.setAttribute('aria-live','off');line.dataset.since=String(since??performance.now());line.textContent=`已等待 ${Math.max(0,Math.floor((performance.now()-Number(line.dataset.since))/1000))} 秒`;return line;}
function chapterList(){
  const list=el('ul',undefined,'chapters');
  chapters(state).forEach(c=>{const li=el('li'),ready=documentMatches()&&(documentState.phase==='ready'||documentState.chapters?.some(x=>x.id===c.id&&x.status==='ready'));
    if(ready){const a=el('a');a.append(el('span',c.title,'chapter-title'),el('span',' · 可阅读','chapter-state'));a.href='/document'+(documentState.phase==='ready'?'':'?chapter='+encodeURIComponent(c.id))+'#'+c.anchor;a.target='_blank';a.rel='noopener';li.append(a);}
    else li.append(el('span',c.title),el('span',documentState.phase==='failed'?' · 待重试':' · 生成中','chapter-pending'));list.append(li);
  });return list;
}
function renderDocument(){
  const phase=documentState.phase;card.append(el('p','已保存 · 只读','k'));
  if(phase==='ready'){
    if(!documentMatches()){card.append(el('h2','正在同步任务文档…','q'),el('p','正在核对当前访谈与文档的版本。','w'));return;}
    card.append(el('h2','问过的，都结成了果。','q'),el('p',`${state.nodes.length} 个问题已确认 · ${chapters(state).length} 颗果子，点击打开对应章节。`,'w'));
    card.append(chapterList());
    const actions=el('div',undefined,'doc-actions');
    const link=el('a','打开完整任务文档','doc-link');link.href='/document';link.target='_blank';link.rel='noopener';
    const download=el('a','保存 HTML 文件','doc-secondary');download.href='/document?download=1';download.download='task.html';
    actions.append(link,download,button('结束预览',()=>act(async()=>{await post('/document/control',{action:'close',expected_revision:state.revision});stopped=true;document.querySelector('#connection').textContent='预览已结束；任务 HTML 已保存在本机。';}),false));card.append(actions);
  }else if(phase==='failed'){
    card.append(el('h2','文档暂时没生成。','q'),el('p',publicError(documentState.error,'文档生成遇到问题，请重试。'),'w'),chapterList(),button('重试生成文档',()=>docAction('retry'),true),el('p','答案已经保存，不用重新答。','w'));
  }else{
    const stage={queued:'等待当前对话接手',drafting:'正在整理三个视图',design:'正在整理设计方案',plan:'正在整理开发清单',acceptance:'正在整理验收标准',checking:'正在校验章节、引用和来源'}[documentState.stage]??'正在整理三个视图';
    const done=documentState.chapters?.filter(c=>c.status==='ready').length??0;
    waitingHeader('正在生成任务文档…','生长中 · '+stage);card.append(elapsedLine(documentSince),el('p',`已完成 ${done} / ${chapters(state).length} 章；完成的章节可以先读。`,'w'),chapterList());if(assistantDisplay==='inactive'||assistantDisplay==='connected')card.append(el('p','答案已保存。若当前对话已中断，请回到原对话说“继续”。','w'));
  }
}
function render(){
  if(!state)return;rendering=true;renderFailed=false;try{
  assistantDisplay=assistantStatus();const reminder=document.querySelector('#copy-reminder');reminder.classList.toggle('needs-attention',assistantDisplay==='paused');if(assistantDisplay==='paused')reminder.setAttribute('aria-describedby','ai-wait-notice');else reminder.removeAttribute('aria-describedby');
  card.replaceChildren();
  if(state.schema_version===1){currentId=null;card.append(el('p','v1 历史访谈 · 只读','k'),el('h2','原来的回答，仍在这棵树上。','q'),el('p','可以点击花朵回看；未完成的旧访谈请用原 alpha 版本继续。不会自动迁移或补写历史理由。','w'));if(documentState.phase==='ready'){const a=el('a','打开原任务文档','doc-link');a.href='/document';a.target='_blank';a.rel='noopener';card.append(a);}card.append(button('结束预览',()=>act(async()=>{await post('/document/control',{action:'close',expected_revision:state.revision});stopped=true;document.querySelector('#connection').textContent='只读预览已结束；原访谈文件保持不变。';})));}
  else if(state.status==='complete'){currentId=null;if(allConfirmed())renderDocument();else card.append(el('p','状态待核对','k'),el('h2','保存状态与答案不一致。','q'),el('p',`当前只有 ${state.nodes.filter(n=>n.status==='answered').length} / ${state.nodes.length} 个问题已确认；请回到原对话核对 tree.json。`,'w'));}
  else{
    const pending=openQuestions(),review=reviews();
    if(pending.length||review.length){
      const count=pending.filter(n=>drafts.has(n.id)).length,ready=count===pending.length&&!review.length;
      card.append(el('p',`${count?`本轮 ${count} 个草稿 · `:''}${pending.length-count} 枚花苞${review.length?` · ${review.length} 片黄叶待复核`:''}`,'scene-count'));
      if(navigationTarget()){const next=button('下一题 →',nextQuestion);next.id='next-question';card.append(next);}
      if(count){
        if(ready){
          const prompt=el('div',undefined,'seal-prompt');
          const meta=el('div',undefined,'seal-meta');
          meta.append(el('span',`第 ${state.current_round} 轮齐了`,'seal-round'),el('span','敲空格或轻触盖章','seal-hint'));
          const summary=button('回看汇总，提交本轮',openSummary,true);
          summary.className='primary seal-btn';
          summary.setAttribute('aria-label','回看汇总，提交本轮');
          summary.innerHTML='<span class="seal-mark">盖章</span><span class="seal-text">接着长 ↗</span>';
          prompt.append(meta,summary);
          card.append(prompt);
        }else{
          const summary=button('查看本轮草稿',openSummary,false);
          card.append(summary);
        }
      }
      if(review.length)card.append(el('p','点黄叶回看；确认上游后，再复核下游。','w'));
      const work=el('p',heartbeatNote(),'w');work.id='heartbeat-work';work.hidden=!work.textContent;card.append(work);
    }else renderWaiting();
  }
  if(reportedPause!==(assistantDisplay==='paused')){reportedPause=assistantDisplay==='paused';post('/ai/telemetry',{event:reportedPause?'pause_shown':'pause_cleared',page_id:pageId,last_check_at:aiActivity?.last_check_at,expected_revision:state.revision,expected_instance_id:aiInstance}).catch(()=>{});}
  card.dataset.currentId=currentId??'';card.dataset.scene=state.status==='complete'?'document':openQuestions().length||reviews().length?'questions':'waiting';updateTree();
  if(dialog.open&&(noteRevision!==state.revision||noteBusy!==busy)){if(noteId)renderNote();else if(noteMode==='summary')renderSummaryNote();}
  syncNotePosition();
  }catch(error){renderFailed=true;card.replaceChildren(el('h2','正在同步生长状态…','q'),el('p','生长中','growth-status'),elapsedLine(state.status==='complete'?documentSince:waitingSince),el('p','已提交答案仍在本机，将自动重新读取。','w'));message('页面状态正在同步，稍后会自动恢复。',true);console.error('State rendering failed');}finally{rendering=false;}
}
function nodeTarget(id){return [...document.querySelectorAll('.tree-node')].find(n=>n.dataset.nodeId===id);}
function closeNote(){dialog.close();noteId=null;currentId=null;questionHeading.hidden=true;document.querySelector('#bubble-link').setAttribute('hidden','');document.body.classList.remove('note-open');updateNavigation();}
function showNote(){
  noteMotion?.cancel();if(!dialog.open)dialog.show();document.body.classList.add('note-open');questionHeading.hidden=!noteId;budGuide.hidden=true;dialog.scrollTop=0;positionNote();
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches){noteMotion=dialog.animate([{opacity:0,transform:'scale(.96)'},{opacity:1,transform:'none'}],{duration:150,easing:'ease-out'});document.querySelector('#bubble-link').animate([{opacity:0},{opacity:1}],{duration:150,easing:'ease-out'});}
  document.querySelector('#node-question')?.focus({preventScroll:true});syncNotePosition();setTimeout(syncNotePosition,120);
}
function editDraft(id){const value=drafts.get(id);if(value)working.set(id,structuredClone(value));openNode(id,nodeTarget(id),'edit');}
function openNode(id,trigger,mode){
  if(busy||stopped)return;const n=state.nodes.find(n=>n.id===id);if(!n)return;
  noteId=currentId=id;returnFocus=nodeTarget(id)??trigger;
  noteMode=mode??(state.schema_version===2&&state.status==='active'&&n.status==='pending'&&!drafts.has(id)?'edit':'read');
  if((noteMode==='edit'||n.status==='needs_review')&&ready(n))advanceId=id;
  renderNote();showNote();render();
}
async function modifyAnswer(id){
  if(drafts.has(id))return editDraft(id);
  const n=state.nodes.find(n=>n.id===id);if(!n)return;
  if(n.status!=='needs_review'){
    const ok=await act(async()=>{await post('/reopen',{id,expected_revision:state.revision});});
    if(!ok||state.status!=='active'||state.nodes.find(n=>n.id===id)?.status!=='needs_review')return;
  }
  openNode(id,nodeTarget(id),'edit');
}
function renderNote(){
  const n=state.nodes.find(n=>n.id===noteId);if(!n){closeNote();return;}
  if(state.schema_version===1||state.status!=='active'||n.status==='answered')noteMode='read';
  const body=document.querySelector('#node-body'),actions=document.querySelector('#node-actions');body.replaceChildren();actions.replaceChildren();questionHeading.replaceChildren();
  const previous=state.nodes.find(p=>p.id===lastAnsweredId&&p.id!==n.id&&(drafts.has(p.id)||p.status==='answered'))??n.depends_on.map(id=>state.nodes.find(n=>n.id===id)).filter(n=>n?.answer).sort((a,b)=>b.round-a.round)[0];
  if(previous){const text=answerText(previous,drafts.get(previous.id)??previous.answer),aside=el('details',undefined,'previous-answer'),summary=el('summary');summary.append(el('small','上一句'),el('span',text,'previous-excerpt'));aside.append(summary,el('blockquote',text));questionHeading.append(aside);aside.addEventListener('toggle',positionNote);}
  const heading=el('h2',n.question);heading.id='node-question';heading.tabIndex=-1;questionHeading.append(heading);
  if(n.status==='needs_review')body.append(el('p','上游或本题有改动，这个回答需要再确认。','review-note'));
  if(noteMode==='edit')inputs(n,body);
  else{
    body.append(el('p',answerText(n,drafts.get(n.id)??n.answer)||'尚未回答。','answer'));
    body.append(el('p',drafts.has(n.id)?'本轮草稿 · 尚未提交':n.status==='needs_review'?'旧回答 · 待复核':`第 ${n.round} 轮 · 已确认`,'draft-hint'));
    if(state.schema_version===2&&state.status==='active')actions.append(button('改',()=>modifyAnswer(n.id)));
  }
  if(state.schema_version===2&&state.status==='active'&&n.status==='needs_review'&&n.answer!==null){const keep=button('仍然有效',()=>act(async()=>{await post('/decision',{id:n.id,expected_revision:state.revision,answer:n.answer});confirmed(n.id);closeNote();}));keep.disabled=busy||!ready(n);actions.append(keep);}
  if(n.rationale){const reason=el('details',undefined,'question-reason');reason.append(el('summary','为什么问这句'),el('p',n.rationale));questionHeading.append(reason);reason.addEventListener('toggle',positionNote);}
  for(const detail of body.querySelectorAll('.note-tools > details'))detail.addEventListener('toggle',positionNote);
  noteRevision=state.revision;noteBusy=busy;dialog.dataset.mode=noteMode;dialog.dataset.nodeId=n.id;
  if(busy)dialog.querySelectorAll('input,textarea,button').forEach(n=>n.disabled=true);else document.querySelector('#close-node').disabled=false;
  positionNote();
}
function renderSummaryNote(){questionHeading.replaceChildren();questionHeading.hidden=true;const body=document.querySelector('#node-body');body.replaceChildren();document.querySelector('#node-actions').replaceChildren();renderSummary(body);document.querySelector('#node-question').tabIndex=-1;document.querySelector('#close-node').disabled=busy;noteRevision=state.revision;noteBusy=busy;dialog.dataset.mode='summary';delete dialog.dataset.nodeId;}
function openSummary(event){if(busy)return;noteId=currentId=null;noteMode='summary';returnFocus=event?.currentTarget;renderSummaryNote();showNote();updateTree();}
function positionNote(){
  const viewport=window.visualViewport;
  document.documentElement.style.setProperty('--visible-height',`${viewport?.height??innerHeight}px`);
  document.documentElement.style.setProperty('--visible-top',`${viewport?.offsetTop??0}px`);
  const link=document.querySelector('#bubble-link');link.setAttribute('hidden','');
  if(!budGuide.hidden){
    const point=flowerPoint(budGuide.dataset.target);
    budGuide.style.visibility=point?'visible':'hidden';
    if(point){const width=budGuide.offsetWidth,height=budGuide.offsetHeight,place=bubblePlace(point,width,height,budGuide.dataset.target,true)??bubblePlace(point,width,height,budGuide.dataset.target,true,true,true);budGuide.style.visibility=place?'visible':'hidden';if(place){budGuide.style.left=place.x+'px';budGuide.style.top=place.y+'px';drawBubbleTail(budGuide,place,point,17);}}
  }
  if(!dialog.open)return;
  const n=state?.nodes.find(n=>n.id===noteId),point=n?flowerPoint(n.id):null;
  // Every question is a speech bubble beside its bud; long question text wraps
  // in the top heading and many options make the bubble taller (scrolls inside).
  questionHeading.classList.toggle('long',!!n&&n.question.length>36);
  dialog.dataset.placement='bubble';dialog.style.left='0px';dialog.style.top='0px';
  const wide=n&&(n.options.some(o=>o.label.length>12)||n.input==='text'||noteMode==='read');
  // Round summary and the copy-reminder fallback have no bud and carry more text.
  dialog.style.width=(!n?Math.min(360,innerWidth-32):wide&&innerWidth>=600?300:Math.min(248,innerWidth-40))+'px';
  if(!point){
    if(noteMode==='summary'&&innerWidth>=768){dialog.style.left='auto';dialog.style.right='44px';dialog.style.top='auto';dialog.style.bottom='36px';return;}
    dialog.style.left=Math.max(10,(innerWidth-dialog.offsetWidth)/2)+'px';dialog.style.top=Math.max(10,innerHeight-dialog.offsetHeight-20)+'px';return;
  }
  let place=bubblePlace(point,dialog.offsetWidth,dialog.offsetHeight,n.id)??bubblePlace(point,dialog.offsetWidth,dialog.offsetHeight,n.id,false,true)??bubblePlace(point,dialog.offsetWidth,dialog.offsetHeight,n.id,false,true,true);
  let w=dialog.offsetWidth,h=dialog.offsetHeight;dialog.style.maxHeight='';
  const covers=p=>p.x-6<point.x&&point.x<p.x+w+6&&p.y-6<point.y&&point.y<p.y+h+6;
  const tr=document.querySelector('.tree-trunk')?.getBoundingClientRect(),onTrunk=p=>tr&&p.x<tr.right&&p.x+w>tr.left&&p.y<tr.bottom&&p.y+h>tr.top;
  // Cramped viewports (e.g. mobile keyboard open): try a slimmer bubble at the side first.
  for(const width of [220,200,180,168,156]){if(!(covers(place)||onTrunk(place))||innerWidth>=600||n.options.length>4)break;dialog.style.width=width+'px';w=dialog.offsetWidth;h=dialog.offsetHeight;const p=bubblePlace(point,w,h,n.id)??bubblePlace(point,w,h,n.id,false,true);if(p&&!covers(p)&&!onTrunk(p)){place=p;break;}}
  if(covers(place)||onTrunk(place)){
    // Never sit on the bud: hang below it (or above), shrinking with inner scroll.
    const limit=innerHeight-64,x=Math.max(10,Math.min(innerWidth-w-10,point.x-w/2)),top=Math.max(64,questionHeading.hidden?0:questionHeading.getBoundingClientRect().bottom+10);
    const below=limit-(point.y+18),above=point.y-18-top;
    const trunk=document.querySelector('.tree-trunk')?.getBoundingClientRect(),hitsTrunk=(y,hh)=>trunk&&x<trunk.right&&x+w>trunk.left&&y<trunk.bottom&&y+hh>trunk.top;
    const under=trunk&&trunk.bottom>point.y?trunk.bottom+8:null;
    const opts=[{y:point.y+18,room:below,down:true,pen:0},{y:null,room:above,down:false,pen:0},...(under&&point.y+18+60>under?[{y:under,room:limit-under,down:true,pen:.5}]:[])].map(o=>{const hh=Math.min(h,o.room),y=o.down?o.y:point.y-18-hh;return{...o,hh,y,score:(hitsTrunk(y,hh)?2:0)+(o.room>=h?0:1)+o.pen-o.room/1e4};}).filter(o=>o.room>40).sort((a,b)=>a.score-b.score);
    const o=opts[0];if(o){if(o.hh<h){dialog.style.maxHeight=o.hh+'px';h=dialog.offsetHeight;}place={x,y:o.down?o.y:point.y-18-h};}
  }
  dialog.style.left=place.x+'px';dialog.style.top=place.y+'px';
  drawBubbleTail(dialog,place,point,18);
}
// One closed path: rounded body (radius r) with a small blunt tail that grows
// out of the side facing the bud. No box-plus-triangle seams.
function drawBubbleTail(element,place,point,radius){
  const w=element.offsetWidth,h=element.offsetHeight,x0=place.x,y0=place.y,x1=x0+w,y1=y0+h,r=Math.min(radius,h/2,w/2),half=element===budGuide?6:7;
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n)),f=n=>Math.round(n*10)/10;
  const side=point.x<x0&&point.y>=y0-4&&point.y<=y1+4?'left':point.x>x1&&point.y>=y0-4&&point.y<=y1+4?'right':point.y<y0?'top':point.y>y1?'bottom':point.x<x0+w/2?'left':'right';
  const horizontal=side==='left'||side==='right';
  const c=horizontal?{x:side==='left'?x0:x1,y:clamp(point.y,y0+r+half,y1-r-half)}:{x:clamp(point.x,x0+r+half,x1-r-half),y:side==='top'?y0:y1};
  let dx=point.x-c.x,dy=point.y-c.y;const dist=Math.hypot(dx,dy)||1;dx/=dist;dy/=dist;
  const len=clamp(dist-9,8,90),tip={x:c.x+dx*len,y:c.y+dy*len};
  // Traversal is clockwise: top L→R, right T→B, bottom R→L, left B→T.
  const along={top:[1,0],right:[0,1],bottom:[-1,0],left:[0,-1]}[side];
  const a={x:c.x-along[0]*half,y:c.y-along[1]*half},b={x:c.x+along[0]*half,y:c.y+along[1]*half};
  const blunt=2.2,ta={x:tip.x-along[0]*blunt,y:tip.y-along[1]*blunt},tb={x:tip.x+along[0]*blunt,y:tip.y+along[1]*blunt};
  const tail=`L${f(a.x)} ${f(a.y)} Q${f(c.x+dx*len*.55-along[0]*1)} ${f(c.y+dy*len*.55-along[1]*1)} ${f(ta.x)} ${f(ta.y)} Q${f(tip.x+dx*2)} ${f(tip.y+dy*2)} ${f(tb.x)} ${f(tb.y)} Q${f(c.x+dx*len*.35+along[0]*2)} ${f(c.y+dy*len*.35+along[1]*2)} ${f(b.x)} ${f(b.y)} `;
  const t=side==='top'?tail:'',ri=side==='right'?tail:'',bo=side==='bottom'?tail:'',le=side==='left'?tail:'';
  const d=`M${f(x0+r)} ${f(y0)} ${t}L${f(x1-r)} ${f(y0)} Q${f(x1)} ${f(y0)} ${f(x1)} ${f(y0+r)} ${ri}L${f(x1)} ${f(y1-r)} Q${f(x1)} ${f(y1)} ${f(x1-r)} ${f(y1)} ${bo}L${f(x0+r)} ${f(y1)} Q${f(x0)} ${f(y1)} ${f(x0)} ${f(y1-r)} ${le}L${f(x0)} ${f(y0+r)} Q${f(x0)} ${f(y0)} ${f(x0+r)} ${f(y0)} Z`;
  const link=document.querySelector('#bubble-link');link.querySelector('.bubble-tail-fill').setAttribute('d',d);link.querySelector('.bubble-tail-edge').setAttribute('d',d);
  link.dataset.target=element===budGuide?budGuide.dataset.target:noteId;link.dataset.kind=element===budGuide?'guide':'options';link.dataset.side=side;link.dataset.tipX=f(tip.x);link.dataset.tipY=f(tip.y);
  element.dataset.side=side;element.style.transformOrigin=side==='left'?'0 50%':side==='right'?'100% 50%':side==='top'?'50% 0':'50% 100%';
  link.removeAttribute('hidden');
}
function flowerPoint(id){const node=nodeTarget(id);if(!node||node.dataset.visible==='false')return null;const box=node.querySelector('.tree-hit').getBoundingClientRect();return{x:box.x+box.width/2,y:box.y+box.height/2};}
function bubblePlace(point,width,height,id,guide=false,relaxed=false,fallback=false){
  const frame=document.querySelector('.tree-viewport').getBoundingClientRect(),matrix=document.querySelector('#tree-canvas').getScreenCTM();if(!matrix)return null;
  const minTop=questionHeading.hidden?frame.top:Math.max(64,questionHeading.getBoundingClientRect().bottom+10);
  const ink=[...document.querySelectorAll('.tree-trunk,.tree-node')].filter(n=>n.dataset.nodeId!==id).map(n=>n.getBoundingClientRect());
  const samples=view.getLayout().nodes.flatMap(n=>n.points.map(([x,y])=>({x:x*matrix.a+matrix.e,y:y*matrix.d+matrix.f})));
  const gap=18,outward=point.x<innerWidth/2?-1:1,clampX=x=>Math.max(10,Math.min(innerWidth-width-10,x));
  const sides=[18,42,66].flatMap(distance=>[outward,-outward].flatMap(side=>{const x=side>0?point.x+distance:point.x-width-distance;return[{x,y:point.y-height/2},{x,y:point.y+gap},{x,y:point.y-height-gap}];}));
  const vertical=[18,42,66,90].flatMap(distance=>[point.x-width/2,point.x-width/2+24,point.x-width/2-24,point.x-width+10,point.x-10].flatMap(x=>[{x:clampX(x),y:Math.max(minTop,point.y-height-distance)},{x:clampX(x),y:point.y+distance}]));
  const candidates=guide?[...vertical,...sides]:[...sides,...vertical];
  if(relaxed){for(let y=minTop;y+height<=frame.bottom;y+=16)for(let x=10;x+width<=innerWidth-10;x+=16)candidates.push({x,y});}
  const distance=p=>Math.hypot(Math.max(p.x-point.x,0,point.x-p.x-width),Math.max(p.y-point.y,0,point.y-p.y-height));
  candidates.sort((a,b)=>distance(a)-distance(b));
  const inFrame=p=>p.x>=10&&p.x+width<=innerWidth-10&&p.y>=minTop&&p.y+height<=frame.bottom;
  const collisions=p=>ink.filter(b=>p.x<b.right+5&&p.x+width>b.left-5&&p.y<b.bottom+5&&p.y+height>b.top-5).length;
  const best=candidates.find(p=>inFrame(p)&&!collisions(p)&&(relaxed||!samples.some(q=>q.x>p.x-6&&q.x<p.x+width+6&&q.y>p.y-6&&q.y<p.y+height+6)));
  if(best||!fallback)return best;
  // Tiny viewports may have no empty rectangle: retain the bubble outline and
  // use the least obstructive location; the existing zoom controls stay usable.
  return candidates.filter(inFrame).sort((a,b)=>collisions(a)-collisions(b))[0]??{x:clampX(point.x-width/2),y:Math.max(frame.top,frame.bottom-height)};
}
function syncNotePosition(){if(noteFrame)return;noteFrame=requestAnimationFrame(()=>{noteFrame=0;positionNote();if(document.querySelector('#tree-canvas').dataset.growing==='true')syncNotePosition();});}
function openFruit(fruit){const ready=documentMatches()&&(documentState.phase==='ready'||documentState.chapters?.some(c=>c.id===fruit.id&&c.status==='ready'));if(!allConfirmed()||!ready){message('这个章节还在生成，完成后果子会成熟。');return;}window.open('/document'+(documentState.phase==='ready'?'':'?chapter='+encodeURIComponent(fruit.id))+'#'+fruit.anchor,'_blank','noopener');}
document.querySelector('#close-node').addEventListener('click',closeNote);
budGuide.addEventListener('click',nextQuestion);
dialog.addEventListener('close',()=>{if(dialog.open)return;noteId=currentId=null;questionHeading.hidden=true;document.querySelector('#bubble-link').setAttribute('hidden','');document.body.classList.remove('note-open');returnFocus?.focus({preventScroll:true});if(state)updateTree();});
window.addEventListener('resize',syncNotePosition);
window.visualViewport?.addEventListener('resize',syncNotePosition);window.visualViewport?.addEventListener('scroll',syncNotePosition);
document.querySelector('.tree-controls').addEventListener('click',syncNotePosition);
window.addEventListener('beforeunload',event=>{if(state?.status==='active'&&(drafts.size||working.size)){event.preventDefault();event.returnValue='';}});
document.addEventListener('keydown',event=>{
  if(!state||busy)return;
  if(event.key==='Escape'){if(dialog.open){event.preventDefault();closeNote();}return;}
  if((event.code==='Space'||event.key===' ')&&!dialog.open&&!event.target.matches('textarea,input')){
    const seal=card.querySelector('.seal-btn');
    if(seal&&!seal.disabled){event.preventDefault();seal.click();return;}
  }
  if(!dialog.open)return;
  if(noteMode==='summary'){
    if(event.key==='Enter'||event.code==='Space'){
      const submit=dialog.querySelector('.seal-btn,.primary');
      if(submit&&!submit.disabled&&!event.target.matches('button')){event.preventDefault();submit.click();}
    }
    return;
  }
  if(noteMode!=='edit')return;const inText=event.target.matches('textarea,input[type=text]');
  if(inText){if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();dialog.querySelector('#confirm-answer')?.click();}return;}
  if(/^[1-9]$/.test(event.key)){const input=dialog.querySelector(`[data-shortcut="${event.key}"]`);if(input&&!input.disabled){event.preventDefault();input.checked=input.type==='checkbox'?!input.checked:true;input.dispatchEvent(new Event('change',{bubbles:true}));input.focus();}}
  else if(event.key==='Enter'&&event.target.matches('input[type=radio],input[type=checkbox]')){event.preventDefault();dialog.querySelector('#confirm-answer')?.click();}
});

async function refresh(force=false){
  const sequence=++refreshSequence;
  const [response,docResponse,progressResponse,adviceResponse]=await Promise.all([fetch('/state',{cache:'no-store'}),fetch('/document/status',{cache:'no-store'}),fetch('/progress',{cache:'no-store'}),fetch('/guidance',{cache:'no-store'})]);
  if(!response.ok||!docResponse.ok||!progressResponse.ok||!adviceResponse.ok)throw Error('读取本机状态失败');
  const next=await response.json(),doc=await docResponse.json(),progress=progressResponse.ok?await progressResponse.json():null,advice=await adviceResponse.json();
  if(stopped)return;
  if(state&&next.session_id!==state.session_id){stopped=true;document.querySelectorAll('#card input,#card button,#card textarea,#node-dialog input,#node-dialog button,#node-dialog textarea').forEach(n=>n.disabled=true);document.querySelector('#connection').textContent='此地址已换成另一个访谈。请复制提醒，恢复原会话后继续。';return;}
  const instance=response.headers.get('x-grow-me-instance');
  if(!instance||[docResponse,progressResponse,adviceResponse].some(r=>r.headers.get('x-grow-me-instance')!==instance)||progress?.session_id!==next.session_id||progress.revision!==next.revision||advice.session_id!==next.session_id||advice.revision!==next.revision||doc.source?.session_id!==next.session_id||doc.source?.revision!==next.revision)throw Error('状态正在变更，稍后重读');
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
  documentState=doc;guidance=advice.recommendations;document.querySelector('#copy-reminder').disabled=false;
  if(instance!==aiInstance){aiInstance=instance;aiOpenedAt=performance.now();}aiActivity=progress.ai??null;aiObservedAt=performance.now();
  if(isWaiting()){if(waitingSince===null)waitingSince=performance.now()-(progress?.session_id===state.session_id&&progress.revision===state.revision&&progress.started_at!==null?Math.max(0,progress.server_now-progress.started_at):0);}else waitingSince=null;
  const key=['requested','generating'].includes(doc.phase)?state.session_id+'/'+doc.job_id:null;
  if(key!==documentKey){documentKey=key;documentSince=key?performance.now()-Math.max(0,(doc.server_now??Date.now())-(doc.started_at??Date.now())):null;}
  document.querySelector('#connection').textContent=state.schema_version===1?'v1 历史访谈 · 只读':state.status==='complete'?(allConfirmed()?'已保存 · 本机文档预览':'保存状态与答案待核对'):'已连接本机';
  if(changed||docChanged||assistantDisplay!==assistantStatus()||force||renderFailed)render();
  const note=document.querySelector('#heartbeat-work');if(note){note.textContent=heartbeatNote();note.hidden=!note.textContent;}
}
async function poll(){if(stopped)return;try{await refresh();}catch(error){if(!stopped){document.querySelector('#connection').textContent='连接已断开，正在重连；已提交答案仍在本机。';if(!state)message('暂时读不到问题，将自动重连。',true);}}if(!stopped)setTimeout(poll,1000);}
document.querySelector('#copy-reminder').addEventListener('click',async()=>{
  if(!state)return;
  const text='请继续 grow-me。恢复后的第一步先运行一次 check.mjs，核对会话身份、实例和 revision，再做别的事；curl GET 不算轮询。服务若已停止，先按原启动回执重启原会话并立即运行 check.mjs。\n'+JSON.stringify({session_id:state.session_id,current_round:state.current_round,url:location.origin});
  try{await navigator.clipboard.writeText(text);message('提醒已复制，粘回原对话即可继续。');}
  catch{questionHeading.replaceChildren();questionHeading.hidden=true;const body=document.querySelector('#node-body'),actions=document.querySelector('#node-actions'),heading=el('h2','复制续接提醒');heading.id='node-question';heading.tabIndex=-1;noteId=currentId=null;noteMode='reminder';returnFocus=document.querySelector('#copy-reminder');body.replaceChildren(heading);actions.replaceChildren();const field=el('textarea',undefined,'field');field.readOnly=true;field.value=text;field.setAttribute('aria-label','续接提醒');body.append(el('p','复制下面的文字，粘回原对话。','w'),field);showNote();field.select();}
});
setInterval(()=>{const notice=document.querySelector('#ai-wait-notice');if(notice&&assistantDisplay==='paused')notice.textContent=pauseText();const late=document.querySelector('#long-wait');if(late)late.hidden=waitingSince===null||performance.now()-waitingSince<=60000;const elapsed=document.querySelector('#wait-elapsed');if(elapsed)elapsed.textContent=`已等待 ${Math.max(0,Math.floor((performance.now()-Number(elapsed.dataset.since))/1000))} 秒`;},500);
poll();
