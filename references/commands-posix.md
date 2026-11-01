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

请求必须带已核对的 expected_session_id 与候选读取时 expected_revision。查询结束后用宿主短等待，约 10 秒再查；不要用一个永不结束的 shell 循环冒充短命令。

服务退出后：

```sh
node "<skill>/scripts/check.mjs" --url "http://127.0.0.1:<old-port>" --session "<UUID>" --restart --state "<workspace>/tree.json" --document "<workspace>/task.html"
```

macOS 和 Linux 共享命令写法，但只在实际运行过的系统记 passed，Linux 结果不代表 macOS。
