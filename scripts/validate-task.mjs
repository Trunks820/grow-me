// Ported from validate_task.py at grow-me 58dd271, originally from ai-dev-workflow.
// The two projects maintain their implementations independently.
import { readFileSync } from 'node:fs';
import { isMain } from './entry.mjs';
import {
  TEXT_BLOCKS,
  VOID_TAGS,
  normalizeTaskSpace,
  parseTaskHtml,
  readTaskHtml,
  splitTaskSpace,
  taskCliArgs,
  writeTaskLine
} from './read-task.mjs';

const workKinds = new Set(['phase', 'work']);
const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary']);
const invisible = new Set(['script', 'style', 'template']);
const blocks = new Set([...TEXT_BLOCKS, 'h5', 'h6', 'br', 'hr', 'td', 'th']);
const statuses = new Set(['passed', 'failed', 'unverified', 'blocked', 'stale']);
const relations = [
  ['requirements', new Set(['requirement'])],
  ['criteria', new Set(['criterion'])],
  ['constraints', new Set(['constraint'])],
  ['depends', workKinds],
  ['questions', new Set(['question'])]
];

const text = (entry, field) => normalizeTaskSpace(entry._text[field].join(''));
const refs = (entry, key) => splitTaskSpace(entry['data-' + key] || '');
const kind = entry => entry['data-kind'];
const entryId = entry => entry.id ?? null;

function unquote(value) {
  return value.replace(/(?:%[a-f0-9]{2})+/gi, encoded =>
    Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8')
  );
}

function readRecord(html) {
  const entries = [];
  const ids = new Map();
  const anchors = [];
  const revisions = [];
  const stack = [];
  function addText({ owner, field, visible }, value) {
    if (visible && owner) owner._text[field].push(value);
  }

  parseTaskHtml(html, {
    start(tag, attrs) {
      let { owner, field, visible } = stack.at(-1) ?? { field: 'body', visible: true };
      visible &&= !invisible.has(tag);
      if (attrs.id) ids.set(attrs.id, (ids.get(attrs.id) ?? 0) + 1);
      if (Object.hasOwn(attrs, 'data-task-record')) revisions.push(attrs['data-revision'] || '');
      if (visible && Object.hasOwn(attrs, 'data-kind')) {
        attrs._text = { body: [], title: [], goal: [], status: [] };
        entries.push(attrs);
        owner = attrs;
        field = 'body';
      }
      if (owner) {
        if (attrs['data-field'] === 'status') field = 'status';
        else if (workKinds.has(kind(owner))) {
          if (attrs['data-field'] === 'goal') field = 'goal';
          else if (field === 'body' && headings.has(tag) && !text(owner, 'title')) field = 'title';
        }
      }
      if (tag === 'a' && attrs.href?.startsWith('#')) anchors.push(unquote(attrs.href.slice(1)));
      const frame = { tag, owner, field, visible };
      if (blocks.has(tag)) addText(frame, ' ');
      if (!VOID_TAGS.has(tag)) stack.push(frame);
    },
    end(tag) {
      const index = stack.findLastIndex(frame => frame.tag === tag);
      if (index < 0) return;
      if (blocks.has(tag)) addText(stack[index], ' ');
      stack.length = index;
    },
    data(value) {
      if (stack.length) addText(stack.at(-1), value);
    }
  });
  return { entries, ids, anchors, revisions };
}

function manifestPacks(work, questions, index, errors) {
  const assigned = new Set();
  const packs = work.map(item => {
    const body = text(item, 'body');
    const title = text(item, 'title') || body || text(item, 'goal');
    const goal = text(item, 'goal') || body || title;
    if (!goal) errors.push(`${item.id}: missing readable work title or goal`);
    const questionIds = [...new Set(refs(item, 'questions'))];
    for (const id of questionIds) assigned.add(id);
    return {
      id: item.id,
      title,
      goal,
      depends_on: refs(item, 'depends'),
      acceptance_criteria: refs(item, 'criteria').map(
        ref => `${ref} · ${text(index.get(ref), 'body')}`
      ),
      open_questions: questionIds.map(ref => questions.get(ref)),
      external_effects: [],
      scope_files: [],
      tags: []
    };
  });
  const unassigned = [...questions]
    .filter(([id]) => !assigned.has(id))
    .map(([, question]) => question);
  if (unassigned.length) {
    const firstRoot = packs.find(pack => !pack.depends_on.length);
    if (firstRoot) firstRoot.open_questions.push(...unassigned);
    else errors.push('Unassigned questions need a work item without dependencies');
  }
  return packs;
}

