# Decision tree and HTTP contract · v1

`tree.json` is the only maintained interview data. The browser renders `GET /state`; it does not keep another localStorage/database copy. The v7 workbench and source-bound writer HTML consume this tree; document orchestration is transient control state, described below. Test fixtures and immutable receipts are evidence, not competing editable specifications.

The machine-readable format is [tree.schema.json](tree.schema.json). The runtime also checks dependency existence, uniqueness and cycles, question readiness and revisions, which JSON Schema alone does not establish.

## Fields

| Level | Fields |
|---|---|
| Root | `schema_version: 1`, `session_id`, `topic`, `revision`, `current_round`, `status`, `nodes` |
| Node | `id`, `question`, `input`, `options`, `answer`, `depends_on`, `status`, `round` |
| Option | Stable `id` and visible `label` |
| Answer | `option_ids: []` plus `text: ""`; preserves free-text whitespace, newlines and Unicode |

Root status is `active` or `complete`. Node status is `pending` (待答), `answered` (已答), or `needs_review` (待复核). `input` is `single_choice` or `text`. Text nodes have an empty options array; single-choice answers select exactly one known option and may include a text note. An unanswered node has `answer: null`. A node needing review retains its previous answer, including null if it had never been answered.

Changing A's answer marks every transitive downstream node `needs_review`, including shared-dependency branches. Unrelated nodes, questions and answers are preserved. Confirming the same answer does not invalidate descendants again. The service does not recompute decisions. Prerequisites must be confirmed before publishing a dependent new question or confirming a dependent old answer.

Pressing **改** first calls `/reopen`: A itself and all downstream nodes immediately become `needs_review`, before an edited answer is saved. Old answers remain available as reference or for explicit reconfirmation. Unrelated in-page drafts survive this state refresh; drafts on the reopened branch are cleared. No second persistent data source is created.

### Leaving needs_review

The user can confirm an existing answer directly in the page with **仍然有效**; AI republication is not required. This posts the exact retained answer to `/decision` with the current revision. Once all prerequisites are answered, the node becomes `answered`. Its descendants are left exactly as they are: for A → B → C, changing A marks B and C `needs_review`; confirming B restores only B, and C remains `needs_review` until explicitly reviewed. A node without a previous answer must be answered, not merely confirmed. Editing the answer instead follows the ordinary downstream-invalidation rule. The AI must not interpret a pending review as user confirmation.

`revision` increments on every successful mutation. Send `expected_revision` on mutations. HTTP 409 means the client must reread state. Mutations validate before writing; state is saved by replacing one file atomically. While the service is running, use its API, not external edits to `tree.json`.

## API

| Method | Path | Request / response |
|---|---|---|
| GET | `/` | Plain live HTML page |
| GET | `/tree.mjs` | Native SVG renderer and pure dependency layout; no framework |
| GET | `/state` | The canonical tree |
| GET | `/wait?round=N` | Blocks until the whole round is answered or service timeout; JSON below |
| POST | `/submit` | `{round, expected_revision, answers:[{id,answer}]}` for every open question of the current round |
| POST | `/round` | `{round, expected_revision, nodes:[...]}`; publishes the next round, preserving prior nodes |
| POST | `/decision` | `{id, expected_revision, answer}`; revise or explicitly reconfirm one node |
| POST | `/reopen` | `{id, expected_revision}`; mark this node and all descendants `needs_review`, retaining answers |
| POST | `/finish` | `{expected_revision}`; save `complete`, release waits, exit and release port |

JSON request bodies use `Content-Type: application/json`. The UI uses the exact printed `http://127.0.0.1:<port>` origin. The service accepts no foreign browser origin and exposes no CORS policy.

Normal wait timeout returns HTTP 200 and `{status:"pending", round, revision, review_ids:[]}`; curl exits 0. Answer return is `{status:"answered", round, revision, answers:[{id,question,answer,selected_options:[{id,label}]}]}`. Already-submitted answers can be read again; waits are not destructive. Finish releases outstanding waits as `closed`. A curl `--max-time` expiry instead exits 28: transport timeout is distinct from a normal `pending` reply.

Any unresolved `needs_review`, including an old node outside the requested round, holds `/wait` pending and blocks `/round`. After receiving an answer batch, the AI must reread `/context` before generating another round, fetching `/state` when an abridged earlier answer needs exact detail.

Use a 25-second service wait and a 35-second curl limit. Tool yielding after 10 seconds is not a process timeout. Actual duration/probe limits belong in the test receipt, not a claim of unlimited host support.

For the 25-second baseline, the measured `exec_command.yield_time_ms: 30000` lets each normal timeout finish in one tool call. Longer HTTP waits can require intermediate `write_stdin`/execution polling, so HTTP request counts alone do not predict model token cost.

### Timing and test evidence

