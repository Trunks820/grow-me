# Windows / PowerShell

把占位符换成已知的绝对路径、原 session 和启动回执地址；不把答案或提醒文本拼成 shell 代码。JSON 用 UTF-8 文件与 `--data-binary @file` 提交，避免引号和换行损坏。

```powershell
node "<skill>/scripts/start.mjs" --state "<workspace>/tree.json" --session "<UUID>" --document "<workspace>/task.html"
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>"
curl.exe --silent --show-error --fail-with-body --max-time 3 "http://127.0.0.1:<port>/state"
curl.exe --silent --show-error --fail-with-body --max-time 3 "http://127.0.0.1:<port>/context"
curl.exe --silent --show-error --fail-with-body --max-time 3 -H "Content-Type: application/json" --data-binary "@<workspace>/request.json" "http://127.0.0.1:<port>/round"
node "<skill>/scripts/validate-task.mjs" "<workspace>/task.html"
node "<skill>/scripts/read-task.mjs" "<workspace>/task.html"
```

`request.json` 带已核对的 `expected_session_id` 和候选读取时的 `expected_revision`。用 `curl.exe`，不使用 PowerShell 的 curl 别名。

`start.mjs` 退出后，立即在下一条命令中用回执里的 URL 和原 session 短查。若返回 `service_closed`，按宿主清理了启动进程处理。用宿主后台任务直接运行下面的命令。Antigravity 用 `run_command`、`WaitMsBeforeAsync = 1000`，从 `/tasks` 读取输出。Claude Code 用 PowerShell 工具的 `run_in_background = true`。

```powershell
Set-Location -LiteralPath "<workspace>"
node "<skill>/scripts/server.mjs" --state "<workspace>/tree.json" --document "<workspace>/task.html" --port 0
```

保持后台任务运行，用新回执里的 URL 和原 session 再短查。成功后才把该地址给用户。

**A. 宿主后台命令结束能唤回 AI**：发布一轮或 offer 后，用宿主后台运行 `node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --wait`，然后结束本条回复。空闲到期自动续等，收到用户事件才正常返回。

**B. 做不到**：在本条回复内，每约 10 秒重复上面的普通 `check.mjs`，直到收到用户事件。

服务退出后的命令（仍用原文件）：

```powershell
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<old-port>" --session "<UUID>" --restart --state "<workspace>/tree.json" --document "<workspace>/task.html"
```

耗时工作前后（两条命令分别执行，不同时执行）：

```text
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --heartbeat
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --heartbeat-stop "<回执heartbeat_id>"
```

短查和等待共用游标，恢复后先短查。`curl.exe` GET 只读取。预计连续超过 3 分钟没有[续租动作](runtime.md#工作租约与心跳)时再开心跳。心跳自动寻找 AI 工具进程，找不到就传 `--owner-pid <AI 工具 PID>`。续心跳租期时，短查或等待传回执中的 PID。

开访谈前先摸项目现状；中间出题不读代码；预计末轮先趁用户作答经 `work.mjs --final-round` 集中核对，再按 A/B 取回执。
