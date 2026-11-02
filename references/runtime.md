# 启动、短查询与恢复

所有脚本路径相对 SKILL.md，运行时请换成绝对路径。准备真实 v2 首轮后，用 `start.mjs --state <原文件> --session <UUID> --document <HTML路径>`。它先校验原文件，启动独立后台 Node 服务，打印启动回执后退出；不会创建或覆盖 tree.json。保留 URL、PID、原 state_file、document_file、session_id；这些是进程定位信息，不是另一份答案存储。Windows 后台窗口隐藏。

## 短查询

`check.mjs --url <origin> --session <UUID>` 是一次性命令。先 GET /state 验证身份，随后读取文档、进度与恢复元数据；核对 session、revision、instance 一致后 POST /ai/check，登记最近一次 AI 查询。所有网络请求共用最多 3 秒期限。输出仅有修订、轮次、文档阶段与计时，不打印答案。下一次带上前次的 `--after-revision R --after-sequence S --after-instance ID`，识别无变更和服务重启；无需缓存另一份决定文件。

用户未点最终保存前，不得结束本轮回复；每次短查询后必须继续下一次，约每 10 秒重新调用。使用宿主短等待，不把一个 shell 命令永久挂住。无变更不是失败；状态变化时读 /context，必要时读 /state 获取精确原文。发现 review 就等用户逐条复核；所有已答时生成追问或 offer。候选读取时捕获修订，提交时不可替换成更晚修订。

没有长期轮次总数。用户本地确认开花不算提交。进入 offered 后继续短查询；保存后 requested 才能 claim。文档阶段、原文使用和重试细节见 progressive-writer.md。服务仍保留旧 /wait 与 /document/wait 兼容接口，新流程不依赖它们。

## AI 查询中断提示

常量 `scripts/progress.mjs` 的 `AI_CHECK_TIMEOUT_MS = 30_000` 控制提示阈值。`/progress.ai` 返回 `last_check_at`（Unix 毫秒）、`seconds_since_last_check` 和 `timeout_ms`；从未收到查询时前两项为 null。记录只在当前服务内存中，不写 tree.json、不递增 revision。普通 /state、/progress 和网页轮询不算 AI 查询，避免页面替已经停止的助手续命；手动读 /state 也不能替代 check.mjs。

只在等待 AI 出题或等待 AI 接手文档的 queued 阶段，超过 30 秒没有查询时提示“AI 对话好像已暂停”，说明发“继续”或复制提醒，并高亮按钮；查询恢复后自动回到正常等待。等待用户答题、保存确认以及已 claim 的文档生成不套用此提示。它根据查询间隔提醒续接，不声称能读取模型的内部运行状态。

页面首次成功同步或检测到服务实例变化后有同样的 30 秒宽限，防止刚打开页面就被旧时间戳误报；使用服务器报告的时间差，避免两端时钟偏差。服务重启清空查询记录；从未来查过时始终显示“等待 AI 对话连接”，不显示暂停。即使宿主仍提前收尾，页面也会提示用户回聊天续接；不会自动唤醒已结束的 AI 对话。提醒只保证已提交／保存的答案，本地未提交草稿仍遵循原规则。

## 恢复原会话

提醒只有 `session_id`、`current_round`、`url` 和静态续接说明。它不包含答案、聊天、路径、revision 或 job。轮次是定位提示，最新事实以 /state 为准。

1. 使用提醒中的 URL 读 /state，确认 session_id；取得当前 revision。端口不是身份，若属于其他会话，停止向该地址写入。
2. 身份一致后，读 /recovery 确认原路径、服务实例和 revision，再读 /document/status。重新读 /context 判断当前是待用户、黄叶、待保存还是生成文档；没有已提交答案就不得凭提醒补写。
3. 服务不可达但原 tree.json 还在：从原启动回执／既有任务上下文取回 state_file、document_file，用 `check.mjs --url <旧地址> --session <原UUID> --restart --state <原文件> --document <原HTML>`。它核对原文件身份，按原文件启动，再读 /state 核对。原端口仍被占用时停止自动恢复，不启动第二个写入进程。先核对占用者及原进程是否确已退出；确认是其他服务且原服务已退出后，可手动用 start.mjs --port 0 恢复原文件并报告新 URL。
4. 原路径缺失且无法从既有上下文定位时，只询问缺失路径；不要创建新树。文件存在不代表用户同意迁移 v1，旧记录只能回看或用旧版继续。
5. 重启后，已提交答案、轮次和 revision 来自原 tree.json。未提交页面草稿仍不持久化。旧的 transient offer/job 可能消失：active 且已问清可重新 offer；complete 且最终 HTML 来源校验通过会恢复 ready，否则失败状态由用户点重试，再用新 job 从同一冻结答案继续，不重新答题。不要假装旧 job 仍有效或复用未核验的旧分片。

所有写入都带 expected_session_id 和 expected_revision，包括 document/control。生成状态不得包含原始流、JSON、命令输出或异常栈。用户结束预览后服务关闭，HTML 保留；不要留下额外后台副本。
