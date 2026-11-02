# Windows / PowerShell

把占位符换成已知的绝对路径、原 session 和启动回执地址；不把答案或提醒文本拼成 shell 代码。JSON 用 UTF-8 文件与 `--data-binary @file` 提交，避免引号和换行损坏。

```powershell
node "<skill>/scripts/start.mjs" --state "<workspace>/tree.json" --session "<UUID>" --document "<workspace>/task.html"
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>"
curl.exe --silent --show-error --fail-with-body --max-time 3 "http://127.0.0.1:<port>/state"
curl.exe --silent --show-error --fail-with-body --max-time 3 "http://127.0.0.1:<port>/context"
curl.exe --silent --show-error --fail-with-body --max-time 3 -H "Content-Type: application/json" --data-binary "@<workspace>/request.json" "http://127.0.0.1:<port>/round"
python "<skill>/scripts/validate_task.py" "<workspace>/task.html"
python "<skill>/scripts/read_task.py" "<workspace>/task.html"
```

`request.json` 必须带已核对的 expected_session_id 和生成候选时的 expected_revision。3 秒网络超时是连接问题，不是用户作答。查询命令退出后，约 10 秒再短查；不使用 PowerShell 的 curl 别名替代 curl.exe。

服务退出后的命令（仍用原文件）：

```powershell
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<old-port>" --session "<UUID>" --restart --state "<workspace>/tree.json" --document "<workspace>/task.html"
```

耗时工作前后（两条命令分别执行，不同时执行）：

```text
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --heartbeat
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --heartbeat-stop "<回执heartbeat_id>"
```

短查询自动管理游标；不再手写 --after-*。恢复后第一步先 check.mjs；curl GET 仅用于读取内容，不是活跃查询。查代码只在最后一轮等待用户提交的窗口，经 runtime.md 的 work.mjs 入口记录每次起止。
