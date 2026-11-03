# 启动、短查询与恢复

所有脚本路径相对 SKILL.md，运行时请换成绝对路径。准备真实 v2 首轮后，用 `start.mjs --state <原文件> --session <UUID> --document <HTML路径>`。它先校验原文件，启动独立后台 Node 服务，打印启动回执后退出；不会创建或覆盖 tree.json。保留 URL、PID、原 state_file、document_file、session_id；这些是进程定位信息，不是另一份答案存储。Windows 后台窗口隐藏。

## 短查询

`check.mjs --url <origin> --session <UUID>` 是一次性命令：先 GET /state 验证身份，再读文档、进度和恢复元数据；核对 session / revision / instance 后 POST /ai/check。全部网络请求共用最多 3 秒期限。输出状态和新用户事件的元数据，不打印答案。

游标自动写入原状态文件旁的 `<tree.json>.cursor.json`（session_id / revision / sequence / instance），下次无需手写 `--after-*`。sequence 是**用户事件序号**，不是文档序号；submit、逐题复核、重新打开答案、最终保存、生成重试才产生事件。AI 发布题目、offer、claim、发布章节不算新提交。`changed` 仅代表有新用户事件；状态仍每次返回。`instance_changed` 单独报告重启。`--after-revision` / `--after-sequence` / `--after-instance` 可显式覆盖筛选／比较；回看旧事件不会重新计算发现延迟。游标和计时日志只存运行元数据，不能恢复或替代任何答案；不要把它们拷到其他访谈。

用户未点最终保存前，不得结束本轮回复；每次短查询后必须继续下一次，约每 10 秒重新调用。使用宿主短等待，不把一个 shell 命令永久挂住。无新事件不是失败；发现用户提交后读 /context，精确原文读 /state。review 等用户逐题复核；全部已答后出追问或 offer。候选捕获原修订，不能改号重交。普通 curl GET 只读取，不登记 AI 活跃，也不推进游标。

没有长期轮次总数。页面内确认开花不算提交。offer 后、用户保存前返回 `waiting_for_save`，不再 `ready_for_ai`，不产生／累加 `discovery_delay_ms`。requested 后才能 claim。服务仍保留旧 /wait 与 /document/wait 兼容接口。

## 耗时工作心跳

出题、查代码、写文档前运行 `check.mjs --url <origin> --session <UUID> --heartbeat`。命令打印 `heartbeat_id` / PID 后立即退出；独立隐藏子进程每 10 秒读取轻量 /recovery 并 POST /ai/heartbeat，核对 session / revision / instance，**不读 /state、/context、/wait，不读取或消费用户事件，不碰游标**。每次工作结束运行 `check.mjs --url <origin> --session <UUID> --heartbeat-stop <heartbeat_id>`；可终止返回的 PID。**心跳期间仍须每约 10 秒短查询，否则页面会提示暂停。** 心跳只报告当前工作类型，不能代替查询，也不证明 AI 仍在继续。工作结束立即短查，处理期间产生的新提交。

间隔为 `progress.mjs: HEARTBEAT_INTERVAL_MS = 10_000`，租期为 `HEARTBEAT_LEASE_MS = 180_000`（3 分钟，由 heartbeat.mjs 同名导出）。租期由服务内存管理：只有身份核对成功的 `/ai/check` 能把**相同 owner_pid** 的活动心跳续到查询时刻后 3 分钟；心跳脉冲、GET、其他 owner 的短查询均不能续租。到期后服务记 `heartbeat_end reason=lease_expired`，worker 在下一脉冲周期退出，旧 ID 不会复活。`/recovery.heartbeats[]` 返回 id / owner_pid / lease_until / last_pulse_at，便于核对。

`check.mjs --heartbeat` 默认使用调用方父进程 `process.ppid` 作为 owner，回执返回 owner_pid；显式 `--owner-pid <PID>` 优先。普通 check.mjs 同样默认 process.ppid，自动给这个 owner 启动的心跳续租。若显式指定了 owner，后续短查询也传同一个 `--owner-pid`。宿主每次命令都新开临时 shell 时，应显式选择已知的稳定宿主 PID，不能假定每次 process.ppid 都相同。work.mjs 自有的心跳仍绑定 work 进程；超过 3 分钟的读取若需要续租，查询需明确用该 work PID，不能另起自动 check 循环掩盖宿主停顿。

worker 每秒检查 owner 是否存在，退出后中止正在进行的心跳请求并登记 `owner_exited`，健康本机服务下在一个 10 秒周期内退出。ready、关闭服务、实例变化、服务不可达也会结束；主动停止记 requested。Windows 强杀 worker 无法执行 finally 时，服务仍按原 30 秒间隔观察规则记 expired_observed，保留最后脉冲时间，不伪造准确退出时刻。宿主结束一条回复但进程仍存活无法靠 PID 判断，**页面仍会在超过 60 秒未收到短查询时提示暂停，持续心跳也不能压住提示**。

## 集中查代码

访谈出题阶段只用用户回答和已有上下文，不读项目代码；需核对的事实记成“待核对”列表（工作笔记，不是用户决定）。在预计最后一轮用户作答、等待提交时，集中核对并准备章节结构；每次代码读取／检索通过：

