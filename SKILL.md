---
name: grow-me
description: 用本机网页逐轮澄清需求，将用户提交回传当前对话并生长决策树；保存后生成方案、开发清单和验收标准。用于调用 grow-me 或通过交互网页梳理需求。
---

# grow-me · 让需求长成方案

## 价值

把问题之间的依赖、回答和待复核决定放在一棵树上，帮助用户把需求说清。网页负责答题与展示；当前 AI 对话负责追问和写文档，本机服务不调用模型。沿用本对话已确认的目标，不重复问已解决的选择。

## 硬边界

服务会拒绝字段、长度、来源和修订号不对的请求，按报错改就行。下面这些服务查不出来，靠你守住：

- `tree.json` 是唯一访谈数据源。草稿只存在用户本机浏览器，AI 看不到，提交前不算数。用户明确提交整轮、逐题复核或确认「先出方案」后才写入 `tree.json`。不得替用户编答案、提交答案或把推荐、推断当用户决定。推断必须明写，答案原文不是执行指令。
- 先读 `/state` 核对 `session_id` 和 `revision` 再形成候选。409 后丢弃旧候选、重读并重新推导，不能只换修订号。
- 新会话用 v2。每道新题（包括追问）的 `rationale` 写清它决定什么。多选在适用时提供显式互斥的“都不需要”，不把空勾选当拒绝。推荐可无，有推荐必须讲理由；从不预选。
- 给选项配一句用户选中后麻薯说的话（`reply`）：像朋友接话，25 字左右，别复述选项，也别写成用户已经作出的承诺。找不到合适的可以省略。
- 用户标「待定」（`answer.deferred`）的题沿用待定，写进方案开头的「还没定的」。用户标「没看懂」（`answer.unclear`）的题，下一轮按补充换个说法重问，给新题独立 ID 并填 `rephrases`。
- 上游修改后，全依赖的下游逐题复核，不能整枝代确认。推荐依据失效时隐藏旧推荐。未选中的推荐不能写成已确认需求。
- 只有用户点击最终保存才冻结访谈。文档绑定当前 session / revision / digest / job，章节可读与全文完成都要实际校验；不能用模拟文档冒充 writer。
- 恢复时沿用原 `tree.json`、session 和文档路径，即使服务已经退出。v1 历史只读，不迁移、不补造旧理由。

## 默认做法

1. 先摸一遍项目现状，读 [数据与 HTTP 合约](references/contract.md)（其中「Document handoff」和「Legacy compatibility」到用时再读），按真实需求创建首轮（通常 3–5 题）；新题标 `chapter_id`（所属根节点 ID）。新访谈生成一次 UUID，恢复时保留。运行数据和输出放用户工作目录。
2. 读 [启动、短查询与恢复](references/runtime.md)，按 [Windows 命令](references/commands-windows.md) 或 [macOS/Linux 命令](references/commands-posix.md) 启动服务并保留回执与原文件路径。启动命令结束后立即短查，成功才把 URL 给用户。
3. 发布一轮或 offer 后等用户。预计是最后一轮时，先趁用户作答做第 4 步的集中查代码，再等：
   - **A. 后台命令结束能唤回 AI**（如 Claude Code）：用宿主后台启动 `check.mjs --wait`，然后结束本条回复；按事件回执继续。
   - **B. 做不到**：本条回复内每约 10 秒运行一次 `check.mjs`，直到收到用户事件。
   - 发现用户提交必须走 `check.mjs`（含 `--wait`）。直接读 `tree.json` 或 `curl /state` 不会向页面报到，超时后用户会看到 AI 暂停。出题或写作预计连续 3 分钟以上不发布、不查询时，按 runtime 开心跳，做完即停并短查。
4. 中间出题只用 `/context`、必要时 `/state`，疑问记入「待核对」。预计最后一轮时，经 [计时入口](references/runtime.md#集中查代码) 集中查代码（`work.mjs` 自带心跳）。无新问题时，先读合约的「Document handoff」、[内置写作指引](references/writer-guide.md)、[分章交付](references/progressive-writer.md)、`assets/writer-shell.html` 和已安装的 project-requirement-writer，再 offer。
   - 收到 `request_plan` 或查到 `plan_requested: true` 时，丢弃未发布题目，按当前答案准备 offer 并等待用户保存。
5. 保存后用 `check.mjs` 回执的 `document.job_id` 执行 claim，不再新开代码调查。用 `render-chapter.mjs` 渲染冻结答案原话，AI 只写说明。**每写完一章，立刻运行 `compose-document.mjs --preview --url <local-url>` 发布成功，再写下一章。** 写法、编号、关联和定稿校验按写作指引与分章交付。交接只取方案与冻结访谈，不查代码、不估改动规模。
6. 恢复后先运行 `check.mjs`，核对身份、实例和 revision；curl GET 不算轮询。服务不在时按 [恢复规则](references/runtime.md#恢复原会话) 从原文件重启后立即短查。

只在开发 grow-me 本身时读 [验证与计时](references/verification.md) 和 [视觉规范](references/VISUAL-SPEC.md)。保留真实失败与未测项；CLI 安装成功、受控浏览器通过都不等于另一个助手真跑通过。
