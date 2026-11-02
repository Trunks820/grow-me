import{test}from'node:test';import assert from'node:assert/strict';
import{layoutTree,cameraFrame,trunkGeometry,taper,branchTwigs}from'../assets/tree.mjs';import{primaryGraph,chapters,chapterAnchor}from'../assets/topics.mjs';import{specimen28,specimen28FourRounds}from'./fixtures.mjs';
test('v7 layout is deterministic, read-only, and independent of answers or review colors',()=>{const tree=specimen28(),before=structuredClone(tree),a=layoutTree(tree);assert.deepEqual(tree,before);assert.deepEqual(a.nodes,layoutTree(tree).nodes);tree.nodes.forEach(n=>{n.status='needs_review';n.answer.text='另一个回答';});assert.deepEqual(a.nodes,layoutTree(tree).nodes);assert.ok(a.nodes.every(n=>[n.x,n.y,n.width,n.length].every(Number.isFinite)));});
test('document chapter assignments leave branch geometry, growth bands, fruit positions and camera unchanged',()=>{
 const tree=specimen28();tree.schema_version=2;tree.nodes[27].depends_on.push('q20');const before=layoutTree(tree),graph=primaryGraph(tree),camera=cameraFrame(tree);
 for(const e of graph)e.node.chapter_id=e.rootId;
 const shared=tree.nodes[27],roots=shared.depends_on.map(id=>graph.find(e=>e.node.id===id).rootId);shared.chapter_id=roots.find(id=>id!==shared.chapter_id)??roots[0];
 const after=layoutTree(tree);for(const key of ['nodes','edges','fruit','rounds','segment','counts','paintBounds'])assert.deepEqual(after[key],before[key]);assert.deepEqual(cameraFrame(tree),camera);
});
test('all dependencies remain represented, one primary parent and one chapter per root',()=>{const tree=specimen28();tree.nodes[27].depends_on.push('q20');const graph=primaryGraph(tree),layout=layoutTree(tree);assert.equal(new Set(layout.nodes.map(n=>n.id)).size,28);assert.equal(layout.edges.filter(e=>e.from!==null).length,tree.nodes.reduce((s,n)=>s+n.depends_on.length,0));assert.equal(layout.fruit.length,tree.nodes.filter(n=>!n.depends_on.length).length);assert.equal(chapters(tree).flatMap(c=>c.nodes).length,28);assert.equal(new Set(chapters(tree).flatMap(c=>c.nodes.map(n=>n.id))).size,28);assert.ok(graph.every(n=>n.rootId));assert.notEqual(chapterAnchor('中文 & /'),chapterAnchor('中文 & ?'));});
test('28 visible question symbols stay separated with finite full bounds',()=>{const result=layoutTree(specimen28());for(const a of result.nodes)for(const b of result.nodes)if(a.id!==b.id)assert.ok(Math.hypot(a.bloomX-b.bloomX,a.bloomY-b.bloomY)>=13,`${a.id} overlaps ${b.id}`);assert.ok(result.height>=900);assert.ok([result.minX,result.minY,result.width,result.height].every(Number.isFinite));});
test('large dependency graphs render every node without adding data or labels',()=>{const tree=specimen28();tree.current_round=8;tree.nodes=Array.from({length:120},(_,i)=>({id:'n'+i,question:'题目'+i,input:'text',options:[],answer:null,status:'pending',round:Math.floor(i/15)+1,depends_on:i<15?[]:['n'+Math.floor((i-15)/3)]}));const result=layoutTree(tree);assert.equal(result.nodes.length,120);assert.equal(result.edges.length,120);assert.ok([result.width,result.height].every(Number.isFinite));});

