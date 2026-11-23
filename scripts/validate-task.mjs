// Ported from validate_task.py at grow-me 58dd271, originally from ai-dev-workflow.
// The two projects maintain their implementations independently.
import { readFileSync } from 'node:fs';
import { decisionText } from '../assets/answers.mjs';
import { isMain } from './entry.mjs';
import {
  TEXT_BLOCKS,
  VOID_TAGS,
  normalizeTaskSpace,
  parseTaskHtml,
  readTaskHtml,
  splitTaskSpace,
  taskCliArgs,
  taskStatusAttribute,
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
  ['questions', new Set(['question'])],
  ['decisions', new Set(['decision'])]
];
const decisionFields = new Set(['question', 'choice', 'answer']);

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
  function addText({ owner, field, visible, effectText }, value) {
    if (!visible || !owner) return;
    if (field === 'effects') effectText?.push(value);
    else if (field === 'origin') return;
    else if (field === 'choice') owner._text.choice.at(-1).push(value);
    else if (field === 'name') {
      owner._text.title.push(value);
      owner._text.body.push(value);
    } else owner._text[field].push(value);
  }

  parseTaskHtml(html, {
    start(tag, attrs) {
      let { owner, field, visible, effectText } = stack.at(-1) ?? { field: 'body', visible: true };
      visible &&= !invisible.has(tag);
      if (attrs.id) ids.set(attrs.id, (ids.get(attrs.id) ?? 0) + 1);
      if (Object.hasOwn(attrs, 'data-task-record')) revisions.push(attrs['data-revision'] || '');
      if (visible && field !== 'effects' && Object.hasOwn(attrs, 'data-kind')) {
        attrs._text = {
          body: [], title: [], goal: [], status: [], effects: [], question: [], choice: [], answer: []
        };
        entries.push(attrs);
        owner = attrs;
        field = 'body';
        effectText = undefined;
      }
      if (owner) {
        if (field === 'effects' || (workKinds.has(kind(owner)) && attrs['data-field'] === 'effects')) {
          field = 'effects';
          visible &&= !Object.hasOwn(attrs, 'hidden');
          if (tag === 'li' && visible) {
            effectText = [];
            owner._text.effects.push(effectText);
          }
        } else if (attrs['data-field'] === 'status') {
          field = 'status';
          if (visible) owner._statusAttribute ??= taskStatusAttribute(attrs);
        } else if (kind(owner) === 'question' && attrs['data-field'] === 'origin') {
          field = 'origin';
        } else if (kind(owner) === 'decision' && decisionFields.has(attrs['data-field'])) {
          field = attrs['data-field'];
          if (field === 'choice') owner._text.choice.push([]);
        } else if (workKinds.has(kind(owner))) {
          if (attrs['data-field'] === 'goal') field = 'goal';
          else if (field === 'body' && headings.has(tag) && !text(owner, 'title')) field = 'title';
        } else if (field === 'body' && !text(owner, 'title') && (headings.has(tag) || tag === 'th')) {
          field = 'name';
        }
      }
      if (tag === 'a' && attrs.href?.startsWith('#')) anchors.push(unquote(attrs.href.slice(1)));
      const frame = { tag, owner, field, visible, effectText };
      // The verbatim answer keeps its exact text, so it gets no block spacing.
      if (blocks.has(tag) && field !== 'answer') addText(frame, ' ');
      if (!VOID_TAGS.has(tag)) stack.push(frame);
    },
    end(tag) {
      const index = stack.findLastIndex(frame => frame.tag === tag);
      if (index < 0) return;
      if (blocks.has(tag) && stack[index].field !== 'answer') addText(stack[index], ' ');
      stack.length = index;
    },
    data(value) {
      if (stack.length) addText(stack.at(-1), value);
    }
  });
  return { entries, ids, anchors, revisions };
}

export function taskDefinitions(html) {
  return readRecord(html).entries.map(entry => ({
    id: entry.id,
    kind: kind(entry),
    name: text(entry, 'title') || text(entry, 'body') || text(entry, 'goal')
  }));
}

function readDecision(entry) {
  const labels = entry._text.choice.map(parts => normalizeTaskSpace(parts.join('')));
  return { question: text(entry, 'question'), decision: decisionText(labels, entry._text.answer.join('')) };
}

