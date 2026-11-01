import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {randomUUID} from 'node:crypto';
import { InputError, assertWritable, validateTree, submitRound, editDecision, reopenDecision, publishRound, finish, roundResult } from './model.mjs';
import { DocumentBridge } from './document.mjs';
import { InterviewProgress } from './progress.mjs';
import { interviewContext } from './context.mjs';
import {recommendationView} from './recommendations.mjs';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
if (!arg('--state')) { console.error('Usage: node server.mjs --state <tree.json> [--port 0] [--wait-ms 25000]'); process.exit(1); }
const stateFile = resolve(arg('--state')), port = Number(arg('--port', 0)), waitMs = Number(arg('--wait-ms', 25000));
if (!Number.isInteger(waitMs) || waitMs < 10 || waitMs > 300000) throw new Error('wait-ms must be 10..300000');
let tree = validateTree(JSON.parse(readFileSync(stateFile, 'utf8'))), closing = false;
const page = readFileSync(new URL('../assets/index.html', import.meta.url));
const css = readFileSync(new URL('../assets/style.css', import.meta.url));
const treeScript = readFileSync(new URL('../assets/tree.mjs', import.meta.url));
const modules = new Map(['app.mjs', 'topics.mjs', 'presentation.mjs', 'answers.mjs'].map(name => ['/' + name, readFileSync(new URL('../assets/' + name, import.meta.url))]));
const documentFile = resolve(arg('--document', resolve(dirname(stateFile), 'outputs', 'task.html')));
const waiters = new Set();
const instanceId = randomUUID();
const appVersion = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
let documents;
const progress=new InterviewProgress(()=>tree);
function save(next, cause = null) {
  validateTree(next); mkdirSync(dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8'); renameSync(temp, stateFile); tree = next;
  documents?.onMutation();
  progress.onMutation(cause);
  for (const waiter of [...waiters]) {
    const result = roundResult(tree, waiter.round); if (result) waiter.done(result);
  }
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-grow-me-instance': instanceId });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new InputError('use application/json', 415);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 131072) throw new InputError('body too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('invalid JSON'); }
}
function stop() {
  if (closing) return; closing = true;
  documents?.closeWaiters();
  for (const waiter of [...waiters]) waiter.done({ status: 'closed', round: waiter.round, revision: tree.revision });
  server.close(); server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 1000).unref();
}
documents = new DocumentBridge({ getTree: () => tree, save, file: documentFile, stop });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(page);
    }
    if (req.method === 'GET' && url.pathname === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(css);
    }
    if (req.method === 'GET' && url.pathname === '/tree.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(treeScript);
    }
    if (req.method === 'GET' && modules.has(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(modules.get(url.pathname));
    }
    if (req.method === 'GET' && url.pathname === '/document/status') return json(res, 200, documents.status());
    if (req.method === 'GET' && url.pathname === '/progress') return json(res, 200, progress.status());
    if (req.method === 'GET' && url.pathname === '/document/wait') return documents.wait(req, res, Number(url.searchParams.get('after') ?? 0), waitMs, json);
    if (req.method === 'GET' && url.pathname === '/document') {
      if (url.searchParams.has('resource')) {
        const resource = documents.resource(url.searchParams.get('resource'));
        res.writeHead(200, { 'content-type': resource.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          ...(resource.type === 'application/zip' ? { 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(resource.name) } : {}) });
        return res.end(resource.content);
      }
      const content = url.searchParams.has('download') ? documents.read() : documents.html(url.searchParams.get('chapter'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
        ...(url.searchParams.has('download') ? { 'content-disposition': 'attachment; filename="task.html"' } : {}) });
      return res.end(content);
    }
    if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, tree);
    if (req.method === 'GET' && url.pathname === '/guidance') return json(res, 200, {session_id:tree.session_id,revision:tree.revision,
      recommendations:Object.fromEntries(tree.nodes.filter(n=>n.recommendation).map(n=>[n.id,recommendationView(tree,n)]))});
    if (req.method === 'GET' && url.pathname === '/recovery') return json(res, 200, {session_id:tree.session_id,schema_version:tree.schema_version,
      revision:tree.revision,current_round:tree.current_round,instance_id:instanceId,app_version:appVersion,read_only:tree.schema_version===1,
      state_file:stateFile,document_file:documentFile});
    if (req.method === 'GET' && url.pathname === '/context') return json(res, 200, interviewContext(tree));
    if (req.method === 'GET' && url.pathname === '/wait') {
      const round = Number(url.searchParams.get('round'));
      if (!Number.isInteger(round) || round < 1) throw new InputError('round must be a positive integer');
      const result = roundResult(tree, round); if (result) return json(res, 200, result);
      const waiter = { round, done: value => { clearTimeout(timer); waiters.delete(waiter); json(res, 200, value); } };
      const timer = setTimeout(() => waiter.done({ status: 'pending', round, revision: tree.revision,
        review_ids: tree.nodes.filter(n => n.status === 'needs_review').map(n => n.id) }), waitMs);
      waiters.add(waiter); res.on('close', () => { clearTimeout(timer); waiters.delete(waiter); }); return;
    }
    if (req.method === 'POST') {
      const allowedOrigin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.origin && req.headers.origin !== allowedOrigin) throw new InputError('foreign origin', 403);
      const data = await body(req);
      if (tree.schema_version === 2 && data.expected_session_id !== tree.session_id) throw new InputError('session changed; read /state and verify identity before writing', 409);
      if (!(url.pathname === '/document/control' && data.action === 'close')) assertWritable(tree);
      if (url.pathname === '/document/control') return json(res, 200, documents.control(data));
      if (url.pathname === '/submit') save(submitRound(tree, data), 'submit');
      else if (url.pathname === '/decision') save(editDecision(tree, data), 'review');
      else if (url.pathname === '/reopen') save(reopenDecision(tree, data));
      else if (url.pathname === '/round') save(publishRound(tree, data));
      else if (url.pathname === '/finish') {
        save(finish(tree, data)); json(res, 200, { status: 'complete', revision: tree.revision });
        setImmediate(stop); return;
      } else throw new InputError('not found', 404);
      return json(res, 200, { ok: true, revision: tree.revision });
    }
    throw new InputError('not found', 404);
  } catch (error) { json(res, error instanceof InputError ? error.code : 500, { error: error.message }); }
});
server.requestTimeout = 0;
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`,
  port: server.address().port, pid: process.pid, instance_id:instanceId, app_version:appVersion,session_id:tree.session_id,schema_version:tree.schema_version,
  revision:tree.revision,current_round:tree.current_round,state_file: stateFile, document_file: documentFile })));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
