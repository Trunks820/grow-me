import {primaryGraph,chapters,answerText} from './topics.mjs';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const J=i=>{const x=Math.sin(i*127.1+311.7)*43758.5453;return x-Math.floor(x);};
const ease=t=>1-Math.pow(1-clamp(t,0,1),3);
const trunkBaseWidth=round=>12+2.4*Math.min(6,Math.max(1,round));
const MAX_CANVAS_HEIGHT=.75;
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
  // Project the same Bezier construction into a growing, bounded crown. This
  // changes drawing proportions only; question counts, parents and seeds stay put.
  const stage=tops.size,stemHeight=110+12*Math.min(stage,6),crownBudget=200+340*(1-Math.exp(-(stage-1)/3));
  const xScale=.82+.04*Math.min(stage,6),yScale=Math.min(1,crownBudget/(695-top+240));
  const projectX=x=>480+(x-480)*xScale,projectY=y=>885-stemHeight+(y-695)*yScale;
  const unprojectY=y=>y>=885-stemHeight?885-(885-y)*190/stemHeight:695+(y-885+stemHeight)/yScale;
  const distance=(x,y)=>Math.hypot(x*xScale,y*yScale);
  const treeSeed=seed(JSON.stringify([tree.session_id,'$trunk']));
  // A topic keeps its dependency branches. Let its supporting bough occupy the
  // otherwise empty bands before the next root-bearing round, rather than
  // growing a bare trunk above a cluster of first-round roots.
  const rootsByRound=new Map();for(const e of ordered)if(!e.parentId){if(!rootsByRound.has(e.node.round))rootsByRound.set(e.node.round,[]);rootsByRound.get(e.node.round).push(e.node.id);}
  const rootRounds=[...rootsByRound.keys()],rootBands=new Map();rootRounds.forEach((r,i)=>rootBands.set(r,{top:tops.get((rootRounds[i+1]??tops.size+1)-1),bottom:tops.get(r)+segment.get(r)}));
  const tx=y=>480+.07*(885-y)+16*Math.sin((885-y)/150),positions=new Map(),rootCount=new Map(),kidCount=new Map();let side=J(treeSeed)<.5?1:-1;
  for(const entry of ordered){
    const{node}=entry,r=node.round,s=seed(JSON.stringify([tree.session_id,node.id])),parent=positions.get(entry.parentId),n={id:node.id,round:r,rootId:entry.rootId,parentId:entry.parentId,depth:entry.depth,seed:s};
    n.roundDepth=parent?.round===r?parent.roundDepth+1:0;
    let k,baseAngle;
    if(!parent){side=-side;n.side=side;k=(rootCount.get(r)||0)+1;rootCount.set(r,k);baseAngle=side>0?-24-r*3:-156+r*3;n.width=Math.max(5,10.5-.9*r);}
    else{k=(kidCount.get(parent.id)||0)+1;kidCount.set(parent.id,k);n.side=parent.side;baseAngle=parent.angle+(k%2?-1:1)*(18+k*4)*(parent.side>0?1:-1)*-1;n.width=Math.max(1.6,parent.width*.45);}
    // Keep the existing session/node seed and bounded Bezier variation. Reserve
    // space for the actual flower/leaf targets, rather than unadorned wood tips.
    let best,bestGap=-Infinity;
    for(let trial=0;trial<192;trial++){
      const candidateSeed=trial?seed(JSON.stringify([tree.session_id,node.id,'avoid',trial])):s;
      const candidate={angle:baseAngle+(J(candidateSeed)-.5)*(parent?26:22)};
      if(parent){candidate.attachT=.7+J(candidateSeed+77)*.1;const p=point(parent,candidate.attachT);candidate.px=p.x;candidate.py=p.y;candidate.length=Math.max(62,parent.length*(.45+J(candidateSeed+9)*.25));}
      else{const band=rootBands.get(r),size=rootsByRound.get(r).length,span=band.bottom-band.top,pad=Math.min(22,span*.2),step=(span-pad*2)/Math.max(1,size-1);candidate.py=size===1?band.top+pad:band.bottom-pad-step*(k-1)+(J(s+77)-.5)*Math.min(10,step*.24);candidate.px=tx(candidate.py);const crownLevel=clamp((candidate.py-top)/(695-top),0,1),lengthScale=1+Math.min(1,(stage-1)/4)*(-.2+.24*Math.sin(Math.PI*crownLevel));candidate.length=clamp(100+20*counts.get(r)-6*r,130,240)*(.85+J(candidateSeed+50)*.3)*lengthScale;}
      const angle=candidate.angle*Math.PI/180;candidate.x=candidate.px+Math.cos(angle)*candidate.length;candidate.y=candidate.py+Math.sin(angle)*candidate.length;
      candidate.cx=(candidate.px+candidate.x)/2+Math.sin(angle)*(10+J(s+3)*22)*n.side;candidate.cy=(candidate.py+candidate.y)/2-10-J(s+4)*14;
      candidate.bloomT=.42+J(candidateSeed+88)*.36;let bloom=point(candidate,candidate.bloomT);
      while(candidate.bloomT>.42&&distance(bloom.x-candidate.x,bloom.y-candidate.y)<16){candidate.bloomT=Math.max(.42,candidate.bloomT-.025);bloom=point(candidate,candidate.bloomT);}
      candidate.bloomX=bloom.x;candidate.bloomY=bloom.y;
      const gap=Math.min(Infinity,...[...positions.values()].map(p=>distance(p.bloomX-bloom.x,p.bloomY-bloom.y)));
      if(gap>bestGap){best=candidate;bestGap=gap;}if(gap>=25)break;
    }
    Object.assign(n,best);
    if(!parent){const trunkWidth=.85+(trunkBaseWidth(stage)-.85)*(projectY(n.py)-projectY(top))/(885-projectY(top));n.width=Math.min(n.width,Math.max(2.4,trunkWidth*.85));}
    const a=n.angle*Math.PI/180;n.cx=(n.px+n.x)/2+Math.sin(a)*(10+J(s+3)*22)*n.side;n.cy=(n.py+n.y)/2-10-J(s+4)*14;positions.set(n.id,n);
  }
  const nodes=tree.nodes.map(n=>positions.get(n.id));
  for(const n of nodes){for(const key of['x','px','cx','bloomX'])n[key]=projectX(n[key]);for(const key of['y','py','cy','bloomY'])n[key]=projectY(n[key]);}
  top=projectY(top);for(const [r,y]of tops){tops.set(r,projectY(y));segment.set(r,segment.get(r)*yScale);}
  const xs=nodes.flatMap(n=>[n.x,n.px]),offset=500-(Math.min(...xs,418)+Math.max(...xs,542))/2;
  for(const n of nodes){n.x+=offset;n.px+=offset;n.cx+=offset;n.bloomX+=offset;n.points=branchPoints(n);}
  const edges=tree.nodes.flatMap(n=>(n.depends_on.length?n.depends_on:[null]).map(from=>({from,to:n.id,primary:positions.get(n.id).parentId===from})));
  const fruit=[],woodClearance=(x,y)=>Math.min(...nodes.flatMap(n=>n.points.slice(1).map((b,i)=>{const a=n.points[i],dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)-n.width/2;})));
  for(const c of chapters(tree)){
    const tip=nodes.filter(n=>n.rootId===c.id&&!nodes.some(x=>x.parentId===n.id)).sort((a,b)=>b.depth-a.depth||b.round-a.round||nodes.indexOf(b)-nodes.indexOf(a))[0],stem=point(tip,1);
    let best,bestGap=-Infinity;
    outer:for(const dy of[18,26,34,42,50,58,66,74,82,90,98])for(const dx of[0,6,-6,12,-12,20,-20,28,-28]){
      const x=stem.x+dx,y=stem.y+dy,gap=Math.min(...nodes.map(n=>Math.hypot(n.bloomX-x,n.bloomY-y)),...fruit.map(f=>Math.hypot(f.x-x,f.y-y)));
      const clearance=woodClearance(x,y),score=Math.min(gap,clearance+15);if(score>bestGap){best={x,y};bestGap=score;}if(gap>=25&&clearance>=10)break outer;
    }
    fruit.push({id:c.id,anchor:c.anchor,nodeId:tip.id,...best,stemX:stem.x-best.x,stemY:stem.y-best.y});
  }
  const rounds=Array.from(tops,([round,y])=>({round,top:y,bottom:y+segment.get(round),height:segment.get(round),duration:1100+200*Math.max(0,...nodes.filter(n=>n.round===round).map(n=>n.roundDepth))}));
  const minX=Math.min(0,...nodes.flatMap(n=>[n.x-36,n.px-24]),...fruit.map(f=>f.x-14)),maxX=Math.max(1000,...nodes.map(n=>n.x+36),...fruit.map(f=>f.x+14)),minY=Math.min(0,top-80,...nodes.map(n=>n.y-40));
  const layout={nodes,edges,fruit,rounds,offset,top,treeSeed,projection:{xScale,yScale,stemHeight},tx:y=>projectX(tx(unprojectY(y)))+offset,minX,minY,width:maxX-minX,height:Math.max(910,...fruit.map(f=>f.y+24))-minY,segment,counts};layout.paintBounds=paintBounds(tree,layout);return layout;
}
// Centre the illustration while retaining the original minimum scale.
export function cameraFrame(tree,layout=layoutTree(tree)){
  const b=layout.paintBounds,width=Math.max(layout.width,b.width+64),height=Math.max(layout.height,b.height/MAX_CANVAS_HEIGHT);return{x:b.x+(b.width-width)/2,y:b.y+(b.height-height)/2,width,height};
}
function paintBounds(tree,layout){
  const points=[],add=list=>points.push(...list),stroke=(list,w0,w1)=>add(taperedOutline(list,w0,w1));
  const trunk=trunkGeometry(layout,tree.current_round,1);stroke(trunk.points,trunk.baseWidth,trunk.tipWidth);const bx=480+layout.offset,rootScale=trunkBaseWidth(tree.current_round)/28;add([[bx-62*rootScale,886],[bx+58*rootScale,886]]);
  for(const t of trunk.twigs)stroke(t.points,t.width,t.tipWidth);
  for(const n of layout.nodes){stroke(n.points,n.width,!layout.nodes.some(c=>c.parentId===n.id)?1:n.width*.5);add([[n.bloomX-9,n.bloomY-9],[n.bloomX+9,n.bloomY+9]]);for(const t of branchTwigs(n,!layout.nodes.some(c=>c.parentId===n.id)))stroke(t.points,t.width,t.tipWidth);}
  for(const f of layout.fruit)add([[f.x-6.5,f.y-6.5],[f.x+6.5,f.y+6.5],[f.x+f.stemX,f.y+f.stemY]]);
  const x=Math.min(...points.map(p=>p[0]))-2,y=Math.min(...points.map(p=>p[1]))-2;return{x,y,width:Math.max(...points.map(p=>p[0]))+2-x,height:Math.max(...points.map(p=>p[1]))+2-y};
}
export function trunkGeometry(layout,round,maturity=0,visibleTop=layout.top){
  const g=clamp(maturity,0,1),apex=layout.top-12;
  const top=visibleTop+(apex-visibleTop)*g,baseWidth=trunkBaseWidth(round),tipWidth=.85-.3*g;
  // Keep every real root attached to its original centerline. Only the leader
  // above those attachments bends while the final shoot grows out.
  const bendStart=Math.min(layout.top+54,...layout.nodes.filter(n=>!n.parentId).map(n=>n.py-14));
  const center=y=>{const t=clamp((bendStart-y)/(bendStart-apex),0,1);return layout.tx(y)+g*(Math.sin(t*Math.PI)*8-t*6);};
  const points=Array.from({length:33},(_,k)=>{const y=885-(885-top)*k/32;return[center(y)+(J(k+900)-.5)*2.5,y];});
  const s=seed(JSON.stringify([layout.treeSeed,layout.nodes.map(n=>n.id)]));
  const twigs=[-1,1].map((side,k)=>{const y=top+(k===0?32:19),x=center(y),endY=top+(k===0?6:-5),endX=x+side*(18+J(s+k)*12);return{...curvedTwig([x,y],[endX,endY],side*4,k===0?1.8:1.1,.2),progress:1};});
  return{points,top,baseWidth,tipWidth,twigs};
}
export function replayFrame(layout,elapsed){
  let start=0;for(const band of layout.rounds){if(elapsed<start+band.duration){const local=elapsed-start;return{round:band.round,local,top:band.bottom-band.height*ease(local/550),maturity:0,fruitElapsed:-Infinity,playing:true,stage:'round-'+band.round};}start+=band.duration;}
  const tail=elapsed-start,end=1400+1000+Math.max(0,layout.fruit.length-1)*60;
  return{round:layout.rounds.at(-1).round,local:Infinity,top:layout.top,maturity:ease(tail/1400),fruitElapsed:tail-1400,playing:tail<end,stage:tail<1400?'finishing':tail<end?'fruit':'complete'};
}
function growingLayout(from,to,progress){
  if(!from||progress>=1)return to;
  const mix=(a,b)=>a+(b-a)*progress,previous=new Map(from.nodes.map(n=>[n.id,n]));
  const nodes=to.nodes.map(n=>{const old=previous.get(n.id);if(!old)return n;const result={...n};for(const key of['x','y','px','py','cx','cy','bloomX','bloomY'])result[key]=mix(old[key],n[key]);result.points=branchPoints(result);return result;});
  const byId=new Map(nodes.map(n=>[n.id,n]));
  for(const n of [...nodes].sort((a,b)=>a.depth-b.depth))if(n.parentId){const p=point(byId.get(n.parentId),n.attachT);const adjusted={...n,px:p.x,py:p.y,cx:n.cx+(p.x-n.px)/2,cy:n.cy+(p.y-n.py)/2};const bloom=point(adjusted,n.bloomT);Object.assign(adjusted,{bloomX:bloom.x,bloomY:bloom.y,points:branchPoints(adjusted)});byId.set(n.id,adjusted);}
  return{...to,nodes:nodes.map(n=>byId.get(n.id)),offset:mix(from.offset,to.offset),top:mix(from.top,to.top),tx:y=>mix(from.tx(y),to.tx(y))};
}
const NS='http://www.w3.org/2000/svg',colors=['#7fa392','#c9a36a','#8ea1b8','#a7a886','#c29a8c','#86a4a4'],names={pending:'待回答',answered:'已答',needs_review:'待复核'};
function svg(tag,attrs={},text){const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;}
const defs=`<defs>
<filter id="wash" x="-50%" y="-80%" width="200%" height="260%"><feTurbulence type="fractalNoise" baseFrequency=".025" numOctaves="3" seed="7"/><feDisplacementMap in="SourceGraphic" scale="18"/><feGaussianBlur stdDeviation="8"/></filter>
<filter id="ink" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence baseFrequency=".6" numOctaves="1" seed="2"/><feDisplacementMap in="SourceGraphic" scale="2.2"/></filter>
<filter id="dry"><feTurbulence type="fractalNoise" baseFrequency=".7 .35" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 .95 0 0 0 0 .92 0 0 0 0 .86 0 0 0 -2 1.25"/><feComposite in2="SourceGraphic" operator="in"/></filter>
<g id="tree-bud"><circle r="2.6" fill="#2f2c26"/></g><g id="tree-flower">${[0,72,144,216,288].map(a=>`<circle cx="${Math.cos(a*Math.PI/180)*3.4}" cy="${Math.sin(a*Math.PI/180)*3.4}" r="2.9" fill="#f7f2e8" stroke="#8b8270" stroke-width=".5"/>`).join('')}<circle r="1.6" fill="#c08a4a"/></g><g id="tree-yellow-leaf"><ellipse rx="9" ry="3.6" fill="#c9a25e" opacity=".75"/></g></defs>`;
export function createDecisionTree(container,{onNode=()=>{},onFruit=()=>{}}={}){
  const canvas=container.querySelector('#tree-canvas');canvas.innerHTML=defs;
  const washes=svg('g',{'aria-hidden':'true'}),wood=svg('g',{class:'tree-wood',fill:'#2f2c26',filter:'url(#ink)','aria-hidden':'true'}),texture=svg('g',{fill:'#2f2c26',filter:'url(#dry)',opacity:'.22','aria-hidden':'true'}),tips=svg('g'),fruits=svg('g');canvas.append(washes,wood,texture,tips,fruits);
  const branches=new Map(),views=new Map(),fruitViews=new Map(),reduced=matchMedia('(prefers-reduced-motion: reduce)'),tooltip=document.querySelector('#tip'),replayButton=container.querySelector('[data-tree-replay]');let tree,layout,previousLayout,roundLayouts=new Map(),options={},newRound=0,growingAt=0,frame=0,zoom=1,lastDraw=0,completionFrom=0,completionTarget=0,completionAt=0,completionStartTop,lastTrunkTop,replayStarted=null,fruitingAt=-Infinity;
  const completion=now=>reduced.matches?completionTarget:completionFrom+(completionTarget-completionFrom)*ease((now-completionAt)/1400);
  function hideTip(){if(tooltip)tooltip.hidden=true;}
  function fruitState(group,fruit){const state=options.fruitStates?.get(fruit.id)??'ready',ready=state==='ready',title=tree.nodes.find(n=>n.id===fruit.id).question;group.dataset.availability=state;group.setAttribute('aria-disabled',String(!ready));group.setAttribute('aria-label',(ready?'文档章节：':state==='failed'?'章节待重试：':'章节生成中：')+title);group.querySelector('title').textContent=(ready?'打开章节：':state==='failed'?'章节待重试：':'章节生成中：')+title;const body=group.querySelector('.fruit-body');body.setAttribute('fill',ready?'#b78263':'#efe9dc');body.setAttribute('stroke-dasharray',ready?'none':'1.4 1.4');}
  function showFruitTip(fruit,event){if(!tooltip)return;const state=options.fruitStates?.get(fruit.id)??'ready';tooltip.replaceChildren();const line=document.createElement('div');line.textContent=(state==='ready'?'可阅读 · ':state==='failed'?'待重试 · ':'生成中 · ')+tree.nodes.find(n=>n.id===fruit.id).question;tooltip.append(line);tooltip.hidden=false;const box=event.currentTarget.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(innerWidth-264,box.right+8))+'px';tooltip.style.top=Math.max(8,Math.min(innerHeight-tooltip.offsetHeight-8,box.top-10))+'px';}

  function showTip(id,event){const n=tree.nodes.find(n=>n.id===id);if(!n||!tooltip)return;tooltip.replaceChildren();const root=tree.nodes.find(r=>r.id===layout.nodes.find(p=>p.id===id).rootId);for(const[cls,text]of[['k',`第 ${n.round} 轮 · ${root.question}${n.status==='needs_review'?' · 需复核':''}`],['',n.question],['a',answerText(n)]]){const p=document.createElement('div');p.className=cls;p.textContent=text;tooltip.append(p);}tooltip.hidden=false;const box=event.currentTarget.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(innerWidth-264,box.right+8))+'px';tooltip.style.top=Math.max(8,Math.min(innerHeight-tooltip.offsetHeight-8,box.top-10))+'px';}
  function fit(){if(!layout)return;const bounds=cameraFrame(tree,layout),w=bounds.width/zoom,h=bounds.height/zoom;canvas.setAttribute('viewBox',`${bounds.x+(bounds.width-w)/2} ${bounds.y+(bounds.height-h)/2} ${w} ${h}`);canvas.dataset.scale=String(zoom);}
  container.querySelectorAll('[data-tree-zoom]').forEach(b=>b.addEventListener('click',()=>{const m=b.dataset.treeZoom;zoom=m==='fit'?1:clamp(zoom*(m==='in'?1.3:1/1.3),.7,4);fit();}));
  replayButton?.addEventListener('click',()=>{if(reduced.matches)return;replayStarted=performance.now();zoom=1;hideTip();fit();kick();});
  function draw(now){
    frame=0;if(!layout)return;if(!reduced.matches&&now-lastDraw<70){frame=requestAnimationFrame(draw);return;}lastDraw=now;
    const replay=replayStarted!==null&&!reduced.matches?replayFrame(layout,now-replayStarted):null,visibleRound=replay?.round??tree.current_round,local=replay?.local??now-growingAt,progress=reduced.matches?1:ease(local/550);
    const target=replay?roundLayouts.get(visibleRound)??layout:layout;
    const drawing=growingLayout(replay?roundLayouts.get(visibleRound-1):previousLayout,target,progress);
    if(replay)for(const view of views.values())if(Number(view.dataset.round)>visibleRound){view.style.opacity='0';view.style.pointerEvents='none';view.dataset.visible='false';view.setAttribute('tabindex','-1');view.setAttribute('aria-hidden','true');}
    const nodeProgress=n=>reduced.matches?1:replay&&n.round>visibleRound?0:n.round<(replay?visibleRound:newRound)||(!replay&&n.round!==newRound)?1:ease((local-250-n.roundDepth*200)/850);
    const roundActive=!reduced.matches&&(replay?replay.stage.startsWith('round-'):Boolean(newRound)&&local<(layout.rounds.find(r=>r.round===newRound)?.duration??1100)),maturity=replay?.maturity??completion(now),finishing=!reduced.matches&&!replay&&completionFrom!==completionTarget&&now-completionAt<1400,fruitActive=tree.status==='complete'&&!reduced.matches&&!replay&&now-fruitingAt<1000+layout.fruit.length*60,active=Boolean(replay?.playing||roundActive||finishing||fruitActive),waiting=options.waiting&&!completionTarget&&!reduced.matches&&!replay?.playing;
    wood.replaceChildren();texture.replaceChildren();washes.replaceChildren();
    for(const n of drawing.nodes){
      if(drawing.nodes.some(child=>child.parentId===n.id))continue;
      const g=nodeProgress(n);if(g<=0)continue;
      const rx=32+J(n.seed+101)*22,ry=24+J(n.seed+102)*22,cx=n.x-n.side*12,cy=n.y+8;
      const cloud=Array.from({length:8},(_,k)=>{const a=k*Math.PI/4,scale=.72+J(n.seed+110+k)*.42;return[cx+Math.cos(a)*rx*scale,cy+Math.sin(a)*ry*scale];});
      const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
      const d='M'+mid(cloud[7],cloud[0]).join(' ')+cloud.map((p,k)=>'Q'+p.join(' ')+' '+mid(p,cloud[(k+1)%8]).join(' ')).join('')+'Z';
      washes.append(svg('path',{class:'tree-wash','data-node-id':n.id,d,fill:colors[(n.round-1)%colors.length],opacity:.16*g,filter:'url(#wash)'}));
    }
    const extension=waiting?7+10*(.5+.5*Math.sin(now/850)):0,trunkTop=replay||roundActive?drawing.top+((replay?roundLayouts.get(visibleRound-1):previousLayout)?0:(1-progress)*(target.segment.get(visibleRound)||0)):completionTarget?completionStartTop:layout.top-extension;
    const trunk=trunkGeometry(drawing,replay?visibleRound:tree.current_round,maturity,trunkTop),d=taper(trunk.points,trunk.baseWidth,trunk.tipWidth);lastTrunkTop=trunk.top;
    wood.append(svg('path',{class:'tree-trunk','data-tip-width':trunk.tipWidth.toFixed(3),d}));texture.append(svg('path',{d}));
    for(const twig of trunk.twigs)if(twig.progress>0)wood.append(svg('path',{class:'tree-completion-twig',d:taper(twig.points,twig.width,.2,twig.progress)}));
    const bx=480+drawing.offset,rootScale=trunkBaseWidth(visibleRound)/28;wood.append(svg('path',{d:`M${bx-62*rootScale} 886 Q${bx-24*rootScale} 883 ${bx-9*rootScale} 859 L${bx-4*rootScale} 875 Q${bx-26*rootScale} 885 ${bx-62*rootScale} 886Z M${bx+58*rootScale} 886 Q${bx+22*rootScale} 884 ${bx+9*rootScale} 863 L${bx+5*rootScale} 877 Q${bx+24*rootScale} 885 ${bx+58*rootScale} 886Z`}));
    for(const n of drawing.nodes){const p=nodeProgress(n);let branch=branches.get(n.id);if(!branch){branch=svg('path',{class:'tree-branch','data-round':n.round,'data-to':n.id,'data-from':n.parentId??''});branches.set(n.id,branch);}const terminal=!drawing.nodes.some(c=>c.parentId===n.id),d=taper(n.points,n.width,terminal?1:n.width*.5,p);branch.setAttribute('d',d);wood.append(branch);if(n.width>3)texture.append(svg('path',{d}));
      if(p>.9)for(const twig of branchTwigs(n,terminal))wood.append(svg('path',{d:taper(twig.points,twig.width,twig.tipWidth)}));
      const view=views.get(n.id);if(view){view.setAttribute('transform',`translate(${n.bloomX} ${n.bloomY})`);const visible=p>=.95||options.drafts?.has(n.id);if(visible&&view.dataset.visible!=='true'&&view.dataset.status==='answered'&&!reduced.matches)view.querySelector('use').animate([{opacity:0,transform:'scale(.1)'},{opacity:1,transform:'scale(1)'}],{duration:450,easing:'cubic-bezier(.2,.8,.3,1)'});view.dataset.visible=String(Boolean(visible));view.style.opacity=visible?'1':'0';view.style.pointerEvents=visible?'auto':'none';view.setAttribute('tabindex',visible?'0':'-1');view.setAttribute('aria-hidden',String(!visible));}
    }
    for(const[_,group]of fruitViews){const index=Number(group.dataset.index),p=reduced.matches?1:ease(((replay?.fruitElapsed??now-fruitingAt)-index*60)/1000);group.style.visibility=p>0?'visible':'hidden';group.style.opacity=String(p);group.style.pointerEvents=p>.9?'auto':'none';group.setAttribute('tabindex',p>.9?'0':'-1');group.setAttribute('aria-hidden',String(p<=0));group.querySelector('.fruit-growth').setAttribute('transform',`scale(${p})`);}
    canvas.classList.toggle('is-waiting',Boolean(waiting));canvas.dataset.growing=String(active);canvas.dataset.waiting=String(Boolean(options.waiting));canvas.dataset.completion=maturity.toFixed(3);canvas.dataset.replaying=String(Boolean(replay?.playing));canvas.dataset.visibleRound=String(visibleRound);canvas.dataset.growthStage=replay?.stage??(active?'growing':waiting?'waiting':completionTarget?'complete':'idle');
    if(replayButton){replayButton.hidden=tree.status!=='complete'||!completionTarget||reduced.matches;replayButton.disabled=Boolean(replay?.playing);replayButton.textContent=replay?.playing?'生长回放中…':'重看生长';}
    if(replay&&!replay.playing)replayStarted=null;if(active||waiting)frame=requestAnimationFrame(draw);
  }
  function kick(){if(reduced.matches){if(frame)cancelAnimationFrame(frame);draw(performance.now());return;}if(!frame)frame=requestAnimationFrame(draw);}
  reduced.addEventListener('change',()=>{canvas.getAnimations({subtree:true}).forEach(a=>a.finish());if(reduced.matches){replayStarted=null;fruitingAt=-Infinity;completionFrom=completionTarget;newRound=0;}kick();});
  return{update(next,opts={}){const previous=tree,now=performance.now();tree=next;options=opts;if(!previous||previous.current_round!==tree.current_round)previousLayout=layout;layout=layoutTree(tree);
    roundLayouts=new Map(layout.rounds.map(({round})=>[round,round===tree.current_round?layout:layoutTree({...tree,current_round:round,nodes:tree.nodes.filter(n=>n.round<=round)})]));const target=(tree.status==='complete'||opts.finished)&&tree.nodes.length>0&&tree.nodes.every(n=>n.status==='answered')?1:0;
    if(!previous){completionFrom=completionTarget=target;completionAt=now;completionStartTop=layout.top;newRound=target?0:tree.current_round;growingAt=now;if(tree.status==='complete'&&target&&!reduced.matches)replayStarted=now;}
    else{if(target!==completionTarget){completionFrom=completion(now);completionTarget=target;completionAt=now;completionStartTop=lastTrunkTop??layout.top;}if(previous.current_round!==tree.current_round){newRound=tree.current_round;growingAt=now;completionStartTop=layout.top;zoom=1;}}
    if(previous&&previous.status!=='complete'&&tree.status==='complete'&&target)fruitingAt=now+Math.max(0,1400-(now-completionAt));
    if(tree.status!=='complete'||!target){replayStarted=null;for(const group of fruitViews.values())group.remove();fruitViews.clear();fruitingAt=-Infinity;}
    for(const n of tree.nodes){const p=layout.nodes.find(p=>p.id===n.id);let view=views.get(n.id);if(!view){view=svg('g',{class:'tree-node',role:'button',tabindex:0,'data-node-id':n.id});view.append(svg('circle',{r:11,fill:'transparent',class:'tree-hit'}),svg('use',{class:'tree-symbol'}));tips.append(view);views.set(n.id,view);view.addEventListener('click',()=>{hideTip();onNode(n.id,view);});view.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();hideTip();onNode(n.id,view);}});view.addEventListener('mouseenter',e=>showTip(n.id,e));view.addEventListener('mouseleave',hideTip);view.addEventListener('focus',e=>showTip(n.id,e));view.addEventListener('blur',hideTip);}
      const local=opts.drafts?.has(n.id),status=n.status==='needs_review'?'needs_review':local?'answered':n.status,prior=view.dataset.status;view.dataset.status=status;view.dataset.round=String(n.round);view.dataset.local=String(Boolean(local));view.setAttribute('transform',`translate(${p.bloomX} ${p.bloomY})`);view.setAttribute('aria-label',`第 ${n.round} 轮，${n.question}，${names[status]}${local?'，本轮未提交':''}`);const symbol=view.querySelector('use');symbol.setAttribute('href','#'+({pending:'tree-bud',answered:'tree-flower',needs_review:'tree-yellow-leaf'}[status]));symbol.setAttribute('transform',status==='needs_review'?`rotate(${p.angle})`:'');if(prior&&prior!==status&&!reduced.matches)symbol.animate([{opacity:.1,transform:'scale(.15)'},{opacity:1,transform:'scale(1)'}],{duration:520,easing:'cubic-bezier(.2,.8,.3,1)'});view.classList.toggle('is-current',opts.currentId===n.id);
    }
    if(tree.status==='complete'&&target)layout.fruit.forEach((fruit,index)=>{let group=fruitViews.get(fruit.id);if(group){fruitState(group,fruit);return;}group=svg('g',{class:'tree-fruit',role:'button',tabindex:-1,'data-fruit-id':fruit.id,'data-index':index,transform:`translate(${fruit.x} ${fruit.y})`,'aria-label':`文档章节：${tree.nodes.find(n=>n.id===fruit.id).question}`});const body=svg('g',{class:'fruit-growth'});body.append(svg('circle',{r:5.2,fill:'#b78263',stroke:'#75675f','stroke-width':'.5',class:'fruit-body'}),svg('ellipse',{cx:1.8,cy:-5.1,rx:2.6,ry:1,fill:'#888875',transform:'rotate(-24 1.8 -5.1)'}),svg('ellipse',{cx:-1.8,cy:-1.2,rx:.9,ry:1.8,fill:'#f7f2e8',opacity:'.16'}));group.append(svg('title',{},`打开第 ${index+1} 章：${tree.nodes.find(n=>n.id===fruit.id).question}`),svg('path',{d:`M${fruit.stemX} ${fruit.stemY} Q${fruit.stemX-2} -10 0 -5`,fill:'none',stroke:'#2f2c26','stroke-width':'.85','pointer-events':'none'}),body,svg('circle',{r:16,fill:'transparent',class:'fruit-hit'}));group.addEventListener('click',()=>{hideTip();onFruit(fruit);});group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();hideTip();onFruit(fruit);}});group.addEventListener('mouseenter',e=>showFruitTip(fruit,e));group.addEventListener('focus',e=>showFruitTip(fruit,e));group.addEventListener('mouseleave',hideTip);group.addEventListener('blur',hideTip);fruits.append(group);fruitViews.set(fruit.id,group);fruitState(group,fruit);});fit();kick();},focusNode(id){const n=layout?.nodes.find(n=>n.id===id);if(!n)return;zoom=2.5;canvas.setAttribute('viewBox',`${n.bloomX-200} ${n.bloomY-180} 400 360`);views.get(id)?.focus();},getLayout(){return layout;},destroy(){if(frame)cancelAnimationFrame(frame);hideTip();}};
}
