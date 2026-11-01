import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../scripts/server.mjs', import.meta.url));
const answered = (id, deps = []) => ({ id, question: `${id} 的问题`, rationale: "受控测试：验证该决定的提交与复核边界。", input: 'text', options: [],
  answer: { option_ids: [], text: `${id} 原答案` }, depends_on: deps, status: 'answered', round: 1 });
const pending = (id, input = 'text', options = [], deps = [], round = 1) => ({ id,
  question: `${id} 的问题`, rationale: "受控测试：验证该决定的提交与复核边界。", input, options, answer: null, depends_on: deps, status: 'pending', round });
function seed(nodes = [pending('platform', 'single_choice', [{ id: 'web', label: '先做网页版' }]), pending('budget')]) {
  return { schema_version: 2, session_id: 'acceptance-fixture', topic: '最小往返', revision: 0,
    current_round: 1, status: 'active', nodes };
}
async function start(t, tree = seed(), port = 0, dir = null) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'grill-web-test-'));
  if (!dir) writeFileSync(join(root, 'tree.json'), JSON.stringify(tree), 'utf8');
  const child = spawn(process.execPath, [serverPath, '--state', join(root, 'tree.json'),
    '--port', String(port), '--wait-ms', '180']);
  let errors = ''; child.stderr.on('data', d => errors += d);
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([d]) => JSON.parse(String(d))),
    once(child, 'exit').then(([code]) => { throw new Error(`startup failed ${code}: ${errors}`); }),
  ]);
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    if (!dir) {
      const target = realpathSync(root), tempRoot = realpathSync(tmpdir());
      assert.equal(dirname(target).toLowerCase(), tempRoot.toLowerCase(), 'cleanup stays in the intended temp directory');
      assert.ok(basename(target).startsWith('grill-web-test-'), 'cleanup only this test fixture');
      rmSync(target, { recursive: true, force: true });
    }
  });
  return { child, root, url: ready.url, port: ready.port };
}
async function post(url, route, data) {
  const tree=await(await fetch(url+'/state')).json();
  return fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({expected_session_id:tree.session_id,...data}) });
}
async function curl(url, maxTime = '3') {
  const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--silent', '--show-error', '--max-time', maxTime, url]);
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d.toString('utf8')); child.stderr.on('data', d => stderr += d);
  const [code] = await once(child, 'exit'); return { code, stdout, stderr };
}
const allAnswers = [
  { id: 'platform', answer: { option_ids: ['web'], text: '' } },
  { id: 'budget', answer: { option_ids: [], text: '预算 3000\n原文：引号 " 与 <标签> 都保留。' } },
];

test('AC1: startup prints address, serves the page and round 1 from the one tree file', async t => {
  const { url, root } = await start(t);
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /id="card"/);
  assert.deepEqual(await (await fetch(url + '/state')).json(), JSON.parse(readFileSync(join(root, 'tree.json'))));
});
test('one local stylesheet is served with the right MIME type and allowed by CSP', async t => {
  const { url } = await start(t);
  const page = await fetch(url);
  assert.match(page.headers.get('content-security-policy'), /style-src 'self'/);
  const css = await fetch(url + '/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.ok((await css.text()).length > 0);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const script = await fetch(url + '/tree.mjs'); assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
});
test('AC2: curl stays pending before submission; normal service timeout and re-wait both exit 0', async t => {
  const { url } = await start(t); let settled = false;
  const first = curl(url + '/wait?round=1').then(x => { settled = true; return x; });
  await new Promise(r => setTimeout(r, 70)); assert.equal(settled, false);
  const result = await first; assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).status, 'pending');
  const retry = await curl(url + '/wait?round=1');
  assert.equal(retry.code, 0); assert.equal(JSON.parse(retry.stdout).status, 'pending');
});
test('AC3: option label and exact free-text reach an outstanding curl in under 5 seconds', async t => {
  const { url } = await start(t); const waiting = curl(url + '/wait?round=1');
  const started = performance.now();
  const response = await post(url, '/submit', { round: 1, expected_revision: 0, answers: allAnswers });
  assert.equal(response.status, 200);
  const result = await waiting; assert.equal(result.code, 0);
  assert.ok(performance.now() - started < 5000);
  const data = JSON.parse(result.stdout); assert.equal(data.status, 'answered');
  assert.equal(data.answers[0].selected_options[0].label, '先做网页版');
  assert.equal(data.answers[1].answer.text, allAnswers[1].answer.text);
  assert.equal((await curl(url + '/wait?round=1')).stdout, result.stdout, 'wait does not consume answers');
});
test('AC4 transport: publishing round 2 changes state while preserving round 1', async t => {
  const { url } = await start(t);
  await post(url, '/submit', { round: 1, expected_revision: 0, answers: allAnswers });
  const q2 = pending('scope', 'text', [], ['budget'], 2); q2.question = '预算 3000 如何分配？';
  const result = await post(url, '/round', { round: 2, expected_revision: 1, nodes: [q2] });
  assert.equal(result.status, 200);
  const state = await (await fetch(url + '/state')).json();
  assert.equal(state.current_round, 2); assert.equal(state.nodes[1].answer.text, allAnswers[1].answer.text);
  assert.match(state.nodes[2].question, /3000/);
});
test('AC6: finish exits, releases port, and the same port can be used on restart', async t => {
  const first = await start(t); const exit = once(first.child, 'exit');
  assert.equal((await post(first.url, '/finish', { expected_revision: 0 })).status, 200);
  const [code] = await exit; assert.equal(code, 0);
  const second = await start(t, seed(), first.port);
  assert.equal((await fetch(second.url + '/state')).status, 200);
});
test('AC7: edit A marks all and only transitive dependants for review; retains questions and answers', async t => {
  const nodes = [answered('A'), answered('B', ['A']), answered('C', ['B']), answered('D'), answered('E', ['D']), answered('F', ['A', 'D'])];
  const { url, root } = await start(t, seed(nodes));
  const result = await post(url, '/decision', { id: 'A', expected_revision: 0, answer: { option_ids: [], text: 'A 新答案' } });
  assert.equal(result.status, 200);
  const state = JSON.parse(readFileSync(join(root, 'tree.json'), 'utf8'));
  assert.deepEqual(state.nodes.map(n => n.status), ['answered', 'needs_review', 'needs_review', 'answered', 'answered', 'needs_review']);
  for (let i = 1; i < nodes.length; i++) { assert.deepEqual(state.nodes[i].answer, nodes[i].answer); assert.equal(state.nodes[i].question, nodes[i].question); }
  assert.equal(state.current_round, 1);
});
test('invalid or stale submission leaves the canonical file unchanged', async t => {
  const { url, root } = await start(t); const before = readFileSync(join(root, 'tree.json'), 'utf8');
  assert.equal((await post(url, '/submit', { round: 1, expected_revision: 9, answers: allAnswers })).status, 409);
  assert.equal((await post(url, '/submit', { round: 1, expected_revision: 0, answers: [{ id: 'platform', answer: { option_ids: ['missing'], text: '' } }] })).status, 400);
  assert.equal(readFileSync(join(root, 'tree.json'), 'utf8'), before);
});
test('review nodes need explicit confirmation before a new round can depend on them', async t => {
  const { url } = await start(t, seed([answered('A'), answered('B', ['A'])]));
  await post(url, '/decision', { id: 'A', expected_revision: 0, answer: { option_ids: [], text: '改了' } });
  const q = pending('C', 'text', [], ['B'], 2);
  assert.equal((await post(url, '/round', { round: 2, expected_revision: 1, nodes: [q] })).status, 409);
  await post(url, '/decision', { id: 'B', expected_revision: 1, answer: { option_ids: [], text: 'B 原答案' } });
  assert.equal((await post(url, '/round', { round: 2, expected_revision: 2, nodes: [q] })).status, 200);
});

