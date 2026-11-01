# Progressive writer handoff

The current conversation applies project-requirement-writer when installed, otherwise the bundled [writer guide](writer-guide.md); the local helper does not call a model. For a **new** document, reuse `assets/writer-shell.html`, copied from the shared writer template, with its three tabs, semantic body, offline reading and task-package behavior. For an existing maintained task page, preserve that page and history; use a validated preview sibling for early reading and atomically update the original page for final delivery.

## Write small independent parts

After claiming, save `/document/status` in the workspace as `status.json`. Share a short ID contract among the three views: the same requirement IDs, work/criterion IDs, dependencies, chapter anchors and confirmed decisions. These are transient generation inputs; tree.json remains the only interview state. Avoid reprinting full tree/history or template code in every task.

Each part is a UTF-8 JSON file in a workspace generation directory:

```json
{
  "source": {"session_id":"from status", "revision":6, "digest":"from status", "job_id":"from status"},
  "view":"chapter",
  "chapter_id":"root node id",
  "title":"A readable topic name",
  "html":"<p>Actual writer-authored chapter body, with source answers and references.</p>"
}
```

- One `view:chapter` per supplied root ID. The assembler creates the exact anchor and `data-chapter-ready="true"`; the body must be actual completed chapter prose. Put each original answer in its primary chapter once; keep cross-topic references.
- One `view:design` with the remaining shared design/requirement/constraint HTML; optional title, summary, decisions, updated. Canonical requirement entries keep stable `data-kind="requirement"` IDs.
- One `view:plan` with the development checklist and `data-kind="work"` entries and their requirement/criterion links.
- One `view:acceptance` with `data-kind="criterion"` entries, source requirements, observable checks and truthful `data-field="status"` values.

The views can be authored independently using the common ID contract. Use parallel agents only when authorized; otherwise compose their small bodies in the current conversation. Parallel assembly support does not itself promise lower model latency.

Whenever a chapter is written, run:

```text
node <skill>/scripts/compose-document.mjs --context <status.json> --tree <tree.json> --parts <parts-dir> --preview --url <local-url>
```

This atomically writes `<document_file>.preview.html`, validates the completed chapters against source/revision/digest/job and publishes each one. Missing views/links are visibly pending in the preview, never passing acceptance. A corresponding fruit becomes readable immediately; other fruit stays labeled “生成中”. Source-stale or duplicate parts fail without replacing the final HTML. File names are arbitrary; use distinct names on case-insensitive filesystems.

Use `/document/control` action `progress` with the current expected_session_id/expected_revision/job_id and stage `drafting`, `design`, `plan`, `acceptance` or `checking` as real work starts. The timer is elapsed time, not an estimated percentage. Avoid repeated stage-only calls while nothing changes.

Once all pieces are ready:

```text
node <skill>/scripts/compose-document.mjs --context <status.json> --tree <tree.json> --parts <parts-dir>
```

The assembler checks source binding, unique IDs, three views, all chapters and local links and atomically replaces the configured final HTML. It does **not** post ready: run the bundled `scripts/validate_task.py`, `scripts/read_task.py` and applicable display checks, then post ready with the current expected_session_id/expected_revision/job_id. HTML validation confirms structure/source, not user acceptance or implementation approval. On failure, retain frozen answers, post failed with a concise human-readable error, and retry under the new job. Never put raw SSE events, JSON payloads or traces into a status/error field.

Record real submit-to-next-question and save-to-document timings in test evidence. Controlled 168/420-second UI waits and assembly milliseconds are not real model-generation speed.
