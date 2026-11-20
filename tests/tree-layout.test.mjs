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
test('both 28-question fixtures have at least 13 units between question centers',()=>{
  for(const factory of [specimen28,specimen28FourRounds]){
    const result=layoutTree(factory());
    for(const [i,a] of result.nodes.entries())for(const b of result.nodes.slice(0,i))
      assert.ok(Math.hypot(a.bloomX-b.bloomX,a.bloomY-b.bloomY)>=13,`${a.id} overlaps ${b.id}`);
    assert.ok(result.height>=900);
    assert.ok([result.minX,result.minY,result.width,result.height].every(Number.isFinite));
  }
});
test('large dependency graphs render every node without adding data or labels',()=>{const tree=specimen28();tree.current_round=8;tree.nodes=Array.from({length:120},(_,i)=>({id:'n'+i,question:'题目'+i,input:'text',options:[],answer:null,status:'pending',round:Math.floor(i/15)+1,depends_on:i<15?[]:['n'+Math.floor((i-15)/3)]}));const result=layoutTree(tree);assert.equal(result.nodes.length,120);assert.equal(result.edges.length,120);assert.ok([result.width,result.height].every(Number.isFinite));});

test('camera centres the ink with fixed minimum dimensions and room around the crown',()=>{
  const tree=specimen28(),layout=layoutTree(tree),finished={...tree,status:'complete'},frame=cameraFrame(tree,layout),b=layout.paintBounds;
  assert.equal(frame.width,Math.max(820,b.width+140));
  assert.equal(frame.height,Math.max(840,b.height/.9));
  assert.ok(Math.abs(frame.x+frame.width/2-b.x-b.width/2)<1e-8);
  assert.ok(Math.abs(frame.y+frame.height/2-b.y-b.height/2)<1e-8);
  assert.deepEqual(cameraFrame(tree),cameraFrame(finished));
  assert.deepEqual(layout.nodes,layoutTree(finished).nodes);
});
test('finishing the tree tapers the leader and keeps its decorative shoots on the trunk',()=>{
  const tree=specimen28(),before=structuredClone(tree),layout=layoutTree(tree),growing=trunkGeometry(layout,tree.current_round),finished=trunkGeometry(layout,tree.current_round,1);
  assert.equal(finished.top,growing.top-12);
  assert.equal(growing.tipWidth,.85);
  assert.ok(Math.abs(finished.tipWidth-.55)<1e-8);
  assert.ok(growing.twigs.length>2);
  assert.equal(finished.twigs.length,growing.twigs.length);
  assert.ok(finished.twigs.every(t=>t.progress===1&&t.points[0][1]>t.points.at(-1)[1]&&t.points[0][1]>=finished.top));
  assert.deepEqual(finished,trunkGeometry(layoutTree({...tree,status:'complete'}),tree.current_round,1));
  assert.equal(layout.nodes.length,28);
  assert.equal(layout.fruit.length,tree.nodes.filter(n=>!n.depends_on.length).length);
  assert.deepEqual(tree,before);
});
test('v7 child branches start at 70–80 percent of the parent Bezier and taper by depth',()=>{const layout=layoutTree(specimen28());for(const n of layout.nodes)if(n.parentId){const p=layout.nodes.find(x=>x.id===n.parentId),t=n.attachT;assert.ok(t>=.7&&t<=.8,`${n.id} attachment must be on the parent curve, not its flower`);const u=1-t,x=u*u*p.px+2*u*t*p.cx+t*t*p.x,y=u*u*p.py+2*u*t*p.cy+t*t*p.y;assert.ok(Math.hypot(x-n.px,y-n.py)<1e-8);assert.equal(n.width,Math.max(1.6,p.width*.45));assert.ok(n.length>=62&&n.length<=Math.max(62,p.length*.7)+1e-8);}});
test('curved branch and twig outlines do not introduce straight or right-angle joins',()=>{const layout=layoutTree(specimen28());for(const n of layout.nodes){const bend=Math.abs((n.cx-n.px)*(n.y-n.py)-(n.cy-n.py)*(n.x-n.px));assert.ok(bend>1e-5);const paths=[taper(n.points,n.width,1),...branchTwigs(n,true).map(t=>taper(t.points,t.width,t.tipWidth))];assert.ok(paths.every(d=>d.includes('C')&&!d.includes('L')));}});