```text
node <skill>/scripts/work.mjs --url <origin> --session <UUID> --final-round -- <executable> <args...>
```

例如 Windows 用 `-- rg -n pattern <project>`、`-- powershell.exe -NoProfile -Command "Get-Content -LiteralPath '<file>'"`；macOS/Linux 用 `-- rg -n pattern <project>`、`-- cat <file>`。它不启用 shell 拼接，拥有独立心跳并在 finally 停掉，登记本次命令 `code_read_start/end`、耗时和退出码；无论成功失败都记结束。服务只允许 active、有本轮待答题、无黄叶且显式声明 final_round 时开始；提交／保存若在读取途中发生，可记结束但不可新开调查。

“最后一轮”是当前判断，不代表预定总轮数。核对发现影响决定的新疑问时，在该轮提交后问真正的新问题；不得用占位题延长读代码窗口。来不及核对或保存后出现新疑点，写成待核对／风险，不能推断为已确认，也不能保存后新开调查。宿主原生 Read/Grep 工具绕过此入口的读取无法自动计时，所以本流程必须经 work.mjs；进程强杀／断电留下未配对 start，标注中断，不编造 end。规则／模板在 offer 前预读；所有需求文字和代码入口说明，最终都须符合冻结答案，不能拿预读推断替代。

## AI 查询中断提示

`scripts/progress.mjs` 中的 `AI_CHECK_TIMEOUT_MS = 30_000` 保留，继续作为心跳失联观察和新页面宽限的兼容间隔；新增 `SHORT_QUERY_TIMEOUT_MS = 60_000` 专门用于短查询暂停判定。`/progress.ai` 和 `/recovery.ai` 都返回独立的 `last_check_at` / `seconds_since_last_check`、`last_heartbeat_at` / `seconds_since_last_heartbeat`。前一组仅 /ai/check 刷新，后一组仅心跳脉冲刷新；没有收到相应事件时为 null。`last_activity_at` 兼容字段只映射短查询，`timeout_ms` 保留 30 秒，`short_query_timeout_ms` 为 60 秒。活跃时间只在当前服务内存中，不从日志恢复、不写 tree.json、不递增 revision。

等待 AI 出题以及文档 requested/queued、已 claim 的 generating 阶段，超过 60 秒未短查就隐藏“生长中／还在想”，提示“已 N 秒没收到 AI 回应，回聊天窗口发"继续"”，高亮复制提醒；N 取短查询间隔。心跳即使仍每 10 秒到达，也只展示“AI 正在出题／查代码／写文档”的工作标签，不清除暂停。只有短查询恢复，提示才在下一次页面状态同步（通常 1 秒内）消失。等用户答题或确认保存时不弹 AI 暂停提示。

页面首次成功同步或服务实例变化后保留原 30 秒宽限；用服务器时间差，避免两端时钟偏差。服务重启清空两组时间；从未短查过时显示“等待 AI 对话连接”，仅有心跳也不冒充已连接。普通 GET、页面轮询和心跳不能刷新 last_check_at。提醒只保证已提交／保存的答案；它不能自动唤醒已结束的对话。

## 恢复原会话

提醒只有 `session_id`、`current_round`、`url` 和静态续接说明。它不包含答案、聊天、路径、revision 或 job。轮次是定位提示，最新事实以 /state 为准。

1. **恢复后的第一步先运行一次 `check.mjs --url <提醒地址> --session <提醒ID>`，再做别的事；curl GET 不算轮询。** 该脚本先读取 /state 并校验身份、revision 和 instance。端口不是身份，属于其他会话时停止写入。
2. 短查询成功后，按回执状态继续；必要时读 /recovery 定位原文件、读 /document/status 取得当前 job。重新读 /context 判断当前是待用户、黄叶、待保存还是生成文档；没有已提交答案就不得凭提醒补写。
3. 服务不可达但原 tree.json 还在：从原启动回执／既有任务上下文取回 state_file、document_file，用 `check.mjs --url <旧地址> --session <原UUID> --restart --state <原文件> --document <原HTML>`。它核对原文件身份，按原文件启动，再读 /state 核对。原端口仍被占用时停止自动恢复，不启动第二个写入进程。先核对占用者及原进程是否确已退出；确认是其他服务且原服务已退出后，可手动用 start.mjs --port 0 恢复原文件并报告新 URL。
4. 原路径缺失且无法从既有上下文定位时，只询问缺失路径；不要创建新树。文件存在不代表用户同意迁移 v1，旧记录只能回看或用旧版继续。
5. 重启后，已提交答案、轮次和 revision 来自原 tree.json。未提交页面草稿仍不持久化。旧的 transient offer/job 可能消失：active 且已问清可重新 offer；complete 且最终 HTML 来源校验通过会恢复 ready，否则失败状态由用户点重试，再用新 job 从同一冻结答案继续，不重新答题。不要假装旧 job 仍有效或复用未核验的旧分片。

所有写入都带 expected_session_id 和 expected_revision，包括 document/control。生成状态不得包含原始流、JSON、命令输出或异常栈。用户结束预览后服务关闭，HTML 保留；不要留下额外后台副本。
