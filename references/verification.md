# 验证与计时

运行 npm test 保留已有场景；再运行 tests/browser_acceptance.py、tests/bud_note_browser.py、tests/wait_flow_browser.py、tests/seeded_growth.py 和 tests/choices_browser.py。开发依赖见 requirements-dev.txt。运行命令的 Windows 用 python，macOS/Linux 用 python3。

`tests/bud_note_browser.py` 验证可见花苞引导、顶部题干与指向花心的气泡、确认后原地开花、只读回看与明确修改、整轮提交及上游修改后的复核；覆盖桌面、紧凑桌面和手机视口。另核对原生 `cameraFrame()`、手动缩放与看全树，防止答题界面再次覆盖树的取景。

新协议测试覆盖：v2 多选至少一项、显式互斥“都不需要”、单选仍恰好一项、文本不带选项；重复／未知 ID／互斥混选拒绝且不落盘；初始与追问理由必填；推荐不预选、有理由和可核对来源、来源变化隐藏；所有原文保留。v1 只读回看与旧文档来源不变，不能自动补字段。

恢复覆盖：等待用户、已提交、黄叶、offered、requested/generating、ready；断线与真实终止进程分开测。重启使用同一原文件，核对 session/revision/原答案，当前 job 与旧 job 不混用。提醒只包含三个定位字段。错误地址不能改变别的访谈。短查询无变化时快速返回；记录实例变化。

AI 查询中断回归：`tests/wait_flow_browser.py` 包含 `ai_presence_browser.py`，实际运行后台心跳并在 check.mjs 后停查超过 60 秒，验证出题等待、文档 queued 和已 claim 写作阶段仍提示暂停；N 是短查询秒数，不是心跳秒数。只有恢复短查询才消失，原等待计时不重置。覆盖从未短查但有心跳、页面初开宽限、同端口重启、桌面／390px、工作类型标签。Node 测试验证两个时间互不刷新、默认父 PID／显式 owner、只有匹配 owner 的 check 续租、真实宿主退出一个周期内停止。租期集成测试用隔离服务的受控时钟推进 3 分钟，运行真实 worker 与服务，不缩短生产常量，并核对 lease_expired 日志；另有边界单测。此测试不代表模型性能测量。

至少一个非 Codex 助手独立读同一 SKILL，从首轮到保存文档，实际生成追问，处理上游修改与黄叶，通过复制提醒恢复，并覆盖服务退出。实际用户提交或以前明确确认的原话回放均须标来源；缺失答案不能编造。Codex 不暗中写题或代写该助手的文档。CLI 存在、测试夹具、语法检查都不算真跑。

## 实际等待

| 指标 | 起点 → 终点 |
| --- | --- |
| 发现提交延迟 | 服务成功提交的时间 → 助手第一次正确读取这一修订 |
| 每轮端到端 | 同一次提交 → 下一轮首题实际可操作 |
| 黄叶后等待 | 最后一片黄叶确认 → 下一轮可操作，单列 |
| 首章可读 | 用户保存 → 第一个果子确实能打开已完成章节 |
| 全文完成 | 同一次保存 → 三视图全文完成且校验成功 |

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
- `pause_shown/pause_cleared`：页面实际展示／收起提示，含 page_id；没有打开页面就没有此事件。`ai_resumed` 仅表示 check 在超过 60 秒后恢复；心跳不能触发 AI 恢复事件，含 source 和 silence_ms。
- `code_read_start/end`：work.mjs 包裹的每次命令，按 operation_id 配对；含 elapsed_ms、exit_code。宿主绕过入口的读取不可观测，未配对项标为中断。
- `submission_discovered`：首次发现用户提交的 discovery_delay_ms；重复检查、AI 发布、waiting_for_save 不累加。与提交到新题的总等待分别报告，避免把轮询发现延迟算成模型生成耗时。
- `chapter_first_published`：每章首次发布，含 job_id、chapter_id、first_published_at、elapsed_ms。既有 `<document>.chapter-timings.jsonl` 与 `/document/status.chapters[].first_published_at` 保留；重新发布不重置。

Windows 查看：`Get-Content -LiteralPath '<tree.json>.runtime-timings.jsonl' | ConvertFrom-Json | Format-Table at_iso,event,sequence,chapter_id,elapsed_ms`。macOS/Linux 可逐行 `cat` 该文件，或用 Python 读取筛选 event。计时文件不能当成用户答案数据源。

新增回归覆盖：symlink/junction CLI 输出、游标连续调用和实例恢复、仅用户事件、waiting_for_save、心跳不消费提交、持续心跳不遮蔽暂停、短查询恢复页面、冻结树原话转义／多选与章节归属、代码读取起止。受控测试不证明 Claude Code 实际变快；真实跨助手用时仍由用户复测。