test('camera centres the complete ink bounds without enlarging the tree or changing node positions',()=>{const tree=specimen28(),layout=layoutTree(tree),finished={...tree,status:'complete'},frame=cameraFrame(tree,layout),b=layout.paintBounds;assert.ok(frame.width>=1000&&frame.height>=910);assert.ok(Math.abs(frame.x+frame.width/2-b.x-b.width/2)<1e-8);assert.ok(Math.abs(frame.y+frame.height/2-b.y-b.height/2)<1e-8);assert.deepEqual(cameraFrame(tree),cameraFrame(finished));assert.deepEqual(layout.nodes,layoutTree(finished).nodes);});
test('every stage has a tapered short leader and final growth keeps the crown compact',()=>{const tree=specimen28(),before=structuredClone(tree),layout=layoutTree(tree),growing=trunkGeometry(layout,tree.current_round),finished=trunkGeometry(layout,tree.current_round,1);assert.ok(finished.top<growing.top&&finished.top>=growing.top-16);assert.ok(finished.tipWidth<1);assert.ok(growing.tipWidth<1);assert.equal(growing.twigs.length,2);assert.equal(finished.twigs.length,2);assert.ok(finished.twigs.every(t=>t.progress===1&&t.points[0][1]>t.points.at(-1)[1]));assert.deepEqual(finished,trunkGeometry(layoutTree({...tree,status:'complete'}),tree.current_round,1));assert.equal(layout.nodes.length,28);assert.equal(layout.fruit.length,tree.nodes.filter(n=>!n.depends_on.length).length);assert.deepEqual(tree,before);});
test('v7 child branches start at 70–80 percent of the parent Bezier and taper by depth',()=>{const layout=layoutTree(specimen28());for(const n of layout.nodes)if(n.parentId){const p=layout.nodes.find(x=>x.id===n.parentId),t=n.attachT;assert.ok(t>=.7&&t<=.8,`${n.id} attachment must be on the parent curve, not its flower`);const u=1-t,x=u*u*p.px+2*u*t*p.cx+t*t*p.x,y=u*u*p.py+2*u*t*p.cy+t*t*p.y;assert.ok(Math.hypot(x-n.px,y-n.py)<1e-8);assert.equal(n.width,Math.max(1.6,p.width*.45));assert.ok(n.length>=62&&n.length<=Math.max(62,p.length*.7)+1e-8);}});
test('curved branch and twig outlines do not introduce straight or right-angle joins',()=>{const layout=layoutTree(specimen28());for(const n of layout.nodes){const bend=Math.abs((n.cx-n.px)*(n.y-n.py)-(n.cy-n.py)*(n.x-n.px));assert.ok(bend>1e-5);const paths=[taper(n.points,n.width,1),...branchTwigs(n,true).map(t=>taper(t.points,t.width,t.tipWidth))];assert.ok(paths.every(d=>d.includes('C')&&!d.includes('L')));}});

test('each grown stage staggers alternating boughs and fills the top even when later rounds have no roots',()=>{
  for(const factory of[specimen28,specimen28FourRounds])for(let i=0;i<100;i++){
    const full=factory();full.session_id='staged-crown-'+i;let previousHeight=0;
    for(let round=1;round<=full.current_round;round++){
      const tree={...full,current_round:round,nodes:full.nodes.filter(n=>n.round<=round)},layout=layoutTree(tree),roots=layout.nodes.filter(n=>!n.parentId);
      const height=885-layout.top;assert.ok(height>previousHeight);previousHeight=height;
      assert.ok(Math.abs(height-layout.projection.stemHeight-layout.rounds.reduce((sum,r)=>sum+Math.max(70,Math.min(130,40+12*tree.nodes.filter(n=>n.round===r.round).length))*layout.projection.yScale,0))<1e-8);
      assert.ok(Math.min(...roots.map(n=>n.py))-layout.top<=28,'no empty upper trunk');
      for(let j=1;j<roots.length;j++){assert.equal(roots[j].side,-roots[j-1].side);assert.ok((roots[j-1].py-roots[j].py)/layout.projection.yScale>9,'boughs must not share a crossbar');}
      const growing=trunkGeometry(layout,round);assert.ok(growing.tipWidth<1);assert.equal(growing.twigs.length,2);
    }
  }
});

test('flowers occupy the middle of their own Bezier branches with bare wood beyond them',()=>{
  for(const factory of[specimen28,specimen28FourRounds]){
    const layout=layoutTree(factory());
    assert.ok(layout.nodes.filter(n=>n.bloomT<=.6).length>=8);
    for(const n of layout.nodes){const t=n.bloomT,u=1-t;assert.ok(t>=.42&&t<=.78);assert.ok(Math.hypot(n.bloomX-(u*u*n.px+2*u*t*n.cx+t*t*n.x),n.bloomY-(u*u*n.py+2*u*t*n.cy+t*t*n.y))<1e-8);assert.ok(Math.hypot(n.bloomX-n.x,n.bloomY-n.y)>12);}
  }
});

