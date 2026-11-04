import{test}from'node:test';
import assert from'node:assert/strict';
import{readFileSync}from'node:fs';
import{dirname,join}from'node:path';
import{fileURLToPath}from'node:url';
import{createDecisionTree}from'../assets/tree.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const dataName=key=>'data-'+String(key).replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());
class El{
  constructor(tag){this.tagName=tag;this.attrs=new Map();this.children=[];this.parent=null;this.textContent='';this.style={};this.classList={toggle:(name,force)=>{const list=new Set((this.getAttribute('class')||'').split(/\s+/).filter(Boolean));const on=force===undefined?!list.has(name):Boolean(force);if(on)list.add(name);else list.delete(name);this.setAttribute('class',[...list].join(' '));return on;},contains:name=>(this.getAttribute('class')||'').split(/\s+/).includes(name)};this.dataset=new Proxy({},{get:(_,key)=>this.attrs.has(dataName(key))?this.attrs.get(dataName(key)):undefined,set:(_,key,value)=>{this.setAttribute(dataName(key),value);return true;}});this.listeners=new Map();this.animations=[];this.hidden=false;this.disabled=false;}
  setAttribute(key,value){this.attrs.set(key,String(value));}
  getAttribute(key){return this.attrs.has(key)?this.attrs.get(key):null;}
  append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  addEventListener(type,fn){const list=this.listeners.get(type)??[];list.push(fn);this.listeners.set(type,list);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  querySelectorAll(selector){const found=[];const visit=node=>{for(const child of node.children){if(matches(child,selector))found.push(child);visit(child);}};visit(this);return found;}
  animate(keyframes,options){const animation={keyframes,options,finished:false,finish(){this.finished=true;}};this.animations.push(animation);return animation;}
  getAnimations({subtree=false}={}){const found=this.animations.filter(animation=>!animation.finished);if(subtree)for(const child of this.children)found.push(...child.getAnimations({subtree:true}));return found;}
  focus(){}
  set innerHTML(value){this._html=value;this.replaceChildren();}
  get innerHTML(){return this._html??'';}
}
function matches(node,selector){
  if(selector.startsWith('#'))return node.getAttribute('id')===selector.slice(1);
  if(selector.startsWith('.'))return (node.getAttribute('class')||'').split(/\s+/).includes(selector.slice(1));
  if(selector.startsWith('[')&&selector.endsWith(']'))return node.attrs.has(selector.slice(1,-1));
  return node.tagName===selector;
}
const mql={matches:false,listeners:[],addEventListener(_type,fn){this.listeners.push(fn);}};
let now=10_000,seq=0,queue=[],jobs=new Map();
function install(){
  now=10_000;seq=0;queue=[];jobs=new Map();mql.matches=false;mql.listeners=[];
  const doc=new El('#document');doc.createElementNS=(_ns,tag)=>new El(tag);
  globalThis.document=doc;
  globalThis.matchMedia=query=>{if(query!=='(prefers-reduced-motion: reduce)')throw new Error(query);return mql;};
  globalThis.requestAnimationFrame=fn=>{const id=++seq;jobs.set(id,fn);queue.push(id);return id;};
  globalThis.cancelAnimationFrame=id=>jobs.delete(id);
  globalThis.performance={now:()=>now};
}
function flush(ms){now+=ms;for(const id of queue.splice(0)){const fn=jobs.get(id);jobs.delete(id);fn?.(now);}}
function pendingFrames(){return queue.filter(id=>jobs.has(id)).length;}
function question(id,round,depends,status){return{id,question:id+'？',rationale:'合成测试：只验证减少动态效果。',input:'text',options:[],answer:status==='pending'?null:{option_ids:[],text:'已确认'},depends_on:depends,status,round};}
function interview(complete=false){return{schema_version:2,session_id:'reduced-motion-fixture',topic:'减少动态',revision:1,current_round:2,status:complete?'complete':'active',nodes:[question('root',1,[],'answered'),question('child',2,['root'],'answered'),question('side',2,['root'],complete?'answered':'pending')]};}
function mount(matches){
  install();mql.matches=matches;
  const canvas=new El('svg');canvas.setAttribute('id','tree-canvas');
  const replay=new El('button');replay.setAttribute('data-tree-replay','');replay.hidden=true;replay.textContent='重看生长';
  const container=new El('section');container.append(canvas,replay);
  const view=createDecisionTree(container);
  return{canvas,replay,view};
}
function snapshot(canvas){
  const ordered=(selector,map)=>canvas.querySelectorAll(selector).map(map).sort((a,b)=>a.id.localeCompare(b.id));
  return{
    nodes:ordered('.tree-node',node=>({id:node.getAttribute('data-node-id'),transform:node.getAttribute('transform'),opacity:node.style.opacity,visible:node.dataset.visible,hidden:node.getAttribute('aria-hidden')})),
    branches:ordered('.tree-branch',node=>({id:node.getAttribute('data-to'),d:node.getAttribute('d')})),
    washes:ordered('.tree-wash',node=>({id:node.getAttribute('data-node-id'),opacity:node.getAttribute('opacity')})),
    fruit:ordered('.tree-fruit',node=>({id:node.getAttribute('data-fruit-id'),opacity:node.style.opacity,visibility:node.style.visibility,scale:node.querySelector('.fruit-growth').getAttribute('transform'),hidden:node.getAttribute('aria-hidden')})),
    trunk:canvas.querySelector('.tree-trunk')?.getAttribute('d')??'',
    twigs:canvas.querySelectorAll('.tree-completion-twig').map(node=>node.getAttribute('d')).sort(),
    growing:canvas.dataset.growing,stage:canvas.dataset.growthStage,replaying:canvas.dataset.replaying,completion:canvas.dataset.completion,
  };
}
function animations(node){return node.animations.length+node.children.reduce((sum,child)=>sum+animations(child),0);}
function settle(){for(let i=0;i<120&&pendingFrames();i++)flush(80);assert.equal(pendingFrames(),0);}

test('reduced motion paints the settled interview immediately and keeps growth when motion is allowed',()=>{
  const tree=interview(false);
  const reduced=mount(true);reduced.view.update(tree);
  const immediate=snapshot(reduced.canvas);
  assert.equal(pendingFrames(),0);
  assert.equal(animations(reduced.canvas),0);
  assert.equal(immediate.growing,'false');
  assert.equal(immediate.replaying,'false');
  assert.equal(immediate.nodes.length,3);
  assert.ok(immediate.nodes.every(node=>node.opacity==='1'&&node.visible==='true'&&node.hidden==='false'));
  assert.ok(immediate.branches.every(branch=>branch.d.includes('C')));
  assert.ok(immediate.trunk.length>10);
  reduced.replay.listeners.get('click').forEach(fn=>fn());
  assert.equal(reduced.canvas.dataset.replaying,'false');
  assert.equal(reduced.canvas.dataset.growing,'false');
  assert.equal(pendingFrames(),0);

  const moving=mount(false);moving.view.update(tree);flush(16);
  const early=snapshot(moving.canvas);
  assert.equal(early.growing,'true');
  assert.ok(animations(moving.canvas)>0);
  assert.notDeepEqual(early.branches,immediate.branches);
  settle();
  assert.deepEqual(snapshot(moving.canvas),immediate);

  const live=mount(false);live.view.update(tree);flush(200);
  assert.equal(live.canvas.dataset.growing,'true');
  mql.matches=true;for(const fn of mql.listeners)fn();
  assert.deepEqual(snapshot(live.canvas),immediate);
  assert.equal(pendingFrames(),0);
  assert.equal(live.canvas.getAnimations({subtree:true}).length,0);

  const done=interview(true);
  const reducedDone=mount(true);reducedDone.view.update(done);
  const finished=snapshot(reducedDone.canvas);
  assert.equal(finished.fruit.length,1);
  assert.equal(finished.fruit[0].opacity,'1');
  assert.equal(finished.fruit[0].visibility,'visible');
  assert.equal(finished.fruit[0].scale,'scale(1)');
  assert.equal(finished.fruit[0].hidden,'false');
  assert.equal(finished.stage,'complete');
  assert.equal(finished.completion,'1.000');
  assert.equal(reducedDone.replay.hidden,true);
  assert.equal(pendingFrames(),0);
  const played=mount(false);played.view.update(done);flush(16);
  assert.equal(played.canvas.dataset.replaying,'true');
  assert.notDeepEqual(snapshot(played.canvas).fruit,finished.fruit);
  settle();
  assert.deepEqual(snapshot(played.canvas),finished);
  assert.equal(played.replay.hidden,false);
  assert.equal(played.replay.textContent,'重看生长');
});

test('reduced motion stops the waiting pulse and leaves the waiting state visible to the page',()=>{
  const tree=interview(false),waiting={waiting:true};
  const moving=mount(false);moving.view.update(tree,waiting);
  for(let i=0;i<120&&moving.canvas.dataset.growthStage!=='waiting';i++)flush(80);
  assert.equal(moving.canvas.dataset.growthStage,'waiting');
  assert.equal(moving.canvas.classList.contains('is-waiting'),true);
  const first=moving.canvas.querySelector('.tree-trunk').getAttribute('d');
  flush(425);
  assert.notEqual(moving.canvas.querySelector('.tree-trunk').getAttribute('d'),first);

  const reduced=mount(true);reduced.view.update(tree,waiting);
  const still=reduced.canvas.querySelector('.tree-trunk').getAttribute('d');
  assert.equal(reduced.canvas.classList.contains('is-waiting'),false);
  assert.equal(reduced.canvas.dataset.waiting,'true');
  assert.equal(reduced.canvas.dataset.growing,'false');
  assert.equal(pendingFrames(),0);
  now+=425;reduced.view.update(tree,waiting);
  assert.equal(reduced.canvas.querySelector('.tree-trunk').getAttribute('d'),still);
  assert.equal(pendingFrames(),0);
});

test('motion does not depend on animation or transition events',()=>{
  const files=['assets/app.mjs','assets/tree.mjs','assets/style.css','assets/index.html','assets/writer-shell.html','assets/presentation.mjs'];
  for(const file of files){
    const source=readFileSync(join(root,file),'utf8');
    assert.equal(/animationend|transitionend|webkitAnimationEnd|<animate[\s>]/i.test(source),false,file);
  }
  for(const file of['assets/style.css','assets/writer-shell.html'])assert.match(readFileSync(join(root,file),'utf8'),/@media\(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important/);
  assert.match(readFileSync(join(root,'assets/tree.mjs'),'utf8'),/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(readFileSync(join(root,'assets/writer-shell.html'),'utf8'),/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
});
