# Decision tree and HTTP contract · v2

`tree.json` is the only maintained interview data. The v7 workbench renders `GET /state`, and the source-bound writer HTML consumes the same tree. Browser-local drafts stay out of the service, `tree.json`, and AI context until user submission. Document orchestration is transient control state, described below. Treat test fixtures and immutable receipts as evidence.

The machine-readable format is [tree.schema.json](tree.schema.json). The runtime also checks dependency existence, uniqueness and cycles, question readiness and revisions, which JSON Schema alone does not establish.

## Fields

| Level | Fields |
|---|---|
| Root | `schema_version: 2`, `session_id`, `topic`, `revision`, `current_round`, `status`, `nodes` |
| Node | `id`, `question`, required `rationale`, optional `recommendation`, `chapter_id` and `rephrases`, `input`, `options`, `answer`, `depends_on`, `status`, `round`. `text` and `multi_choice` may include `reply`. |
| Option | Stable `id`, visible `label`, optional `reply`; multi_choice may have one `exclusive: true` option |
| Answer | Required `option_ids` and `text`, optional boolean `deferred` or `unclear`. Preserve free-text whitespace, newlines and Unicode. |

Root status is `active` or `complete`. Node status is `pending` (待答), `answered` (已提交), or `needs_review` (待复核). A `pending` node has `answer: null`. Review retains the previous answer, including null. For confirmed answers, `single_choice` selects one known option, `multi_choice` selects at least one, and `text` requires nonblank text with no option IDs. An exclusive “都不需要” must be selected alone.

`{ "option_ids": [], "text": "", "deferred": true }` submits a question as 待定. `{ "option_ids": [], "text": "", "unclear": true }` submits it as 没看懂 and asks the AI to rephrase it. The user can describe what was unclear in `text`. Both states allow empty selections and notes. Any selected IDs still follow the input's rules and are tentative. Only one flag can be true. Omitted and false flags use the ordinary answer rules. Both states count as `answered` for round completion and save. Only ordinary submitted answers count as confirmed.

`chapter_id` is optional v2 document metadata, naming a root question reachable through this question's dependencies; roots name themselves. New question authors supply it each round. Explicit values directly determine document membership, including a chosen root for a multi-dependency question; missing values fall back to the original primary-root projection without backfilling the file. It never changes parent branches, review dependencies or geometry. `/context` projects the resolved ID and `/document/status.source.chapters[].node_ids` supplies frozen membership. V1 schema and read-only behavior are unchanged.

## New questions and recommendations

Every v2 initial/follow-up question has a nonblank `rationale` explaining the decision it controls. No generated default reason is inserted by the service. Recommendations are optional `recommendation: {option_ids, reason, source_ids, source_digest?}`. IDs must belong to this question; source_ids must name earlier submitted answers. Sources need not become depends_on links or change tree shape.

收到 `unclear: true` 后，下一轮必须把还没换问的题用更好懂的话再问一遍。有补充就照着补充解释，保留原来要决定的事。给新题一个新 ID，并填 `rephrases: "<旧题 id>"`。同一句题目不能原样再问。用户选择先出方案时按保存流程走。发布时，`rephrases` 必须指向之前存在且标为 `unclear: true` 的题。这个字段记录新题从哪道题换问而来。新题可以沿用旧题所属的章节。

出题时给每个选项配一句用户选中后麻薯说的话，写在选项的 `reply`。文本题和多选题可以在题目上写一句通用的 `reply`。像朋友接话，25 字左右（1–40 字），别复述选项，别写成用户已经作出的承诺。字段可省略，已有文件可以直接用。`reply` 不计入 `source_digest`。

`/round` computes `source_digest`. The UTF-8 JSON encodes `{id, answer: {option_ids, text}}` in source ID order. Append `deferred: true` or `unclear: true` after `text` when present. `assets/answers.mjs` defines the encoding. Required digests are 64 lowercase SHA-256 hex characters. New source-less AI suggestions can omit the digest.