test('the trunk gains girth, later crowns widen, and complete ink stays below 75 percent of the frame',()=>{
  const full=specimen28();let width=0,height=0,lateral=0;
  for(const round of[1,2,4,6]){
    const tree={...full,current_round:round,nodes:full.nodes.filter(n=>n.round<=round)},layout=layoutTree(tree),trunk=trunkGeometry(layout,round),camera=cameraFrame(tree,layout);
    assert.ok(trunk.baseWidth>width);width=trunk.baseWidth;
    assert.ok(885-layout.top>height);height=885-layout.top;
    assert.ok(layout.projection.xScale>lateral);lateral=layout.projection.xScale;
    assert.ok(layout.paintBounds.height/camera.height<=.75+1e-8);
    if(round<=2){assert.ok(trunk.baseWidth<18);assert.ok(885-layout.top<300);}
  }
  const later={...full,current_round:12,nodes:full.nodes.map((n,i)=>({...n,round:Math.floor(i*12/28)+1}))},layout=layoutTree(later);
  assert.ok(layout.paintBounds.height/cameraFrame(later,layout).height<=.75+1e-8);
});

test('every fruit hangs from a terminal branch endpoint, never from its middle',()=>{
  for(const factory of[specimen28,specimen28FourRounds])for(let index=0;index<100;index++){
    const tree=factory();tree.session_id='fruit-tip-'+index;const layout=layoutTree(tree);
    for(const fruit of layout.fruit){const branch=layout.nodes.find(n=>n.id===fruit.nodeId);assert.ok(!layout.nodes.some(n=>n.parentId===branch.id));assert.ok(Math.hypot(fruit.x+fruit.stemX-branch.x,fruit.y+fruit.stemY-branch.y)<1e-8);assert.ok(fruit.y>branch.y);assert.ok(Math.abs(fruit.x-branch.x)<=28);}
  }
});

test('same node ids and dependencies grow distinct branches for different requirement ids',()=>{
  const a=specimen28(),b=structuredClone(a);a.session_id='requirement-A';b.session_id='requirement-B';
  const first=layoutTree(a),second=layoutTree(b);
  const shape=layout=>layout.nodes.map(n=>[n.angle,n.length,n.cx-(n.px+n.x)/2,n.cy-(n.py+n.y)/2]);
  assert.notDeepEqual(shape(first),shape(second),'requirement identity must participate in branch randomness');
  assert.ok(first.nodes.filter((n,i)=>Math.abs(n.angle-second.nodes[i].angle)>1||Math.abs(n.length-second.nodes[i].length)>3).length>=20);
  assert.deepEqual(first.edges,second.edges,'visual variation must not change dependencies');
  assert.deepEqual(first.fruit.map(({id,anchor,nodeId})=>({id,anchor,nodeId})),second.fruit.map(({id,anchor,nodeId})=>({id,anchor,nodeId})));
});

test('reload, answer edits and metadata changes keep one requirement recognisable',()=>{
  const tree=specimen28();tree.session_id='持久需求-id';const before=structuredClone(tree),first=layoutTree(tree);
  assert.deepEqual(first.nodes,layoutTree(JSON.parse(JSON.stringify(tree))).nodes);
  tree.revision+=7;tree.topic='标题调整';tree.status='complete';tree.nodes.forEach(n=>{n.status='needs_review';n.answer.text='修改后的回答';});
  const next=layoutTree(tree);assert.deepEqual(first.nodes,next.nodes);
  assert.deepEqual(trunkGeometry(first,tree.current_round,1),trunkGeometry(next,tree.current_round,1));
  assert.deepEqual(before.nodes.map(n=>n.id),tree.nodes.map(n=>n.id));
});