export function validateTask(html, { handoff = false, expectedQuestions = [] } = {}) {
  const { entries, ids, anchors, revisions } = readRecord(html);
  const errors = [];
  for (const [name, count] of ids) {
    if (count !== 1) errors.push('Duplicate ID: ' + name);
  }
  if (revisions.length !== 1 || !normalizeTaskSpace(revisions[0]) || revisions[0].includes('{{'))
    errors.push('Expected one filled task record revision');

  const index = new Map(entries.map(entry => [entryId(entry), entry]));
  const questions = new Map();
  for (const entry of entries) {
    const name = entry.id || '(missing id)';
    if (!entry.id) errors.push('Definition missing ID: ' + kind(entry));
    if (Object.hasOwn(entry, 'data-questions') && !workKinds.has(kind(entry)))
      errors.push(`${name}: data-questions requires a work item or phase`);
    for (const [relation, kinds] of relations) {
      for (const ref of refs(entry, relation)) {
        if (!index.has(ref)) errors.push(`${name}: missing reference ${ref}`);
        else if (!kinds.has(kind(index.get(ref))))
          errors.push(`${name}: wrong reference type ${ref}`);
      }
    }
    if (kind(entry) === 'criterion') {
      if (!refs(entry, 'requirements').length) errors.push(`${name}: missing requirement source`);
      if (!statuses.has(text(entry, 'status')))
        errors.push(`${name}: missing/invalid criterion status`);
      if (handoff && !text(entry, 'body')) errors.push(`${name}: missing readable criterion text`);
    }
    if (kind(entry) === 'question') {
      const question = text(entry, 'body');
      if (!question) errors.push(`${name}: missing readable question text`);
      questions.set(name, question);
    }
  }
  for (const anchor of anchors) {
    if (anchor && !ids.has(anchor)) errors.push('Missing anchor: ' + anchor);
  }

  const requirements = entries.filter(
    entry => kind(entry) === 'requirement' && entry['data-important'] !== 'false'
  );
  const criteria = entries.filter(entry => kind(entry) === 'criterion');
  const work = entries.filter(entry => workKinds.has(kind(entry)));
  for (const requirement of requirements) {
    const name = entryId(requirement);
    const covered = criteria.filter(criterion => refs(criterion, 'requirements').includes(name));
    if (!covered.length) errors.push(`${name ?? 'None'}: missing acceptance coverage`);
    if (
      work.length &&
      !work.some(
        item =>
          refs(item, 'requirements').includes(name) ||
          covered.some(criterion => refs(item, 'criteria').includes(entryId(criterion)))
      )
    ) {
      errors.push(`${name ?? 'None'}: missing plan coverage`);
    }
  }
  for (const criterion of criteria) {
    const name = entryId(criterion);
    if (
      work.length &&
      criterion['data-final'] !== 'true' &&
      !work.some(item => refs(item, 'criteria').includes(name))
    ) {
      errors.push(`${name ?? 'None'}: missing work-item mapping`);
    }
  }
  for (const [id, question] of expectedQuestions) {
    if (questions.get(id) !== normalizeTaskSpace(question))
      errors.push(`${id}: missing or changed frozen question`);
  }
  const packs = handoff && !errors.length ? manifestPacks(work, questions, index, errors) : null;
  return {
    valid: !errors.length,
    errors: [...new Set(errors)],
    requirements: requirements.length,
    criteria: criteria.length,
    work_entries: work.length,
    revision: revisions.length === 1 ? revisions[0] : null,
    limits: 'Structural links only; not business completeness or executed acceptance.',
    ...(handoff && !errors.length && { packs })
  };
}

function main() {
  const options = taskCliArgs(process.argv.slice(2), {
    program: 'validate_task.py',
    usage: '[-h] [--handoff] page',
    option: '--handoff',
    help: `Check the shared semantic task format; this does not judge business
completeness.

positional arguments:
  page

options:
  -h, --help  show this help message and exit
  --handoff   Include validated packs; read frozen question ID/text pairs from
              stdin`
  });
  if (!options) return;
  const handoff = Boolean(options.value);
  let html;
  let expectedQuestions;
  try {
    expectedQuestions = handoff ? JSON.parse(readFileSync(0, 'utf8')) : [];
  } catch (error) {
    writeTaskLine(process.stderr, error.message);
    process.exitCode = 1;
    return;
  }
  try {
    html = readTaskHtml(options.page);
  } catch (error) {
    writeTaskLine(process.stderr, error.message);
    process.exitCode = 2;
    return;
  }
  const report = validateTask(html, { handoff, expectedQuestions });
  writeTaskLine(process.stdout, JSON.stringify(report, null, 2));
  process.exitCode = report.valid ? 0 : 1;
}

if (isMain(import.meta.url)) main();
