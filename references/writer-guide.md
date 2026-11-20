# Built-in writer guide

Use this guide when `project-requirement-writer` is not installed. If it is available, apply that skill and retain its established task page. This guide supplies the portable three-view contract for grow-me; it does not authorize implementing the resulting plan.

## Write from confirmed decisions

- Keep user decisions, AI proposals and unresolved questions visibly distinct. Read all selected option labels, including an exclusive “都不需要”, and preserve notes exactly. Rationale explains why a question was asked; recommendation is AI metadata. An unselected recommendation is never a confirmed requirement. Mark source-stale advice as expired rather than restoring it as a decision. Preserve original answers once in the chapter assigned by frozen `source.chapters[].node_ids` (explicit `chapter_id`, or the legacy primary root when absent) and link cross-topic dependencies.
- Each root from `/document/status.source.chapters` gets the supplied anchor in design-view. A readable chapter title may summarize the question; IDs and source bindings must remain exact.
- Keep `answer.deferred: true` under 待确认 in all three views. Link to the generated chapter for tentative choices and notes. Leave implementation and acceptance decisions that depend on them open.
- The overview states the goal, current position, next action and meaningful pending choices. Do not present a generated plan as human approval.
- Use stable requirement IDs (`R1`…), work IDs (`W1`…) and criterion IDs (`AC1`…). Agree these IDs before writing independent views, so links do not drift.

## One HTML, three views

1. **设计方案**: goals, scope, capabilities, user flows, preserved behavior, technical choices and topic chapters. Canonical requirements carry `data-kind="requirement"` and a stable `id`. Constraints may carry `data-kind="constraint"`, with `data-global="true"` only for a genuinely shared constraint.
2. **开发清单**: independently verifiable deliverables with actual dependencies and visible status. Use `data-kind="work"` or `data-kind="phase"` with a stable ID, a heading, a visible `data-field="goal"`, `data-requirements="R1"`, `data-criteria="AC1"` and optional `data-constraints` / `data-depends`. Put the visible state in `<span data-field="status">planned</span>`. Link to definitions rather than copying them. Do not invent development tasks for an interview whose scope is reflection or documentation only.
3. **验收标准**: each criterion gives its source requirement, scenario/actions, observable pass condition and verification method. Use `data-kind="criterion"`, `data-requirements="R1"` and a visible status of `unverified`, `passed`, `failed`, `blocked` or `stale`. Generated criteria begin unverified; only record checks that actually ran. Human acceptance stays unverified until the human confirms it.

Keep business operations and outcomes readable. Fold commands, schema details and run logs into adjacent native `<details>` sections. All canonical text must remain in semantic HTML and readable offline without scripts; the bundled shell handles tabs, anchors and read-only task packages.

Write each additional 待确认 item once as a visible `data-kind="question"` entry with a stable ID such as `Q1`, and link to it from the other views. Use space-separated IDs in `data-questions="deferred-timing Q1"` on every work item that needs those answers. Use the generated pending-entry IDs for deferred interview questions (see the progressive guide). Unlinked pending items go to the first work item without dependencies.

## Assemble and publish progressively

Follow [progressive-writer.md](progressive-writer.md). Write UTF-8 JSON parts bound to the exact session, revision, digest and job. After each actual chapter is finished, assemble and publish its preview so the fruit becomes readable. Use progress stages for real work, never raw model tokens or SSE payloads.

Final assembly requires every chapter and all three view parts. Run the final command in the progressive guide, then check readable static content before posting `ready`.

```text
node "<skill>/scripts/read-task.mjs" "<task.html>"
```

Final assembly calls `validate-task.mjs` in process to check unique IDs, local links, requirement → criterion → work associations, question references and status values. Use the extractor to confirm collapsed and static body text is present. When a browser is available, check narrow layout, tab switching, deep chapter anchors and offline reading. Preserve genuine pending decisions and report any unperformed display checks.

Only after these checks succeed, post `ready` with the current expected_session_id, expected_revision and job_id. On failure, post a short actionable error and retain frozen answers for retry. An existing task page must be updated in place with its IDs and history preserved; do not replace it with a fresh template just to simplify assembly.