test('200 seeded 28-question trees stay inside v7 bounds and retain separate nodes and fruit',()=>{
  for(const factory of [specimen28,specimen28FourRounds])for(let index=0;index<100;index++){
    const tree=factory();tree.session_id='bounded-requirement-'+index;tree.nodes[11].status='needs_review';tree.nodes[20].status='needs_review';const original=structuredClone(tree),layout=layoutTree(tree);
    const counts=new Map();for(const n of tree.nodes)counts.set(n.round,(counts.get(n.round)||0)+1);
    const siblings=new Map();for(const n of [...layout.nodes].sort((a,b)=>a.round-b.round||a.depth-b.depth||tree.nodes.findIndex(x=>x.id===a.id)-tree.nodes.findIndex(x=>x.id===b.id))){
      const parent=layout.nodes.find(p=>p.id===n.parentId);let baseAngle,minLength,maxLength;
      if(parent){const k=(siblings.get(parent.id)||0)+1;siblings.set(parent.id,k);baseAngle=parent.angle+(k%2?-1:1)*(18+k*4)*(parent.side>0?1:-1)*-1;minLength=Math.max(62,parent.length*.45);maxLength=Math.max(62,parent.length*.7);assert.ok(n.attachT>=.7&&n.attachT<=.8);}
      else{baseAngle=n.side>0?-24-n.round*3:-156+n.round*3;const size=Math.max(130,Math.min(240,100+20*counts.get(n.round)-6*n.round));const crownLevel=(n.py-layout.top)/(layout.rounds[0].bottom-layout.top),lengthScale=1+Math.min(1,(tree.current_round-1)/4)*(-.2+.24*Math.sin(Math.PI*crownLevel));minLength=size*.85*lengthScale;maxLength=size*1.15*lengthScale;const band=layout.rounds.find(r=>r.round===n.round),nextRootRound=Math.min(Infinity,...layout.nodes.filter(p=>!p.parentId&&p.round>n.round).map(p=>p.round)),last=layout.rounds.find(r=>r.round===Math.min(tree.current_round,nextRootRound-1));assert.ok(n.py>last.top&&n.py<band.bottom);}
      assert.ok(Math.abs(n.angle-baseAngle)<=(parent?13:11)+1e-8,tree.session_id+' angle escaped v7 bounds: '+n.id);
      assert.ok(n.length>=minLength-1e-8&&n.length<=maxLength+1e-8,tree.session_id+' length escaped v7 bounds: '+n.id);
      const angle=n.angle*Math.PI/180,bend=(n.cx-(n.px+n.x)/2)/layout.projection.xScale,up=((n.py+n.y)/2-n.cy)/layout.projection.yScale;
      assert.ok(Math.abs(bend)<=32+1e-8&&up>=10-1e-8&&up<=24+1e-8);
      if(Math.abs(Math.sin(angle))>1e-6){const radius=bend/(Math.sin(angle)*n.side);assert.ok(radius>=10-1e-8&&radius<=32+1e-8);}
    }
    const bounds=n=>{
      if(tree.nodes.find(x=>x.id===n.id).status==='needs_review'){const angle=n.angle*Math.PI/180,x=Math.hypot(9*Math.cos(angle),3.6*Math.sin(angle)),y=Math.hypot(9*Math.sin(angle),3.6*Math.cos(angle));return{left:n.bloomX-x,right:n.bloomX+x,top:n.bloomY-y,bottom:n.bloomY+y};}
      return{left:n.bloomX-5.651,right:n.bloomX+6.3,top:n.bloomY-6.134,bottom:n.bloomY+6.134};
    };
    for(let i=0;i<layout.nodes.length;i++)for(let j=0;j<i;j++){
      const a=layout.nodes[i],b=layout.nodes[j];
      assert.ok(Math.hypot(a.bloomX-b.bloomX,a.bloomY-b.bloomY)>=13,tree.session_id+' flower overlap: '+a.id+'/'+b.id);const x=bounds(a),y=bounds(b);assert.ok(Math.min(x.right,y.right)-Math.max(x.left,y.left)<=.01||Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)<=.01,tree.session_id+' painted symbols overlap: '+a.id+'/'+b.id);
    }
    for(let i=0;i<layout.fruit.length;i++){
      const f=layout.fruit[i];for(const n of layout.nodes)assert.ok(Math.hypot(f.x-n.bloomX,f.y-n.bloomY)>=18-1e-8,tree.session_id+' fruit overlaps '+n.id);
      for(let j=0;j<i;j++)assert.ok(Math.hypot(f.x-layout.fruit[j].x,f.y-layout.fruit[j].y)>=18-1e-8,tree.session_id+' fruit overlap');
    }
    assert.deepEqual(tree,original,'layout must not write a seed or modify answers');
  }
});
