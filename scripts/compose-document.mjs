import { isMain } from './entry.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeferred } from '../assets/answers.mjs';
import { chapterAnchor } from '../assets/topics.mjs';
import { validateDocument } from './document.mjs';

const escape = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
const partError = (file, detail) =>
  Error(file ? `分片 ${JSON.stringify(file)}：${detail}` : detail);
const frozenQuestions = tree =>
  new Map(
    (tree?.nodes ?? [])
      .filter(node => isDeferred(node.answer))
      .map(node => [node.id, node.question])
  );
const questionId = id =>
  /^[a-z\d_-]+$/i.test(id) ? 'deferred-' + id : 'deferred~' + chapterAnchor(id);

function deferredLists(status, chapterParts, tree) {
  const frozen = frozenQuestions(tree);
  const items = status.source.chapters.flatMap(chapter => {
    const part = chapterParts.get(chapter.id);
    if (!part) return [];
    const known = (chapter.node_ids ?? []).filter(id => frozen.has(id));
    const texts = new Set(known.map(id => frozen.get(id)));
    return [
      ...known.map(id => ({ id: questionId(id), text: frozen.get(id), anchor: chapter.anchor })),
      ...(part.deferred_questions ?? [])
        .filter(question => !texts.has(question))
        .map((text, index) => ({
          id: `pending-${chapter.anchor}-${index + 1}`,
          text,
          anchor: chapter.anchor
        }))
    ];
  });
  const list = entries =>
    entries.length
      ? `<section class="deferred-questions"><h3>待确认</h3><ul>${entries.join('')}</ul></section>`
      : '';
  return {
    definitions: list(
      items.map(
        ({ id, text, anchor }) =>
          `<li id="${escape(id)}" data-kind="question"><a href="#${escape(anchor)}">${escape(text)}</a></li>`
      )
    ),
    links: list(
      items.map(({ text, anchor }) => `<li><a href="#${escape(anchor)}">${escape(text)}</a></li>`)
    )
  };
}

