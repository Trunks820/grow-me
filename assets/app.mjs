import { createDecisionTree } from './tree.mjs';
import { chapters, answerText } from './topics.mjs';
import { publicError, assistantConnection, assistantSilenceSeconds } from './presentation.mjs';
import { isDeferred, selectionValid } from './answers.mjs';

const card = document.querySelector('#card'),
  dialog = document.querySelector('#node-dialog'),
  mascot = document.querySelector('#mascot'),
  bubbleLink = document.querySelector('#bubble-link'),
  treeViewport = document.querySelector('.tree-viewport'),
  treeCanvas = document.querySelector('#tree-canvas'),
  sheetLayout = matchMedia('(max-width: 720px)'),
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const drafts = new Map(),
  working = new Map();
const bloomReplies = [
  '记下啦，这里又开了一朵花。',
  '收到，树又长了一点。',
  '这一题有答案了，花也开了。',
  '好呀，这朵花开得正好。'
];
const deferredReplies = [
  '记下了，先放一放。',
  '这题留着，想好了再回来。',
  '好，这里先按个暂停。',
  '先留个记号，回头再聊。'
];
let noteId = null,
  noteMode = 'read',
  noteRevision = null,
  noteBusy = false,
  noteFrame = 0,
  askNext = false,
  replyTimer = null,
  bloomReplyIndex = 0,
  deferredReplyIndex = 0,
  advanceId = null,
  lastAnsweredId = null;
let guidance = {};
let aiActivity = null,
  aiInstance = null,
  aiOpenedAt = performance.now(),
  aiObservedAt = performance.now(),
  assistantDisplay = 'inactive',
  reportedPause = false;
const pageId = crypto.randomUUID();
const pauseText = () =>
  `已 ${Math.max(0, Math.floor((assistantSilenceSeconds(aiActivity) ?? 0) + (performance.now() - aiObservedAt) / 1000))} 秒没收到 AI 回应，回聊天窗口发\"继续\"`;
let state,
  draftsSaved = false,
  documentState = { phase: 'idle' },
  planRequested = false,
  busy = false,
  waitingSince = null,
  documentSince = null,
  documentKey = null,
  stopped = false,
  returnFocus = null,
  rendering = false,
  renderFailed = false,
  refreshSequence = 0,
  appliedRefresh = 0,
  messageTimer;
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const message = (text, error = false) => {
  const n = document.querySelector('#message');
  clearTimeout(messageTimer);
  n.textContent = text ? publicError(text) : '';
  n.setAttribute('role', error ? 'alert' : 'status');
  if (text)
    messageTimer = setTimeout(() => {
      n.textContent = '';
    }, 8000);
};
const view = createDecisionTree(document.querySelector('#decision-tree'), {
  onNode: openNode,
  onFruit: openFruit
});
// A visible, half-open question bud; branch geometry and the seeded renderer stay unchanged.
document.querySelector('#tree-bud').innerHTML =
  `<g transform="scale(1.4)"><path d="M0 6 Q1 3 0 1" fill="none" stroke="#827d58" stroke-width=".9"/>
<path d="M0 4 C-3 1 -3 -4 0 -7 C3 -4 3 1 0 4Z" fill="#f8eed9" stroke="#9b8663" stroke-width=".65"/>
<path d="M0 5 C-5 3 -6 -1 -5 -4 C-2 -4 0 0 0 5Z" fill="#c9b78d" stroke="#8e7e5e" stroke-width=".7"/>
<path d="M0 5 C5 3 6 -1 5 -4 C2 -4 0 0 0 5Z" fill="#e4d3ae" stroke="#8e7e5e" stroke-width=".7"/>
<path d="M-3 4 Q0 7 3 4" fill="none" stroke="#898261" stroke-width=".8"/></g>`;
document.querySelector('#tree-canvas defs').insertAdjacentHTML(
  'beforeend',
  `<g id="tree-deferred"><circle r="5.7" fill="#e5e8e4" stroke="#566d70" stroke-width="1"/>
<path d="M-1.5 -2.1v4.2m3 -4.2v4.2" fill="none" stroke="#566d70" stroke-width="1.2" stroke-linecap="round"/></g>`
);
function displayAnswer(node, answer = node.answer) {
  const text = answerText(node, answer);
  return isDeferred(answer) ? ['待定', text].filter(Boolean).join('\n') : text;
}
const ready = n =>
  n.depends_on.every(id => state.nodes.find(n => n.id === id)?.status === 'answered');
const valid = (n, a) => ready(n) && selectionValid(n, a);
const openQuestions = () =>
  state.nodes.filter(n => n.round === state.current_round && n.status === 'pending');
const draftStorageKey = () => `grow-me:drafts:${state.session_id}`;

function readSavedDrafts() {
  try {
    return JSON.parse(localStorage.getItem(draftStorageKey()));
  } catch {
    return null;
  }
}
function removeStaleDrafts(saved) {
  if (saved?.revision < state.revision) {
    try {
      localStorage.removeItem(draftStorageKey());
    } catch {}
  }
}
function saveDrafts() {
  draftsSaved = false;
  const saved = readSavedDrafts();
  if (!drafts.size) {
    removeStaleDrafts(saved);
    return;
  }
  if (saved?.revision > state.revision) return;
  try {
    localStorage.setItem(
      draftStorageKey(),
      JSON.stringify({ revision: state.revision, answers: Object.fromEntries(drafts) })
    );
    draftsSaved = true;
  } catch {}
}
function restoreDrafts() {
  if (state.schema_version !== 2) return;
  const saved = readSavedDrafts();
  removeStaleDrafts(saved);
  if (saved?.revision !== state.revision || state.status !== 'active') return;
  for (const node of openQuestions()) {
    const answer = saved.answers?.[node.id];
    if (valid(node, answer)) {
      const { option_ids, text } = answer;
      drafts.set(node.id, { option_ids, text, ...(isDeferred(answer) ? { deferred: true } : {}) });
    }
  }
  draftsSaved = drafts.size > 0;
}

const reviews = () => state.nodes.filter(n => n.status === 'needs_review');
const isWaiting = () =>
  state?.schema_version === 2 &&
  state.status === 'active' &&
  state.nodes.every(n => n.status === 'answered');
const allSubmitted = () =>
  Boolean(state?.nodes.length) &&
  state.nodes.every(n => n.status === 'answered' && n.answer !== null);
const documentMatches = () =>
  documentState.source?.session_id === state.session_id &&
  documentState.source?.revision === state.revision;
const saveOffered = () =>
  documentState.phase === 'offered' && documentState.offered_revision === state.revision;