test('each grown stage staggers alternating boughs and fills the top even when later rounds have no roots',()=>{
  for(const factory of[specimen28,specimen28FourRounds])for(let i=0;i<100;i++){
    const full=factory();full.session_id='staged-crown-'+i;let previousHeight=0;
    for(let round=1;round<=full.current_round;round++){
      const tree={...full,current_round:round,nodes:full.nodes.filter(n=>n.round<=round)},layout=layoutTree(tree),roots=layout.nodes.filter(n=>!n.parentId);
      const height=885-layout.top;assert.ok(height>previousHeight);previousHeight=height;
      const bands=layout.rounds.map(({round})=>{
        const count=tree.nodes.filter(n=>n.round===round).length;
        return round===1?Math.max(80,Math.min(170,50+16*count)):Math.max(70,Math.min(130,40+12*count));
      });
      assert.ok(Math.abs(height-layout.projection.stemHeight-bands.reduce((sum,band)=>sum+band*layout.projection.yScale,0))<1e-8);
      for(let j=1;j<roots.length;j++){assert.equal(roots[j].side,-roots[j-1].side);assert.ok((roots[j-1].py-roots[j].py)/layout.projection.yScale>9,'boughs must not share a crossbar');}
      const growing=trunkGeometry(layout,round),shoots=growing.twigs.slice(2);
      const stops=[...roots.map(n=>n.py),layout.top+40];
      for(let j=1;j<stops.length;j++){
        const gap=stops[j-1]-stops[j];
        if(gap>=46)assert.equal(shoots.filter(t=>t.points[0][1]<stops[j-1]&&t.points[0][1]>stops[j]).length,Math.floor(gap/38));
      }
    }
  }
});

test('questions generally bloom near the tip on their own curved branch',()=>{
  for(const factory of[specimen28,specimen28FourRounds]){
    const layout=layoutTree(factory());
    assert.ok(layout.nodes.filter(n=>n.bloomT>=.72).length>layout.nodes.length/2);
    for(const n of layout.nodes){const t=n.bloomT,u=1-t;assert.ok(t>=.42&&t<=.90);assert.ok(Math.hypot(n.bloomX-(u*u*n.px+2*u*t*n.cx+t*t*n.x),n.bloomY-(u*u*n.py+2*u*t*n.cy+t*t*n.y))<1e-8);assert.ok(Math.hypot(n.bloomX-n.x,n.bloomY-n.y)>=16-1e-8);}
  }
});

test('one late topic forms the crown and its follow-ups fork to both sides',()=>{
  const tree=specimen28();
  tree.current_round=3;
  tree.nodes=tree.nodes.slice(0,5).map((node,index)=>({
    ...node,
    round:[1,1,2,2,3][index],
    depends_on:index>2?['q03']:[]
  }));
  const [,,leader,right,left]=layoutTree(tree).nodes;
  assert.ok(leader.y<leader.py&&Math.abs(leader.x-leader.px)<(leader.py-leader.y)/2);
  assert.equal(right.parentId,leader.id);
  assert.equal(left.parentId,leader.id);
  assert.ok(right.x>right.px&&left.x<left.px);
});

