# 启动、短查询与恢复

所有脚本路径相对 SKILL.md，运行时请换成绝对路径。准备真实 v2 首轮后，用 `start.mjs --state <原文件> --session <UUID> --document <HTML路径>`。它先校验原文件，启动独立后台 Node 服务，打印启动回执后退出；不会创建或覆盖 tree.json。保留 URL、PID、原 state_file、document_file、session_id；这些是进程定位信息，不是另一份答案存储。Windows 后台窗口隐藏。

## 短查询

`check.mjs --url <origin> --session <UUID>` 是一次性命令：先 GET /state 验证身份，再读文档、进度和恢复元数据；核对 session / revision / instance 后 POST /ai/check。全部网络请求共用最多 3 秒期限。输出状态和新用户事件的元数据，不打印答案。

游标自动写入原状态文件旁的 `<tree.json>.cursor.json`（session_id / revision / sequence / instance），下次无需手写 `--after-*`。sequence 是**用户事件序号**，不是文档序号；submit、逐题复核、重新打开答案、最终保存、生成重试才产生事件。AI 发布题目、offer、claim、发布章节不算新提交。`changed` 仅代表有新用户事件；状态仍每次返回。`instance_changed` 单独报告重启。`--after-revision` / `--after-sequence` / `--after-instance` 可显式覆盖筛选／比较；回看旧事件不会重新计算发现延迟。游标和计时日志只存运行元数据，不能恢复或替代任何答案；不要把它们拷到其他访谈。

用户未点最终保存前，不得结束本轮回复；每次短查询后必须继续下一次，约每 10 秒重新调用。使用宿主短等待，不把一个 shell 命令永久挂住。无新事件不是失败；发现用户提交后读 /context，精确原文读 /state。review 等用户逐题复核；全部已答后出追问或 offer。候选捕获原修订，不能改号重交。普通 curl GET 只读取，不登记 AI 活跃，也不推进游标。

没有长期轮次总数。页面内确认开花不算提交。offer 后、用户保存前返回 `waiting_for_save`，不再 `ready_for_ai`，不产生／累加 `discovery_delay_ms`。requested 后才能 claim。服务仍保留旧 /wait 与 /document/wait 兼容接口。

## 耗时工作心跳

出题、查代码、写文档前运行 `check.mjs --url <origin> --session <UUID> --heartbeat`。命令打印 `heartbeat_id` / PID 后立即退出；独立隐藏子进程每 10 秒读取轻量 /recovery 并 POST /ai/heartbeat，核对 session / revision / instance，**不读 /state、/context、/wait，不读取或消费用户事件，不碰游标**。每次工作结束运行 `check.mjs --url <origin> --session <UUID> --heartbeat-stop <heartbeat_id>`；可终止返回的 PID。心跳不代替后续 check：工作结束立即短查，处理期间产生的新提交。

间隔为 `progress.mjs: HEARTBEAT_INTERVAL_MS = 10_000`。ready、关闭服务、实例变化、服务不可达后自动结束；可传 `--owner-pid <宿主长寿命进程PID>`，宿主进程消失后退出（不要用即将退出的临时 shell PID）。宿主“结束一条回复”没有通用操作系统通知，无法仅凭 PID 精确判断。因此后台心跳最多保活 `heartbeat.mjs: HEARTBEAT_LEASE_MS = 900_000`（15 分钟），防止遗留进程永远掩盖暂停；超长工作应显式重新启动并结束旧心跳。正常停止立即登记；Windows 强杀无法执行 finally 时，服务 30 秒后登记 `expired_observed` 和最后脉冲时间，不伪造准确退出时刻。

## 集中查代码

访谈出题阶段只用用户回答和已有上下文，不读项目代码；需核对的事实记成“待核对”列表（工作笔记，不是用户决定）。在预计最后一轮用户作答、等待提交时，集中核对并准备章节结构；每次代码读取／检索通过：

```text
node <skill>/scripts/work.mjs --url <origin> --session <UUID> --final-round -- <executable> <args...>
```

例如 Windows 用 `-- rg -n pattern <project>`、`-- powershell.exe -NoProfile -Command "Get-Content -LiteralPath '<file>'"`；macOS/Linux 用 `-- rg -n pattern <project>`、`-- cat <file>`。它不启用 shell 拼接，拥有独立心跳并在 finally 停掉，登记本次命令 `code_read_start/end`、耗时和退出码；无论成功失败都记结束。服务只允许 active、有本轮待答题、无黄叶且显式声明 final_round 时开始；提交／保存若在读取途中发生，可记结束但不可新开调查。