function navigationTarget() {
  if (state?.schema_version !== 2 || state.status !== 'active') return null;
  const review = reviews(),
    active = state.nodes.find(n => n.id === advanceId && ready(n));
  if (review.length)
    return active?.status === 'needs_review' ? active : (review.find(ready) ?? null);
  if (
    active?.status === 'pending' &&
    active.round === state.current_round &&
    (!drafts.has(active.id) || working.has(active.id))
  )
    return active;
  return openQuestions().find(n => !drafts.has(n.id) && ready(n)) ?? null;
}
function updateNavigation() {
  const targetId = noteId ?? navigationTarget()?.id;
  card.dataset.currentId = noteId ?? '';
  for (const flower of document.querySelectorAll('.tree-node')) {
    const current = flower.dataset.nodeId === targetId;
    flower.classList.toggle('is-current', flower.dataset.nodeId === noteId);
    flower.classList.toggle('is-next', current && !dialog.open);
    if (current) flower.setAttribute('aria-current', 'step');
    else flower.removeAttribute('aria-current');
  }
  const plan = card.querySelector('#request-plan');
  if (plan) plan.disabled = busy || noteMode === 'plan';
  syncNotePosition();
}
function cancelAdvance() {
  clearTimeout(replyTimer);
  replyTimer = null;
  askNext = false;
}
function answerReply(node, answer) {
  if (isDeferred(answer)) return deferredReplies[deferredReplyIndex++ % deferredReplies.length];
  const option = node.options.find(option => option.id === answer.option_ids[0]);
  return node.reply ?? option?.reply ?? bloomReplies[bloomReplyIndex++ % bloomReplies.length];
}
function handleAnswer(node, answer) {
  cancelAdvance();
  lastAnsweredId = node.id;
  if (advanceId === node.id) advanceId = null;
  noteMode = 'reply';
  dialog.dataset.mode = noteMode;
  const heading = el('h2', answerReply(node, answer));
  heading.id = 'node-question';
  heading.tabIndex = -1;
  document.querySelector('#node-body').replaceChildren(heading);
  document.querySelector('#node-actions').replaceChildren();
  askNext = true;
  replyTimer = setTimeout(() => {
    replyTimer = null;
    syncNotePosition();
  }, 1500);
  showNote();
}
function assistantStatus() {
  const writing =
    state?.status === 'complete' &&
    documentMatches() &&
    ['requested', 'generating'].includes(documentState.phase);
  if (state?.schema_version !== 2 || !((isWaiting() && !saveOffered()) || writing))
    return 'inactive';
  return assistantConnection(aiActivity, performance.now() - aiOpenedAt);
}
function heartbeatNote() {
  const text = aiActivity?.heartbeat_active
    ? {
        questions: planRequested ? 'AI 正在准备保存' : 'AI 正在出题',
        code: 'AI 正在查代码',
        document: 'AI 正在写文档'
      }[aiActivity.heartbeat_activity]
    : null;
  return text ? '心跳报告：' + text : '';
}
function waitingHeader(title, progress) {
  if (['paused', 'connecting'].includes(assistantDisplay)) {
    const paused = assistantDisplay === 'paused',
      notice = el(
        'p',
        paused
          ? pauseText()
          : '请回到聊天窗口让 AI 继续，或点「复制提醒」粘贴过去。你的答案已保存。',
        'ai-wait-notice'
      );
    notice.id = 'ai-wait-notice';
    card.append(el('h2', paused ? '等待 AI 对话续接' : '等待 AI 对话连接', 'q'), notice);
    if (paused) card.append(el('p', '也可以点「复制提醒」粘贴过去。你的答案已保存，不会丢。', 'w'));
  } else card.append(el('h2', title, 'q'), el('p', progress, 'growth-status'));
  const note = el('p', heartbeatNote(), 'w');
  note.id = 'heartbeat-work';
  note.hidden = !note.textContent;
  card.append(note);
}