GET /guidance and /context derive recommendation freshness without changing the tree. A source in review or a changed answer makes advice stale and hides its option IDs; the actual user selection is never overwritten. Source round and quoted answer come from the original tree. Rationale, advice and inferred content are AI metadata, not user confirmation; only selected IDs/notes are the answer. Render as text, not HTML.

## Legacy compatibility

Resume v0.2 v2 files directly. `deferred`, `unclear` and `rephrases` are optional.

New service recognizes [the original v1 schema](tree-v1.schema.json) for read-only history. No mutation, answer/round publication, document retry or metadata backfill is accepted for v1; a valid existing source-bound HTML is still readable. Finish active v1 interviews with v0.1.0-alpha.1. No automatic migration or rewriting of old document digests occurs.

Changing A's answer marks every transitive downstream node `needs_review`, including shared-dependency branches. Unrelated nodes, questions and answers are preserved. Keeping the same answer does not invalidate descendants again. The service does not recompute decisions. Prerequisites must be submitted and out of review before publishing or answering a dependent question. Treat a deferred or unclear prerequisite as an open decision when drafting questions.

Pressing **改** first calls `/reopen`. A itself and all downstream nodes immediately become `needs_review`, before an edited answer is saved. Old answers remain available as reference or for explicit reconfirmation. Clear drafts on the reopened branch. Keep unrelated drafts and unconfirmed input in the open page, and save the retained confirmed drafts under the new revision.

### Leaving needs_review

Use **仍然有效** to keep a confirmed answer, **仍待定** to keep a deferred answer, or **还是没看懂** to keep asking for a rephrase. Each posts the exact retained answer to `/decision` with the current revision and restores `answered` when prerequisites are ready. For A → B → C, changing A marks B and C `needs_review`. Keeping B restores only B. Review C separately. A node without a previous answer needs a new submission. Treat answers in review as unresolved.

`revision` increments on every successful mutation. Every v2 POST sends `expected_session_id` and `expected_revision`. Identity is verified against /state before generation; the service rejects wrong/missing session IDs even if revisions happen to match. HTTP 409 means the client must reread state. Mutations validate before writing; state is saved by replacing one file atomically. While the service is running, use its API, not external edits to `tree.json`.

## API

| Method | Path | Request / response |
|---|---|---|
| GET | `/` | Plain live HTML page |
| GET | `/tree.mjs` | Native SVG renderer and pure dependency layout; no framework |
| GET | `/state` | The canonical tree, unchanged from tree.json |
| GET | `/recovery` | Read-only session/schema/revision, process instance and original file paths; never included in clipboard reminder |
| GET | `/guidance` | Source-bound recommendation freshness; no tree writes |
| GET | `/wait?round=N` | Blocks until the whole round is answered or service timeout; JSON below |
| POST | `/ai/check` | `{expected_revision, expected_instance_id}`; identity-bound AI query receipt in memory, returns current progress |
| POST | `/submit` | `{round, expected_revision, answers:[{id,answer}]}` for every open question of the current round |
| POST | `/request-plan` | `{round, expected_revision, answers:[{id,answer}]}` with any locally confirmed, deferred or unclear drafts for the current round |
| POST | `/round` | `{round, expected_revision, nodes:[...]}` with the requested `round`, `status: "pending"` and explicit `answer: null` on every new node. If given, `rephrases` names an existing earlier question with `answer.unclear: true`. |
| POST | `/decision` | `{id, expected_revision, answer}`; revise or explicitly reconfirm one node |
| POST | `/reopen` | `{id, expected_revision}`; mark this node and all descendants `needs_review`, retaining answers |
| POST | `/finish` | `{expected_revision}`; save `complete`, release waits, exit and release port |

All POST table payloads below also require `expected_session_id`. JSON request bodies use `Content-Type: application/json`. The UI uses the exact printed `http://127.0.0.1:<port>` origin. The service accepts no foreign browser origin and exposes no CORS policy.

Normal wait timeout returns HTTP 200 and `{status:"pending", round, revision, review_ids:[]}`; curl exits 0. Answer return is `{status:"answered", round, revision, answers:[{id,question,answer,selected_options:[{id,label}]}]}`. Already-submitted answers can be read again; waits are not destructive. Finish releases outstanding waits as `closed`. A curl `--max-time` expiry instead exits 28: transport timeout is distinct from a normal `pending` reply.

