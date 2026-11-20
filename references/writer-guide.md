# Built-in writer guide

Use this guide for grow-me's three-view format. If `project-requirement-writer` is installed, use its writing guidance and retain any existing task page.

## Write from confirmed decisions

- 正文用大白话，先说结论，再说细节。每章用一句话讲清决定，接着写「你会看到」和「为什么」。章节短标题讲主题。写出人在什么情况下做什么、会看到什么。
- 正文不写编号、英文状态词、会话号或 revision。正文链接显示名字。需求、开发项和验收的编号放在 `id`、`data-*` 及锚点地址里。脚本生成页末的「记录信息」和「编号对照」。
- Write the goal in `design.summary`, the actual progress in `design.position`, and the next concrete action in `design.next`. A saved plan can still be waiting for development and acceptance.
- Keep confirmed decisions, AI proposals and unresolved questions distinct. Let `render-chapter.mjs` put each question, its selected options and exact notes under the chapter's closed 「访谈原话」. Keep tentative answers tentative. Use the frozen chapter anchors for named cross-topic links.
- Put unresolved items in the opening 「还没定的」. Use `design.open_questions` for items raised outside the frozen questions and for AI suggestions that need a decision. Each item has a stable `id`, plain `text`, and `origin` of `user` (你提的), `suggestion` (AI 的建议), or `deferred` (待定的题). An optional `chapter_id` links it to the chapter. The assembler adds frozen pending questions and counts the entries. Link dependent work to the pending item by name.

## One HTML, three views

1. **设计方案** — Open questions, topic chapters, and remaining requirements and constraints. Canonical requirements carry `data-kind="requirement"` and a stable `id`. Use `data-kind="constraint"` and `data-global="true"` for genuinely shared constraints.
2. **开发清单** — One numbered card per verifiable work item. Use `class="work-item"`, `data-number`, `data-kind="work"` (or `phase`), a named heading and `data-field="goal"` for the work. Show what will be observable when it is done, any prerequisites, the irreversible actions, and the status. Keep named links to the requirements, acceptance criteria and open questions in a closed `<details class="work-details">`. The shell adds the copy control there.
3. **验收标准** — Write one four-cell `<tr>` per criterion in the acceptance part. The assembler adds the table and column labels 「验什么」「怎么做」「应该看到」「结论」. Keep the criterion's stable ID and source requirements. State the action and observable result in separate cells. Record runs only when they took place. Human acceptance is 「还没验」 until the human confirms it.

Use `data-field="status"` with a canonical `data-status` and a Chinese label.

| 属性值 | 页面文字 |
| --- | --- |
| `planned` | 还没开始 |
| `in-progress` | 进行中 |
| `implemented` | 已实现 |
| `verified` | 已验收 |
| `passed` | 通过 |
| `failed` | 没通过 |
| `unverified` | 还没验 |
| `blocked` | 卡住了 |
| `stale` | 要重验 |

开发项示例

```html
<article id="W2" class="work-item" data-kind="work" data-number="2"
         data-requirements="R1" data-criteria="AC1" data-depends="W1" data-questions="Q1">
  <div class="work-heading">
    <h3>报名后发站内回执</h3>
    <span data-field="status" data-status="planned">还没开始</span>
  </div>
  <p data-field="goal">报名成功时往用户的站内消息发一条回执。</p>
  <p class="work-meta"><strong>做完能看到</strong> 报名人打开站内消息就能找到回执。</p>
  <p class="work-meta"><strong>先做完</strong> <a href="#W1">第 1 包 · 保存报名结果</a></p>
  <div class="work-effects" data-field="effects"><strong>撤不回的动作</strong><ul><li>无</li></ul></div>
  <details class="work-details">
    <summary>关联需求和验收</summary>
    <ul>
      <li><a href="#R1">报名回执</a></li>
      <li><a href="#AC1">报名人收到回执</a></li>
      <li><a href="#Q1">谁维护回执模板？</a></li>
    </ul>
  </details>
</article>
```

验收示例

```html
<tr id="AC1" data-kind="criterion" data-requirements="R1">
  <th scope="row">报名人收到回执</th>
  <td>提交一份有效的报名，再打开报名人的站内消息。</td>
  <td>能看到一条带活动名称和报名日期的回执。</td>
  <td><span data-field="status" data-status="unverified">还没验</span></td>
</tr>
```

In 开发清单, add one `data-field="effects"` block inside each work item or phase. List the irreversible actions that executing that item will perform, one per `<li>`. Use `<li>无</li>` when the item has none. The attribute can go directly on the `<ul>`. The manifest exports only the list items, in order, with normalized whitespace. A standalone `无` is omitted. An older plan without the block still exports an empty list.

- Include writes to production or other real databases (including running migrations), deployments or enabling production flags, outbound messages, notifications or emails, paid API calls (including batch calls), and deleting or overwriting user data.
- Exclude local commits, work against test databases, and code-only changes. For a migration script that will be written but left unrun, mention the irreversible production step in the handoff notes.

Keep business operations and outcomes readable. Fold commands, schema details and run logs into adjacent native `<details>` sections. All canonical text must remain in semantic HTML and readable offline without scripts; the bundled shell handles tabs, anchors and read-only task packages.

Use space-separated IDs in `data-questions="deferred-timing Q1"` on every work item that needs those answers. Use the generated pending-entry IDs for deferred interview questions. Unlinked pending items go to the first work item without dependencies.

## Assemble and publish progressively

Follow [progressive-writer.md](progressive-writer.md). Write UTF-8 JSON parts bound to the exact session, revision, digest and job. After each actual chapter is finished, assemble and publish its preview so the fruit becomes readable. Use progress stages for real work, never raw model tokens or SSE payloads.

Final assembly requires every chapter and all three view parts. Run the final command in the progressive guide, then check readable static content before posting `ready`.

```text
node "<skill>/scripts/read-task.mjs" "<task.html>"
```

Final assembly checks unique IDs, local links, requirement → criterion → work associations, question references and status values. The validator and text reader prefer `data-status` and fall back to the status text in older pages. Check the displayed text alongside the extracted definitions. When a browser is available, check narrow layout, tab switching, deep chapter anchors and offline reading.

Only after these checks succeed, post `ready` with the current expected_session_id, expected_revision and job_id. On failure, post a short actionable error and retain frozen answers for retry. An existing task page must be updated in place with its IDs and history preserved; do not replace it with a fresh template just to simplify assembly.
