import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {composeDocument} from './compose-document.mjs';
import {validateDocument} from './document.mjs';
import {chapters} from '../assets/topics.mjs';

const args=process.argv.slice(2);
if(args.includes('--help')){console.log('node scripts/demo.mjs [--port 0]\nRead-only synthetic reading-club example. No model or real interview data.');process.exit(0);}
const root=mkdtempSync(join(tmpdir(),'grow-me-demo-')),stateFile=join(root,'tree.json'),documentFile=join(root,'reading-club.html');
const question=(id,text,answer,round=1,depends_on=[])=>({id,question:text,input:'text',options:[],answer:{option_ids:[],text:answer},depends_on,status:'answered',round});
const tree={schema_version:1,session_id:'synthetic-reading-club-'+randomUUID(),topic:'示例 · 周末读书会报名（合成数据）',revision:0,current_round:3,status:'complete',nodes:[
  question('purpose','这次报名页要解决什么？','组织一场周末读书会，让参与者在同一处了解活动、报名与取消。'),
  question('people','谁会使用报名页？','参与者从手机报名，组织者查看名单。'),
  question('capacity','活动的名额怎么管理？','每场 12 个名额，满员后进入候补。'),
  question('privacy','报名信息保留多久？','只收昵称与联系方式；活动结束七天后删除。'),
  question('cancel','报名后能取消吗？','开始前两小时可以自行取消。',2,['purpose']),
  question('organizer','组织者最常做什么？','查看已报名人数、候补顺序，以及需要联系的参与者。',2,['people']),
  question('promotion','空出名额时怎么补位？','按候补先后顺序通知下一位，不自动替对方确认。',2,['capacity']),
  question('access','谁能看联系方式？','仅本场活动的组织者；公开页面只显示人数。',2,['privacy']),
  question('receipt','报名成功后怎么知道？','页面立即显示确认状态、活动时间与取消入口。',3,['cancel']),
  question('export','是否需要导出名单？','首版在页面查看，暂不提供导出文件。',3,['organizer']),
  question('duplicate','同一个人能重复报名吗？','同场活动只保留一条有效报名。',3,['promotion','people']),
  question('deletion','删除后怎么确认？','组织者能看到清理完成的状态，公开页面没有个人信息。',3,['access'])
]};
writeFileSync(stateFile,JSON.stringify(tree,null,2)+'\n','utf8');
const port=args.includes('--port')?args[args.indexOf('--port')+1]:'0';
const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url)),'--state',stateFile,'--document',documentFile,'--port',port],{stdio:['ignore','pipe','inherit']});
process.on('SIGINT',()=>child.kill('SIGTERM'));process.on('SIGTERM',()=>child.kill('SIGTERM'));
try{
  const started=await Promise.race([once(child.stdout,'data').then(([value])=>JSON.parse(String(value))),once(child,'exit').then(([code])=>{throw Error('Demo server did not start: '+code);})]);
  const control=async(action,extra={})=>{const response=await fetch(started.url+'/document/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,expected_revision:0,...extra})});const body=await response.json();if(!response.ok)throw Error(body.error);return body;};
  let status=await control('retry');status=await control('claim',{job_id:status.job_id});
  const esc=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),source={session_id:status.source.session_id,revision:0,digest:status.source.digest,job_id:status.job_id};
  const roots=chapters(tree),titles=['报名与取消','参与者与组织者','名额与候补','隐私与清理'];
  const parts=roots.map((chapter,i)=>({source,view:'chapter',chapter_id:chapter.id,title:titles[i],html:'<p>合成示例，仅用于演示章节阅读，不是已完成的真实项目。</p>'+chapter.nodes.map(n=>`<details><summary>${esc(n.question)}</summary><p>${esc(n.answer.text)}</p></details>`).join('')+`<p><a href="#R${i+1}">需求</a> · <a href="#W${i+1}">开发项</a> · <a href="#AC${i+1}">验收</a></p>`}));
  parts.push({source,view:'design',title:'周末读书会报名 · 合成示例',summary:'示例展示回答如何分属主题章节。全部问题、答案和计划均为公开的合成数据。',updated:'合成演示',html:titles.map((title,i)=>`<article id="R${i+1}" data-kind="requirement"><h3>R${i+1} · ${title}</h3><p>按对应主题中已列出的示例边界提供报名页能力；此条仅是示例需求。</p></article>`).join('')});
  parts.push({source,view:'plan',html:titles.map((title,i)=>`<article id="W${i+1}" data-kind="work" data-requirements="R${i+1}" data-criteria="AC${i+1}"><h3>W${i+1} · ${title}</h3><p><span data-field="status">planned</span> · 示例开发项，尚未实施。</p><p><a href="#R${i+1}">需求</a> · <a href="#AC${i+1}">验收标准</a></p></article>`).join('')});
  parts.push({source,view:'acceptance',html:titles.map((title,i)=>`<article id="AC${i+1}" data-kind="criterion" data-requirements="R${i+1}"><h3>AC${i+1} · ${title}</h3><p><span data-field="status">unverified</span> · 示例验收，未执行。</p><p>按<a href="#R${i+1}">该主题需求</a>依次操作正常流程与边界场景，观察状态、数据和可见结果是否符合章节描述；保留实际执行记录。</p></article>`).join('')});
  writeFileSync(documentFile,composeDocument(status,parts).html,'utf8');validateDocument(documentFile,tree,status.job_id);await control('ready',{job_id:status.job_id});
  console.log(JSON.stringify({url:started.url,kind:'synthetic-read-only-demo',state_file:stateFile,document_file:documentFile}));
  const[code]=await once(child,'exit');process.exitCode=code??0;
}catch(error){console.error(error.message);child.kill('SIGTERM');process.exitCode=1;}