Any unresolved `needs_review`, including an old node outside the requested round, holds `/wait` pending and blocks `/round`. After receiving an answer batch, reread `/context` and check `/state` for `answer.deferred` and `answer.unclear`, including earlier rounds. `selected_options` on either lists tentative selections. Rephrase unanswered unclear decisions in the next round. Continue past deferred questions.

Call `/request-plan` only after the user chooses **先出方案** in the confirmation bubble. Resolve yellow leaves first. The service submits supplied drafts, defers omitted questions, advances the revision even for an empty round submission, and records one `request_plan` user event. The active session then rejects new rounds. Both check modes return the event and report `plan_requested` independently of the event cursor. Prepare the save offer and wait for the user to save.

## Short queries, recovery and evidence

`/ai/check` and `/ai/wait` validate session, revision and instance before updating `last_check_at`. An explicit matching `owner_pid` renews an active heartbeat's 180-second lease. Continuing heartbeat pulses update `last_heartbeat_at` without consuming events or renewing either lease. `/recovery.heartbeats` lists each active id, owner_pid, lease_until and last_pulse_at. Heartbeat end reasons include `lease_expired` and `owner_exited`.

The service starts a 180-second work lease when it emits its startup receipt for a writable, unfinished session. Read-only v1 and complete sessions with document phase `ready` or `closed` start without a lease. A check or wait returning user events, a round publication, a successful AI document control (`offer`, `claim`, `progress`, `chapter`, `ready`, `failed`), or a heartbeat start renews the lease. Empty receipts, rejected requests and ordinary GETs leave the deadline as is. Document `ready` ends waits and heartbeats. The lease is scoped to the running instance. Closing clears it, and restart measures a fresh lease from startup for eligible sessions.