export function composeDocument(status, parts, { preview = false, tree = null, files = [] } = {}) {
  if (!status.job_id || !['requested', 'generating'].includes(status.phase))
    throw Error('需要当前冻结访谈的生成任务');
  const views = new Map(),
    chapterParts = new Map();
  for (const [index, part] of parts.entries()) {
    const file = files[index];
    if (!part?.source || typeof part.source !== 'object' || Array.isArray(part.source))
      throw partError(file, 'source 必须是分片来源对象');
    for (const key of ['session_id', 'revision', 'digest', 'job_id']) {
      if (!Object.hasOwn(part.source, key)) throw partError(file, `缺少 source.${key}`);
      if (part.source[key] !== (key === 'job_id' ? status.job_id : status.source[key]))
        throw partError(file, `source.${key} 与当前生成任务不符，分片已过期`);
    }
    if (
      typeof part.html !== 'string' ||
      !part.html.trim() ||
      /^\s*(?:event:|data:|\{)/.test(part.html)
    )
      throw partError(file, 'html 必须是已写好的 HTML 正文');
    if (part.view === 'chapter') {
      if (
        !status.source.chapters.some(c => c.id === part.chapter_id) ||
        chapterParts.has(part.chapter_id)
      )
        throw partError(file, 'chapter_id 对应的章节不存在或重复');
      if (
        part.deferred_questions !== undefined &&
        (!Array.isArray(part.deferred_questions) ||
          part.deferred_questions.some(
            question => typeof question !== 'string' || !question.trim()
          ))
      )
        throw partError(file, 'deferred_questions 需要问题文本');
      chapterParts.set(part.chapter_id, part);
    } else {
      if (!['design', 'plan', 'acceptance'].includes(part.view) || views.has(part.view))
        throw partError(file, 'view 对应的视图不存在或重复');
      views.set(part.view, part);
    }
  }
  if (!preview && (views.size !== 3 || chapterParts.size !== status.source.chapters.length))
    throw Error('最终文档需要三个视图和全部章节');
  const design = views.get('design'),
    pending = '<p class="small">本部分仍在生成；完成的主题章节已可阅读。</p>';
  const deferred = deferredLists(status, chapterParts, tree);
  const chapters = status.source.chapters
    .map(c => {
      const part = chapterParts.get(c.id);
      return `<article id="${c.anchor}"${part ? ' data-chapter-ready="true"' : ''}><h2>${escape(part?.title ?? c.title)}</h2>${part?.html ?? pending}</article>`;
    })
    .join('\n');
  const values = {
    TITLE: escape(design?.title ?? '需求梳理记录'),
    REVISION: 'source-' + status.source.revision,
    UPDATED: escape(design?.updated ?? ''),
    SUMMARY: escape(
      design?.summary ??
        (preview ? '正在生成；已完成章节可以先阅读。' : '本次访谈的回答与方案记录。')
    ),
    POSITION: preview ? '文档生成中，尚未完成最终校验。' : '全文已组装，验收状态以正文为准。',
    NEXT: preview ? '可从树上的成熟果子打开已完成主题。' : '阅读方案、开发清单与验收标准。',
    CONTEXT: escape('访谈 ' + status.source.session_id + ' / revision ' + status.source.revision),
    DECISIONS: deferred.definitions + (design?.decisions ?? ''),
    DESIGN: chapters + (design?.html ?? pending),
    REQUIREMENTS: '',
    CONSTRAINTS: '',
    PLAN: deferred.links + (views.get('plan')?.html ?? pending),
    HANDOFF: '',
    ACCEPTANCE: deferred.links + (views.get('acceptance')?.html ?? pending)
  };
  let html = readFileSync(new URL('../assets/writer-shell.html', import.meta.url), 'utf8').replace(
    /\{\{([A-Z]+)\}\}/g,
    (_, key) => values[key] ?? ''
  );
  const attrs = ` data-source-session="${escape(status.source.session_id)}" data-source-revision="${status.source.revision}" data-source-digest="${escape(status.source.digest)}" data-source-job="${escape(status.job_id)}"${preview ? ' data-generating="true"' : ''}`;
  html = html.replace('<main data-task-record', '<main' + attrs + ' data-task-record');
  for (const id of ['requirements', 'constraints', 'handoff'])
    html = html.replace(new RegExp('<section id="' + id + '"[\\s\\S]*?<\\/section>'), '');
  if (preview) {
    // Pending references are visibly pending anchors, never pretend requirement/acceptance entries.
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(x => x[1]));
    const missing = [...new Set([...html.matchAll(/\shref="#([^"]+)"/g)].map(x => x[1]))].filter(
      id => !ids.has(id)
    );
    html = html.replace(
      '<section id="plan-view"',
      missing.map(id => `<p id="${escape(id)}" class="small">相关内容仍在生成。</p>`).join('') +
        '<section id="plan-view"'
    );
    html = html.replace(
      'function refreshSummaries(){',
      'function refreshSummaries(){\n if(record.hasAttribute("data-generating")){document.getElementById("record-check").textContent="章节预览 · 全文仍在生成，任务包在完成校验后开放。";return;}'
    );
    html = html.replace(
      'for(const item of nodes().filter(',
      'for(const item of (record.hasAttribute("data-generating")?[]:nodes()).filter('
    );
  }
  return { html, ready_chapters: [...chapterParts.keys()], views: [...views.keys()] };
}

function validateHandoff(file, tree, jobId) {
  validateDocument(file, tree, jobId);
  const questions = [...frozenQuestions(tree)].map(([id, question]) => [questionId(id), question]);
  const validation = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-B',
      '-X',
      'utf8',
      fileURLToPath(new URL('./validate_task.py', import.meta.url)),
      file,
      '--handoff'
    ],
    {
      input: JSON.stringify(questions),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }
  );
  if (validation.error) throw Error('无法运行全文校验：' + validation.error.message);
  if (![0, 1].includes(validation.status) || !validation.stdout) throw Error('全文校验程序未完成');
  const report = JSON.parse(validation.stdout);
  if (validation.status !== 0 || !report.valid) throw Error(report.errors.join('；'));
  return {
    project: tree.topic,
    upstream_source: `grow-me session ${tree.session_id} / revision ${tree.revision}`,
    packs: report.packs
  };
}

