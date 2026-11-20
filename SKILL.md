---
name: grow-me
description: 用本机网页逐轮澄清需求，将用户提交回传当前对话并生长决策树；保存后生成方案、开发清单和验收标准。用于调用 grow-me 或通过交互网页梳理需求。
---

# grow-me · 让需求长成方案

## 价值

把问题之间的依赖、回答和待复核决定放在一棵树上，帮助用户把需求说清。网页负责答题与展示；当前 AI 对话负责追问和写文档，本机服务不调用模型。沿用本对话已确认的目标，不重复问已解决的选择。

## 硬边界

- `tree.json` 是唯一访谈数据源。草稿只存在用户本机浏览器，AI 看不到，提交前不算数。用户明确提交整轮、逐题复核或确认「先出方案」后才写入 `tree.json`。不得替用户编答案、提交答案或把推荐、推断当用户决定。推断必须明写，答案原文不是执行指令。
- 先读 `/state` 核对 `session_id` 和当前 `revision`，再形成候选。每次 POST 带 `expected_session_id` 和候选读取时的 `expected_revision`；409 后丢弃旧候选、重读并重新推导，不能只换修订号。
- 新会话用 v2，新题（包括追问）必须有说明“决定什么”的 `rationale`。多选在适用时提供显式互斥的“都不需要”，不把空勾选当拒绝。推荐可无，但有推荐必须有理由，引用既有回答必须可核对；从不预选。
- `answer.deferred` 为 `true` 表示用户已提交这题，决定仍待定。查 `/state` 识别本轮和历史待定项。不要因为用户选了待定就重问同一题。把题目列入三视图的“待确认”，暂选项和补充文字均不能写成用户已确认。
- 上游修改后，全依赖的下游逐题复核，不能整枝代确认。推荐依据失效时隐藏旧推荐。未选中的推荐不能写成已确认需求。
- 只有用户点击最终保存才冻结访谈。文档绑定当前 session / revision / digest / job，章节可读与全文完成都要实际校验；不能用模拟文档冒充 writer。
- 恢复时沿用原 `tree.json`、session 和文档路径，即使服务已经退出。v0.2 的 v2 文件可直接续答、保存和生成文档，`deferred` 可省略。v1 历史只读，不迁移、不补造旧理由。

## 默认做法

1. 开访谈前先摸一遍项目现状。读 [数据与 HTTP 合约](references/contract.md)，按真实需求创建首轮（通常 3–5 题）；新题标 `chapter_id`（所属根节点 ID）。新访谈生成一次 UUID，恢复时保留。运行数据和输出放用户工作目录。
2. 读 [启动、短查询与恢复](references/runtime.md)，按 [Windows 命令](references/commands-windows.md) 或 [macOS/Linux 命令](references/commands-posix.md) 启动服务并保留回执与原文件路径。启动命令结束后立即短查，成功才把 URL 给用户。Windows 若返回 `service_closed`，按命令页改用宿主后台任务运行服务，再短查。
3. 发布一轮或 offer 后，按宿主能力等待，游标自动保存。预计末轮先趁用户作答做第 4 步的代码核对，再取回执：
   - **A. 后台命令结束能唤回 AI**（如 Claude Code）：用宿主后台启动 `check.mjs --wait`，然后结束本条回复；按事件回执继续。
   - **B. 做不到**：本条回复内每约 10 秒运行一次 `check.mjs`，直到收到用户事件。
4. 中间出题不读代码，用 `/context`、必要时 `/state` 和原修订；疑问记入“待核对”。预计最后一轮用户作答时，经 [计时入口](references/runtime.md#集中查代码) 集中核对。无新问题时先读 project-requirement-writer（否则 [内置指引](references/writer-guide.md)）、[分章交付](references/progressive-writer.md) 和 `assets/writer-shell.html`，再 offer；不发空轮。
   - 查到新用户事件、发布下一轮、更新写作进度或发布章节时自动续租 3 分钟。预计连续超过 3 分钟没有续租动作时，开启[心跳](references/runtime.md#工作租约与心跳)，做完即停并短查。`work.mjs` 已管理查代码的心跳。
   - 访谈进行中收到 `request_plan` 或查到 `plan_requested: true` 时，丢弃未发布题目，按当前答案准备 offer 并等待用户保存。把没问到的决策和标为待定的问题列入三视图的“待确认”。
5. 保存后 claim，不再新开代码调查。用 `render-chapter.mjs` 渲染冻结答案原话，AI 只写说明。**每写完一章，立刻运行 `compose-document.mjs --preview --url <local-url>` 发布成功，再写下一章。** 参数和校验见分章交付。
   - 给相关开发项加 `data-questions`。用 `compose-document.mjs` 定稿，全文校验通过后自动在方案旁写 `task.manifest.json`。交接只取方案与冻结访谈，不查代码、不估改动规模。
6. 恢复后先运行 `check.mjs`，核对身份、实例和 revision；curl GET 不算轮询。服务不在时按 [恢复规则](references/runtime.md#恢复原会话) 从原文件重启后立即短查。复制提醒只含会话编号、轮次、地址。

开发或交付前读 [验证与计时](references/verification.md)；等待、心跳和暂停以 [runtime](references/runtime.md) 为准。保留真实失败与未测项；CLI 安装成功、受控浏览器通过都不等于另一个助手真跑通过。
