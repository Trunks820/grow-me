# 验证与计时

运行 npm test 保留已有场景；再运行 tests/browser_acceptance.py、tests/bud_note_browser.py、tests/wait_flow_browser.py、tests/seeded_growth.py 和 tests/choices_browser.py。开发依赖见 requirements-dev.txt。运行命令的 Windows 用 python，macOS/Linux 用 python3。

`tests/bud_note_browser.py` 验证可见花苞引导、顶部题干与指向花心的气泡、确认后原地开花、只读回看与明确修改、整轮提交及上游修改后的复核；覆盖桌面、紧凑桌面和手机视口。另核对原生 `cameraFrame()`、手动缩放与看全树，防止答题界面再次覆盖树的取景。

`tests/deferred_browser.py --work <目录>` 验证待定草稿、暂停符号、整轮提交和刷新回看。`npm test` 验证待定进入三视图的“待确认”，以及 v0.2 样例从未完访谈继续到生成文档。

`tests/request_plan_browser.py --work <目录>` 验证半轮和全答后的确认、取消保留草稿，以及确认后待定与保存。`npm test` 验证短查和等待都返回 `request_plan`，恢复后继续收尾。

新协议测试覆盖：v2 多选至少一项、显式互斥“都不需要”、单选仍恰好一项、文本不带选项；重复／未知 ID／互斥混选拒绝且不落盘；初始与追问理由必填；推荐不预选、有理由和可核对来源、来源变化隐藏；所有原文保留。v1 只读回看与旧文档来源不变，不能自动补字段。

恢复覆盖：等待用户、已提交、黄叶、offered、requested/generating、ready；断线与真实终止进程分开测。重启使用同一原文件，核对 session/revision/原答案，当前 job 与旧 job 不混用。提醒只包含三个定位字段。错误地址不能改变别的访谈。短查询无变化时快速返回；记录实例变化。

`tests/ai_presence_browser.py --work <目录>` 使用受控服务时钟，验证首次短查前靠启动租约在线、发现提交后 90 秒无短查和心跳仍在线，以及写作靠逐章发布持续在线。心跳停止且工作租约过期后，检查暂停提示和短查秒数。恢复短查后提示消失，等待计时继续。覆盖 30 秒页面宽限、同端口重启、桌面与 390px 视口及工作类型标签。`tests/wait_flow_browser.py` 也运行此用例。

`npm test` 验证服务启动即开工作租约、重启按新实例启动时间计租、只读 v1 和已 ready 会话跳过启动租约，以及续期、过期和失败请求。受控服务时钟沿用生产常量。独立核对短查和心跳时钟、匹配 owner 的短查续心跳租期，以及真实 worker 退出时的日志原因。

Job 回归先用 WMI 启动一个立即退出的 Node 进程探测能力。非 Windows 或探测未取得 PID 时跳过并打印诊断。探测成功后，关闭带 `KILL_ON_JOB_CLOSE` 的命令，核对对照进程已退出、服务仍能短查、心跳继续报到且 owner 指向宿主。分片回归核对 `--parts` 有 JSON 旁文件时能指出文件名和不符字段。

至少一个非 Codex 助手独立读同一 SKILL，从首轮到保存文档，实际生成追问，处理上游修改与黄叶，通过复制提醒恢复，并覆盖服务退出。实际用户提交或以前明确确认的原话回放均须标来源；缺失答案不能编造。Codex 不暗中写题或代写该助手的文档。CLI 存在、测试夹具、语法检查都不算真跑。

## 模拟用户

让被测 AI 按正常流程启动一场新的 v2 访谈、出题和写方案。另开终端运行模拟用户。首次使用可通过 `python -m pip install -r requirements-dev.txt` 和 `python -m playwright install chromium` 准备浏览器测试环境。模拟用户只通过网页点击和填写，并观察网页自己收到的状态回执。被测 AI 可以使用任意工具。

```text
python tests/sim_user.py --url <网页地址> --answers <answers.json> --report <report.json> --state <tree.json> --timeout 1800
python tests/sim_user_browser.py --work <离线自测输出目录>
```

为预期题目准备 UTF-8 JSON，`rounds` 从第一轮起按顺序排列。例如第一轮有渠道选择和日期两题，第二轮答完第一题就出方案：

```json
{
  "rounds": [
    {
      "reload_after": 1,
      "answers": [
        { "keyword": "渠道", "options": ["邮件", 2], "text": "附上报名入口。\n保留这一行。" },
        { "deferred": true, "text": "等场地回复。" }
      ]
    },
    {
      "enough_after": 1,
      "answers": [{ "text": "先验收报名入口。" }]
    }
  ]
}
```

