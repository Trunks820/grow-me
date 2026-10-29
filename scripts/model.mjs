export class InputError extends Error {
  constructor(message, code = 400) { super(message); this.code = code; }
}
const requireValue = (ok, message, code = 400) => { if (!ok) throw new InputError(message, code); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unique = list => new Set(list).size === list.length;
export function validateAnswer(node, answer) {
  requireValue(answer && Array.isArray(answer.option_ids) && typeof answer.text === 'string', 'answer needs option_ids[] and text');
  requireValue(answer.option_ids.every(id => typeof id === 'string') && unique(answer.option_ids), 'invalid option ids');
  if (node.input === 'single_choice') {
    requireValue(answer.option_ids.length === 1 && node.options.some(o => o.id === answer.option_ids[0]), 'choose exactly one listed option');
  } else {
    requireValue(answer.option_ids.length === 0 && nonempty(answer.text), 'text answer must not be blank');
  }
}
export function validateTree(tree) {
  requireValue(tree?.schema_version === 1 && nonempty(tree.session_id) && nonempty(tree.topic), 'invalid tree header');
  requireValue(Number.isInteger(tree.revision) && tree.revision >= 0, 'invalid revision');
  requireValue(Number.isInteger(tree.current_round) && tree.current_round > 0, 'invalid current round');
  requireValue(['active', 'complete'].includes(tree.status) && Array.isArray(tree.nodes) && tree.nodes.length > 0, 'invalid tree status/nodes');
  requireValue(unique(tree.nodes.map(n => n.id)), 'duplicate node id');
  const nodes = new Map(tree.nodes.map(n => [n.id, n]));
  for (const n of tree.nodes) {
    requireValue(nonempty(n.id) && nonempty(n.question) && ['text', 'single_choice'].includes(n.input), 'invalid node');
    requireValue(Number.isInteger(n.round) && n.round > 0 && n.round <= tree.current_round, 'invalid node round');
    requireValue(Array.isArray(n.options) && unique(n.options.map(o => o.id)) && n.options.every(o => nonempty(o.id) && nonempty(o.label)), 'invalid options');
    requireValue(n.input === 'text' ? n.options.length === 0 : n.options.length > 0, 'options do not match input');
    requireValue(Array.isArray(n.depends_on) && unique(n.depends_on) && n.depends_on.every(id => id !== n.id && nodes.has(id)), 'unknown/self dependency');
    requireValue(['pending', 'answered', 'needs_review'].includes(n.status), 'invalid node status');
    requireValue(n.status !== 'pending' || n.answer === null, 'pending node must have null answer');
    requireValue(n.status !== 'answered' || n.answer !== null, 'answered node needs an answer');
    if (n.answer !== null) validateAnswer(n, n.answer);
  }
  const active = new Set(), visited = new Set();
  function visit(id) {
    requireValue(!active.has(id), 'dependency cycle');
    if (visited.has(id)) return;
    active.add(id); for (const dep of nodes.get(id).depends_on) visit(dep);
    active.delete(id); visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  requireValue(tree.nodes.some(n => n.round === tree.current_round), 'current round has no nodes');
  return tree;
}
function prepare(tree, revision) {
  requireValue(tree.status === 'active', 'session already complete', 409);
  requireValue(revision === tree.revision, 'revision changed; reload state and try again', 409);
  return structuredClone(tree);
}
function ready(tree, node) {
  requireValue(node.depends_on.every(id => tree.nodes.find(n => n.id === id)?.status === 'answered'), 'confirm prerequisites first', 409);
}
function markDownstream(tree, id) {
  const changed = new Set([id]); let count;
  do {
    count = changed.size;
    for (const node of tree.nodes) if (node.id !== id && node.depends_on.some(dep => changed.has(dep))) {
      changed.add(node.id); node.status = 'needs_review';
    }
  } while (changed.size !== count);
}
export function editDecision(tree, body) {
  const next = prepare(tree, body.expected_revision), node = next.nodes.find(n => n.id === body.id);
  requireValue(node, 'unknown node'); ready(next, node); validateAnswer(node, body.answer);
  const changed = JSON.stringify(node.answer) !== JSON.stringify(body.answer);
  node.answer = structuredClone(body.answer); node.status = 'answered';
  if (changed) markDownstream(next, node.id);
  next.revision++; return validateTree(next);
}
export function reopenDecision(tree, body) {
  const next = prepare(tree, body.expected_revision), node = next.nodes.find(n => n.id === body.id);
  requireValue(node, 'unknown node');
  node.status = 'needs_review'; markDownstream(next, node.id);
  next.revision++; return validateTree(next);
}
export function submitRound(tree, body) {
  const next = prepare(tree, body.expected_revision);
  requireValue(body.round === next.current_round, 'round changed', 409);
  const wanted = next.nodes.filter(n => n.round === body.round && n.status !== 'answered');
  requireValue(Array.isArray(body.answers) && wanted.length > 0 && body.answers.length === wanted.length &&
    unique(body.answers.map(a => a.id)) && body.answers.every(a => wanted.some(n => n.id === a.id)), 'submit every open question in this round');
  for (const entry of body.answers) {
    const node = next.nodes.find(n => n.id === entry.id); ready(next, node); validateAnswer(node, entry.answer);
    const changed = JSON.stringify(node.answer) !== JSON.stringify(entry.answer);
    node.answer = structuredClone(entry.answer); node.status = 'answered';
    if (changed) markDownstream(next, node.id);
  }
  next.revision++; return validateTree(next);
}
export function publishRound(tree, body) {
  const next = prepare(tree, body.expected_revision);
  requireValue(body.round === next.current_round + 1, 'publish the next round only', 409);
  requireValue(!next.nodes.some(n => n.status === 'needs_review'), 'confirm reviewed decisions first', 409);
  requireValue(next.nodes.filter(n => n.round === next.current_round).every(n => n.status === 'answered'), 'current round is not answered', 409);
  requireValue(Array.isArray(body.nodes) && body.nodes.length > 0, 'round needs nodes');
  for (const n of body.nodes) {
    requireValue(n.round === body.round && n.status === 'pending' && n.answer === null, 'new questions must be pending in the new round');
    ready(tree, n);
  }
  next.nodes.push(...structuredClone(body.nodes)); next.current_round = body.round; next.revision++;
  return validateTree(next);
}
export function finish(tree, body) {
  const next = prepare(tree, body.expected_revision); next.status = 'complete'; next.revision++;
  return next;
}
export function roundResult(tree, round) {
  const nodes = tree.nodes.filter(n => n.round === round);
  requireValue(nodes.length, 'unknown round', 404);
  if (!tree.nodes.some(n => n.status === 'needs_review') && nodes.every(n => n.status === 'answered')) return { status: 'answered', round, revision: tree.revision,
    answers: nodes.map(n => ({ id: n.id, question: n.question, answer: n.answer,
      selected_options: n.options.filter(o => n.answer.option_ids.includes(o.id)) })) };
  if (tree.status === 'complete') return { status: 'closed', round, revision: tree.revision };
  return null;
}