test('review exit: reconfirm B restores answered and leaves B descendants exactly as they were', async t => {
  const { url } = await start(t, seed([answered('A'), answered('B', ['A']), answered('C', ['B']), answered('D')]));
  await post(url, '/decision', { id: 'A', expected_revision: 0, answer: { option_ids: [], text: 'A 已修改' } });
  const before = await (await fetch(url + '/state')).json();
  assert.equal(before.nodes[1].status, 'needs_review');
  assert.equal(before.nodes[2].status, 'needs_review');
  const result = await post(url, '/decision', { id: 'B', expected_revision: 1, answer: before.nodes[1].answer });
  assert.equal(result.status, 200);
  const after = await (await fetch(url + '/state')).json();
  assert.equal(after.nodes[1].status, 'answered');
  assert.deepEqual(after.nodes[1].answer, before.nodes[1].answer);
  assert.deepEqual(after.nodes[2], before.nodes[2], 'C remains needs_review, not implicitly confirmed');
  assert.deepEqual(after.nodes[3], before.nodes[3], 'unrelated D is untouched');
  assert.equal(after.revision, 2);
});

test('reopen immediately marks the chosen node and all descendants for review without changing answers', async t => {
  const original = [answered('A'), answered('B', ['A']), answered('C', ['B']), answered('D')];
  const { url } = await start(t, seed(original));
  assert.equal((await post(url, '/reopen', { id: 'A', expected_revision: 0 })).status, 200);
  const reopened = await (await fetch(url + '/state')).json();
  assert.deepEqual(reopened.nodes.map(n => n.status), ['needs_review', 'needs_review', 'needs_review', 'answered']);
  reopened.nodes.forEach((n, i) => { assert.deepEqual(n.answer, original[i].answer); assert.equal(n.question, original[i].question); });
  assert.deepEqual(reopened.nodes[3], original[3]);
  assert.equal((await post(url, '/reopen', { id: 'D', expected_revision: 0 })).status, 409);
  assert.deepEqual(await (await fetch(url + '/state')).json(), reopened);
});

test('a reopened old decision keeps wait pending even if the latest unrelated round was already answered', async t => {
  const old = answered('A'), latest = { ...answered('X'), round: 2 };
  const tree = { ...seed([old, latest]), current_round: 2 };
  const { url } = await start(t, tree);
  await post(url, '/reopen', { id: 'A', expected_revision: 0 });
  assert.equal((await post(url, '/round', { round: 3, expected_revision: 1, nodes: [pending('Y', 'text', [], [], 3)] })).status, 409,
    'an unrelated new question must not skip an unresolved old review');
  const waiting = await curl(url + '/wait?round=2');
  assert.equal(waiting.code, 0); assert.equal(JSON.parse(waiting.stdout).status, 'pending');
  await post(url, '/decision', { id: 'A', expected_revision: 1, answer: old.answer });
  assert.equal(JSON.parse((await curl(url + '/wait?round=2')).stdout).status, 'answered');
});
