# 启动、短查询与恢复

所有脚本路径相对 SKILL.md，运行时请换成绝对路径。准备真实 v2 首轮后，用 `start.mjs --state <原文件> --session <UUID> --document <HTML路径>`。它用现有 `tree.json` 校验会话，启动独立后台 Node 服务并打印回执。保留 URL、PID、state_file、document_file、session_id、launch 和 log_file。Windows 优先用隐藏窗口的 WMI 启动，失败时回退 spawn，服务输出保存在 `.grow-me-server-*.log`。启动命令退出后立即短查，成功才给用户地址。Windows 若返回 `service_closed`，按 [Windows 命令](commands-windows.md) 切到宿主后台任务并短查。

默认 `--port 0` 由系统分配空闲端口；如果浏览器会拦截这个端口，服务会换一个，只打印最终可用的地址。手动指定了浏览器会拦截的端口时，服务不会启动，请换一个端口。

## 短查询与等待

`check.mjs --url <origin> --session <UUID>` 是一次性命令：先 GET /state 验证身份，再读文档、进度和恢复元数据；核对 session / revision / instance 后 POST /ai/check。全部网络请求共用最多 3 秒期限。输出状态和新用户事件的元数据，不打印答案。服务不可达时退出码为 2，`status` 为 `service_closed`，`kind` 为 `offline`。

短查和等待共用 `<tree.json>.cursor.json`（session_id / revision / sequence / instance），无需手写 `--after-*`。`sequence` 是用户事件序号，随提交、复核、重开、确认先出方案、保存或重试推进。`changed` 表示有新用户事件，`instance_changed` 表示实例变化。显式 `--after-revision` / `--after-sequence` / `--after-instance` 仍按同一规则筛选或比较。回看不重复计发现延迟。