`/progress.ai` and `/recovery.ai` expose both check and heartbeat timestamps and ages, `heartbeat_active`, `heartbeat_activity`, `work_active`, `work_until` (Unix milliseconds) and `seconds_since_last_work`. The check and heartbeat clocks start at null. `last_activity_at` aliases the check clock. `timeout_ms` remains 30000 and `short_query_timeout_ms` remains 60000. See [runtime](runtime.md#ai-查询中断提示) for pause rules and page-open grace.

The old /wait and /document/wait endpoints remain available with their historical 25-second default, but assistants use one-shot scripts/check.mjs with a 3-second overall network deadline. Check /state identity first; read document/progress/recovery together and reject mixed session/revision/instance snapshots. The CLI prints compact state and new user-event metadata, not answers. A local `<tree.json>.cursor.json` stores revision/sequence/instance automatically. User-event sequence is separate from document sequence; AI publications do not set changed=true. Offered state returns waiting_for_save, with no discovery delay. Recovery begins with check.mjs, not curl GET. Approximately 10 seconds between invocations is a starting default, not automatic chat wakeup or a speed guarantee.

The webpage copies only session_id, current_round and URL plus static resume instructions. Paths and answers are never copied. Original paths remain in the assistant's startup receipt. scripts/start.mjs starts an independent local process and returns; scripts/check.mjs --restart can restore it from the exact original file, verifies session identity, and never creates/reseeds an interview. An occupied port stops automatic restart; verify the original process has exited before choosing a new port manually. Wrong-session live addresses are rejected instead of restarted.

The server retains compatibility last_submission {revision,round,at,cause} in memory; this is null after restart. New user events and first-discovery receipts are persisted in `<tree.json>.runtime-timings.jsonl`, without answers. The journal can measure a real unobserved submission after restart; missing historical timestamps are never invented. Repeated checks or waiting_for_save do not accrue discovery delay. `/ai/telemetry` records actual page pause visibility; `/ai/work` records code-read commands during the declared final-round answer window. These metadata endpoints require matching session/revision/instance and never modify tree.json. End-to-end submit → usable question includes polling discovery delay. See [runtime](runtime.md) and [verification and timing](verification.md) for actual commands and test modes. Synthetic browser actors do not establish interview quality or model performance.

## v7 workbench and document handoff

The approved visual basis is v7.html / VISUAL-SPEC.md: paper #efe9dc, tapered ink #2f2c26, per-round watercolor, five white petals, yellow leaves and hanging fruit. The old Claude prototype is an interaction reference. Production contains no prototype questions, simulated answers, fast-forward or fake-generation controls.

The workbench opens the first available question in a speech bubble beside round mochi (圆麻薯). Activating any node brings its question or saved answer into the same bubble. The bubble contains the question, rationale, answer controls, and deferral. Choice questions show an optional expanding note field and mark valid AI suggestions without selecting them. Activating one option confirms a single-choice answer and advances to the next available question. Multi-choice and text answers confirm with **好了**. At widths of 720 pixels or less, the bubble becomes a bottom sheet with internal scrolling and the mascot stays by the bud. Focus moves into the bubble when it opens. Reduced motion shows the final positions immediately.

确认普通答案后，芽开成花。选待定时显示暂停符号。点「没看懂，换个说法」展开「哪里没看懂？（可不填）」。点「请 AI 换个说法」后，树上显示问号，麻薯说「好，我让 AI 换个说法再问你」。这题算本轮已交，决定还没定。单选用所选项的 `reply`，多选优先用题目的 `reply`，再看第一个所选项。文本题用题目的 `reply`。没有台词时轮换模板，待定题用待定模板。约 1.5 秒后转到下一题。减少动态效果时直接换位置。

Store confirmed, deferred and unclear drafts in `localStorage`. While the page is open, a revision change clears drafts for submitted, reopened, and invalidated questions. Save retained drafts under the new revision. On page load, restore drafts only for the same `session_id` and `revision` in the same browser and origin. Guard storage access and keep drafts in memory when storage is unavailable. Unconfirmed form input stays in memory. Submitted answers recover through `/state`.

本轮答齐且没有待复核的黄叶时，麻薯先在最后确认的题旁接一句，约 1.5 秒后带着答案飞走。开启减少动态效果时直接显示倒数，最后一题点了「没看懂」时先显示静止的接话。页面倒数 5 秒后自动 `POST /submit`。待定和没看懂都算本轮已答。如果最后确认的是黄叶，同样先接话再倒数。接话或倒数时点树上的题目会取消这次交卷。页面切到后台时暂停倒数，切回来接着数。点「等等，我再看看」或按 Esc 可在倒数时打开答案列表并取消交卷。改完并再次确认时，符合条件就从接话开始。刷新的页面恢复草稿，可从底栏回看并点「交给 AI」。自动提交失败时显示原有错误，把仍然有效的草稿留在答案列表里供重试。

底栏显示轮次、剩余题数和进度小圆点。点「够了，先出方案」会取消交卷，麻薯在底部气泡里确认。气泡说明还有几题没答，没答的会记成「待定」，写进方案的「待确认」。即使本轮都答完也要确认。点「就先出方案」提交请求，点「再答几题」关闭气泡并保留草稿。

The current conversation authors each next round, ordinarily 3–5 questions with a soft count. Published candidates keep the revision captured before generation.

Waiting loops a visual extension, without adding rounds/nodes or cumulative tree height. While the AI is online and preparing the next round, the card shows “正在想下一轮的问题…”, then after 60 seconds “还在想，可以先回看本轮回答”. After the user requests a plan, it shows “正在准备保存…”. The card shows elapsed seconds, including after the last yellow leaf is reviewed. While the AI is online it also shows “生长中”. Timers use a process-local server start timestamp and a browser monotonic clock, survive polling and reconnect, and reset for a genuinely new wait/job. Transport loss reconnects. The human can edit during waiting. All transitive dependencies participate in review. A changed upstream invalidates in-progress review input even when the affected node was already `needs_review`. Unrelated unconfirmed form input survives in the open page. Reduced motion keeps text and stops movement.

等待出题或写文档时，如果页面判定 AI 已暂停或还没连上，麻薯就在最近答过的花旁睡着，气泡提示可以点它复制提醒。页头也能复制。复制成功后，气泡请用户去跟 AI 的聊天窗口粘贴，也可以再复制一次。复制失败时提供原文供手动复制。页面收到 AI 恢复在线的状态时，麻薯睁眼约 1 秒，随后恢复平常的显示。

### Document and projection endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /document/control | action offer / save / claim / progress / chapter / ready / failed / retry / close, with expected_session_id and expected_revision; claim / progress / chapter / ready / failed also require the current job_id |
| GET | /document/status | phase, control sequence, offered revision, job, failure and source context derived from tree.json |
| GET | /document/wait?after=S | Bounded current-conversation wait for a newer control sequence; pending is normal |
| GET | /document | Source-validated standalone HTML; ?download=1 downloads the final file; ?chapter=ID reads an already validated chapter snapshot during generation |
| GET | /progress | Transient waiting start, server clock, AI presence, stage, actual round and completed round count |
| GET | /context | Bounded decision summary, exact latest answers, full dependency/status index and source revision/digest |

Get the current job ID from `check.mjs` (`document.job_id`) or `GET /document/status` (`job_id`) after save or retry. HTTP 409 identifies a missing or mismatched `job_id`, a wrong phase, or a job known to have been replaced by a retry in this instance.

Offer is valid only while the current tree revision is fully answered and review-free. A canonical mutation invalidates it. Human save uses the existing finish model to atomically freeze complete and increment revision once. The read-only preview remains alive. Claim enters generating; only source-valid output can become ready. progress accepts fixed stage names, never arbitrary stream text. chapter accepts a root chapter_id and validates the fixed <document_file>.preview.html sibling against the current source/job, all three views and a completed chapter in design-view (data-chapter-ready="true"). It freezes an immutable readable snapshot for that chapter; unpublished chapters and the final document stay unavailable. Retry clears snapshots and replaces the job. The UI labels unripe fruit “生成中”, and only opens source-matching ready chapters. Failure messages are short operational text, not raw protocol output. See [progressive writer handoff](progressive-writer.md). Failure/retry keeps the identical frozen tree and creates a fresh transient job. Closing the preview exits and releases the port. The original /finish still immediately closes an active interview.

Configure an existing task file with --document; otherwise the default is outputs/task.html beside tree.json. This conversation applies project-requirement-writer and preserves its canonical three tabs. The main data-task-record includes data-source-session, data-source-revision, data-source-digest and data-source-job from the current document context. Consume the supplied digest directly; a different JSON serializer must not redefine it. Before posting ready, run `compose-document.mjs` to check the source and call `validate-task.mjs` in process with the frozen questions. Successful validation exports the sibling `task.manifest.json`. A missing or mismatched file is never a generated document.

换问的新题一旦提交，就替代旧题。原问法和补充仍可在树上回看。冻结章节按新题的回答写方案。保存时仍没有换问答案的题，以及换问后仍没看懂或选择待定的新题，列入设计方案开头的「还没定的」。每项链接到所属章节，补充文字保留在该章的「访谈原话」。相关开发项用 `data-questions` 关联待定事项。

新方案的正文状态用中文，`data-field="status"` 里的 `data-status` 保留机器值。校验和文本读取都优先读取该属性，已有方案继续支持只写机器值文本的状态字段。页末「记录信息」展示来源和编号对照。分片与交接见[分章交付](progressive-writer.md)。

Each root question defines one chapter and one fruit. The primary parent is the dependency with the latest round, tie-breaking by later original nodes order. Other dependencies remain available for review and cross-topic references. The same root IDs supply chapter anchors to renderer and server; anchors use an injective UTF-16 encoding of the root ID. Explicit chapter_id (or the legacy primary root when absent) places each source answer in one chapter and links related work and criteria. A task saved from an interview is not approval to implement it.

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

The complete flag alone cannot display a successful saved interview: every node must also be answered. A mismatch displays the real count and a state-consistency message, with no fruit. Ready document links additionally require matching source session and revision. tests/tree-layout.test.mjs checks the parent-curve attachment, taper, curved outlines, stable seed geometry and centred frame. The public browser regression checks replay, fruit/chapter navigation, reduced motion and both 28-node fixtures. Historical forced-layer and enlarged-fruit behavior remains superseded by the v7 restoration.
