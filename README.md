# grow-me · 让需求长成方案

把逐轮澄清搬到本机网页：回答一题，树上开一朵花；追问沿着依赖长出枝条；修改上游答案，相关问题变成需要复核的黄叶；保存后，果子通向文档里的主题章节。

**早期试用版 · MIT 开源。** 界面与接口回归已通过，真实模型生成速度仍在验收中。欢迎带着真实需求试用并反馈等待时间。

![需求生长树示例：合成读书会需求，非真实用户数据](docs/images/tree-preview.png)

## 怎么用

需要 Node.js 22+、Git，以及能读取 `SKILL.md`、运行终端并持续等待的 AI 编码助手。当前工作流在 Codex 中实测；其他助手需要具备相同能力，兼容性待验证。Python 只用于文档校验和开发测试。

### 跟 AI 一起梳理一个真实需求

```sh
git clone https://github.com/Trunks820/grow-me.git
```

在 AI 助手里发送，把路径换成你的克隆位置：

```text
读取 /你的路径/grow-me/SKILL.md，使用 grow-me 帮我澄清下面的需求。
启动本机网页让我逐题回答；收到整轮答案后继续追问。
没有必要的新问题时进入保存阶段，保存后生成三视图 HTML。

需求：……
```

如果助手支持 `.agents/skills` 自动发现，可以将仓库克隆到 `~/.agents/skills/grow-me`；如果没有自动发现，直接读取上面的文件即可。Windows PowerShell 可用：

```powershell
git clone https://github.com/Trunks820/grow-me.git "$env:USERPROFILE/.agents/skills/grow-me"
```

本机服务不自带模型、不需要在仓库配置模型 API Key。**当前 AI 对话负责出题和写文档，网页负责答题与展示。** 让原对话保持运行；对话中断后，回到同一对话说“继续”。答案会交给所用 AI 助手处理，本机服务本身不调用外部模型。

已安装 `project-requirement-writer` 时可沿用它；没有安装也可使用仓库内置的 [writer 指引](references/writer-guide.md)、HTML 模板与校验工具，完成同样的三视图交付。

### 先看看长什么样

```sh
cd grow-me
npm run demo
```

打开终端打印的本机网址。此命令只展示**合成的读书会需求**：可以回放生长、回看花朵、点击四颗果子打开对应章节；不会调用 AI，也不代表真实模型的回答或生成耗时。点「结束预览」或在终端按 Ctrl+C 退出。

生产服务没有 npm 运行时依赖，无需先执行 `npm install`。完整访谈请通过 `SKILL.md` 启动，demo 仅用于预览。

## 已实现

- 逐题确认立即在本地开花，整轮汇总后手动提交；未提交草稿刷新会丢失，离开前会提醒。
- `tree.json` 是唯一访谈数据源，所有写操作保留 revision 冲突检测。
- 依赖追问从父枝曲线长出；同一份数据生成相同树形。
- 修改答案后，所有下游依赖进入黄叶复核，逐题确认。
- 等待时持续显示「生长中」与秒数；超过 60 秒提示可回看，断线自动重连。
- 每条根话题对应一颗果子；章节完成并通过来源校验后即可先读，其余章节标记「生成中」。
- 文档包含「设计方案／开发清单／验收标准」三个视图，最终保存后访谈只读，文档失败可重试。
- 桌面与窄屏布局、键盘操作、生长回放和减少动态效果支持。

## 当前边界

- 服务只监听 `127.0.0.1`，朋友需要在自己的电脑运行；这不是托管网站。
- 实际出题和文档生成耗时取决于 AI 助手与需求内容。分片组装、模板复用和摘要输入已经提供，真实提速尚未完成对比验收。
- Python 3.10+ 用于内置 writer 校验；Playwright 仅供开发测试，普通答题无需安装浏览器测试依赖。
- 原始访谈、用户答案、聊天记录、本机运行日志与私人技能配置均不在仓库内。提交 Issue 或截图前，请自行去掉个人回答。

## 帮忙试用时，记这三类时间

| 指标 | 起点 | 终点 |
| --- | --- | --- |
| 每轮出题 | 点击「提交本轮」；黄叶场景从最后一题复核确认后单列 | 下一轮第一题可答 |
| 首章可读 | 点击「保存并生成」 | 第一个果子能打开对应章节 |
| 全文完成 | 同上 | 全部章节与三个视图生成、校验完成 |

请附上题数、章节数、所用助手／模型与操作系统。首章可读时间指真正可以打开的章节；一个仍标着「生成中」的果子不算完成。不同规模需求的耗时不直接混为同一组对比。

[反馈 Bug 或试用结果](https://github.com/Trunks820/grow-me/issues)

## 开发与验证

```sh
npm test
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
python tests/browser_acceptance.py --work outputs/qa/browser
python tests/wait_flow_browser.py --work outputs/qa/waiting
python tests/seeded_growth.py --work outputs/qa/seeded
```

Node 测试覆盖 v1 守卫、依赖复核、文档任务、确定性树形与 200 个布局种子；Chromium 测试覆盖答题、断线、长等待、章节跳转和 28 题布局。受控时钟与合成数据不算真实模型的性能测试。

接口见 [v1 contract](references/contract.md)，文档分片见 [progressive writer](references/progressive-writer.md)。

## License

[MIT](LICENSE) · Copyright 2026 Trunks820