“最后一轮”是当前判断，不代表预定总轮数。核对发现影响决定的新疑问时，在该轮提交后问真正的新问题；不得用占位题延长读代码窗口。来不及核对或保存后出现新疑点，写成待核对／风险，不能推断为已确认，也不能保存后新开调查。宿主原生 Read/Grep 工具绕过此入口的读取无法自动计时，所以本流程必须经 work.mjs；进程强杀／断电留下未配对 start，标注中断，不编造 end。规则／模板在 offer 前预读；所有需求文字和代码入口说明，最终都须符合冻结答案，不能拿预读推断替代。

## AI 查询中断提示

常量 `scripts/progress.mjs` 的 `AI_CHECK_TIMEOUT_MS = 30_000` 控制提示阈值。`/progress.ai` 返回 `last_activity_at`（Unix 毫秒）、兼容别名 `last_check_at`、`source`、`seconds_since_last_check` 和 `timeout_ms`；从未收到 check／心跳时活跃时间和间隔为 null。活跃状态只在当前服务内存中，不写 tree.json、不递增 revision。普通 /state、/progress 和网页轮询不算 AI 查询，避免页面替已经停止的助手续命；手动读 /state 也不能替代 check.mjs。

只在等待 AI 出题或等待 AI 接手文档的 queued 阶段，超过 30 秒没有 check 或心跳时隐藏“生长中／还在想”，提示“已 N 秒没收到 AI 回应，回聊天窗口发\"继续\"”，并高亮复制提醒；恢复后在下一次页面状态同步（通常 1 秒内）自动消失。等待用户答题、保存确认以及已 claim 的文档生成不套用此提示。它根据查询间隔提醒续接，不声称能读取模型的内部运行状态。

页面首次成功同步或检测到服务实例变化后有同样的 30 秒宽限，防止刚打开页面就被旧时间戳误报；使用服务器报告的时间差，避免两端时钟偏差。服务重启清空查询记录；从未来查过时始终显示“等待 AI 对话连接”，不显示暂停。即使宿主仍提前收尾，页面也会提示用户回聊天续接；不会自动唤醒已结束的 AI 对话。提醒只保证已提交／保存的答案，本地未提交草稿仍遵循原规则。

## 恢复原会话

提醒只有 `session_id`、`current_round`、`url` 和静态续接说明。它不包含答案、聊天、路径、revision 或 job。轮次是定位提示，最新事实以 /state 为准。

1. **恢复后的第一步先运行一次 `check.mjs --url <提醒地址> --session <提醒ID>`，再做别的事；curl GET 不算轮询。** 该脚本先读取 /state 并校验身份、revision 和 instance。端口不是身份，属于其他会话时停止写入。
2. 短查询成功后，按回执状态继续；必要时读 /recovery 定位原文件、读 /document/status 取得当前 job。重新读 /context 判断当前是待用户、黄叶、待保存还是生成文档；没有已提交答案就不得凭提醒补写。
3. 服务不可达但原 tree.json 还在：从原启动回执／既有任务上下文取回 state_file、document_file，用 `check.mjs --url <旧地址> --session <原UUID> --restart --state <原文件> --document <原HTML>`。它核对原文件身份，按原文件启动，再读 /state 核对。原端口仍被占用时停止自动恢复，不启动第二个写入进程。先核对占用者及原进程是否确已退出；确认是其他服务且原服务已退出后，可手动用 start.mjs --port 0 恢复原文件并报告新 URL。
4. 原路径缺失且无法从既有上下文定位时，只询问缺失路径；不要创建新树。文件存在不代表用户同意迁移 v1，旧记录只能回看或用旧版继续。
5. 重启后，已提交答案、轮次和 revision 来自原 tree.json。未提交页面草稿仍不持久化。旧的 transient offer/job 可能消失：active 且已问清可重新 offer；complete 且最终 HTML 来源校验通过会恢复 ready，否则失败状态由用户点重试，再用新 job 从同一冻结答案继续，不重新答题。不要假装旧 job 仍有效或复用未核验的旧分片。

所有写入都带 expected_session_id 和 expected_revision，包括 document/control。生成状态不得包含原始流、JSON、命令输出或异常栈。用户结束预览后服务关闭，HTML 保留；不要留下额外后台副本。