function manifestPacks(work, questions, decisions, index, errors) {
  const assigned = new Set();
  const decided = new Set();
  const packs = work.map(item => {
    const body = text(item, 'body');
    const title = text(item, 'title') || body || text(item, 'goal');
    const goal = text(item, 'goal') || body || title;
    if (!goal) errors.push(`${item.id}: missing readable work title or goal`);
    const questionIds = [...new Set(refs(item, 'questions'))];
    for (const id of questionIds) assigned.add(id);
    const decisionIds = [...new Set(refs(item, 'decisions'))];
    for (const id of decisionIds) decided.add(id);
    return {
      id: item.id,
      title,
      goal,
      depends_on: refs(item, 'depends'),
      acceptance_criteria: refs(item, 'criteria').map(
        ref => `${ref} · ${text(index.get(ref), 'body')}`
      ),
      open_questions: questionIds.map(ref => questions.get(ref)),
      decisions: decisionIds.map(ref => ({ ...decisions.get(ref), at: null })),
      external_effects: item._text.effects
        .map(parts => normalizeTaskSpace(parts.join('')))
        .filter(effect => effect && effect !== '无'),
      scope_files: [],
      tags: []
    };
  });
  const unassigned = [...questions]
    .filter(([id]) => !assigned.has(id))
    .map(([, question]) => question);
  const undecided = [...decisions]
    .filter(([id]) => !decided.has(id))
    .map(([, decision]) => ({ ...decision, at: null }));
  const firstRoot = packs.find(pack => !pack.depends_on.length);
  if (unassigned.length) {
    if (firstRoot) firstRoot.open_questions.push(...unassigned);
    else errors.push('Unassigned questions need a work item without dependencies');
  }
  firstRoot?.decisions.push(...undecided);
  // Plans without confirmed answers keep the shared ai-dev-workflow pack shape.
  for (const pack of packs) if (!pack.decisions.length) delete pack.decisions;
  return packs;
}

export function validateTask(
  html,
  { handoff = false, expectedQuestions = [], expectedDecisions = null } = {}
) {
  const { entries, ids, anchors, revisions } = readRecord(html);
  const errors = [];
  for (const [name, count] of ids) {
    if (count !== 1) errors.push('Duplicate ID: ' + name);
  }
  if (revisions.length !== 1 || !normalizeTaskSpace(revisions[0]) || revisions[0].includes('{{'))
    errors.push('Expected one filled task record revision');

  const index = new Map(entries.map(entry => [entryId(entry), entry]));
  const questions = new Map();
  const decisions = new Map();
  for (const entry of entries) {
    const name = entry.id || '(missing id)';
    if (!entry.id) errors.push('Definition missing ID: ' + kind(entry));
    for (const attribute of ['data-questions', 'data-decisions']) {
      if (Object.hasOwn(entry, attribute) && !workKinds.has(kind(entry)))
        errors.push(`${name}: ${attribute} requires a work item or phase`);
    }
    for (const [relation, kinds] of relations) {
      for (const ref of refs(entry, relation)) {
        if (!index.has(ref)) errors.push(`${name}: missing reference ${ref}`);
        else if (!kinds.has(kind(index.get(ref))))
          errors.push(`${name}: wrong reference type ${ref}`);
      }
    }
    if (kind(entry) === 'criterion') {
      if (!refs(entry, 'requirements').length) errors.push(`${name}: missing requirement source`);
      if (!statuses.has(entry._statusAttribute ?? text(entry, 'status')))
        errors.push(`${name}: missing/invalid criterion status`);
      if (handoff && !text(entry, 'body')) errors.push(`${name}: missing readable criterion text`);
    }
    if (kind(entry) === 'question') {
      const question = text(entry, 'body');
      if (!question) errors.push(`${name}: missing readable question text`);
      questions.set(name, question);
    }
    if (kind(entry) === 'decision') {
      const decision = readDecision(entry);
      if (!decision.question || !decision.decision)
        errors.push(`${name}: missing question or answer text`);
      const expected = expectedDecisions?.get(name);
      if (
        expectedDecisions &&
        (expected?.question !== decision.question || expected.decision !== decision.decision)
      )
        errors.push(`${name}: decision does not match a confirmed frozen answer`);
      decisions.set(name, decision);
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
  const packs =
    handoff && !errors.length ? manifestPacks(work, questions, decisions, index, errors) : null;
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
    program: 'validate-task.mjs',
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