test('the trunk and crown grow while the camera leaves room for the whole tree',()=>{
  const full=specimen28();let width=0,height=0,lateral=0;
  for(const round of[1,2,4,6]){
    const tree={...full,current_round:round,nodes:full.nodes.filter(n=>n.round<=round)},layout=layoutTree(tree),trunk=trunkGeometry(layout,round),camera=cameraFrame(tree,layout);
    assert.ok(trunk.baseWidth>width);width=trunk.baseWidth;
    assert.ok(885-layout.top>height);height=885-layout.top;
    assert.ok(layout.projection.xScale>lateral);lateral=layout.projection.xScale;
    assert.ok(layout.paintBounds.height/camera.height<=.9+1e-8);
    if(round===1)assert.ok(layout.paintBounds.height/camera.height<.4);
  }
  const later={...full,current_round:12,nodes:full.nodes.map((n,i)=>({...n,round:Math.floor(i*12/28)+1}))},layout=layoutTree(later);
  assert.ok(layout.paintBounds.height/cameraFrame(later,layout).height<=.9+1e-8);
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

test('200 seeded 28-question trees stay within the new branch bounds and leave room for flowers and fruit',()=>{
  for(const factory of [specimen28,specimen28FourRounds])for(let index=0;index<100;index++){
    const tree=factory();tree.session_id='bounded-requirement-'+index;tree.nodes[11].status='needs_review';tree.nodes[20].status='needs_review';const original=structuredClone(tree),layout=layoutTree(tree);
    const counts=new Map();for(const n of tree.nodes)counts.set(n.round,(counts.get(n.round)||0)+1);
    const roots=layout.nodes.filter(n=>!n.parentId),siblings=new Map(),trunk=trunkGeometry(layout,tree.current_round);
    for(const n of [...layout.nodes].sort((a,b)=>a.round-b.round||a.depth-b.depth)){
      const parent=layout.nodes.find(p=>p.id===n.parentId);
      let baseAngle,angleLimit,minLength,maxLength;
      if(parent){
        const k=(siblings.get(parent.id)||0)+1;
        siblings.set(parent.id,k);
        baseAngle=parent.angle+(k%2?1:-1)*(16+k*3)*parent.side;
        angleLimit=23;
        minLength=Math.max(62,parent.length*.45);
        maxLength=Math.max(62,parent.length*.7)*1.3;
        assert.ok(n.attachT>=.7&&n.attachT<=.8);
      }else{
        const crownLevel=(n.py-layout.top)/(layout.rounds[0].bottom-layout.top);
        const tilt=20+36*(1-crownLevel);
        const band=layout.rounds.find(r=>r.round===n.round);
        const nextRootRound=Math.min(Infinity,...roots.filter(p=>p.round>n.round).map(p=>p.round));
        const last=layout.rounds.find(r=>r.round===Math.min(tree.current_round,nextRootRound-1));
        const loneTop=n.round>1&&nextRootRound===Infinity&&roots.filter(p=>p.round===n.round).length===1;
        baseAngle=loneTop?(n.side>0?-78:-102):(n.side>0?-tilt:-180+tilt);
        angleLimit=loneTop?11:8;
        const size=Math.max(130,Math.min(240,100+20*counts.get(n.round)-6*n.round));
        const lengthScale=1+Math.min(1,(tree.current_round-1)/4)*(-.2+.24*Math.sin(Math.PI*crownLevel));
        const length=size*lengthScale*(.68+.42*crownLevel)*(loneTop ? .8 : 1);
        minLength=length*.85;
        maxLength=length*1.15;
        assert.ok(n.py>last.top&&n.py<band.bottom);
        const t=(885-n.py)/(885-layout.top);
        const width=trunk.baseWidth+(trunk.tipWidth-trunk.baseWidth)*t**1.7;
        assert.ok(Math.abs(n.width-Math.min(Math.max(5,10.5-.9*n.round),Math.max(2.4,width*.85)))<1e-8);
      }
      assert.ok(Math.abs(n.angle-baseAngle)<=angleLimit+1e-8,tree.session_id+' branch angle: '+n.id);
      assert.ok(n.length>=minLength-1e-8&&n.length<=maxLength+1e-8,tree.session_id+' branch length: '+n.id);
      const angle=n.angle*Math.PI/180,bend=(n.cx-(n.px+n.x)/2)/layout.projection.xScale,up=((n.py+n.y)/2-n.cy)/layout.projection.yScale;
      assert.ok(Math.abs(bend)<=40+1e-8&&up>=18-1e-8&&up<=34+1e-8);
      if(Math.abs(Math.sin(angle))>1e-6){const radius=bend/(Math.sin(angle)*n.side);assert.ok(radius>=16-1e-8&&radius<=40+1e-8);}
    }
    const bounds=n=>{
      if(tree.nodes.find(x=>x.id===n.id).status==='needs_review'){const angle=n.angle*Math.PI/180,x=Math.hypot(9*Math.cos(angle),3.6*Math.sin(angle)),y=Math.hypot(9*Math.sin(angle),3.6*Math.cos(angle));return{left:n.bloomX-x,right:n.bloomX+x,top:n.bloomY-y,bottom:n.bloomY+y};}
      return{left:n.bloomX-13.13,right:n.bloomX+11.95,top:n.bloomY-9.375,bottom:n.bloomY+11.08};
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
