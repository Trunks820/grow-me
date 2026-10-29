import {primaryGraph,chapters,answerText} from './topics.mjs';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const J=i=>{const x=Math.sin(i*127.1+311.7)*43758.5453;return x-Math.floor(x);};
const ease=t=>1-Math.pow(1-clamp(t,0,1),3);
function seed(id){let h=2166136261;for(const c of id){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return h>>>0;}
const point=(p,t)=>{const u=1-t;return{x:u*u*p.px+2*u*t*p.cx+t*t*p.x,y:u*u*p.py+2*u*t*p.cy+t*t*p.y};};
export function branchPoints(n){return Array.from({length:17},(_,k)=>{const p=point(n,k/16),dx=n.x-n.px,dy=n.y-n.py,L=Math.hypot(dx,dy)||1,w=Math.sin(k/16*Math.PI)*(J(n.seed*17+k)-.5)*5;return[p.x-dy/L*w,p.y+dx/L*w];});}
function taperedOutline(points,w0,w1,progress=1){
  if(progress<=0)return[];const f=clamp(progress,0,1),last=(points.length-1)*f,list=points.slice(0,Math.floor(last)+1);
  if(last%1){const a=points[Math.floor(last)],b=points[Math.ceil(last)];list.push([a[0]+(b[0]-a[0])*(last%1),a[1]+(b[1]-a[1])*(last%1)]);}
  if(list.length<2)list.push([...list[0]]);const left=[],right=[];
  list.forEach((q,k)=>{const a=list[Math.min(k+1,list.length-1)],b=list[Math.max(k-1,0)],dx=a[0]-b[0],dy=a[1]-b[1],d=Math.hypot(dx,dy)||1,w=(w0+(w1-w0)*k/(list.length-1)*f)/2*(1+Math.sin(k*2.3+w0)*.12);left.push([q[0]-dy/d*w,q[1]+dx/d*w]);right.push([q[0]+dy/d*w,q[1]-dx/d*w]);});
  return left.concat(right.reverse());
}
export function taper(points,w0,w1,progress=1){
  const outline=taperedOutline(points,w0,w1,progress);if(!outline.length)return'';const format=q=>q.map(x=>x.toFixed(2)).join(' ');
  return'M'+format(outline[0])+outline.map((p,k)=>{const a=outline[(k-1+outline.length)%outline.length],q=outline[(k+1)%outline.length],b=outline[(k+2)%outline.length];return'C'+format([p[0]+(q[0]-a[0])/6,p[1]+(q[1]-a[1])/6])+' '+format([q[0]-(b[0]-p[0])/6,q[1]-(b[1]-p[1])/6])+' '+format(q);}).join('')+'Z';
}
function curvedTwig(start,end,bend,width,tipWidth=.3){const dx=end[0]-start[0],dy=end[1]-start[1],l=Math.hypot(dx,dy)||1,p={px:start[0],py:start[1],x:end[0],y:end[1],cx:(start[0]+end[0])/2-dy/l*bend,cy:(start[1]+end[1])/2+dx/l*bend};return{points:Array.from({length:9},(_,i)=>{const q=point(p,i/8);return[q.x,q.y];}),width,tipWidth};}
export function branchTwigs(n,terminal){
  const result=[];for(const[k,sg]of[[6,-1],[11,1]]){const q=n.points[k],b=n.points[k+1],a=Math.atan2(b[1]-q[1],b[0]-q[0])+sg*(.5+J(n.seed+k)*.5),l=10+J(n.seed*3+k)*14;result.push(curvedTwig(q,[q[0]+Math.cos(a)*l,q[1]+Math.sin(a)*l-3],sg*(1.5+J(n.seed+k)*2),Math.max(1,n.width*.35),.4));}
  if(terminal){const q=n.points[16],b=n.points[14],a=Math.atan2(q[1]-b[1],q[0]-b[0]);for(const[k,da]of[-.55,.45].entries()){const l=9+J(n.seed+k*7)*9;result.push(curvedTwig(q,[q[0]+Math.cos(a+da)*l,q[1]+Math.sin(a+da)*l],da*3,1));}}
  return result;
}
export function layoutTree(tree){
  const graph=primaryGraph(tree),ordered=[...graph].sort((a,b)=>a.node.round-b.node.round||a.depth-b.depth||a.index-b.index),counts=new Map(),segment=new Map(),tops=new Map();
  for(const{node}of graph)counts.set(node.round,(counts.get(node.round)||0)+1);let top=695;
  for(let r=1;r<=(tree.current_round??Math.max(...graph.map(e=>e.node.round)));r++){segment.set(r,clamp(40+12*(counts.get(r)||0),70,130));top-=segment.get(r);tops.set(r,top);}
  const treeSeed=seed(JSON.stringify([tree.session_id,'$trunk']));
  const tx=y=>480+.07*(885-y)+16*Math.sin((885-y)/150),positions=new Map(),rootCount=new Map(),kidCount=new Map();let side=J(treeSeed)<.5?1:-1;
  for(const entry of ordered){
    const{node}=entry,r=node.round,s=seed(JSON.stringify([tree.session_id,node.id])),parent=positions.get(entry.parentId),n={id:node.id,round:r,rootId:entry.rootId,parentId:entry.parentId,depth:entry.depth,seed:s};
    n.roundDepth=parent?.round===r?parent.roundDepth+1:0;
    let k,baseAngle;
    if(!parent){side=-side;n.side=side;k=(rootCount.get(r)||0)+1;rootCount.set(r,k);baseAngle=side>0?-24-r*3:-156+r*3;n.width=Math.max(5,10.5-.9*r);}
    else{k=(kidCount.get(parent.id)||0)+1;kidCount.set(parent.id,k);n.side=parent.side;baseAngle=parent.angle+(k%2?-1:1)*(18+k*4)*(parent.side>0?1:-1)*-1;n.width=Math.max(1.6,parent.width*.45);}
    // Re-sample deterministically inside the original v7 ranges. Avoidance must
    // never rotate branches further or stretch them beyond those same bounds.
    let best,bestGap=-Infinity;
    for(let trial=0;trial<192;trial++){
      const candidateSeed=trial?seed(JSON.stringify([tree.session_id,node.id,'avoid',trial])):s;
      const candidate={angle:baseAngle+(J(candidateSeed)-.5)*(parent?26:22)};
      if(parent){candidate.attachT=.7+J(candidateSeed+77)*.1;const p=point(parent,candidate.attachT);candidate.px=p.x;candidate.py=p.y;candidate.length=Math.max(62,parent.length*(.45+J(candidateSeed+9)*.25));}
      else{candidate.py=tops.get(r)+segment.get(r)*(1-(.3+.45*((k*.618+J(candidateSeed+77)*(trial?1:.3))%1)));candidate.px=tx(candidate.py);candidate.length=clamp(100+20*counts.get(r)-6*r,130,240)*(.85+J(candidateSeed+50)*.3);}
      const angle=candidate.angle*Math.PI/180;candidate.x=candidate.px+Math.cos(angle)*candidate.length;candidate.y=candidate.py+Math.sin(angle)*candidate.length;
      const gap=Math.min(Infinity,...[...positions.values()].map(p=>Math.hypot(p.x-candidate.x,p.y-candidate.y)));
      if(gap>bestGap){best=candidate;bestGap=gap;}if(gap>=25)break;
    }
    Object.assign(n,best);
    const a=n.angle*Math.PI/180;n.cx=(n.px+n.x)/2+Math.sin(a)*(10+J(s+3)*22)*n.side;n.cy=(n.py+n.y)/2-10-J(s+4)*14;positions.set(n.id,n);
  }
  const nodes=tree.nodes.map(n=>positions.get(n.id)),xs=nodes.flatMap(n=>[n.x,n.px]),offset=500-(Math.min(...xs,418)+Math.max(...xs,542))/2;
  for(const n of nodes){n.x+=offset;n.px+=offset;n.cx+=offset;n.points=branchPoints(n);}
  const edges=tree.nodes.flatMap(n=>(n.depends_on.length?n.depends_on:[null]).map(from=>({from,to:n.id,primary:positions.get(n.id).parentId===from})));
  const fruit=[];for(const c of chapters(tree)){const tip=nodes.filter(n=>n.rootId===c.id&&!nodes.some(x=>x.parentId===n.id)).sort((a,b)=>b.depth-a.depth||b.round-a.round||nodes.indexOf(b)-nodes.indexOf(a))[0];let x=tip.x,y=tip.y+18;outer:for(const dy of[18,26,34,42])for(const dx of[0,14,-14,28,-28,42,-42]){x=tip.x+dx;y=tip.y+dy;if(nodes.every(n=>Math.hypot(n.x-x,n.y-y)>=18)&&fruit.every(f=>Math.hypot(f.x-x,f.y-y)>=18))break outer;}fruit.push({id:c.id,anchor:c.anchor,nodeId:tip.id,x,y,stemX:tip.x-x,stemY:tip.y-y});}
  const rounds=Array.from(tops,([round,y])=>({round,top:y,bottom:y+segment.get(round),height:segment.get(round),duration:1100+200*Math.max(0,...nodes.filter(n=>n.round===round).map(n=>n.roundDepth))}));
  const minX=Math.min(0,...nodes.flatMap(n=>[n.x-36,n.px-24]),...fruit.map(f=>f.x-14)),maxX=Math.max(1000,...nodes.map(n=>n.x+36),...fruit.map(f=>f.x+14)),minY=Math.min(0,top-80,...nodes.map(n=>n.y-40));
  const layout={nodes,edges,fruit,rounds,offset,top,treeSeed,tx:y=>tx(y)+offset,minX,minY,width:maxX-minX,height:Math.max(910,...fruit.map(f=>f.y+24))-minY,segment,counts};layout.paintBounds=paintBounds(tree,layout);return layout;
}
// Centre the illustration while retaining the original minimum scale.
export function cameraFrame(tree,layout=layoutTree(tree)){
  const b=layout.paintBounds,width=Math.max(layout.width,b.width+64),height=Math.max(layout.height,b.height+64);return{x:b.x+(b.width-width)/2,y:b.y+(b.height-height)/2,width,height};
}
function paintBounds(tree,layout){
  const points=[],add=list=>points.push(...list),stroke=(list,w0,w1)=>add(taperedOutline(list,w0,w1));
  const trunk=trunkGeometry(layout,tree.current_round,1);stroke(trunk.points,trunk.baseWidth,trunk.tipWidth);const bx=480+layout.offset;add([[bx-62,886],[bx+58,886]]);
  for(const t of trunk.twigs)stroke(t.points,t.width,t.tipWidth);
  for(const n of layout.nodes){stroke(n.points,n.width,!layout.nodes.some(c=>c.parentId===n.id)?1:n.width*.5);add([[n.x-7,n.y-7],[n.x+7,n.y+7]]);for(const t of branchTwigs(n,!layout.nodes.some(c=>c.parentId===n.id)))stroke(t.points,t.width,t.tipWidth);}
  for(const f of layout.fruit)add([[f.x-6.5,f.y-6.5],[f.x+6.5,f.y+6.5],[f.x+f.stemX,f.y+f.stemY]]);
  const x=Math.min(...points.map(p=>p[0]))-2,y=Math.min(...points.map(p=>p[1]))-2;return{x,y,width:Math.max(...points.map(p=>p[0]))+2-x,height:Math.max(...points.map(p=>p[1]))+2-y};
}
export function trunkGeometry(layout,round,maturity=0,visibleTop=layout.top){
  const g=clamp(maturity,0,1),apex=Math.min(layout.top-52,...layout.nodes.map(n=>n.y-20));
  const top=visibleTop+(apex-visibleTop)*g,baseWidth=Math.max(12,34-1.3*round),tipWidth=Math.max(5,baseWidth*.3)*(1-g)+.55*g;
  // Keep every real root attached to its original centerline. Only the leader
  // above those attachments bends while the final shoot grows out.
  const bendStart=Math.min(layout.top+54,...layout.nodes.filter(n=>!n.parentId).map(n=>n.py-14));
  const center=y=>{const t=clamp((bendStart-y)/(bendStart-apex),0,1);return layout.tx(y)+g*(Math.sin(t*Math.PI)*8-t*6);};
  const points=Array.from({length:33},(_,k)=>{const y=885-(885-top)*k/32;return[center(y)+(J(k+900)-.5)*2.5,y];});
  const twigProgress=clamp((g-.3)/.7,0,1),s=seed(JSON.stringify([layout.treeSeed,layout.nodes.map(n=>n.id)]));
  const twigs=[-1,1].map((side,k)=>{const y=layout.top+(k===0?22:-8),x=center(y),endY=apex+(k===0?24:9),endX=x+side*(24+J(s+k)*12);return{...curvedTwig([x,y],[endX,endY],side*4,k===0?2.2:1.5,.2),progress:twigProgress};});
  return{points,top,baseWidth,tipWidth,twigs};
}
export function replayFrame(layout,elapsed){
  let start=0;for(const band of layout.rounds){if(elapsed<start+band.duration){const local=elapsed-start;return{round:band.round,local,top:band.bottom-band.height*ease(local/550),maturity:0,fruitElapsed:-Infinity,playing:true,stage:'round-'+band.round};}start+=band.duration;}
  const tail=elapsed-start,end=1400+1000+Math.max(0,layout.fruit.length-1)*60;
  return{round:layout.rounds.at(-1).round,local:Infinity,top:layout.top,maturity:ease(tail/1400),fruitElapsed:tail-1400,playing:tail<end,stage:tail<1400?'finishing':tail<end?'fruit':'complete'};
}
const NS='http://www.w3.org/2000/svg',colors=['#7fa392','#c9a36a','#8ea1b8','#a7a886','#c29a8c','#86a4a4'],names={pending:'待回答',answered:'已答',needs_review:'待复核'};
function svg(tag,attrs={},text){const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;}
const defs=`<defs>
<filter id="wash" x="-50%" y="-80%" width="200%" height="260%"><feTurbulence type="fractalNoise" baseFrequency=".012" numOctaves="3" seed="7"/><feDisplacementMap in="SourceGraphic" scale="70"/><feGaussianBlur stdDeviation="14"/></filter>
<filter id="ink" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence baseFrequency=".6" numOctaves="1" seed="2"/><feDisplacementMap in="SourceGraphic" scale="2.2"/></filter>
<filter id="dry"><feTurbulence type="fractalNoise" baseFrequency=".7 .35" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 .95 0 0 0 0 .92 0 0 0 0 .86 0 0 0 -2 1.25"/><feComposite in2="SourceGraphic" operator="in"/></filter>
<g id="tree-bud"><circle r="2.6" fill="#2f2c26"/></g><g id="tree-flower">${[0,72,144,216,288].map(a=>`<circle cx="${Math.cos(a*Math.PI/180)*3.4}" cy="${Math.sin(a*Math.PI/180)*3.4}" r="2.9" fill="#f7f2e8" stroke="#8b8270" stroke-width=".5"/>`).join('')}<circle r="1.6" fill="#c08a4a"/></g><g id="tree-yellow-leaf"><ellipse rx="9" ry="3.6" fill="#c9a25e" opacity=".75"/></g></defs>`;
export function createDecisionTree(container,{onNode=()=>{},onFruit=()=>{}}={}){
  const canvas=container.querySelector('#tree-canvas');canvas.innerHTML=defs;
  const washes=svg('g',{'aria-hidden':'true'}),wood=svg('g',{class:'tree-wood',fill:'#2f2c26',filter:'url(#ink)','aria-hidden':'true'}),texture=svg('g',{fill:'#2f2c26',filter:'url(#dry)',opacity:'.22','aria-hidden':'true'}),tips=svg('g'),fruits=svg('g');canvas.append(washes,wood,texture,tips,fruits);
  const branches=new Map(),views=new Map(),fruitViews=new Map(),reduced=matchMedia('(prefers-reduced-motion: reduce)'),tooltip=document.querySelector('#tip'),replayButton=container.querySelector('[data-tree-replay]');let tree,layout,options={},newRound=0,growingAt=0,frame=0,zoom=1,lastDraw=0,completionFrom=0,completionTarget=0,completionAt=0,completionStartTop,lastTrunkTop,replayStarted=null,fruitingAt=-Infinity;
  const completion=now=>reduced.matches?completionTarget:completionFrom+(completionTarget-completionFrom)*ease((now-completionAt)/1400);
  function hideTip(){if(tooltip)tooltip.hidden=true;}
  function fruitState(group,fruit){const state=options.fruitStates?.get(fruit.id)??'ready',ready=state==='ready',title=tree.nodes.find(n=>n.id===fruit.id).question;group.dataset.availability=state;group.setAttribute('aria-disabled',String(!ready));group.setAttribute('aria-label',(ready?'文档章节：':state==='failed'?'章节待重试：':'章节生成中：')+title);group.querySelector('title').textContent=(ready?'打开章节：':state==='failed'?'章节待重试：':'章节生成中：')+title;const body=group.querySelector('.fruit-body');body.setAttribute('fill',ready?'#9a7b6d':'#efe9dc');body.setAttribute('stroke-dasharray',ready?'none':'1.4 1.4');}
  function showFruitTip(fruit,event){if(!tooltip)return;const state=options.fruitStates?.get(fruit.id)??'ready';tooltip.replaceChildren();const line=document.createElement('div');line.textContent=(state==='ready'?'可阅读 · ':state==='failed'?'待重试 · ':'生成中 · ')+tree.nodes.find(n=>n.id===fruit.id).question;tooltip.append(line);tooltip.hidden=false;const box=event.currentTarget.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(innerWidth-264,box.right+8))+'px';tooltip.style.top=Math.max(8,Math.min(innerHeight-tooltip.offsetHeight-8,box.top-10))+'px';}

  function showTip(id,event){const n=tree.nodes.find(n=>n.id===id);if(!n||!tooltip)return;tooltip.replaceChildren();const root=tree.nodes.find(r=>r.id===layout.nodes.find(p=>p.id===id).rootId);for(const[cls,text]of[['k',`第 ${n.round} 轮 · ${root.question}${n.status==='needs_review'?' · 需复核':''}`],['',n.question],['a',answerText(n)]]){const p=document.createElement('div');p.className=cls;p.textContent=text;tooltip.append(p);}tooltip.hidden=false;const box=event.currentTarget.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(innerWidth-264,box.right+8))+'px';tooltip.style.top=Math.max(8,Math.min(innerHeight-tooltip.offsetHeight-8,box.top-10))+'px';}
  function fit(){if(!layout)return;const bounds=cameraFrame(tree,layout),w=bounds.width/zoom,h=bounds.height/zoom;canvas.setAttribute('viewBox',`${bounds.x+(bounds.width-w)/2} ${bounds.y+(bounds.height-h)/2} ${w} ${h}`);canvas.dataset.scale=String(zoom);}
  container.querySelectorAll('[data-tree-zoom]').forEach(b=>b.addEventListener('click',()=>{const m=b.dataset.treeZoom;zoom=m==='fit'?1:clamp(zoom*(m==='in'?1.3:1/1.3),.7,4);fit();}));
  replayButton?.addEventListener('click',()=>{replayStarted=performance.now();zoom=1;hideTip();fit();kick();});
  function draw(now){
    frame=0;if(!layout)return;if(now-lastDraw<70){frame=requestAnimationFrame(draw);return;}lastDraw=now;
    const replay=replayStarted!==null&&!reduced.matches?replayFrame(layout,now-replayStarted):null,visibleRound=replay?.round??tree.current_round,local=replay?.local??now-growingAt,progress=reduced.matches?1:ease(local/550);
    const nodeProgress=n=>reduced.matches?1:replay&&n.round>visibleRound?0:n.round<(replay?visibleRound:newRound)||(!replay&&n.round!==newRound)?1:ease((local-250-n.roundDepth*200)/850);
    const roundActive=!reduced.matches&&(replay?replay.stage.startsWith('round-'):Boolean(newRound)&&local<(layout.rounds.find(r=>r.round===newRound)?.duration??1100)),maturity=replay?.maturity??completion(now),finishing=!reduced.matches&&!replay&&completionFrom!==completionTarget&&now-completionAt<1400,fruitActive=tree.status==='complete'&&!reduced.matches&&!replay&&now-fruitingAt<1000+layout.fruit.length*60,active=Boolean(replay?.playing||roundActive||finishing||fruitActive),waiting=options.waiting&&!completionTarget&&!reduced.matches&&!replay?.playing;
    wood.replaceChildren();texture.replaceChildren();washes.replaceChildren();
    for(let r=1;r<=tree.current_round;r++){const ns=layout.nodes.filter(n=>n.round===r);if(!ns.length)continue;const g=replay&&r>visibleRound?0:r===(replay?visibleRound:newRound)?progress:1,mx=ns.reduce((s,n)=>s+n.x+n.px,0)/ns.length/2,my=ns.reduce((s,n)=>s+n.y+n.py,0)/ns.length/2,rx=Math.max(...ns.map(n=>Math.abs(n.x-mx)))+60;washes.append(svg('ellipse',{cx:mx,cy:my,rx:rx*.9*g,ry:55*g+10,fill:colors[(r-1)%colors.length],opacity:.32*g,filter:'url(#wash)'}));}
    const extension=waiting?7+10*(.5+.5*Math.sin(now/850)):0,trunkTop=replay?replay.top:completionTarget?completionStartTop:layout.top+(roundActive?(1-progress)*(layout.segment.get(newRound)||0):0)-extension;
    const trunk=trunkGeometry(layout,replay?visibleRound:tree.current_round,maturity,trunkTop),d=taper(trunk.points,trunk.baseWidth,trunk.tipWidth);lastTrunkTop=trunk.top;
    wood.append(svg('path',{class:'tree-trunk','data-tip-width':trunk.tipWidth.toFixed(3),d}));texture.append(svg('path',{d}));
    for(const twig of trunk.twigs)if(twig.progress>0)wood.append(svg('path',{class:'tree-completion-twig',d:taper(twig.points,twig.width,.2,twig.progress)}));
    const bx=480+layout.offset;wood.append(svg('path',{d:`M${bx-62} 886 Q${bx-24} 883 ${bx-9} 859 L${bx-4} 875 Q${bx-26} 885 ${bx-62} 886Z M${bx+58} 886 Q${bx+22} 884 ${bx+9} 863 L${bx+5} 877 Q${bx+24} 885 ${bx+58} 886Z`}));
    for(const n of layout.nodes){const p=nodeProgress(n);let branch=branches.get(n.id);if(!branch){branch=svg('path',{class:'tree-branch','data-round':n.round,'data-to':n.id,'data-from':n.parentId??''});branches.set(n.id,branch);}const terminal=!layout.nodes.some(c=>c.parentId===n.id),d=taper(n.points,n.width,terminal?1:n.width*.5,p);branch.setAttribute('d',d);wood.append(branch);if(n.width>3)texture.append(svg('path',{d}));
      if(p>.9)for(const twig of branchTwigs(n,terminal))wood.append(svg('path',{d:taper(twig.points,twig.width,twig.tipWidth)}));
      const view=views.get(n.id);if(view){const visible=p>=.95||options.drafts?.has(n.id);if(visible&&view.dataset.visible!=='true'&&view.dataset.status==='answered'&&!reduced.matches)view.querySelector('use').animate([{opacity:0,transform:'scale(.1)'},{opacity:1,transform:'scale(1)'}],{duration:450,easing:'cubic-bezier(.2,.8,.3,1)'});view.dataset.visible=String(Boolean(visible));view.style.opacity=visible?'1':'0';view.style.pointerEvents=visible?'auto':'none';view.setAttribute('tabindex',visible?'0':'-1');view.setAttribute('aria-hidden',String(!visible));}
    }
    for(const[_,group]of fruitViews){const index=Number(group.dataset.index),p=reduced.matches?1:ease(((replay?.fruitElapsed??now-fruitingAt)-index*60)/1000);group.style.visibility=p>0?'visible':'hidden';group.style.opacity=String(p);group.style.pointerEvents=p>.9?'auto':'none';group.setAttribute('tabindex',p>.9?'0':'-1');group.setAttribute('aria-hidden',String(p<=0));group.querySelector('.fruit-growth').setAttribute('transform',`scale(${p})`);}
    canvas.classList.toggle('is-waiting',Boolean(waiting));canvas.dataset.growing=String(active);canvas.dataset.waiting=String(Boolean(options.waiting));canvas.dataset.completion=maturity.toFixed(3);canvas.dataset.replaying=String(Boolean(replay?.playing));canvas.dataset.visibleRound=String(visibleRound);canvas.dataset.growthStage=replay?.stage??(active?'growing':waiting?'waiting':completionTarget?'complete':'idle');
    if(replayButton){replayButton.hidden=tree.status!=='complete'||!completionTarget||reduced.matches;replayButton.disabled=Boolean(replay?.playing);replayButton.textContent=replay?.playing?'生长回放中…':'重看生长';}
    if(replay&&!replay.playing)replayStarted=null;if(active||waiting)frame=requestAnimationFrame(draw);
  }
  function kick(){if(!frame)frame=requestAnimationFrame(draw);}
  reduced.addEventListener('change',()=>{canvas.getAnimations({subtree:true}).forEach(a=>a.finish());if(reduced.matches){replayStarted=null;fruitingAt=-Infinity;completionFrom=completionTarget;newRound=0;}kick();});
  return{update(next,opts={}){const previous=tree,now=performance.now();tree=next;options=opts;layout=layoutTree(tree);const target=(tree.status==='complete'||opts.finished)&&tree.nodes.length>0&&tree.nodes.every(n=>n.status==='answered')?1:0;
    if(!previous){completionFrom=completionTarget=target;completionAt=now;completionStartTop=layout.top;newRound=target?0:tree.current_round;growingAt=now;if(tree.status==='complete'&&target&&!reduced.matches)replayStarted=now;}
    else{if(target!==completionTarget){completionFrom=completion(now);completionTarget=target;completionAt=now;completionStartTop=lastTrunkTop??layout.top;}if(previous.current_round!==tree.current_round){newRound=tree.current_round;growingAt=now;completionStartTop=layout.top;zoom=1;}}
    if(previous&&previous.status!=='complete'&&tree.status==='complete'&&target)fruitingAt=now+Math.max(0,1400-(now-completionAt));
    if(tree.status!=='complete'||!target){replayStarted=null;for(const group of fruitViews.values())group.remove();fruitViews.clear();fruitingAt=-Infinity;}
    for(const n of tree.nodes){const p=layout.nodes.find(p=>p.id===n.id);let view=views.get(n.id);if(!view){view=svg('g',{class:'tree-node',role:'button',tabindex:0,'data-node-id':n.id});view.append(svg('circle',{r:11,fill:'transparent',class:'tree-hit'}),svg('use',{class:'tree-symbol'}));tips.append(view);views.set(n.id,view);view.addEventListener('click',()=>{hideTip();onNode(n.id,view);});view.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();hideTip();onNode(n.id,view);}});view.addEventListener('mouseenter',e=>showTip(n.id,e));view.addEventListener('mouseleave',hideTip);view.addEventListener('focus',e=>showTip(n.id,e));view.addEventListener('blur',hideTip);}
      const local=opts.drafts?.has(n.id),status=n.status==='needs_review'?'needs_review':local?'answered':n.status,prior=view.dataset.status;view.dataset.status=status;view.dataset.round=String(n.round);view.dataset.local=String(Boolean(local));view.setAttribute('transform',`translate(${p.x} ${p.y})`);view.setAttribute('aria-label',`第 ${n.round} 轮，${n.question}，${names[status]}${local?'，本轮未提交':''}`);const symbol=view.querySelector('use');symbol.setAttribute('href','#'+({pending:'tree-bud',answered:'tree-flower',needs_review:'tree-yellow-leaf'}[status]));symbol.setAttribute('transform',status==='needs_review'?`rotate(${p.angle})`:'');if(prior&&prior!==status&&!reduced.matches)symbol.animate([{opacity:.1,transform:'scale(.15)'},{opacity:1,transform:'scale(1)'}],{duration:520,easing:'cubic-bezier(.2,.8,.3,1)'});view.classList.toggle('is-current',opts.currentId===n.id);
    }
    if(tree.status==='complete'&&target)layout.fruit.forEach((fruit,index)=>{let group=fruitViews.get(fruit.id);if(group){fruitState(group,fruit);return;}group=svg('g',{class:'tree-fruit',role:'button',tabindex:-1,'data-fruit-id':fruit.id,'data-index':index,transform:`translate(${fruit.x} ${fruit.y})`,'aria-label':`文档章节：${tree.nodes.find(n=>n.id===fruit.id).question}`});const body=svg('g',{class:'fruit-growth'});body.append(svg('circle',{r:5.2,fill:'#9a7b6d',stroke:'#75675f','stroke-width':'.5',class:'fruit-body'}),svg('ellipse',{cx:1.8,cy:-5.1,rx:2.6,ry:1,fill:'#888875',transform:'rotate(-24 1.8 -5.1)'}),svg('ellipse',{cx:-1.8,cy:-1.2,rx:.9,ry:1.8,fill:'#f7f2e8',opacity:'.16'}));group.append(svg('title',{},`打开第 ${index+1} 章：${tree.nodes.find(n=>n.id===fruit.id).question}`),svg('path',{d:`M${fruit.stemX} ${fruit.stemY} Q${fruit.stemX-2} -10 0 -5`,fill:'none',stroke:'#2f2c26','stroke-width':'.85','pointer-events':'none'}),body,svg('circle',{r:16,fill:'transparent',class:'fruit-hit'}));group.addEventListener('click',()=>{hideTip();onFruit(fruit);});group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();hideTip();onFruit(fruit);}});group.addEventListener('mouseenter',e=>showFruitTip(fruit,e));group.addEventListener('focus',e=>showFruitTip(fruit,e));group.addEventListener('mouseleave',hideTip);group.addEventListener('blur',hideTip);fruits.append(group);fruitViews.set(fruit.id,group);fruitState(group,fruit);});fit();kick();},focusNode(id){const n=layout?.nodes.find(n=>n.id===id);if(!n)return;zoom=2.5;canvas.setAttribute('viewBox',`${n.x-200} ${n.y-180} 400 360`);views.get(id)?.focus();},getLayout(){return layout;},destroy(){if(frame)cancelAnimationFrame(frame);hideTip();}};
}