async function post(path, body) {
  if (stopped) throw Error('请先恢复原访谈，再继续操作。');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, expected_session_id: state.session_id })
  });
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw Error('本机服务返回格式异常，请重试。');
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error('本机服务返回格式异常，请重试。');
  }
  if (!response.ok) throw Error(publicError(result.error, '提交暂时失败，请重试。'));
  return result;
}
async function act(action) {
  if (busy) return false;
  busy = true;
  document.querySelectorAll('#card button,#node-dialog button').forEach(b => (b.disabled = true));
  try {
    await action();
    message('');
    if (!stopped) await refresh(true);
    return true;
  } catch (error) {
    message(publicError(error.message) + '；已保留仍有效的草稿。', true);
    await refresh(true).catch(() => {});
    return false;
  } finally {
    busy = false;
    if (!stopped) render();
  }
}
function button(label, action, primary = false) {
  const b = el('button', label, primary ? 'primary' : '');
  b.type = 'button';
  b.addEventListener('click', action);
  return b;
}
function docAction(action) {
  return act(async () => {
    await post('/document/control', {
      action,
      expected_revision: state.revision,
      job_id: documentState.job_id
    });
  });
}
function updateMeta() {
  const meta = document.querySelector('#meta'),
    total = state.nodes.length,
    submitted = state.nodes.filter(n => n.status === 'answered'),
    done = submitted.length,
    deferred = submitted.filter(n => isDeferred(n.answer)).length,
    review = reviews().length,
    complete = state.status === 'complete';
  // Topic first (what this tree is about), then where we are, then a hairline of progress.
  const progress = el('span', undefined, 'meta-progress');
  progress.append(
    el(
      'span',
      complete
        ? `共完成 ${new Set(state.nodes.map(n => n.round)).size} 轮`
        : `第 ${state.current_round} 轮`,
      'meta-round'
    )
  );
  if (!complete) progress.append(el('span', ' · 总轮数随回答确定', 'meta-note'));
  progress.append(el('span', ` · 已确认 ${done - deferred} / ${total}`));
  if (deferred) progress.append(el('span', ` · 待定 ${deferred}`));
  if (drafts.size) progress.append(el('span', ` · 本轮未提交 ${drafts.size}`, 'meta-draft'));
  if (review) progress.append(el('span', ` · 待复核 ${review}`, 'meta-review'));
  const bar = el('span', undefined, 'meta-bar');
  bar.setAttribute('aria-hidden', 'true');
  bar.style.setProperty('--done', String(total ? done / total : 0));
  bar.style.setProperty('--reach', String(total ? Math.min(1, (done + drafts.size) / total) : 0));
  meta.replaceChildren(el('span', state.topic, 'meta-topic'), progress, bar);
  meta.title = state.topic;
  meta.dataset.revision = String(state.revision);
  card.dataset.revision = String(state.revision);
}
function updateTree() {
  const finished =
    documentState.phase === 'offered' && documentState.offered_revision === state.revision;
  const nodes = state.nodes.map(n => {
    const answer = drafts.get(n.id) ?? n.answer;
    return isDeferred(answer)
      ? { ...n, answer: { ...answer, option_ids: [], text: displayAnswer(n, answer) } }
      : n;
  });
  view.update(
    { ...state, nodes },
    {
      drafts,
      currentId: noteId,
      waiting: isWaiting() && !finished && assistantDisplay === 'connected',
      finished,
      fruitStates: new Map(
        chapters(state).map(c => [
          c.id,
          documentMatches()
            ? (documentState.chapters?.find(x => x.id === c.id)?.status ??
              (documentState.phase === 'ready' ? 'ready' : 'generating'))
            : 'generating'
        ])
      )
    }
  );
  for (const n of nodes) {
    if (n.status === 'needs_review' || !isDeferred(n.answer)) continue;
    const marker = nodeTarget(n.id),
      symbol = marker.querySelector('.tree-symbol');
    marker.dataset.status = 'deferred';
    marker.setAttribute(
      'aria-label',
      `第 ${n.round} 轮，${n.question}，待定${drafts.has(n.id) ? '，本轮未提交' : ''}`
    );
    symbol.setAttribute('href', '#tree-deferred');
    for (const animation of symbol.getAnimations()) animation.cancel();
  }
  updateMeta();
  updateNavigation();
}
function inputs(n, host) {
  const value = working.get(n.id) ?? drafts.get(n.id) ?? n.answer ?? { option_ids: [], text: '' };
  const form = el('form', undefined, 'question-form'),
    single = n.input === 'single_choice',
    defer = button('先待定，以后再说', () => saveAnswer({ ...read(), deferred: true }));
  defer.className = 'defer-answer';
  defer.disabled = busy || !ready(n);
  let read;
  if (n.input !== 'text') {
    const multiple = n.input === 'multi_choice',
      advice = guidance[n.id];
    let recommendation;
    if (advice) {
      const info = el('details', undefined, 'recommendation-info');
      recommendation = info;
      info.append(el('summary', '查看推荐'));
      if (advice.stale) info.append(el('p', '推荐依据已变／待复核，旧推荐已隐藏。', 'w'));
      else {
        info.append(
          el('p', 'AI 建议', 'recommendation-label'),
          el('p', advice.reason.replace(/^AI 建议[，,]不是你的决定[：:，,。\s]*/, ''), 'w')
        );
        const choices = el('ul', undefined, 'recommended-options');
        for (const option of n.options.filter(o => advice.option_ids.includes(o.id)))
          choices.append(el('li', option.label));
        info.append(choices);
        for (const source of advice.sources) {
          const line = el('p', undefined, 'recommendation-source');
          line.append(
            el('span', `根据你第 ${source.round} 轮说的“${source.answer}”，不对请改。`),
            button('回看依据', event => openNode(source.id, event?.currentTarget))
          );
          info.append(line);
        }
      }
    }
    const group = el('fieldset', undefined, 'choice-group'),
      legend = el('legend', multiple ? '选择一项或多项' : '选择一项', 'sr-only');
    group.append(legend);
    n.options.forEach((o, i) => {
      const label = el('label', undefined, 'option'),
        input = document.createElement('input');
      input.type = multiple ? 'checkbox' : 'radio';
      input.name = 'answer';
      input.value = o.id;
      input.checked = value.option_ids.includes(o.id);
      input.setAttribute('aria-label', o.label);
      input.dataset.exclusive = String(Boolean(o.exclusive));
      const copy = el('span', o.label, 'option-copy');
      if (advice && !advice.stale && advice.option_ids.includes(o.id)) {
        const badge = el('span', 'AI 建议', 'recommendation-badge');
        badge.id = `recommendation-${i + 1}`;
        input.setAttribute('aria-describedby', badge.id);
        copy.append(badge);
      }
      if (o.exclusive) copy.append(el('span', '与其他选项互斥', 'exclusive-hint'));
      label.append(input, copy);
      group.append(label);
      input.dataset.shortcut = String(i + 1);
    });
    group.addEventListener('click', event => {
      if (single && event.target.matches('input[type=radio]')) saveAnswer(read());
    });
    group.addEventListener('change', event => {
      const input = event.target;
      if (!multiple || !input.checked) return;
      for (const other of group.querySelectorAll('input'))
        if (
          other !== input &&
          (input.dataset.exclusive === 'true' || other.dataset.exclusive === 'true')
        )
          other.checked = false;
    });
    const label = el('label', '补一句（可选）', 'sr-only'),
      area = el('textarea', undefined, 'field note-field');
    area.id = 'answer-note';
    label.htmlFor = area.id;
    area.value = value.text;
    area.rows = 1;
    area.placeholder = '想补充就写这儿，可不填';
    form.append(group, defer, label, area);
    if (recommendation) form.append(recommendation);
    read = () => ({
      option_ids: [...group.querySelectorAll('input:checked')].map(n => n.value),
      text: area.value
    });
  } else {
    const label = el('label', n.question, 'sr-only'),
      area = el('textarea', undefined, 'field');
    area.id = 'answer-text';
    label.htmlFor = area.id;
    area.value = value.text;
    area.placeholder = '写下你的想法';
    form.append(label, area);
    read = () => ({ option_ids: [], text: area.value });
  }
  let confirm;
  if (!single) {
    const toolbar = el('div', undefined, 'actions');
    confirm = el('button', '好了', 'primary');
    confirm.type = 'submit';
    confirm.id = 'confirm-answer';
    if (n.input === 'text') toolbar.append(defer);
    toolbar.append(confirm);
    form.append(toolbar);
  }
  const reword = el('button', '没看懂，换个说法');
  reword.type = 'button';
  reword.id = 'reword-question';
  reword.hidden = true;
  form.append(reword);
  const update = () => {
    if (rendering || !form.isConnected) return;
    const answer = read();
    working.set(n.id, answer);
    if (confirm) confirm.disabled = busy || !valid(n, answer);
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  if (confirm) confirm.disabled = busy || !valid(n, read());
  if (!ready(n)) {
    form.querySelectorAll('input,textarea').forEach(x => (x.disabled = true));
    host.append(el('p', '请先处理上游的黄叶，再回来作答。', 'review-note'));
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveAnswer(read());
  });
  function saveAnswer(answer) {
    if (busy || stopped || !valid(n, answer)) return;
    if (n.status === 'needs_review')
      act(async () => {
        await post('/decision', { id: n.id, expected_revision: state.revision, answer });
        handleAnswer(n, answer);
      });
    else {
      drafts.set(n.id, structuredClone(answer));
      saveDrafts();
      working.delete(n.id);
      handleAnswer(n, answer);
      message('');
      render();
    }
  }
  host.append(form);
}
function renderSummary(host) {
  const list = el('ul', undefined, 'summary-list');
  openQuestions()
    .filter(n => drafts.has(n.id))
    .forEach(n => {
      const row = el('li'),
        answer = drafts.get(n.id);
      row.append(
        el('div', n.question),
        el('div', displayAnswer(n, answer), 'answer'),
        button(isDeferred(answer) ? '回看待定题' : '回看这朵花', () =>
          openNode(n.id, nodeTarget(n.id))
        )
      );
      list.append(row);
    });
  const title = el('h2', `第 ${state.current_round} 轮 · 答案核对`, 'q');
  title.id = 'node-question';
  const draftHint = draftsSaved
    ? '本轮未提交 · 草稿已存于此浏览器。'
    : '本轮未提交 · 刷新或关闭可能丢失草稿。';
  host.append(title, list, el('p', draftHint, 'draft-hint'));
  const submit = button(
    '提交本轮答案',
    () =>
      act(async () => {
        const round = state.current_round,
          revision = state.revision,
          answers = openQuestions().map(n => ({ id: n.id, answer: drafts.get(n.id) }));
        if (
          !answers.every(a =>
            valid(
              state.nodes.find(n => n.id === a.id),
              a.answer
            )
          )
        )
          throw Error('请完整回答本轮问题');
        await post('/submit', { round, expected_revision: revision, answers });
        waitingSince = performance.now();
        closeNote();
      }),
    true
  );
  submit.className = 'primary seal-btn';
  submit.setAttribute('aria-label', '提交本轮答案');
  submit.innerHTML =
    '<span class="seal-mark">盖章</span><span class="seal-text">提交 · 接着长 ↗</span>';
  submit.disabled = busy || reviews().length > 0 || openQuestions().some(n => !drafts.has(n.id));
  host.append(submit);
}
function planConfirmation(unanswered, confirm, cancel) {
  const question = el(
    'h2',
    unanswered
      ? `这一轮还有 ${unanswered} 题没答，会记成待定，直接出方案吗？`
      : '这一轮已答完，直接出方案吗？'
  );
  question.id = 'node-question';
  question.tabIndex = -1;
  const actions = el('div', undefined, 'actions');
  actions.append(button('我再答几题', cancel), button('先出方案', confirm, true));
  return [question, actions];
}
function openPlanConfirmation(event) {
  if (busy || stopped || noteMode === 'plan') return;
  const pending = openQuestions();
  const answers = pending
    .filter(n => drafts.has(n.id))
    .map(n => ({ id: n.id, answer: drafts.get(n.id) }));
  const request = { round: state.current_round, expected_revision: state.revision, answers };
  const confirm = () =>
    act(async () => {
      await post('/request-plan', request);
      closeNote();
    });
  noteId = null;
  cancelAdvance();
  noteMode = 'plan';
  noteRevision = state.revision;
  returnFocus = event.currentTarget;
  dialog.dataset.mode = noteMode;
  delete dialog.dataset.nodeId;
  document.querySelector('#close-node').disabled = false;
  document.querySelector('#node-actions').replaceChildren();
  document
    .querySelector('#node-body')
    .replaceChildren(...planConfirmation(pending.length - answers.length, confirm, closeNote));
  showNote();
}
function renderWaiting() {
  card.append(el('p', `第 ${state.current_round} 轮 · 已提交`, 'k'));
  waitingHeader(planRequested ? '正在准备保存…' : '正在想下一轮的问题…', '生长中');
  card.append(elapsedLine(waitingSince), el('p', '可以点树上的题目回看或修改。', 'w'));
  if (assistantDisplay === 'connected') {
    const late = el(
      'p',
      planRequested ? '还在准备保存，可以先回看本轮回答' : '还在想，可以先回看本轮回答',
      'w'
    );
    late.id = 'long-wait';
    late.hidden = waitingSince === null || performance.now() - waitingSince <= 60000;
    card.append(late);
  }
  if (saveOffered()) {
    card.replaceChildren(
      el('p', '访谈可保存', 'k'),
      el('h2', '这一棵树，可以结果了。', 'q'),
      el('p', '保存后这次访谈只读，接下来生成方案、开发清单与验收标准。', 'w'),
      button('保存并生成任务文档', () => docAction('save'), true)
    );
  }
}
function elapsedLine(since) {
  const line = el('p', '', 'wait-elapsed');
  line.id = 'wait-elapsed';
  line.setAttribute('aria-live', 'off');
  line.dataset.since = String(since ?? performance.now());
  line.textContent = `已等待 ${Math.max(0, Math.floor((performance.now() - Number(line.dataset.since)) / 1000))} 秒`;
  return line;
}
function chapterList() {
  const list = el('ul', undefined, 'chapters');
  chapters(state).forEach(c => {
    const li = el('li'),
      ready =
        documentMatches() &&
        (documentState.phase === 'ready' ||
          documentState.chapters?.some(x => x.id === c.id && x.status === 'ready'));
    if (ready) {
      const a = el('a');
      a.append(el('span', c.title, 'chapter-title'), el('span', ' · 可阅读', 'chapter-state'));
      a.href =
        '/document' +
        (documentState.phase === 'ready' ? '' : '?chapter=' + encodeURIComponent(c.id)) +
        '#' +
        c.anchor;
      a.target = '_blank';
      a.rel = 'noopener';
      li.append(a);
    } else
      li.append(
        el('span', c.title),
        el('span', documentState.phase === 'failed' ? ' · 待重试' : ' · 生成中', 'chapter-pending')
      );
    list.append(li);
  });
  return list;
}
function renderDocument() {
  const phase = documentState.phase;
  card.append(el('p', '已保存 · 只读', 'k'));
  if (phase === 'ready') {
    if (!documentMatches()) {
      card.append(
        el('h2', '正在同步任务文档…', 'q'),
        el('p', '正在核对当前访谈与文档的版本。', 'w')
      );
      return;
    }
    card.append(
      el('h2', '问过的，都结成了果。', 'q'),
      el(
        'p',
        `已提交 ${state.nodes.length} 题 · ${chapters(state).length} 颗果子，点击打开对应章节。`,
        'w'
      )
    );
    card.append(chapterList());
    const actions = el('div', undefined, 'doc-actions');
    const link = el('a', '打开完整任务文档', 'doc-link');
    link.href = '/document';
    link.target = '_blank';
    link.rel = 'noopener';
    const download = el('a', '保存 HTML 文件', 'doc-secondary');
    download.href = '/document?download=1';
    download.download = 'task.html';
    actions.append(
      link,
      download,
      button(
        '结束预览',
        () =>
          act(async () => {
            await post('/document/control', { action: 'close', expected_revision: state.revision });
            stopped = true;
            document.querySelector('#connection').textContent =
              '预览已结束；任务 HTML 已保存在本机。';
          }),
        false
      )
    );
    card.append(actions);
  } else if (phase === 'failed') {
    card.append(
      el('h2', '文档暂时没生成。', 'q'),
      el('p', publicError(documentState.error, '文档生成遇到问题，请重试。'), 'w'),
      chapterList(),
      button('重试生成文档', () => docAction('retry'), true),
      el('p', '答案已经保存，不用重新答。', 'w')
    );
  } else {
    const stage =
      {
        queued: '等待当前对话接手',
        drafting: '正在整理三个视图',
        design: '正在整理设计方案',
        plan: '正在整理开发清单',
        acceptance: '正在整理验收标准',
        checking: '正在校验章节、引用和来源'
      }[documentState.stage] ?? '正在整理三个视图';
    const done = documentState.chapters?.filter(c => c.status === 'ready').length ?? 0;
    waitingHeader('正在生成任务文档…', '生长中 · ' + stage);
    card.append(
      elapsedLine(documentSince),
      el('p', `已完成 ${done} / ${chapters(state).length} 章；完成的章节可以先读。`, 'w'),
      chapterList()
    );
    if (assistantDisplay === 'inactive' || assistantDisplay === 'connected')
      card.append(el('p', '答案已保存。若当前对话已中断，请回到原对话说“继续”。', 'w'));
  }
}
function renderRoundProgress(pending, review) {
  const round = state.nodes.filter(n => n.round === state.current_round),
    remaining = pending.filter(n => !drafts.has(n.id)).length,
    canSubmit = remaining === 0 && review.length === 0,
    progress = el('div', undefined, 'round-progress'),
    dots = el('span', undefined, 'round-dots');
  dots.setAttribute('aria-hidden', 'true');
  for (const n of round) {
    const dot = el('span');
    dot.dataset.done = String(drafts.has(n.id) || n.status === 'answered');
    dots.append(dot);
  }
  const count = el(
    'span',
    `第 ${state.current_round} 轮 · 还剩 ${remaining} 题${review.length ? ` · ${review.length} 题待复核` : ''}`,
    'scene-count'
  );
  count.id = 'round-count';
  if (drafts.size) {
    const label = canSubmit ? '回看汇总，提交本轮' : '查看本轮草稿',
      summary = button('', openSummary);
    summary.id = 'round-summary';
    summary.title = label;
    summary.setAttribute('aria-label', label);
    summary.setAttribute('aria-describedby', count.id);
    summary.dataset.ready = String(canSubmit);
    summary.disabled = busy;
    summary.append(count, dots);
    if (canSubmit) summary.append(el('span', '提交本轮'));
    progress.append(summary);
  } else progress.append(count, dots);
  card.append(progress);
}
function render() {
  if (!state) return;
  rendering = true;
  renderFailed = false;
  try {
    assistantDisplay = assistantStatus();
    const reminder = document.querySelector('#copy-reminder'),
      header = reminder.closest('header');
    header.querySelector('#heartbeat-work')?.remove();
    reminder.classList.toggle('needs-attention', assistantDisplay === 'paused');
    if (assistantDisplay === 'paused') reminder.setAttribute('aria-describedby', 'ai-wait-notice');
    else reminder.removeAttribute('aria-describedby');
    card.replaceChildren();
    if (state.schema_version === 1) {
      card.append(
        el('p', 'v1 历史访谈 · 只读', 'k'),
        el('h2', '原来的回答，仍在这棵树上。', 'q'),
        el(
          'p',
          '可以点击花朵回看；未完成的旧访谈请用原 alpha 版本继续。不会自动迁移或补写历史理由。',
          'w'
        )
      );
      if (documentState.phase === 'ready') {
        const a = el('a', '打开原任务文档', 'doc-link');
        a.href = '/document';
        a.target = '_blank';
        a.rel = 'noopener';
        card.append(a);
      }
      card.append(
        button('结束预览', () =>
          act(async () => {
            await post('/document/control', { action: 'close', expected_revision: state.revision });
            stopped = true;
            document.querySelector('#connection').textContent =
              '只读预览已结束；原访谈文件保持不变。';
          })
        )
      );
    } else if (state.status === 'complete') {
      if (allSubmitted()) renderDocument();
      else
        card.append(
          el('p', '状态待核对', 'k'),
          el('h2', '保存状态与答案不一致。', 'q'),
          el(
            'p',
            `当前只有 ${state.nodes.filter(n => n.status === 'answered').length} / ${state.nodes.length} 题已提交。请回到原对话核对 tree.json。`,
            'w'
          )
        );
    } else {
      const pending = openQuestions(),
        review = reviews();
      if (pending.length || review.length) {
        renderRoundProgress(pending, review);
        const work = el('span', heartbeatNote(), 'question-work');
        work.id = 'heartbeat-work';
        work.hidden = !work.textContent;
        header.append(work);
      } else renderWaiting();
      if (!planRequested && !review.length && !saveOffered()) {
        const plan = button('够了，先出方案', openPlanConfirmation);
        plan.id = 'request-plan';
        card.append(plan);
      }
    }
    if (reportedPause !== (assistantDisplay === 'paused')) {
      reportedPause = assistantDisplay === 'paused';
      post('/ai/telemetry', {
        event: reportedPause ? 'pause_shown' : 'pause_cleared',
        page_id: pageId,
        last_check_at: aiActivity?.last_check_at,
        expected_revision: state.revision,
        expected_instance_id: aiInstance
      }).catch(() => {});
    }
    card.dataset.scene =
      state.status === 'complete'
        ? 'document'
        : openQuestions().length || reviews().length
          ? 'questions'
          : 'waiting';
    updateTree();
    if (dialog.open) {
      if (noteMode === 'plan') {
        if (noteRevision !== state.revision) closeNote();
        else dialog.querySelectorAll('button').forEach(b => (b.disabled = busy));
      } else if (noteMode === 'reply') {
        document.querySelector('#close-node').disabled = busy;
      } else if (!askNext && (noteRevision !== state.revision || noteBusy !== busy)) {
        if (noteId) renderNote();
        else if (noteMode === 'summary') renderSummaryNote();
      }
    }
    syncNotePosition();
  } catch (error) {
    renderFailed = true;
    card.replaceChildren(
      el('h2', '正在同步生长状态…', 'q'),
      el('p', '生长中', 'growth-status'),
      elapsedLine(state.status === 'complete' ? documentSince : waitingSince),
      el('p', '已提交答案仍在本机，将自动重新读取。', 'w')
    );
    message('页面状态正在同步，稍后会自动恢复。', true);
    console.error('State rendering failed');
  } finally {
    rendering = false;
  }
}
function nodeTarget(id) {
  return [...document.querySelectorAll('.tree-node')].find(n => n.dataset.nodeId === id);
}
function closeNote() {
  const trigger = returnFocus;
  if (dialog.open) dialog.close();
  noteId = null;
  noteMode = 'read';
  cancelAdvance();
  returnFocus = null;
  mascot.getAnimations().forEach(animation => animation.cancel());
  mascot.setAttribute('hidden', '');
  bubbleLink.toggleAttribute('hidden', true);
  document.body.classList.remove('note-open');
  updateNavigation();
  const target = trigger?.isConnected ? trigger : document.getElementById(trigger?.id ?? '');
  target?.focus({ preventScroll: true });
}
function showNote() {
  const wasOpen = dialog.open,
    oldPlacement = dialog.dataset.placement,
    moved = !mascot.hasAttribute('hidden') && mascot.dataset.nodeId !== noteId,
    from = moved ? mascot.getBoundingClientRect() : null,
    heading = dialog.querySelector('#node-question');
  const image = noteMode === 'reply' ? '/mascot-bloom.svg' : '/mascot-ask.svg';
  if (mascot.getAttribute('src') !== image) mascot.src = image;
  dialog.dataset.placement = sheetLayout.matches ? 'sheet' : 'panel';
  if (!wasOpen) {
    heading.setAttribute('autofocus', '');
    dialog.show();
  }
  document.body.classList.add('note-open');
  dialog.scrollTop = 0;
  positionNote();
  if (!reducedMotion.matches) {
    if (from && !mascot.hasAttribute('hidden')) {
      mascot.getAnimations().forEach(animation => animation.cancel());
      const to = mascot.getBoundingClientRect(),
        dx = from.x - to.x,
        dy = from.y - to.y;
      mascot.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 14}px)`, offset: 0.55 },
          { transform: 'none' }
        ],
        { duration: 300, easing: 'ease-out' }
      );
    }
    dialog.getAnimations().forEach(animation => animation.cancel());
    bubbleLink.getAnimations().forEach(animation => animation.cancel());
    const slide = sheetLayout.matches && (!wasOpen || oldPlacement !== 'sheet');
    dialog.animate(
      [{ opacity: 0.35, transform: slide ? 'translateY(12px)' : 'none' }, { opacity: 1, transform: 'none' }],
      { duration: 160, easing: 'ease-out' }
    );
    if (!bubbleLink.hasAttribute('hidden'))
      bubbleLink.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  }
  heading.focus({ preventScroll: true });
  updateNavigation();
}
function editDraft(id) {
  const value = drafts.get(id);
  if (value) working.set(id, structuredClone(value));
  openNode(id, nodeTarget(id), 'edit');
}
function openNode(id, trigger, mode) {
  if (busy || stopped) return;
  const n = state?.nodes.find(n => n.id === id);
  if (!n) return;
  cancelAdvance();
  noteId = id;
  returnFocus = nodeTarget(id) ?? trigger;
  noteMode =
    mode ??
    (state.schema_version === 2 &&
    state.status === 'active' &&
    n.status === 'pending' &&
    !drafts.has(id)
      ? 'edit'
      : 'read');
  if ((noteMode === 'edit' || n.status === 'needs_review') && ready(n)) advanceId = id;
  renderNote();
  showNote();
}
async function modifyAnswer(id) {
  if (drafts.has(id)) return editDraft(id);
  const n = state.nodes.find(n => n.id === id);
  if (!n) return;
  if (n.status !== 'needs_review') {
    const ok = await act(async () => {
      await post('/reopen', { id, expected_revision: state.revision });
    });
    if (
      !ok ||
      state.status !== 'active' ||
      state.nodes.find(n => n.id === id)?.status !== 'needs_review'
    )
      return;
  }
  openNode(id, nodeTarget(id), 'edit');
}
function renderNote() {
  const n = state.nodes.find(n => n.id === noteId);
  if (!n) {
    closeNote();
    return;
  }
  if (state.schema_version === 1 || state.status !== 'active' || n.status === 'answered')
    noteMode = 'read';
  const body = document.querySelector('#node-body'),
    actions = document.querySelector('#node-actions'),
    hadFocus = dialog.contains(document.activeElement);
  body.replaceChildren();
  actions.replaceChildren();
  const heading = el('h2', n.question);
  heading.id = 'node-question';
  heading.tabIndex = -1;
  body.append(heading);
  const details = el('div', undefined, 'question-details');
  if (n.rationale) {
    const reason = el('details', undefined, 'question-reason');
    reason.append(el('summary', '为什么问这个'), el('p', n.rationale));
    details.append(reason);
  }
  const previous =
    state.nodes.find(
      p => p.id === lastAnsweredId && p.id !== n.id && (drafts.has(p.id) || p.status === 'answered')
    ) ??
    n.depends_on
      .map(id => state.nodes.find(n => n.id === id))
      .filter(n => n?.answer)
      .sort((a, b) => b.round - a.round)[0];
  if (previous) {
    const text = displayAnswer(previous, drafts.get(previous.id) ?? previous.answer),
      aside = el('details', undefined, 'previous-answer'),
      summary = el('summary');
    summary.append(el('small', '上一句'), el('span', text, 'previous-excerpt'));
    aside.append(summary, el('blockquote', text));
    details.append(aside);
  }
  if (details.childElementCount) body.append(details);
  if (n.status === 'needs_review')
    body.append(el('p', '上游或本题有改动，这个回答需要再确认。', 'review-note'));
  if (noteMode === 'edit') inputs(n, body);
  else {
    const answer = drafts.get(n.id) ?? n.answer;
    body.append(el('p', displayAnswer(n, answer) || '尚未回答。', 'answer'));
    body.append(
      el(
        'p',
        drafts.has(n.id)
          ? '本轮草稿 · 尚未提交'
          : n.status === 'needs_review'
            ? '旧回答 · 待复核'
            : `第 ${n.round} 轮 · ${isDeferred(answer) ? '待定' : '已确认'}`,
        'draft-hint'
      )
    );
    if (state.schema_version === 2 && state.status === 'active')
      actions.append(button('改', () => modifyAnswer(n.id)));
  }
  if (
    state.schema_version === 2 &&
    state.status === 'active' &&
    n.status === 'needs_review' &&
    n.answer !== null
  ) {
    const keep = button(isDeferred(n.answer) ? '仍待定' : '仍然有效', () =>
      act(async () => {
        await post('/decision', { id: n.id, expected_revision: state.revision, answer: n.answer });
        handleAnswer(n, n.answer);
      })
    );
    keep.disabled = busy || !ready(n);
    actions.append(keep);
  }
  noteRevision = state.revision;
  noteBusy = busy;
  dialog.dataset.mode = noteMode;
  dialog.dataset.nodeId = n.id;
  if (busy) dialog.querySelectorAll('input,textarea,button').forEach(n => (n.disabled = true));
  else document.querySelector('#close-node').disabled = false;
  if (hadFocus) heading.focus({ preventScroll: true });
}
function renderSummaryNote() {
  const body = document.querySelector('#node-body');
  body.replaceChildren();
  document.querySelector('#node-actions').replaceChildren();
  renderSummary(body);
  document.querySelector('#node-question').tabIndex = -1;
  document.querySelector('#close-node').disabled = busy;
  noteRevision = state.revision;
  noteBusy = busy;
  dialog.dataset.mode = 'summary';
  delete dialog.dataset.nodeId;
}
function openSummary(event) {
  if (busy || stopped) return;
  cancelAdvance();
  noteId = null;
  noteMode = 'summary';
  returnFocus = event?.currentTarget;
  renderSummaryNote();
  showNote();
}
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function visibleBud(id) {
  const node = nodeTarget(id);
  if (node?.dataset.visible !== 'true') return null;
  const box = node.querySelector('.tree-hit').getBoundingClientRect(),
    frame = treeViewport.getBoundingClientRect();
  if (
    box.left >= frame.left && box.right <= frame.right &&
    box.top >= frame.top && box.bottom <= frame.bottom
  ) return box;
  return null;
}

function mascotPlace(bud, frame, size) {
  const gap = 5,
    center = bud.left + bud.width / 2,
    outward = center < frame.left + frame.width / 2 ? -1 : 1,
    left = frame.left + gap,
    right = frame.right - size - gap,
    x = clamp(center + outward * 10 - size / 2, left, right);
  if (bud.top - gap - size >= frame.top) return { x, y: bud.top - gap - size };
  if (bud.bottom + gap + size <= frame.bottom) return { x, y: bud.bottom + gap };
  const beside = outward === -1 ? bud.left - gap - size : bud.right + gap;
  return {
    x: beside >= left && beside <= right ? beside : outward === -1 ? bud.right + gap : bud.left - gap - size,
    y: clamp(bud.top + (bud.height - size) / 2, frame.top, frame.bottom - size)
  };
}

function bubblePlace(bud, frame, mochi, size) {
  const ideal = dialog.offsetWidth,
    left = frame.left,
    right = frame.right,
    top = frame.top + 4,
    bottom = frame.bottom - 4,
    gap = 10,
    center = mochi.y + size * 0.67,
    edges = [
      { x: Math.min(mochi.x - gap, bud.left - gap), side: -1 },
      { x: Math.max(mochi.x + size + gap, bud.right + gap), side: 1 }
    ],
    outward = bud.left < left + frame.width / 2 ? -1 : 1,
    buds = [...treeCanvas.querySelectorAll('.tree-node[data-visible="true"]')]
      .filter(node => node.dataset.nodeId !== noteId)
      .map(node => node.getBoundingClientRect()),
    trunk = treeCanvas.querySelector('.tree-trunk')?.getBoundingClientRect(),
    controls = document.querySelector('.tree-controls').getBoundingClientRect(),
    matrix = treeCanvas.getScreenCTM(),
    branches = matrix
      ? view.getLayout().nodes.flatMap(n =>
          n.points.map(([x, y]) => ({ x: x * matrix.a + matrix.e, y: y * matrix.d + matrix.f }))
        )
      : [],
    candidates = [];
  function add(x, y, width, height, penalty, maxHeight) {
    const overlaps = b =>
      b && x < b.right + 4 && x + width > b.left - 4 && y < b.bottom + 4 && y + height > b.top - 4;
    const score =
      penalty +
      1000 * (buds.filter(overlaps).length + Number(overlaps(controls))) +
      (overlaps(trunk) ? 35 : 0) +
      branches.filter(p => p.x > x && p.x < x + width && p.y > y && p.y < y + height).length +
      Math.abs(y + height / 2 - center) / 32;
    candidates.push({ x, y, width, maxHeight, score });
  }

  for (const edge of edges) {
    const room = edge.side === -1 ? edge.x - left : right - edge.x,
      width = Math.min(ideal, Math.floor(room));
    if (width < Math.min(212, ideal)) continue;
    dialog.style.setProperty('--bubble-width', width + 'px');
    const height = Math.min(dialog.offsetHeight, bottom - top),
      x = edge.side === -1 ? edge.x - width : edge.x,
      penalty = (ideal - width) / 9 + (edge.side === outward ? 0 : 2),
      obstacles = [...buds, controls].filter(b => b.right > x && b.left < x + width),
      positions = [center - height / 2, ...obstacles.flatMap(b => [b.top - height - 5, b.bottom + 5])];
    for (const y of positions) add(x, clamp(y, top, bottom - height), width, height, penalty, height);
  }

  dialog.style.removeProperty('--bubble-width');
  const height = dialog.offsetHeight,
    width = ideal,
    x = clamp(mochi.x + (size - width) / 2, left, right - width),
    above = Math.min(bud.top, mochi.y) - gap,
    below = Math.max(bud.bottom, mochi.y + size) + gap;
  // Use the space above or below when a side would cover another bud.
  for (const [y, room] of [[null, above - top], [below, bottom - below]]) {
    if (room < 36) continue;
    const fit = Math.min(room, height);
    add(x, y ?? above - fit, width, fit, 32 + (height - fit) / 5, fit);
  }
  return candidates.sort((a, b) => a.score - b.score)[0];
}

function positionNote() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty('--visible-height', `${viewport?.height ?? innerHeight}px`);
  document.documentElement.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
  if (!dialog.open) return;

  const mobile = sheetLayout.matches;
  if (mobile) dialog.dataset.placement = 'sheet';
  const bud = noteId ? visibleBud(noteId) : null;
  if (!mobile) dialog.dataset.placement = bud ? 'bubble' : 'panel';
  mascot.toggleAttribute('hidden', !bud);
  bubbleLink.toggleAttribute('hidden', mobile || !bud);
  if (!bud) return;

  const frame = treeViewport.getBoundingClientRect(),
    size = mascot.width,
    mochi = mascotPlace(bud, frame, size);
  mascot.dataset.nodeId = noteId;
  mascot.style.left = mochi.x + 'px';
  mascot.style.top = mochi.y + 'px';
  if (mobile) return;

  dialog.style.removeProperty('--bubble-max-height');
  dialog.style.removeProperty('--bubble-width');
  const place = bubblePlace(bud, frame, mochi, size);
  if (!place) {
    dialog.dataset.placement = 'panel';
    bubbleLink.setAttribute('hidden', '');
    return;
  }
  dialog.style.setProperty('--bubble-left', place.x + 'px');
  dialog.style.setProperty('--bubble-top', place.y + 'px');
  dialog.style.setProperty('--bubble-width', place.width + 'px');
  dialog.style.setProperty('--bubble-max-height', place.maxHeight + 'px');
  drawBubbleTail(dialog, place, { x: mochi.x + size / 2, y: mochi.y + size * 0.67 }, 18);
}
// One closed path: rounded body (radius r) with a small blunt tail that grows
// out of the side facing the mascot. No box-plus-triangle seams.
function drawBubbleTail(element, place, point, radius) {
  const w = element.offsetWidth,
    h = element.offsetHeight,
    x0 = place.x,
    y0 = place.y,
    x1 = x0 + w,
    y1 = y0 + h,
    r = Math.min(radius, h / 2, w / 2),
    half = 7;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n)),
    f = n => Math.round(n * 10) / 10;
  const side =
    point.x < x0 && point.y >= y0 - 4 && point.y <= y1 + 4
      ? 'left'
      : point.x > x1 && point.y >= y0 - 4 && point.y <= y1 + 4
        ? 'right'
        : point.y < y0
          ? 'top'
          : point.y > y1
            ? 'bottom'
            : point.x < x0 + w / 2
              ? 'left'
              : 'right';
  const horizontal = side === 'left' || side === 'right';
  const c = horizontal
    ? { x: side === 'left' ? x0 : x1, y: clamp(point.y, y0 + r + half, y1 - r - half) }
    : { x: clamp(point.x, x0 + r + half, x1 - r - half), y: side === 'top' ? y0 : y1 };
  let dx = point.x - c.x,
    dy = point.y - c.y;
  const dist = Math.hypot(dx, dy) || 1;
  dx /= dist;
  dy /= dist;
  const len = clamp(dist - 26, 8, 70),
    tip = { x: c.x + dx * len, y: c.y + dy * len };
  // Traversal is clockwise: top L→R, right T→B, bottom R→L, left B→T.
  const along = { top: [1, 0], right: [0, 1], bottom: [-1, 0], left: [0, -1] }[side];
  const a = { x: c.x - along[0] * half, y: c.y - along[1] * half },
    b = { x: c.x + along[0] * half, y: c.y + along[1] * half };
  const blunt = 2.2,
    ta = { x: tip.x - along[0] * blunt, y: tip.y - along[1] * blunt },
    tb = { x: tip.x + along[0] * blunt, y: tip.y + along[1] * blunt };
  const tail = `L${f(a.x)} ${f(a.y)} Q${f(c.x + dx * len * 0.55 - along[0] * 1)} ${f(c.y + dy * len * 0.55 - along[1] * 1)} ${f(ta.x)} ${f(ta.y)} Q${f(tip.x + dx * 2)} ${f(tip.y + dy * 2)} ${f(tb.x)} ${f(tb.y)} Q${f(c.x + dx * len * 0.35 + along[0] * 2)} ${f(c.y + dy * len * 0.35 + along[1] * 2)} ${f(b.x)} ${f(b.y)} `;
  const t = side === 'top' ? tail : '',
    ri = side === 'right' ? tail : '',
    bo = side === 'bottom' ? tail : '',
    le = side === 'left' ? tail : '';
  const d = `M${f(x0 + r)} ${f(y0)} ${t}L${f(x1 - r)} ${f(y0)} Q${f(x1)} ${f(y0)} ${f(x1)} ${f(y0 + r)} ${ri}L${f(x1)} ${f(y1 - r)} Q${f(x1)} ${f(y1)} ${f(x1 - r)} ${f(y1)} ${bo}L${f(x0 + r)} ${f(y1)} Q${f(x0)} ${f(y1)} ${f(x0)} ${f(y1 - r)} ${le}L${f(x0)} ${f(y0 + r)} Q${f(x0)} ${f(y0)} ${f(x0 + r)} ${f(y0)} Z`;
  bubbleLink.querySelector('.bubble-tail-fill').setAttribute('d', d);
  bubbleLink.querySelector('.bubble-tail-edge').setAttribute('d', d);
  bubbleLink.dataset.target = noteId;
  bubbleLink.dataset.tipX = f(tip.x);
  bubbleLink.dataset.tipY = f(tip.y);
}
function syncNotePosition() {
  if (noteFrame) return;
  noteFrame = requestAnimationFrame(() => {
    noteFrame = 0;
    const advancing = askNext && replyTimer === null && !busy && !stopped;
    if (advancing) {
      const next = navigationTarget(),
        target = nodeTarget(next?.id);
      if (!next) {
        askNext = false;
        if (noteId && noteId === lastAnsweredId) {
          closeNote();
          card.querySelector('#round-summary[data-ready="true"]')?.focus({ preventScroll: true });
        }
      } else if (target?.dataset.visible === 'true') {
        if (!visibleBud(next.id)) document.querySelector('[data-tree-zoom=fit]').click();
        openNode(next.id, target, next.id === advanceId && working.has(next.id) ? 'edit' : undefined);
        return;
      }
    }
    positionNote();
    if (!stopped && ((advancing && askNext) || (dialog.open && treeCanvas.dataset.growing === 'true')))
      syncNotePosition();
  });
}
function openFruit(fruit) {
  const ready =
    documentMatches() &&
    (documentState.phase === 'ready' ||
      documentState.chapters?.some(c => c.id === fruit.id && c.status === 'ready'));
  if (!allSubmitted() || !ready) {
    message('这个章节还在生成，完成后果子会成熟。');
    return;
  }
  window.open(
    '/document' +
      (documentState.phase === 'ready' ? '' : '?chapter=' + encodeURIComponent(fruit.id)) +
      '#' +
      fruit.anchor,
    '_blank',
    'noopener'
  );
}
document.querySelector('#close-node').addEventListener('click', closeNote);
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  if (!busy) closeNote();
});
window.addEventListener('resize', syncNotePosition);
window.visualViewport?.addEventListener('resize', syncNotePosition);
window.visualViewport?.addEventListener('scroll', syncNotePosition);
document.querySelector('.tree-controls').addEventListener('click', syncNotePosition);
const noteResize = new ResizeObserver(syncNotePosition);
noteResize.observe(treeViewport);
noteResize.observe(dialog);
reducedMotion.addEventListener('change', () => {
  for (const element of [mascot, dialog, bubbleLink])
    element.getAnimations().forEach(animation => animation.cancel());
  syncNotePosition();
});
window.addEventListener('beforeunload', event => {
  if (state?.status === 'active' && (working.size || (drafts.size && !draftsSaved))) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener('keydown', event => {
  if (!state || busy || stopped || event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    if (dialog.open) {
      event.preventDefault();
      closeNote();
    }
    return;
  }
  if (
    (event.code === 'Space' || event.key === ' ') &&
    !dialog.open &&
    !event.target.matches('button,textarea,input,a,summary,[role=button]')
  ) {
    const summary = card.querySelector('#round-summary[data-ready="true"]');
    if (summary && !summary.disabled) {
      event.preventDefault();
      summary.click();
      return;
    }
  }
  if (!dialog.open || !dialog.contains(event.target)) return;
  if (noteMode === 'summary') {
    if (event.key === 'Enter' || event.code === 'Space') {
      const submit = dialog.querySelector('.seal-btn,.primary');
      if (submit && !submit.disabled && event.target.id === 'node-question') {
        event.preventDefault();
        submit.click();
      }
    }
    return;
  }
  if (noteMode !== 'edit') return;
  const inText = event.target.matches('textarea,input[type=text]');
  if (inText) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.target.form?.requestSubmit();
    }
    return;
  }
  if (/^[1-9]$/.test(event.key)) {
    const input = dialog.querySelector(`[data-shortcut="${event.key}"]`);
    if (input && !input.disabled) {
      event.preventDefault();
      input.click();
      if (input.type === 'checkbox') input.focus();
    }
  } else if (
    event.key === 'Enter' &&
    event.target.matches('input[type=radio],input[type=checkbox]')
  ) {
    event.preventDefault();
    if (event.target.type === 'radio') event.target.click();
    else event.target.form?.requestSubmit();
  } else if (event.key.startsWith('Arrow') && event.target.matches('input[type=radio]')) {
    const group = [...dialog.querySelectorAll('input[type=radio]:enabled')],
      step = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1,
      index = (group.indexOf(event.target) + step + group.length) % group.length;
    event.preventDefault();
    group[index]?.focus();
  }
});

async function refresh(force = false) {
  const sequence = ++refreshSequence;
  const [response, docResponse, progressResponse, adviceResponse] = await Promise.all([
    fetch('/state', { cache: 'no-store' }),
    fetch('/document/status', { cache: 'no-store' }),
    fetch('/progress', { cache: 'no-store' }),
    fetch('/guidance', { cache: 'no-store' })
  ]);
  if (!response.ok || !docResponse.ok || !progressResponse.ok || !adviceResponse.ok)
    throw Error('读取本机状态失败');
  const next = await response.json(),
    doc = await docResponse.json(),
    progress = progressResponse.ok ? await progressResponse.json() : null,
    advice = await adviceResponse.json();
  if (stopped) return;
  if (state && next.session_id !== state.session_id) {
    stopped = true;
    cancelAdvance();
    document
      .querySelectorAll(
        '#card input,#card button,#card textarea,#node-dialog input,#node-dialog button,#node-dialog textarea'
      )
      .forEach(n => (n.disabled = true));
    document.querySelector('#connection').textContent =
      '此地址已换成另一个访谈。请复制提醒，恢复原会话后继续。';
    return;
  }
  const instance = response.headers.get('x-grow-me-instance');
  if (
    !instance ||
    [docResponse, progressResponse, adviceResponse].some(
      r => r.headers.get('x-grow-me-instance') !== instance
    ) ||
    progress?.session_id !== next.session_id ||
    progress.revision !== next.revision ||
    advice.session_id !== next.session_id ||
    advice.revision !== next.revision ||
    doc.source?.session_id !== next.session_id ||
    doc.source?.revision !== next.revision
  )
    throw Error('状态正在变更，稍后重读');
  if (sequence < appliedRefresh || (state && next.revision < state.revision)) return;
  appliedRefresh = sequence;
  const changed = !state || next.revision !== state.revision,
    planChanged = planRequested !== Boolean(progress.plan_requested),
    docChanged =
      JSON.stringify({ ...doc, server_now: 0 }) !==
      JSON.stringify({ ...documentState, server_now: 0 });
  if (changed) {
    const old = state;
    const invalidated = new Set();
    for (const n of next.nodes) {
      const previous = old?.nodes.find(p => p.id === n.id);
      if (
        previous &&
        (JSON.stringify(previous.answer) !== JSON.stringify(n.answer) ||
          (n.status === 'needs_review' && previous.status !== 'needs_review'))
      )
        invalidated.add(n.id);
    }
    let count;
    do {
      count = invalidated.size;
      for (const n of next.nodes)
        if (n.depends_on.some(id => invalidated.has(id))) invalidated.add(n.id);
    } while (count !== invalidated.size);
    for (const n of next.nodes)
      if (n.status === 'answered' || invalidated.has(n.id)) {
        drafts.delete(n.id);
        working.delete(n.id);
      }
    if (!old || old.current_round !== next.current_round) {
      if (!dialog.open) askNext = true;
      waitingSince = null;
    }
    state = next;
    if (!old) restoreDrafts();
    else if (state.schema_version === 2) saveDrafts();
  }
  documentState = doc;
  planRequested = Boolean(progress.plan_requested);
  guidance = advice.recommendations;
  document.querySelector('#copy-reminder').disabled = false;
  if (instance !== aiInstance) {
    aiInstance = instance;
    aiOpenedAt = performance.now();
  }
  aiActivity = progress.ai ?? null;
  aiObservedAt = performance.now();
  if (isWaiting()) {
    if (waitingSince === null || planChanged)
      waitingSince =
        performance.now() -
        (progress?.session_id === state.session_id &&
        progress.revision === state.revision &&
        progress.started_at !== null
          ? Math.max(0, progress.server_now - progress.started_at)
          : 0);
  } else waitingSince = null;
  const key = ['requested', 'generating'].includes(doc.phase)
    ? state.session_id + '/' + doc.job_id
    : null;
  if (key !== documentKey) {
    documentKey = key;
    documentSince = key
      ? performance.now() -
        Math.max(0, (doc.server_now ?? Date.now()) - (doc.started_at ?? Date.now()))
      : null;
  }
  document.querySelector('#connection').textContent =
    state.schema_version === 1
      ? 'v1 历史访谈 · 只读'
      : state.status === 'complete'
        ? allSubmitted()
          ? '已保存 · 本机文档预览'
          : '保存状态与答案待核对'
        : '已连接本机';
  if (
    changed ||
    planChanged ||
    docChanged ||
    assistantDisplay !== assistantStatus() ||
    force ||
    renderFailed
  )
    render();
  const note = document.querySelector('#heartbeat-work');
  if (note) {
    note.textContent = heartbeatNote();
    note.hidden = !note.textContent;
  }
}
async function poll() {
  if (stopped) return;
  try {
    await refresh();
  } catch (error) {
    if (!stopped) {
      document.querySelector('#connection').textContent =
        '连接已断开，正在重连；已提交答案仍在本机。';
      if (!state) message('暂时读不到问题，将自动重连。', true);
    }
  }
  if (!stopped) setTimeout(poll, 1000);
}
document.querySelector('#copy-reminder').addEventListener('click', async () => {
  if (!state) return;
  const text =
    '请继续 grow-me。恢复后的第一步先运行一次 check.mjs，核对会话身份、实例和 revision，再做别的事；curl GET 不算轮询。服务若已停止，先按原启动回执重启原会话并立即运行 check.mjs。\n' +
    JSON.stringify({
      session_id: state.session_id,
      current_round: state.current_round,
      url: location.origin
    });
  try {
    await navigator.clipboard.writeText(text);
    message('提醒已复制，粘回原对话即可继续。');
  } catch {
    const body = document.querySelector('#node-body'),
      actions = document.querySelector('#node-actions'),
      heading = el('h2', '复制续接提醒');
    heading.id = 'node-question';
    heading.tabIndex = -1;
    cancelAdvance();
    noteId = null;
    noteMode = 'reminder';
    returnFocus = document.querySelector('#copy-reminder');
    body.replaceChildren(heading);
    actions.replaceChildren();
    const field = el('textarea', undefined, 'field');
    field.readOnly = true;
    field.value = text;
    field.setAttribute('aria-label', '续接提醒');
    body.append(el('p', '复制下面的文字，粘回原对话。', 'w'), field);
    showNote();
    field.select();
  }
});
setInterval(() => {
  const notice = document.querySelector('#ai-wait-notice');
  if (notice && assistantDisplay === 'paused') notice.textContent = pauseText();
  const late = document.querySelector('#long-wait');
  if (late) late.hidden = waitingSince === null || performance.now() - waitingSince <= 60000;
  const elapsed = document.querySelector('#wait-elapsed');
  if (elapsed)
    elapsed.textContent = `已等待 ${Math.max(0, Math.floor((performance.now() - Number(elapsed.dataset.since)) / 1000))} 秒`;
}, 500);
poll();