预计末轮发布后，先趁用户作答[集中查代码](#集中查代码)，再按下列路径取回执。

**A. 宿主能在后台跑命令、结束时唤回 AI**（如 Claude Code）：发布一轮或 offer 后，用宿主后台运行 `check.mjs --url <origin> --session <UUID> --wait`，然后结束本条回复。命令定期报到，一段等待到期会自动续等，不输出、不唤回 AI。收到用户事件时输出与短查同格式 JSON，退出码为 0；服务关闭、会话结束、身份不符退出码为 2，`status` 分别为 `service_closed`、`session_finished`、`identity`。

**B. 宿主做不到**：留在本条回复内，用宿主短等待，每约 10 秒运行一次普通 `check.mjs`，直到收到用户事件。普通 curl GET 不登记 AI 活跃，也不推进游标。

发现用户提交后读 `/context`，精确原文读 `/state`。有黄叶等用户逐题复核；全答后出追问或 offer。候选使用原修订，不能改号重交。

会话仍在进行时，任一种查询收到 `request_plan` 或看到 `plan_requested: true`，就停止出题。读当前答案，复核完成后直接准备 offer。已 offer 时等用户点击保存。即使游标已读过事件，恢复后也按此标记继续。把没问到的决策列入“待确认”。

没有长期轮次总数。页面内确认开花不算提交。offer 后、用户保存前返回 `waiting_for_save`，不再 `ready_for_ai`，不产生／累加 `discovery_delay_ms`。requested 后才能 claim。服务仍保留旧 /wait 与 /document/wait 兼容接口。

## 工作租约与心跳

服务成功启动并打印回执时，为可继续的 v2 会话开 3 分钟工作租约。已结束（complete 且文档 ready 或 closed）和只读 v1 会话不开启动租约。短查或等待返回 `changed: true`、发布下一轮、文档控制（如 offer、claim、progress、章节预览、ready）成功或启动心跳时续租。写作期间每完成一章就联机发布。空等、未发现事件的短查和失败请求都不续租。

预计连续超过 3 分钟没有续租动作时，运行 `check.mjs --url <origin> --session <UUID> --heartbeat`。启动前沿父进程链找最近的 Claude Code、Codex、Cursor 或 Antigravity，把 PID 传给后台心跳。找不到就传 `--owner-pid <AI 工具 PID>`。Windows 心跳同样优先用 WMI，失败回退 spawn。回执包含 `heartbeat_id`、`owner_pid` 和 `launch`。工作结束用 `--heartbeat-stop <heartbeat_id>` 停止，再短查处理期间的用户事件。`work.mjs` 已为查代码管理心跳。

后续心跳每 10 秒报到，只刷新心跳时钟，不消费事件。心跳自身的租期为 3 分钟，续期时用回执中的 `--owner-pid` 短查或等待。owner 退出记录 `owner_exited`，租期届满记录 `lease_expired`，连续超过 30 秒未收到心跳则标记失联。

## 集中查代码

开访谈前先摸一遍项目现状。中间出题只用用户回答和已有上下文，不读代码；把需要核对的事实记为“待核对”。预计最后一轮用户作答时集中核对并准备章节结构；此时每次代码读取／检索通过：

```text
node <skill>/scripts/work.mjs --url <origin> --session <UUID> --final-round -- <executable> <args...>
```

例如 Windows 用 `-- rg -n pattern <project>`、`-- powershell.exe -NoProfile -Command "Get-Content -LiteralPath '<file>'"`；macOS/Linux 用 `-- rg -n pattern <project>`、`-- cat <file>`。它不启用 shell 拼接，拥有独立心跳并在 finally 停掉，登记本次命令 `code_read_start/end`、耗时和退出码；无论成功失败都记结束。服务只允许 active、有本轮待答题、无黄叶且显式声明 final_round 时开始；提交／保存若在读取途中发生，可记结束但不可新开调查。

“最后一轮”是当前判断，不代表预定总轮数。核对发现影响决定的新疑问时，在该轮提交后问真正的新问题；不得用占位题延长读代码窗口。来不及核对或保存后出现新疑点，写成待核对／风险，不能推断为已确认，也不能保存后新开调查。宿主原生 Read/Grep 工具绕过此入口的读取无法自动计时，所以本流程必须经 work.mjs；进程强杀／断电留下未配对 start，标注中断，不编造 end。规则／模板在 offer 前预读；所有需求文字和代码入口说明，最终都须符合冻结答案，不能拿预读推断替代。

## AI 查询中断提示

`/progress.ai` 和 `/recovery.ai` 分开记录短查／等待报到（`last_check_at`）、心跳（`last_heartbeat_at`）和工作租约（`work_active`、`work_until`）。这些状态只存于实例内存。结束预览清空租约，重启从新实例启动时重新计时。普通 GET 只读。

等待 AI 出题或生成文档时，心跳和工作租约任一有效，页面就显示在线。两者都已失效且超过 60 秒没有短查或等待报到时，页面提示暂停。没有短查时间时按最后一次心跳计时，其次用最近工作动作的时间。没有任何活动记录时显示“等待 AI 对话连接”。新打开或刚切换服务实例的页面保留 30 秒宽限。用户答题和确认保存时不提示暂停。

## 恢复原会话

提醒只有 `session_id`、`current_round`、`url` 和静态续接说明。它不包含答案、聊天、路径、revision 或 job。轮次是定位提示，最新事实以 /state 为准。

1. **恢复后的第一步先运行一次 `check.mjs --url <提醒地址> --session <提醒ID>`，再做别的事；curl GET 不算轮询。** 该脚本先读取 /state 并校验身份、revision 和 instance。端口不是身份，属于其他会话时停止写入。
2. 短查询成功后，按回执状态继续；必要时读 /recovery 定位原文件、读 /document/status 取得当前 job。重新读 /context 判断当前是待用户、黄叶、待保存还是生成文档；没有已提交答案就不得凭提醒补写。
3. 服务不可达但原 tree.json 还在：从原启动回执／既有任务上下文取回 state_file、document_file，用 `check.mjs --url <旧地址> --session <原UUID> --restart --state <原文件> --document <原HTML>`。它核对原文件身份，按原文件启动，再读 /state 核对。原端口仍被占用时停止自动恢复，不启动第二个写入进程。先核对占用者及原进程是否确已退出；确认是其他服务且原服务已退出后，可手动用 start.mjs --port 0 恢复原文件并报告新 URL。
4. 原路径缺失且无法从既有上下文定位时，只询问缺失路径；不要创建新树。文件存在不代表用户同意迁移 v1，旧记录只能回看或用旧版继续。
5. 重启后，已提交答案、轮次和 revision 来自原 tree.json。草稿只存在用户本机浏览器，服务重启不影响已存草稿。原浏览器和原地址在会话编号及 revision 一致时可恢复。AI 看不到，提交前不算数。旧的 transient offer/job 可能消失：active 且已问清可重新 offer；complete 且最终 HTML 来源校验通过会恢复 ready，否则失败状态由用户点重试，再用新 job 从同一冻结答案继续，不重新答题。不要假装旧 job 仍有效或复用未核验的旧分片。

所有写入都带 expected_session_id 和 expected_revision，包括 document/control。生成状态不得包含原始流、JSON、命令输出或异常栈。用户结束预览后服务关闭，HTML 保留；不要留下额外后台副本。
