import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fingerprint} from './document.mjs';
import {validateTree} from './model.mjs';
import {chapters} from '../assets/topics.mjs';
import {isMain} from './entry.mjs';

const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function renderChapter(status,tree,chapterId,explanation){
  validateTree(tree);
  if(tree.status!=='complete'||tree.nodes.some(n=>n.status!=='answered')||!status.job_id||!['requested','generating'].includes(status.phase))throw Error('需要已保存冻结的访谈和当前生成任务');
  if(status.source?.session_id!==tree.session_id||status.source.revision!==tree.revision||status.source.digest!==fingerprint(tree))throw Error('冻结来源不匹配');
  const chapter=chapters(tree).find(c=>c.id===chapterId),binding=status.source.chapters.find(c=>c.id===chapterId);
  if(!chapter||!binding||JSON.stringify(binding.node_ids)!==JSON.stringify(chapter.nodes.map(n=>n.id)))throw Error('章节归属不匹配');
  if(typeof explanation!=='string'||!explanation.trim()||/^\s*(?:event:|data:|\{)/.test(explanation))throw Error('需要已写好的说明性 HTML');
  const answers=chapter.nodes.map(n=>{
    const selected=n.answer.option_ids.map(id=>n.options.find(o=>o.id===id));
    return `<section data-source-node="${escape(n.id)}"><h4>${escape(n.question)}</h4>${selected.length?'<p>用户选择：</p><ul>'+selected.map(o=>`<li>${escape(o.label)}</li>`).join('')+'</ul>':''}${n.answer.text?`<p>用户原话：</p><pre class="frozen-answer" style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${escape(n.answer.text)}</pre>`:''}</section>`;
  }).join('\n');
  return{source:{session_id:tree.session_id,revision:tree.revision,digest:status.source.digest,job_id:status.job_id},view:'chapter',chapter_id:chapterId,title:binding.title,html:`<section class="frozen-answers"><h3>已提交的决定</h3>${answers}</section><section class="writer-explanation"><h3>方案说明（AI）</h3>${explanation}</section>`};
}
if(isMain(import.meta.url)){
  const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
  if(args.includes('--help'))console.log('node scripts/render-chapter.mjs --context <status.json> --tree <tree.json> --chapter <root-id> --explanation <prose.html> --out <parts/chapter.json>\nOriginal answers are escaped and rendered directly from the frozen tree. AI supplies explanatory HTML only.');
  else try{
    for(const key of ['--context','--tree','--chapter','--explanation','--out'])if(!args.includes(key)||!value(key))throw Error(key+' required');
    const result=renderChapter(JSON.parse(readFileSync(value('--context'),'utf8')),JSON.parse(readFileSync(value('--tree'),'utf8')),value('--chapter'),readFileSync(value('--explanation'),'utf8'));
    const file=value('--out'),temp=file+'.'+process.pid+'.tmp';mkdirSync(dirname(file),{recursive:true});writeFileSync(temp,JSON.stringify(result,null,2)+'\n','utf8');renameSync(temp,file);console.log(JSON.stringify({file,chapter_id:result.chapter_id,source:result.source}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