- `keyword` 按题干子串匹配，须唯一命中。先分配关键词答案，其余预设依次分配给剩余题目。选项用页面上的完整标签或从 1 开始的序号。多选可给多项。选择题的 `text` 填入补充说明，文本题填入正文。
- `reload_after` 在确认指定数量的本轮草稿后刷新，核对草稿标记并继续答题。省略 `enough_after` 时答完本轮再提交。填写该字段时，答完指定数量后点击「够了，先出方案」并在气泡选「先出方案」。填 0 可直接请求方案，其余题由网页提交为待定。严格模式下题目与预设不符时，按报告中的轮次和题序调整预设。
- 省略 `--state` 时从 `/recovery` 取 `state_file`。模拟用户只读配套的 `<tree.json>.runtime-timings.jsonl`，按本轮提交事件的 sequence 取 AI 首次发现的延迟。取不到路径、日志或首次发现事件时记「未测」。
- 章节逐章发布以全文就绪前看到成熟果子一次增加一个、并收到对应的首次发布时间为通过依据。轮询漏掉中间状态或缺少预览时记「未测」。
- 「AI 工作期间在线」（`ai_work_online`）使用提交后和写文档期间的 `/progress` 样本。心跳或工作租约任一有效即在线。否则依次取短查、心跳、工作动作的首个非空静默秒数，换算为毫秒后不超过 `short_query_timeout_ms` 也算在线，其余计入 `offline_samples`。30 秒宽限仅用于页面提示。缺少样本的阶段记「未测」。出题期间按页面显示转换计数暂停提示，用同一在线规则确认误报，缺少同一时段样本的提示待判定。
- 现有运行日志没有 AI 等待命令提前返回的记录，真实访谈报告将「等待上限白叫醒」标为「未测」。离线自测用脚本扮演 AI，直接检查 `check.mjs --wait` 跨过多个服务端等待上限后仍挂起，收到用户事件才返回。
- JSON 写入 `--report`，终端输出中文摘要。访谈的 `--timeout` 默认 1800 秒，从启动浏览器开始计算。超时保留已有报告并退出 2，操作或已测校验失败时退出 1。完成且无已测失败时退出 0，仍需逐项查看「未测」。

### 驱动别的 AI 实测

把本次访谈单独放在一个目录。先运行模拟用户，再给被测 AI 发送下面的任务书，替换尖括号里的值。

```text
这是一次非交互运行。读取 <SKILL.md 绝对路径>，就「<访谈主题>」在 <本次访谈目录> 新建 v2 访谈并启动服务。
网页由用户自己打开操作。请在同一条回复的工具调用中持续等待用户答题、读取提交、出后续题并等待保存。
收到用户的保存回执后，在这条回复中写完方案，逐章发布并校验完整任务文档可读后再结束回复。
```

```text
python tests/sim_user.py --auto --find <本次访谈目录> --find-timeout 300 --timeout 1800 --report <report.json>
```

- `--find` 递归扫描 `.grow-me-server-*.log`，按修改时间从新到旧检查，取 `/state` 可达且 session 与回执一致的地址。找不到时等到 `--find-timeout`，默认 1800 秒。服务没写日志时，用 `--url <网页地址>` 替代 `--find <目录>`。
- `--auto` 按网页当前推荐选答案，缺有效推荐时取第一项非互斥选项。只有一项时选该项，单选始终只取一项。文本题用预设文字或默认话，选择题的预设文字仍填到补充说明。用 `--answers <answers.json>` 提供文字或指定待定、刷新和出方案时机。关键词仍须唯一匹配。剩余题重复最后一条顺序预设，多余顺序预设忽略。缺少顺序预设或轮次预设时直接按题型答。

## 实际等待

| 指标         | 起点 → 终点                                     |
| ------------ | ----------------------------------------------- |
| 发现提交延迟 | 服务成功提交的时间 → 助手第一次正确读取这一修订 |
| 每轮端到端   | 同一次提交 → 下一轮首题实际可操作               |
| 黄叶后等待   | 最后一片黄叶确认 → 下一轮可操作，单列           |
| 首章可读     | 用户保存 → 第一个果子确实能打开已完成章节       |
| 全文完成     | 同一次保存 → 三视图全文完成且校验成功           |

check.mjs 的 timing 来源于服务进程内的 last_submission；只保留新提交后的第一次观察作为发现延迟，重复查询的更大数值不能冒充首次。服务重启会失去这份暂存时间，记 unavailable；从持久树的 revision 猜不出提交时间。