The default is a 25-second service wait and 35-second caller limit. Long-request behavior and model re-entry costs depend on the host. The public test suite uses synthetic inputs and controlled clocks; it does not include personal interview data, host usage logs or historical chat receipts. Real model latency must be measured separately during an actual interview.

## Reproduce the browser/current-conversation check

1. Create a fresh tree from `assets/example.tree.json`; start the service in the current Codex turn. Run one `/wait?round=1` without submitting; observe `pending`, exit 0, then re-wait.
2. Start `python tests/browser_acceptance.py --url <url> --evidence <workspace-evidence-dir>` as a background helper. The script launches real headless Chromium, submits one choice and a free-text budget of 3000 with a freshly random feature word after a 3-second delay.
3. In this same Codex conversation, receive `/wait?round=1`. Read its exact budget and feature word. Author round 2 referencing those values and the existing conversation's scope, then POST it to `/round`. Do not generate round 2 inside the service or browser test.
4. The browser asserts round 2 contains both values and `performance.timeOrigin` did not change, submits round 2, and saves a receipt/screenshot. Receive round 2 in this conversation. Finish the service and verify it exits and the port can be bound again.

The browser test's report is evidence of UI continuity and preserved answer use, not a test of interview quality or human business acceptance. All supplied budget/feature-word answers in this procedure are synthetic test data.

## Deferred v2 items

- Add a `multi_choice` input variant, with multiple option IDs; it is reserved in the plan but is not accepted/rendered by v1. Keep single-choice limits specific to that variant when extending the schema.
- Add optional AI-authored `asked_because`/`rationale` to explain the source/reason for a question and feed future design documents.
- Return answers with an explicit data boundary and host instructions treating them as answer data; preserve raw text separately from execution instructions. DOM text rendering already escapes HTML but does not establish model-level prompt-injection protection.

These are recorded follow-ups, not implemented capabilities or a v1 schema change.

## v7 workbench and document handoff

The approved visual basis is v7.html / VISUAL-SPEC.md: paper #efe9dc, tapered ink #2f2c26, per-round watercolor, five white petals, yellow leaves and hanging fruit. The old Claude prototype is an interaction reference. Production contains no prototype questions, simulated answers, fast-forward or fake-generation controls.

The workbench presents one question. Confirming locally blooms a memory draft. After the summary the human submits the entire round; until then tree.json and revision are unchanged. Dirty drafts warn on refresh/close, and are intentionally not a persistent browser store. Saved answers recover through /state. The current conversation authors each next round, ordinarily 3–5 questions with a soft count. Published candidates keep the revision captured before generation.

Waiting loops a visual extension, without adding rounds/nodes or cumulative tree height. The exact waiting text is “正在想下一轮的问题…”, then after 60 seconds “还在想，可以先回看已答的花”. The card always displays “生长中” and elapsed seconds, including after the last yellow leaf is explicitly reconfirmed. Timers use a process-local server start timestamp and a browser monotonic clock, survive polling and reconnect, and reset for a genuinely new wait/job. Transport loss reconnects. The human can edit during waiting; all transitive dependencies participate in review. A changed upstream also invalidates in-progress review drafts even when their status was already needs_review; unrelated drafts survive. Reduced motion keeps text and stops movement.

### Additional control endpoints (v1 unchanged)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /document/control | action offer / save / claim / progress / chapter / ready / failed / retry / close, with expected_revision; job completion also requires the current job_id |
| GET | /document/status | phase, control sequence, offered revision, job, failure and source context derived from tree.json |
| GET | /document/wait?after=S | Bounded current-conversation wait for a newer control sequence; pending is normal |
| GET | /document | Source-validated standalone HTML; ?download=1 downloads the final file; ?chapter=ID reads an already validated chapter snapshot during generation |
| GET | /progress | Transient waiting start, server clock, stage, actual round and completed round count; no tree writes |
| GET | /context | Bounded decision summary, exact latest answers, full dependency/status index and source revision/digest |

Offer is valid only while the current tree revision is fully answered and review-free. A canonical mutation invalidates it. Human save uses the existing finish model to atomically freeze complete and increment revision once. The read-only preview remains alive. Claim enters generating; only source-valid output can become ready. progress accepts fixed stage names, never arbitrary stream text. chapter accepts a root chapter_id and validates the fixed <document_file>.preview.html sibling against the current source/job, all three views and a completed chapter in design-view (data-chapter-ready="true"). It freezes an immutable readable snapshot for that chapter; unpublished chapters and the final document stay unavailable. Retry clears snapshots and replaces the job. The UI labels unripe fruit “生成中”, and only opens source-matching ready chapters. Failure messages are short operational text, not raw protocol output. See [progressive writer handoff](progressive-writer.md). Failure/retry keeps the identical frozen tree and creates a fresh transient job. Closing the preview exits and releases the port. The original /finish still immediately closes an active interview.

