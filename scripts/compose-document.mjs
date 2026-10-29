import {readFileSync,writeFileSync,readdirSync,renameSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateDocument} from './document.mjs';

const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const same=(part,status)=>part.source?.session_id===status.source.session_id&&part.source.revision===status.source.revision&&part.source.digest===status.source.digest&&part.source.job_id===status.job_id;
export function composeDocument(status,parts,{preview=false}={}){
  if(!status.job_id||!['requested','generating'].includes(status.phase))throw Error('需要当前冻结访谈的生成任务');
  const views=new Map(),chapterParts=new Map();
  for(const part of parts){
    if(!same(part,status))throw Error('分片来源或 job 已过期');
    if(typeof part.html!=='string'||!part.html.trim()||/^\s*(?:event:|data:|\{)/.test(part.html))throw Error('分片必须是已写好的 HTML 正文');
    if(part.view==='chapter'){
      if(!status.source.chapters.some(c=>c.id===part.chapter_id)||chapterParts.has(part.chapter_id))throw Error('章节不存在或重复');chapterParts.set(part.chapter_id,part);
    }else{if(!['design','plan','acceptance'].includes(part.view)||views.has(part.view))throw Error('视图不存在或重复');views.set(part.view,part);}
  }
  if(!preview&&(views.size!==3||chapterParts.size!==status.source.chapters.length))throw Error('最终文档需要三个视图和全部章节');
  const design=views.get('design'),pending='<p class="small">本部分仍在生成；完成的主题章节已可阅读。</p>';
  const chapters=status.source.chapters.map(c=>{const part=chapterParts.get(c.id);return`<article id="${c.anchor}"${part?' data-chapter-ready="true"':''}><h2>${escape(part?.title??c.title)}</h2>${part?.html??pending}</article>`;}).join('\n');
  const values={TITLE:escape(design?.title??'需求梳理记录'),REVISION:'source-'+status.source.revision,UPDATED:escape(design?.updated??''),SUMMARY:escape(design?.summary??(preview?'正在生成；已完成章节可以先阅读。':'本次已确认回答与方案记录。')),POSITION:preview?'文档生成中，尚未完成最终校验。':'全文已组装，验收状态以正文为准。',NEXT:preview?'可从树上的成熟果子打开已完成主题。':'阅读方案、开发清单与验收标准。',CONTEXT:escape('访谈 '+status.source.session_id+' / revision '+status.source.revision),DECISIONS:design?.decisions??'',DESIGN:chapters+(design?.html??pending),REQUIREMENTS:'',CONSTRAINTS:'',PLAN:views.get('plan')?.html??pending,HANDOFF:'',ACCEPTANCE:views.get('acceptance')?.html??pending};
  let html=readFileSync(new URL('../assets/writer-shell.html',import.meta.url),'utf8').replace(/\{\{([A-Z]+)\}\}/g,(_,key)=>values[key]??'');
  const attrs=` data-source-session="${escape(status.source.session_id)}" data-source-revision="${status.source.revision}" data-source-digest="${escape(status.source.digest)}" data-source-job="${escape(status.job_id)}"${preview?' data-generating="true"':''}`;
  html=html.replace('<main data-task-record','<main'+attrs+' data-task-record');
  for(const id of ['requirements','constraints','handoff'])html=html.replace(new RegExp('<section id="'+id+'"[\\s\\S]*?<\\/section>'), '');
  if(preview){
    // Pending references are visibly pending anchors, never pretend requirement/acceptance entries.
    const ids=new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(x=>x[1]));
    const missing=[...new Set([...html.matchAll(/\shref="#([^"]+)"/g)].map(x=>x[1]))].filter(id=>!ids.has(id));
    html=html.replace('<section id="plan-view"',missing.map(id=>`<p id="${escape(id)}" class="small">相关内容仍在生成。</p>`).join('')+'<section id="plan-view"');
    html=html.replace('function refreshSummaries(){','function refreshSummaries(){\n if(record.hasAttribute("data-generating")){document.getElementById("record-check").textContent="章节预览 · 全文仍在生成，任务包在完成校验后开放。";return;}');
    html=html.replace('for(const item of nodes().filter(', 'for(const item of (record.hasAttribute("data-generating")?[]:nodes()).filter(');
  }
  return{html,ready_chapters:[...chapterParts.keys()],views:[...views.keys()]};
}

async function main(){
  const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
  if(args.includes('--help')||!args.includes('--context')){console.log('node compose-document.mjs --context status.json --tree tree.json --parts <dir> [--preview] [--url http://127.0.0.1:PORT]\nEach JSON part: {source:{session_id,revision,digest,job_id},view:design|plan|acceptance|chapter,html,...}. Chapter parts also carry chapter_id and optional title. Outputs are atomic; --preview publishes readable chapters when --url is given. Final output still needs writer validation then action ready.');return;}
  const started=performance.now(),status=JSON.parse(readFileSync(value('--context'),'utf8')),tree=JSON.parse(readFileSync(value('--tree'),'utf8')),preview=args.includes('--preview');
  if(args.includes('--url')){const response=await fetch(value('--url')+'/document/status');if(!response.ok)throw Error('无法核对当前生成任务');const current=await response.json();if(current.job_id!==status.job_id||current.phase!=='generating'||current.source.digest!==status.source.digest)throw Error('生成任务已过期，未写入文件');}
  const parts=readdirSync(value('--parts')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(resolve(value('--parts'),n),'utf8'))),result=composeDocument(status,parts,{preview});
  const file=status.source.document_file+(preview?'.preview.html':''),temp=file+'.'+process.pid+'.tmp';mkdirSync(dirname(file),{recursive:true});writeFileSync(temp,result.html,'utf8');
  try{if(preview){for(const id of result.ready_chapters)validateDocument(temp,tree,status.job_id,{partial:true,chapterId:id});}else validateDocument(temp,tree,status.job_id);renameSync(temp,file);}catch(error){throw Error('组装校验失败：'+error.message);}
  if(args.includes('--url'))for(const id of preview?result.ready_chapters:[]){const response=await fetch(value('--url')+'/document/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'chapter',expected_revision:status.source.revision,job_id:status.job_id,chapter_id:id})});if(!response.ok)throw Error('章节发布失败：'+response.status);}
  console.log(JSON.stringify({file,preview,views:result.views,ready_chapters:result.ready_chapters,parts:parts.length,assembly_ms:Math.round(performance.now()-started)}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
