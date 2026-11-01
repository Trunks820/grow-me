# 启动、短查询与恢复

所有脚本路径相对 SKILL.md，运行时请换成绝对路径。准备真实 v2 首轮后，用 `start.mjs --state <原文件> --session <UUID> --document <HTML路径>`。它先校验原文件，启动独立后台 Node 服务，打印启动回执后退出；不会创建或覆盖 tree.json。保留 URL、PID、原 state_file、document_file、session_id；这些是进程定位信息，不是另一份答案存储。Windows 后台窗口隐藏。

## 短查询

`check.mjs --url <origin> --session <UUID>` 是一次性命令。先 GET /state 验证身份，随后读取文档、进度与恢复元数据，所有网络请求共用最多 3 秒期限。输出仅有修订、轮次、文档阶段与计时，不打印答案。下一次带上前次的 `--after-revision R --after-sequence S --after-instance ID`，识别无变更和服务重启；无需缓存另一份决定文件。

保持当前任务活跃，约每 10 秒重新调用一次；使用宿主短等待，不把一个 shell 命令永久挂住。无变更不是失败；状态变化时读 /context，必要时读 /state 获取精确原文。发现 review 就等用户逐条复核；所有已答时生成追问或 offer。候选读取时捕获修订，提交时不可替换成更晚修订。

没有长期轮次总数。用户本地确认开花不算提交。进入 offered 后继续短查询；保存后 requested 才能 claim。文档阶段、原文使用和重试细节见 progressive-writer.md。服务仍保留旧 /wait 与 /document/wait 兼容接口，新流程不依赖它们。

## 恢复原会话

提醒只有 `session_id`、`current_round`、`url` 和静态续接说明。它不包含答案、聊天、路径、revision 或 job。轮次是定位提示，最新事实以 /state 为准。

1. 使用提醒中的 URL 读 /state，确认 session_id；取得当前 revision。端口不是身份，若属于其他会话，停止向该地址写入。
2. 身份一致后，读 /recovery 确认原路径、服务实例和 revision，再读 /document/status。重新读 /context 判断当前是待用户、黄叶、待保存还是生成文档；没有已提交答案就不得凭提醒补写。
3. 服务不可达但原 tree.json 还在：从原启动回执／既有任务上下文取回 state_file、document_file，用 `check.mjs --url <旧地址> --session <原UUID> --restart --state <原文件> --document <原HTML>`。它核对原文件身份，按原文件启动，再读 /state 核对。原端口仍被占用时停止自动恢复，不启动第二个写入进程。先核对占用者及原进程是否确已退出；确认是其他服务且原服务已退出后，可手动用 start.mjs --port 0 恢复原文件并报告新 URL。
4. 原路径缺失且无法从既有上下文定位时，只询问缺失路径；不要创建新树。文件存在不代表用户同意迁移 v1，旧记录只能回看或用旧版继续。
5. 重启后，已提交答案、轮次和 revision 来自原 tree.json。未提交页面草稿仍不持久化。旧的 transient offer/job 可能消失：active 且已问清可重新 offer；complete 且最终 HTML 来源校验通过会恢复 ready，否则失败状态由用户点重试，再用新 job 从同一冻结答案继续，不重新答题。不要假装旧 job 仍有效或复用未核验的旧分片。

所有写入都带 expected_session_id 和 expected_revision，包括 document/control。生成状态不得包含原始流、JSON、命令输出或异常栈。用户结束预览后服务关闭，HTML 保留；不要留下额外后台副本。
