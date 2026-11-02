# 验证与计时

运行 npm test 保留已有场景；再运行 tests/browser_acceptance.py、tests/wait_flow_browser.py、tests/seeded_growth.py 和 tests/choices_browser.py。开发依赖见 requirements-dev.txt。运行命令的 Windows 用 python，macOS/Linux 用 python3。

新协议测试覆盖：v2 多选至少一项、显式互斥“都不需要”、单选仍恰好一项、文本不带选项；重复／未知 ID／互斥混选拒绝且不落盘；初始与追问理由必填；推荐不预选、有理由和可核对来源、来源变化隐藏；所有原文保留。v1 只读回看与旧文档来源不变，不能自动补字段。

恢复覆盖：等待用户、已提交、黄叶、offered、requested/generating、ready；断线与真实终止进程分开测。重启使用同一原文件，核对 session/revision/原答案，当前 job 与旧 job 不混用。提醒只包含三个定位字段。错误地址不能改变别的访谈。短查询无变化时快速返回；记录实例变化。

AI 查询中断回归：`tests/wait_flow_browser.py` 包含 `ai_presence_browser.py`，实际调用 check.mjs 后停查超过 30 秒，验证出题等待与文档 queued 都提示暂停并高亮复制提醒；恢复查询后提示消失，原等待计时不重置。覆盖从未来查、页面首次打开宽限、同端口重启恢复、桌面／390px 和已 claim 阶段不误报。Node 测试核对阈值、内存记录、普通 GET 不续命、身份／revision／instance 冲突不登记、tree.json 字节不变。此等待测试证明提示机制，不是模型性能测量。

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
