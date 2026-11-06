import {mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {composeDocument} from './compose-document.mjs';
import {validateDocument} from './document.mjs';
import {chapters} from '../assets/topics.mjs';

const root = mkdtempSync(join(tmpdir(), 'grow-me-interactive-'));
const stateFile = join(root, 'tree.json');
const documentFile = join(root, 'task.html');

const tree = {
  schema_version: 2,
  session_id: 'interactive-preview-' + randomUUID(),
  topic: '读书会报名 · 交互生长与选项试用',
  revision: 0,
  current_round: 1,
  status: 'active',
  nodes: [
    {
      id: 'purpose',
      question: '这次报名页，最核心先解决哪件事？',
      rationale: '界定应用范围与核心诉求。',
      input: 'single_choice',
      options: [
        {id: 'signup', label: '让报名有一个统一入口'},
        {id: 'notice', label: '及时通知活动变更与状态'}
      ],
      answer: null,
      depends_on: [],
      status: 'pending',
      round: 1
    },
    {
      id: 'audience',
      question: '第一批先开放给谁用？',
      rationale: '明确首批用户的准入门槛。',
      input: 'single_choice',
      options: [
        {id: 'club', label: '固定读书会老成员'},
        {id: 'open', label: '任何有兴趣的新读者'}
      ],
      answer: null,
      depends_on: [],
      status: 'pending',
      round: 1
    },
    {
      id: 'channels',
      question: '活动有变动时，首版支持哪些通知渠道？',
      rationale: '确定消息触达的技术集成范围。',
      input: 'multi_choice',
      options: [
        {id: 'mail', label: '邮件通知'},
        {id: 'inbox', label: '站内私信'},
        {id: 'sms', label: '短信提醒'},
        {id: 'none', label: '都不需要', exclusive: true}
      ],
      answer: null,
      depends_on: [],
      status: 'pending',
      round: 1
    },
    {
      id: 'privacy',
      question: '报名时，哪些信息真的需要留下？',
      rationale: '明确必要字段与隐私边界。',
      input: 'text',
      options: [],
      answer: null,
      depends_on: [],
      status: 'pending',
      round: 1
    }
  ]
};

writeFileSync(stateFile, JSON.stringify(tree, null, 2) + '\n', 'utf8');

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '4720';

const child = spawn(process.execPath, [
  fileURLToPath(new URL('./server.mjs', import.meta.url)),
  '--state', stateFile,
  '--document', documentFile,
  '--port', port
], {stdio: ['ignore', 'pipe', 'inherit']});

process.on('SIGINT', () => child.kill('SIGTERM'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

try {
  const [data] = await once(child.stdout, 'data');
  const started = JSON.parse(String(data));
  console.log(JSON.stringify({
    url: started.url,
    kind: 'interactive-choices-preview',
    state_file: stateFile
  }));

  const post = async (path, body) => {
    const res = await fetch(started.url + path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body)
    });
    return res.json();
  };

  const get = async (path) => (await fetch(started.url + path)).json();

  // Watch for submissions and automate round progression
  let round2Added = false;
  let offered = false;
  let documentBuilt = false;

  const loop = setInterval(async () => {
    try {
      const state = await get('/state');
      const doc = await get('/document/status');

      // Round 1 answered -> wait 2s -> grow Round 2 branches!
      if (!round2Added && state.current_round === 1) {
        const r1Answered = state.nodes.filter(n => n.round === 1).every(n => n.status === 'answered');
        if (r1Answered && state.status === 'active') {
          round2Added = true;
          setTimeout(async () => {
            const current = await get('/state');
            const round2Nodes = [
              {
                id: 'format',
                question: '每次读书会的时长大概多久？',
                rationale: '确定单次活动的流程密度与场地租用时间。',
                input: 'single_choice',
                options: [
                  {id: 'short', label: '1.5 小时轻分享'},
                  {id: 'standard', label: '2.5 小时深度共读'}
                ],
                answer: null,
                depends_on: ['purpose'],
                status: 'pending',
                round: 2
              },
              {
                id: 'deposit',
                question: '为防止放鸽子，是否需要收取报名押金？',
                rationale: '防止空占名额，活动结束后全额退还。',
                input: 'single_choice',
                options: [
                  {id: 'free', label: '完全免费，靠诚信'},
                  {id: 'deposit', label: '收取 10 元押金，到场全退'}
                ],
                answer: null,
                depends_on: ['audience'],
                status: 'pending',
                round: 2
              },
              {
                id: 'reminder_time',
                question: '提前多久发出活动确认通知？',
                rationale: '给候补读者留出充足的行程安排时间。',
                input: 'single_choice',
                options: [
                  {id: 'day2', label: '活动前 2 天'},
                  {id: 'day1', label: '活动前 1 天上午'}
                ],
                answer: null,
                depends_on: ['channels'],
                status: 'pending',
                round: 2
              }
            ];
            await post('/round', {
              expected_session_id: current.session_id,
              expected_revision: current.revision,
              round: 2,
              nodes: round2Nodes
            });
            console.log('Round 2 branches grew!');
          }, 2000);
        }
      }

      // Round 2 answered -> wait 1.5s -> offer saving document!
      if (round2Added && !offered && state.current_round === 2) {
        const r2Answered = state.nodes.filter(n => n.round === 2).every(n => n.status === 'answered');
        if (r2Answered && state.status === 'active') {
          offered = true;
          setTimeout(async () => {
            const current = await get('/state');
            await post('/document/control', {
              action: 'offer',
              expected_session_id: current.session_id,
              expected_revision: current.revision
            });
            console.log('Document offer triggered!');
          }, 1500);
        }
      }

      // User clicked "保存并生成任务文档" -> phase becomes 'requested' -> compose document!
      if (offered && !documentBuilt && doc.phase === 'requested') {
        documentBuilt = true;
        const current = await get('/state');
        const control = async (action, extra = {}) => {
          const res = await post('/document/control', {
            action,
            expected_session_id: current.session_id,
            expected_revision: current.revision,
            ...extra
          });
          return res;
        };

        let status = await control('claim', {job_id: doc.job_id});
        const esc = t => t.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
        const source = {
          session_id: status.source.session_id,
          revision: current.revision,
          digest: status.source.digest,
          job_id: status.job_id
        };

        const roots = chapters(current);
        const titles = ['活动目标', '用户圈层', '通知渠道', '隐私边界'];
        const parts = roots.map((chapter, i) => ({
          source,
          view: 'chapter',
          chapter_id: chapter.id,
          title: titles[i] ?? chapter.title,
          html: `<p>本章节汇总了围绕该核心主题推导的详细方案与边界约束。</p>` +
            chapter.nodes.map(n => `<details><summary>${esc(n.question)}</summary><p>${esc(n.answer?.text || n.answer?.option_ids?.join(' / ') || '已确认')}</p></details>`).join('') +
            `<p><a href="#R${i+1}">需求定义</a> · <a href="#W${i+1}">开发任务</a> · <a href="#AC${i+1}">验收标准</a></p>`
        }));

        parts.push({
          source,
          view: 'design',
          title: '读书会报名 · 需求设计方案',
          summary: '围绕读书会组织、报名、候补、通知与隐私的全景需求方案。',
          updated: '最新生成',
          html: titles.map((title, i) => `<article id="R${i+1}" data-kind="requirement"><h3>R${i+1} · ${title}</h3><p>系统必须满足对应章节所界定的用户决策边界与功能支持。</p></article>`).join('')
        });

        parts.push({
          source,
          view: 'plan',
          html: titles.map((title, i) => `<article id="W${i+1}" data-kind="work" data-requirements="R${i+1}" data-criteria="AC${i+1}"><h3>W${i+1} · 实现 ${title}</h3><p><span data-field="status">planned</span> · 待开发项</p><p><a href="#R${i+1}">关联需求</a> · <a href="#AC${i+1}">关联验收标准</a></p></article>`).join('')
        });

        parts.push({
          source,
          view: 'acceptance',
          html: titles.map((title, i) => `<article id="AC${i+1}" data-kind="criterion" data-requirements="R${i+1}"><h3>AC${i+1} · 验证 ${title}</h3><p><span data-field="status">unverified</span> · 待验证</p><p>核对<a href="#R${i+1}">R${i+1}</a>在边界场景下的行为是否符合预期。</p></article>`).join('')
        });

        const composed = composeDocument(status, parts);
        writeFileSync(documentFile, composed.html, 'utf8');
        validateDocument(documentFile, current, status.job_id);
        await control('ready', {job_id: status.job_id});
        console.log('All chapters ready and published!');
      }
    } catch (e) {
      // transient check errors
    }
  }, 800);

  const [code] = await once(child, 'exit');
  clearInterval(loop);
  process.exitCode = code ?? 0;
} catch (error) {
  console.error(error.message);
  child.kill('SIGTERM');
  process.exitCode = 1;
}