async function main() {
  const args = process.argv.slice(2),
    value = name => args[args.indexOf(name) + 1];
  if (args.includes('--help') || !args.includes('--context')) {
    console.log(
      'node compose-document.mjs --context status.json --tree tree.json (--parts <dir> [--preview] | --existing) [--url http://127.0.0.1:PORT]\nParts carry source, view, html and, for chapters, chapter_id. Final validation exports task.manifest.json. --existing validates and exports the maintained HTML in place. After final checks, post action ready.'
    );
    return;
  }
  const started = performance.now(),
    status = JSON.parse(readFileSync(value('--context'), 'utf8')),
    tree = JSON.parse(readFileSync(value('--tree'), 'utf8')),
    preview = args.includes('--preview'),
    existing = args.includes('--existing');
  if (!status.job_id || !['requested', 'generating'].includes(status.phase))
    throw Error('需要当前冻结访谈的生成任务');
  if (existing && (preview || args.includes('--parts')))
    throw Error('--existing 单独用于校验已有全文');
  const checkCurrent = async () => {
    const response = await fetch(value('--url') + '/document/status');
    if (!response.ok) throw Error('无法核对当前生成任务');
    const current = await response.json();
    if (
      current.job_id !== status.job_id ||
      current.phase !== 'generating' ||
      current.source.digest !== status.source.digest ||
      current.source.document_file !== status.source.document_file
    )
      throw Error('生成任务已过期，未写入文件');
    return current;
  };
  const online = args.includes('--url');
  let current = online && preview ? await checkCurrent() : null;
  const partDir = value('--parts');
  const files = existing ? [] : readdirSync(partDir).filter(name => name.endsWith('.json'));
  const parts = files.map(name => {
    try {
      return JSON.parse(readFileSync(resolve(partDir, name), 'utf8'));
    } catch (error) {
      throw partError(name, error instanceof SyntaxError ? 'JSON 格式无效' : '无法读取文件');
    }
  });
  const result = existing
    ? { views: [], ready_chapters: [] }
    : composeDocument(status, parts, { preview, tree, files });
  const file = status.source.document_file + (preview ? '.preview.html' : ''),
    temp = file + '.' + process.pid + '.tmp',
    manifestFile = resolve(dirname(file), 'task.manifest.json'),
    manifestTemp = manifestFile + '.' + process.pid + '.tmp';
  if (!preview && basename(file).toLowerCase() === 'task.manifest.json')
    throw Error('方案路径不能与交接清单同名');
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (!existing) writeFileSync(temp, result.html, 'utf8');
    if (preview) {
      for (const id of result.ready_chapters)
        validateDocument(temp, tree, status.job_id, { partial: true, chapterId: id });
    } else {
      const manifest = validateHandoff(existing ? file : temp, tree, status.job_id);
      writeFileSync(manifestTemp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      if (online) current = await checkCurrent();
    }
    if (!existing) renameSync(temp, file);
    if (!preview) renameSync(manifestTemp, manifestFile);
  } catch (error) {
    throw Error('组装校验失败：' + error.message);
  } finally {
    if (!existing) rmSync(temp, { force: true });
    if (!preview) rmSync(manifestTemp, { force: true });
  }
  const publishedBefore = new Set(
      current?.chapters.filter(c => c.status === 'ready').map(c => c.id)
    ),
    newlyPublished = [],
    warnings = [];
  try {
    if (online)
      for (const id of preview ? result.ready_chapters : []) {
        const response = await fetch(value('--url') + '/document/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'chapter',
            expected_session_id: status.source.session_id,
            expected_revision: status.source.revision,
            job_id: status.job_id,
            chapter_id: id
          })
        });
        if (!response.ok) throw Error('章节发布失败：' + response.status);
        current = await response.json();
        if (!publishedBefore.has(id)) newlyPublished.push(id);
      }
  } finally {
    if (newlyPublished.length >= 2) {
      const warning = `警告：本次 --preview 一次新发布了 ${newlyPublished.length} 章（${newlyPublished.join('、')}）。必须每写完一章立即发布，再写下一章；不得攒多章一起发布。`;
      warnings.push(warning);
      console.error(warning);
    }
  }
  console.log(
    JSON.stringify({
      file,
      preview,
      ...(!preview && { manifest_file: manifestFile }),
      views: result.views,
      ready_chapters: result.ready_chapters,
      newly_published_chapters: newlyPublished,
      chapter_timings:
        current?.chapters.map(({ id, first_published_at }) => ({ id, first_published_at })) ?? [],
      chapter_timing_file: current?.chapter_timing_file ?? null,
      warnings,
      parts: parts.length,
      assembly_ms: Math.round(performance.now() - started)
    })
  );
}
if (isMain(import.meta.url))
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