Configure an existing task file with --document; otherwise the default is outputs/task.html beside tree.json. This conversation applies project-requirement-writer and preserves its canonical three tabs. The main data-task-record includes data-source-session, data-source-revision, data-source-digest and data-source-job from the current document context. Consume the supplied digest directly; a different JSON serializer must not redefine it. The writer validates and atomically replaces the target before posting ready. A missing or mismatched file is never a generated document.

Each root question defines one chapter and one fruit. The primary parent is the dependency with the latest round, tie-breaking by later original nodes order. Other dependencies remain available for review and cross-topic references. The same shared projection supplies chapter anchors to renderer and server; anchors use an injective UTF-16 encoding of the root ID. The primary-root chapter contains each source answer once and links related work and criteria. A task saved from an interview is not approval to implement it.

On restart, complete tree data and a validated document restore read-only ready; an unfinished document can be resumed/retried by the same conversation. The local server does not run a model or wake an ended chat. Reconnect is connection recovery; AI continuation needs the original conversation to resume.

### Current checks

node --test tests/acceptance.test.mjs tests/document.test.mjs tests/tree-layout.test.mjs tests/wait-flow.test.mjs

python tests/browser_acceptance.py --work <folder>

python tests/browser_acceptance.py --scenario tree --layout-fixture four --work <folder>

python tests/seeded_growth.py --work <folder>

The controlled browser checks use explicitly synthetic input. The four-round fixture preserves the earlier approved 28-question/seven-root shape; the six-round fixture covers the v7 reference geometry. Both are canonical v1 fixtures outside production. They include actual hit testing, entity-overlap checks and root-to-fruit navigation. A separate current-conversation transport actor and real-requirement replay establish model/writer execution; measured requests and real UI times are receipts, never generated by the fixture service.

HTML previews rewrite links to their explicitly referenced local reports/images/downloads through /document?resource=. Only supported files inside the configured document directory are readable; unreferenced names, absolute paths, traversal and escaping symlinks are rejected. The offline HTML keeps its original relative links.

### Sparse-tree framing (r3)
Branch generation follows v7: root branches alternate on the appropriate round's trunk segment, children start at 70–80% of their primary parent's quadratic Bezier, their length derives from the parent's length, and their width is max(1.6, parent_width * 0.45). Branch angles, control points and organic perturbations use stable seeds derived from the persisted requirement `session_id` plus node ID. A new requirement gets a unique identity once; refresh, replay, answer edits, revisions and title changes do not reseed it. No clock or timestamp participates, and no geometry seed is stored in tree.json. The first root side and final twigs use the same requirement identity. Deterministic collision resolution re-samples up to 192 candidates within the v7 limits: root angular jitter ±11°, child jitter ±13°, root length factor 0.85–1.15, child factor 0.45–0.70 (minimum 62), root attachment 30–75%, child attachment 70–80%, horizontal curvature factor 10–32 and upward control-point lift 10–24. It prefers a 25-unit endpoint gap and otherwise retains the largest feasible gap; it cannot escape those limits or force endpoints onto rows. Regression coverage checks actual symbol separation as well as parameter bounds. The filled taper has a smooth cubic outline. Fine side twigs also curve; the artificial pair of trunk rungs from r5 is removed. Trunk segment height remains clamp(40 + 12 * question_count, 70, 130).

The entire ink illustration, including its final leader, flowers and fruit, is centred horizontally and vertically in the tree viewport. The viewBox retains at least the previous 1000 by 910 scale and remains fixed throughout a replay; centring changes its origin rather than enlarging the tree. preserveAspectRatio is xMidYMid meet.

A completed interview replays its recorded growth when opened: successive trunk segments and branches, flowers, the 1.4-second tapered leader, then fruit. The replay button repeats this display without changing answers, revision, confirmation counts or document state. Each round takes 1.1 seconds plus 0.2 seconds per same-round dependency depth. Reduced-motion mode shows the full final tree immediately. Fruit is smaller again (5.2-unit radius) with a muted #9a7b6d body, a short stalk and a small leaf. Its hit area remains larger than its painted body; the stalk is paint-only so it cannot intercept the question node at its attachment. There is one fruit per root; clicking opens the matching chapter of the validated writer HTML. The desktop panel remains raised and retains its own overflow area.

The complete flag alone cannot display a successful saved interview: every node must also be answered. A mismatch displays the real count and a state-consistency message, with no fruit. Ready document links additionally require matching source session and revision. tests/tree-layout.test.mjs checks the parent-curve attachment, taper, curved outlines, stable seed geometry and centred frame. tests/growth_layers.py (a retained filename) checks replay, small muted fruit, visible flowers, centring at three viewports and every real chapter link, preserves the canonical file hash, and covers the inconsistent-complete guard. tests/completion_growth.py retains the final taper regression. Both 28-node browser fixtures remain regression checks. The r5 forced-layer and enlarged-fruit requirements have been superseded by the user's r6 v7-restoration request.
