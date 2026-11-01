import {readFileSync,existsSync,realpathSync,statSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute,extname,basename} from 'node:path';
import {InputError,finish} from './model.mjs';
import {chapters} from '../assets/topics.mjs';
import {publicError} from '../assets/presentation.mjs';

const requireValue=(ok,message,code=409)=>{if(!ok)throw new InputError(message,code);};
export const fingerprint=tree=>createHash('sha256').update(JSON.stringify(tree)).digest('hex');
const decode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi,(_,x)=>x[0]==='#'?String.fromCodePoint(x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1))):({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[x.toLowerCase()]));
const elementRange=(body,tag)=>{
  const start=body.indexOf(tag),name=tag?.match(/^<([\w-]+)/)?.[1];if(start<0||!name)return null;
  const pattern=new RegExp('<\\/?'+name+'\\b[^>]*>','gi');pattern.lastIndex=start;let depth=0,match;
  while((match=pattern.exec(body))){depth+=match[0].startsWith('</')?-1:1;if(depth===0)return{start,end:pattern.lastIndex};}return null;
};

export function validateDocument(file,tree,jobId=null,{chapterId=null,partial=false}={}){
  requireValue(existsSync(file),'任务 HTML 尚未生成',404);
  const content=readFileSync(file,'utf8'),body=content.replace(/<!--[\s\S]*?-->/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  const main=body.match(/<main\b[^>]*\bdata-task-record(?:\s|=|>)[^>]*>/i)?.[0];
  requireValue(main,'缺少 writer 语义任务正文',422);
  const attribute=name=>{const match=main.match(new RegExp('\\b'+name+'\\s*=\\s*(["\\\'])(.*?)\\1','i'));return match?decode(match[2]):null;};
  requireValue(attribute('data-source-session')===tree.session_id,'文档 session 不匹配',422);
  requireValue(attribute('data-source-revision')===String(tree.revision),'文档源 revision 不匹配',422);
  requireValue(attribute('data-source-digest')===fingerprint(tree),'文档源内容指纹不匹配',422);
  if(jobId)requireValue(attribute('data-source-job')===jobId,'文档生成任务已过期',409);
  const tags=body.match(/<[a-zA-Z][^>]*>/g)??[];
  const ids=tags.flatMap(tag=>[...tag.matchAll(/\sid\s*=\s*(["'])(.*?)\1/gi)].map(m=>decode(m[2])));
  requireValue(new Set(ids).size===ids.length,'文档有重复锚点',422);
  const required=['design-view','plan-view','acceptance-view',...chapters(tree).filter(c=>!partial||c.id===chapterId).map(c=>c.anchor)];
  requireValue(required.every(id=>ids.includes(id)),'文档缺少页签或话题章节',422);
  for(const tag of tags.filter(tag=>/^<a\b/i.test(tag)))for(const match of tag.matchAll(/\shref\s*=\s*(["'])#(.*?)\1/gi))requireValue(ids.includes(decodeURIComponent(decode(match[2]))),'文档存在失效章节链接',422);
  if(!partial)for(const kind of ['requirement','criterion','work'])requireValue(tags.some(tag=>new RegExp('\\sdata-kind\\s*=\\s*["\\\']'+kind+'["\\\']').test(tag)),'文档缺少 '+kind,422);
  if(partial){
    const chapter=chapters(tree).find(c=>c.id===chapterId);requireValue(chapter,'未知话题章节',400);
    const chapterTag=tags.find(tag=>new RegExp('\\sid\\s*=\\s*["\\\']'+chapter.anchor+'["\\\']').test(tag));
    requireValue(chapterTag&&/\sdata-chapter-ready\s*=\s*["']true["']/.test(chapterTag),'章节尚未完成',422);
    const designTag=tags.find(tag=>/\sid\s*=\s*["']design-view["']/.test(tag)),designRange=elementRange(body,designTag),chapterRange=elementRange(body,chapterTag);
    requireValue(designRange&&chapterRange&&chapterRange.start>designRange.start&&chapterRange.end<designRange.end,'章节必须位于设计方案中',422);
  }
  return content;
}

export class DocumentBridge{
  constructor({getTree,save,file,stop}){
    Object.assign(this,{getTree,save,file,stop});this.waiters=new Set();this.sequence=0;this.phase='idle';this.offeredRevision=null;this.jobId=null;this.error=null;this.startedAt=null;this.updatedAt=Date.now();this.stage='queued';this.readable=new Map();
    const tree=getTree();
    if(tree.status==='complete'&&tree.nodes.every(n=>n.status==='answered')){
      try{validateDocument(file,tree);this.phase='ready';}catch{this.phase='failed';this.error='答案已保存；请在原对话恢复文档生成，或点击重试。';}
    }
  }
  context(){const tree=this.getTree();return{session_id:tree.session_id,revision:tree.revision,digest:fingerprint(tree),chapters:chapters(tree).map(({id,anchor,title})=>({id,anchor,title})),document_file:this.file};}
  status(){return{phase:this.phase,sequence:this.sequence,offered_revision:this.offeredRevision,job_id:this.jobId,error:this.error===null?null:publicError(this.error,'文档生成遇到问题，请重试。'),started_at:this.startedAt,updated_at:this.updatedAt,server_now:Date.now(),stage:this.phase==='ready'?'complete':this.stage,chapters:chapters(this.getTree()).map(c=>({id:c.id,anchor:c.anchor,title:c.title,status:this.phase==='ready'||this.readable.has(c.id)?'ready':this.phase==='failed'?'failed':'generating'})),source:this.context()};}
  changed(){this.sequence++;this.updatedAt=Date.now();for(const waiter of [...this.waiters])if(this.sequence>waiter.after)waiter.done(this.status());}
  onMutation(){if(this.getTree().status==='active'){this.phase='idle';this.offeredRevision=null;this.error=null;this.changed();}}
  control(body){
    const tree=this.getTree();requireValue(body.expected_revision===tree.revision,'revision changed; reload state and try again');
    switch(body.action){
      case'offer':
        requireValue(tree.status==='active'&&tree.nodes.every(n=>n.status==='answered'),'先回答并复核全部问题');
        this.phase='offered';this.offeredRevision=tree.revision;break;
      case'save':
        requireValue(this.phase==='offered'&&this.offeredRevision===tree.revision,'AI 尚未针对当前版本确认收尾');
        requireValue(tree.status==='active'&&tree.nodes.every(n=>n.status==='answered'),'先处理所有未答与黄叶');
        this.save(finish(tree,body));this.phase='requested';this.offeredRevision=null;this.jobId=randomUUID();this.error=null;this.startedAt=Date.now();this.stage='queued';this.readable.clear();break;
      case'retry':
        requireValue(tree.status==='complete'&&tree.nodes.every(n=>n.status==='answered')&&this.phase==='failed','当前不能重试');
        this.phase='requested';this.jobId=randomUUID();this.error=null;this.startedAt=Date.now();this.stage='queued';this.readable.clear();break;
      case'claim':
        requireValue(tree.status==='complete'&&this.phase==='requested'&&body.job_id===this.jobId,'生成请求已过期');this.phase='generating';this.stage='drafting';break;
      case'progress':
        requireValue(this.phase==='generating'&&body.job_id===this.jobId,'生成请求已过期');
        requireValue(['drafting','design','plan','acceptance','checking'].includes(body.stage),'未知生成阶段',400);this.stage=body.stage;break;
      case'chapter':{
        requireValue(this.phase==='generating'&&body.job_id===this.jobId,'生成请求已过期');
        const content=validateDocument(this.file+'.preview.html',tree,this.jobId,{partial:true,chapterId:body.chapter_id});
        this.readable.set(body.chapter_id,content);break;
      }
      case'ready':
        requireValue(tree.status==='complete'&&this.phase==='generating'&&body.job_id===this.jobId,'生成请求已过期');
        validateDocument(this.file,tree,this.jobId);this.phase='ready';this.error=null;break;
      case'failed':
        requireValue(tree.status==='complete'&&this.phase==='generating'&&body.job_id===this.jobId,'生成请求已过期');
        this.phase='failed';this.error=publicError(body.error,'文档生成遇到问题，请重试。');break;
      case'close':
        requireValue(tree.status==='complete'||tree.schema_version===1,'请先保存访谈');this.phase='closed';setImmediate(this.stop);break;
      default:throw new InputError('unknown document action',400);
    }
    this.changed();return this.status();
  }
  wait(req,res,after,waitMs,send){
    requireValue(Number.isSafeInteger(after)&&after>=0,'after must be a nonnegative sequence',400);
    if(this.sequence>after)return send(res,200,this.status());
    let timer;
    const waiter={after,done:value=>{clearTimeout(timer);this.waiters.delete(waiter);send(res,200,value);}};
    timer=setTimeout(()=>waiter.done({status:'pending',sequence:this.sequence}),waitMs);this.waiters.add(waiter);
    res.on('close',()=>{clearTimeout(timer);this.waiters.delete(waiter);});
  }
  closeWaiters(send){for(const waiter of [...this.waiters])waiter.done({status:'closed',sequence:this.sequence});}
  read(chapterId=null){if(chapterId&&this.phase!=='ready'){requireValue(this.readable.has(chapterId),'这个章节还在生成',409);return this.readable.get(chapterId);}requireValue(this.phase==='ready','文档尚不可阅读',409);return validateDocument(this.file,this.getTree(),this.jobId);}
  resources(content){
    const root=realpathSync(dirname(this.file)),files=new Map();
    const mime={'.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.zip':'application/zip'};
    for(const tag of content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').match(/<a\b[^>]*>/gi)??[]){
      const match=tag.match(/\shref\s*=\s*(["'])(.*?)\1/i);if(!match)continue;const href=decode(match[2]);
      if(!href||href.startsWith('#')||href.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(href))continue;
      try{
        const path=resolve(root,decodeURIComponent(href.split('#')[0]));if(!existsSync(path))continue;
        const target=realpathSync(path),local=relative(root,target),type=mime[extname(target).toLowerCase()];
        if(!local||local.startsWith('..')||isAbsolute(local)||!type||!statSync(target).isFile())continue;
        files.set(href,{path:target,type,name:basename(target)});
      }catch{/* A missing local reference is not permission to read another file. */}
    }
    return files;
  }
  html(chapterId=null){
    const content=this.read(chapterId),files=this.resources(content);
    return content.replace(/<a\b[^>]*>/gi,tag=>tag.replace(/(\shref\s*=\s*)(["'])(.*?)\2/i,(all,prefix,quote,value)=>{
      const href=decode(value);return files.has(href)?prefix+quote+'/document?resource='+encodeURIComponent(href)+quote:all;
    }));
  }
  resource(name){
    const entry=this.resources(this.read()).get(name);requireValue(entry,'文档未引用或未允许的本地资源',404);
    return {...entry,content:readFileSync(entry.path)};
  }
}
