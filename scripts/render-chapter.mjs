import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fingerprint } from './document.mjs';
import { validateTree } from './model.mjs';
import { isDeferred } from '../assets/answers.mjs';
import { chapters } from '../assets/topics.mjs';
import { isMain } from './entry.mjs';

const escape = value =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export function renderChapter(status, tree, chapterId, explanation, { title } = {}) {
  validateTree(tree);
  if (
    tree.status !== 'complete' ||
    tree.nodes.some(n => n.status !== 'answered') ||
    !status.job_id ||
    !['requested', 'generating'].includes(status.phase)
  )
    throw Error('需要已保存冻结的访谈和当前生成任务');
  if (
    status.source?.session_id !== tree.session_id ||
    status.source.revision !== tree.revision ||
    status.source.digest !== fingerprint(tree)
  )
    throw Error('冻结来源不匹配');
  const chapter = chapters(tree).find(c => c.id === chapterId),
    binding = status.source.chapters.find(c => c.id === chapterId);
  if (
    !chapter ||
    !binding ||
    JSON.stringify(binding.node_ids) !== JSON.stringify(chapter.nodes.map(n => n.id))
  )
    throw Error('章节归属不匹配');
  if (
    typeof explanation !== 'string' ||
    !explanation.trim() ||
    /^\s*(?:event:|data:|\{)/.test(explanation)
  )
    throw Error('需要已写好的说明性 HTML');
  if (title !== undefined && (typeof title !== 'string' || !title.trim()))
    throw Error('章节标题需要一句可读的主题名');
  const deferredQuestions = [];
  const answers = chapter.nodes.map(node => {
    const pending = isDeferred(node.answer),
      selected = node.answer.option_ids.map(id => node.options.find(option => option.id === id)),
      options = selected.length
        ? `<p><strong>${pending ? '你暂选' : '你选'}</strong></p><ul>${selected.map(option => `<li>${escape(option.label)}</li>`).join('')}</ul>`
        : '',
      note = node.answer.text
        ? `<p><strong>你的原话</strong></p><div class="frozen-answer">${escape(node.answer.text).replaceAll('\r', '&#13;')}</div>`
        : '',
      state = pending ? ' data-pending-answer="true"' : '',
      label = pending ? ' <span class="question-origin">待定</span>' : '';
    if (pending) deferredQuestions.push(node.question);
    return `<section data-source-node="${escape(node.id)}"${state}><p><strong>问</strong> ${escape(node.question)}${label}</p>${options}${note}</section>`;
  });
  return {
    source: {
      session_id: tree.session_id,
      revision: tree.revision,
      digest: status.source.digest,
      job_id: status.job_id
    },
    view: 'chapter',
    chapter_id: chapterId,
    title: title?.trim() ?? binding.title,
    ...(deferredQuestions.length ? { deferred_questions: deferredQuestions } : {}),
    html: `<div class="writer-explanation">${explanation}</div>
<details class="interview"><summary>访谈原话（${answers.length} 问）</summary>
<div class="interview-answers">${answers.join('\n')}</div></details>`
  };
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2),
    value = name => args[args.indexOf(name) + 1];
  if (args.includes('--help'))
    console.log(
      'node scripts/render-chapter.mjs --context <status.json> --tree <tree.json> --chapter <root-id> [--title <topic-name>] --explanation <prose.html> --out <parts/chapter.json>\nOriginal answers are escaped and rendered directly from the frozen tree. AI supplies explanatory HTML only.'
    );
  else
    try {
      for (const key of ['--context', '--tree', '--chapter', '--explanation', '--out'])
        if (!args.includes(key) || !value(key)) throw Error(key + ' required');
      const result = renderChapter(
        JSON.parse(readFileSync(value('--context'), 'utf8')),
        JSON.parse(readFileSync(value('--tree'), 'utf8')),
        value('--chapter'),
        readFileSync(value('--explanation'), 'utf8'),
        { title: args.includes('--title') ? value('--title') : undefined }
      );
      const file = value('--out'),
        temp = file + '.' + process.pid + '.tmp';
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temp, JSON.stringify(result, null, 2) + '\n', 'utf8');
      renameSync(temp, file);
      console.log(JSON.stringify({ file, chapter_id: result.chapter_id, source: result.source }));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