10 秒理想轮询平均约多等 5 秒、最多一个周期；宿主调度可能更久，实际都算进端到端，不从与 73 秒／168 秒／约 420 秒基准比较中扣除。记录助手／模型、系统、题数、轮数、章节数、原文来源与实际时戳。首章没有独立旧基线。不同模型或规模只报告，不强称可比提速。受控时钟 168/420 秒与组装耗时不能算真实模型速度。功能、真实闭环、可比提速和用户验收分别判定。

## 逐章发布时间

实际 `--preview --url` 发布成功后，查看命令 JSON 的 `chapter_timings`，或读取 `/document/status` 的 `chapters[].first_published_at`（Unix 毫秒；未发布为 null）。时间由服务在来源与章节校验通过时记录，不是写完分片或启动组装的时间；网页实际可点击仍需另记。

持久日志固定为 `<document_file>.chapter-timings.jsonl`，路径也返回在 `chapter_timing_file`；例如 `outputs/task.html.chapter-timings.jsonl`。每行包含 `session_id`、`revision`、`digest`、`job_id`、`chapter_id`、`first_published_at`、UTC 的 `first_published_at_iso`、`generation_started_at` 和 `elapsed_ms`。不记录答案原文。关闭或重启服务后仍可读此日志；它只是计时证据，不是第二份访谈数据。

同一 job 重复发布不改首次时间、不重复追加；失败请求不记成功事件。重试换 job 后另记，历史保留。`elapsed_ms` 从本次保存或重试任务开始算起，不能把重试后的时间冒充用户首次保存起的总等待；按 session/revision/digest/job 分组查看，不删慢尝试。直接 ready 或没有 `--url` 的本地预览不能冒充逐章发布，缺事件须如实记未测。

Windows PowerShell 查看（替换实际路径）：

```powershell
Get-Content -LiteralPath 'outputs/task.html.chapter-timings.jsonl' | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object job_id,chapter_id,first_published_at_iso,elapsed_ms
```

macOS/Linux：

```sh
cat outputs/task.html.chapter-timings.jsonl
```

检查每章写完后立即 preview，再写下一章；旧章节加一章不警告，一次新发布两章以上必须看到警告但命令成功。检查旧 v2 无 chapter_id 仍能组装，显式字段被直接采用，树形不变。预读只涉及规则／模板，内容与代码入口须核对保存后的冻结答案。自动化只验证这些流程与记录机制，实际提速由用户的 Claude Code 真实运行判定。

## 运行计时日志与自动游标

`/recovery.timing_file` 指向 `<tree.json>.runtime-timings.jsonl`；只保存事件元数据，不保存答案。每行有 event、Unix 毫秒 at、ISO at_iso、session_id、instance_id，以及相关 revision。`user_event` 有独立 sequence；check.mjs 把处理到的 revision/sequence/instance 写入 `<tree.json>.cursor.json`。AI 活跃状态仍只在内存，重启不从日志恢复“在线”。

- `heartbeat_start/end`：后台工作起止；end 的 reason 区分 requested、session_closed、owner_exited、lease_expired 和 expired_observed，含 owner_pid 与 lease_until。强杀后仅能知道 last_pulse_at，不能据此编造实际退出时刻。
- `pause_shown/pause_cleared`：页面实际展示／收起提示，含 page_id。`ai_resumed` 记录间隔超过 60 秒后的短查，含 source 和 silence_ms。
- `code_read_start/end`：work.mjs 包裹的每次命令，按 operation_id 配对；含 elapsed_ms、exit_code。宿主绕过入口的读取不可观测，未配对项标为中断。
- `submission_discovered`：首次发现用户提交的 discovery_delay_ms；重复检查、AI 发布、waiting_for_save 不累加。与提交到新题的总等待分别报告，避免把轮询发现延迟算成模型生成耗时。
- `chapter_first_published`：每章首次发布，含 job_id、chapter_id、first_published_at、elapsed_ms。既有 `<document>.chapter-timings.jsonl` 与 `/document/status.chapters[].first_published_at` 保留；重新发布不重置。

Windows 查看：`Get-Content -LiteralPath '<tree.json>.runtime-timings.jsonl' | ConvertFrom-Json | Format-Table at_iso,event,sequence,chapter_id,elapsed_ms`。macOS/Linux 可逐行 `cat` 该文件，或用 Python 读取筛选 event。计时文件不能当成用户答案数据源。

回归覆盖 symlink/junction CLI 输出、游标与实例恢复、仅用户事件、waiting_for_save、在线及暂停判定、冻结树原话转义／多选与章节归属、代码读取起止。真实跨助手用时按实际访谈记录。
