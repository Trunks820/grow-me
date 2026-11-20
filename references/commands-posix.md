# macOS / Linux

把占位符换成已知的绝对路径、原 session 和启动回执地址；不把答案或提醒拼成 shell 代码。写入 JSON 使用 UTF-8 文件，保留原文。

```sh
node "<skill>/scripts/start.mjs" --state "<workspace>/tree.json" --session "<UUID>" --document "<workspace>/task.html"
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>"
curl --silent --show-error --fail-with-body --max-time 3 "http://127.0.0.1:<port>/state"
curl --silent --show-error --fail-with-body --max-time 3 "http://127.0.0.1:<port>/context"
curl --silent --show-error --fail-with-body --max-time 3 -H 'Content-Type: application/json' --data-binary "@<workspace>/request.json" "http://127.0.0.1:<port>/round"
python3 "<skill>/scripts/validate_task.py" "<workspace>/task.html"
python3 "<skill>/scripts/read_task.py" "<workspace>/task.html"
```

请求带已核对的 `expected_session_id` 和候选读取时的 `expected_revision`。

**A. 宿主后台命令结束能唤回 AI**：发布一轮或 offer 后，用宿主后台运行 `node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --wait`，然后结束本条回复。空闲到期自动续等，收到用户事件才正常返回。

**B. 做不到**：在本条回复内，每约 10 秒重复上面的普通 `check.mjs`，直到收到用户事件。

服务退出后：

```sh
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<old-port>" --session "<UUID>" --restart --state "<workspace>/tree.json" --document "<workspace>/task.html"
```

macOS 和 Linux 共享命令写法，但只在实际运行过的系统记 passed，Linux 结果不代表 macOS。

耗时工作前后（两条命令分别执行，不同时执行）：

```text
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --heartbeat
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<port>" --session "<UUID>" --heartbeat-stop "<回执heartbeat_id>"
```

短查和等待共用游标，恢复后先短查。curl GET 只读取。预计连续超过 3 分钟没有[续租动作](runtime.md#工作租约与心跳)时再开心跳。心跳自动寻找 AI 工具进程，找不到就传 `--owner-pid <AI 工具 PID>`。续心跳租期时，短查或等待传回执中的 PID。

开访谈前先摸项目现状；中间出题不读代码；预计末轮先趁用户作答经 `work.mjs --final-round` 集中核对，再按 A/B 取回执。
