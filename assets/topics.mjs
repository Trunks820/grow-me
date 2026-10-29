// Read-only v1 projections shared by the renderer and document bridge.
export function primaryGraph(tree) {
  const entries=new Map(tree.nodes.map((node,index)=>[node.id,{node,index}])),visiting=new Set();
  function resolve(entry){
    if(entry.depth!==undefined)return entry;
    if(visiting.has(entry.node.id))throw Error('dependency cycle');visiting.add(entry.node.id);
    const deps=entry.node.depends_on.map(id=>entries.get(id));if(deps.some(x=>!x))throw Error('unknown dependency');
    deps.sort((a,b)=>b.node.round-a.node.round||b.index-a.index);
    const parent=deps[0]?resolve(deps[0]):null;
    Object.assign(entry,{parentId:parent?.node.id??null,rootId:parent?.rootId??entry.node.id,depth:parent?parent.depth+1:0});
    visiting.delete(entry.node.id);return entry;
  }
  return [...entries.values()].map(resolve);
}
export const chapterAnchor=id=>'topic-'+Array.from({length:id.length},(_,i)=>id.charCodeAt(i).toString(16).padStart(4,'0')).join('');
export function chapters(tree){const graph=primaryGraph(tree);return graph.filter(e=>e.parentId===null).map(root=>({id:root.node.id,anchor:chapterAnchor(root.node.id),title:root.node.question,nodes:graph.filter(e=>e.rootId===root.node.id).map(e=>e.node)}));}
export function answerText(node,answer=node.answer){return !answer?'尚未回答':[...node.options.filter(o=>answer.option_ids.includes(o.id)).map(o=>o.label),answer.text].filter(Boolean).join('\n');}
