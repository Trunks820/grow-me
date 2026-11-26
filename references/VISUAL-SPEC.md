# grow-me 需求生长树 · 视觉规范

## 颜色

- 纸底用 #f2eee5，叠一层细噪点纹理。
- 树干与枝用墨色 #2f2c26。正文用 #2b2a26，次要文字用 #4f4a3e 和 #6b6454。
- 晕染按轮次着色，依次用 #7fa392 #c9a36a #8ea1b8 #a7a886 #c29a8c #86a4a4。
- 花瓣用 #f7f2e8，描边用 #8b8270，花心用 #c08a4a。黄叶用 #c9a25e，成熟果实用 #b78263。
- 主按钮 #3a372f 底，文字用纸色

## 树干

- 树干用填充路径。底宽为 12 + 2.4 × clamp(当前轮次, 1, 6)，顶宽 0.85，保存后收至 0.55，树梢再长 12 个单位。宽度从底到顶按 `底宽 + (顶宽−底宽) × t^1.7` 收细，轮廓另有约 ±12% 的笔触起伏。
- 根部向两侧长出两条根须。分轮枝段以下的树干基段高为 `80 + 18 × min(当前轮次, 6)`。
- 首轮枝段高为 `clamp(50 + 16n, 80, 170)`。后续每段为 `clamp(40 + 12n, 70, 130)`，n 是该轮题数。枝段和树冠纵向按 `min(1, 树冠预算 / (各轮枝段高之和 + 240))` 缩放。首轮预算为 360，后续为 `260 + 420 × (1−exp(−(当前轮次−1)/3))`。横向比例为 `0.82 + 0.04 × min(当前轮次, 6)`。
- 树干中心线在缩放前按 `x = 480 + 0.07h + 16 × sin(h/150)` 倾斜并弯曲，h 是离地高度。
- 树梢保留两根短杈。相邻主枝挂点之间，以及最高挂点到树梢下方 40 个单位之间，空段达到 46 个单位时，加 `floor(空段高度 / 38)` 根交替向上长的装饰短杈。装饰短杈起宽 2.4、尖宽 0.3，长度参数为 24–42，横向伸出长度的 0.8 倍、向上抬 0.75 倍。它们随树干长出，没有点击区。

## 枝

- 主枝对应没有依赖的题，挂点左右交替。每轮的挂枝区延伸到下一轮有新话题的枝段下方。多根主枝扣掉两端 `min(22, 区段高度 × 0.2)` 后错开排列，每个挂点在 `±min(5, 挂点间隔 × 0.12)` 内微调。单根主枝从区段上沿往下 45% 处长出。
- 主枝长度以 `clamp(100 + 20n − 6r, 130, 240)` 为基准，乘随机比例 0.85–1.15、`0.68 + 0.42u` 及 `1 + min(1, (当前轮次−1)/4) × (−0.2 + 0.24 × sin(πu))`。u 从所有枝段的最高处到最低处由 0 增至 1，按挂点高度取值。第一轮再乘 0.78。越低的枝越平，向上倾角为 `20° + 36° × (1−u)`，另有 ±8° 的变化。
- 最后一批有新话题的轮次在首轮之后且只有一根主枝时，这根枝向上当树顶，长为上述长度的 0.8 倍，基准角为 −78° 或 −102°，另有 ±11° 的变化。追问从父枝两侧交替长出。
- 子枝从父枝的 70%–80% 处长出，长度为父枝的 0.45–0.70，最短 62。第 k 根子枝偏离父枝 `16° + 3° × k`，取样变化为 ±13°。装不下整簇花时可放宽到 ±23°，并在正常长度上最多再加 30%。
- 主枝起宽取 `max(5, 10.5−0.9r)`，上限为 `max(2.4, 挂点处树干宽 × 0.85)`，按树干的 1.7 次方曲线计算挂点宽度。子枝起宽是父枝的 0.45 倍，最小 1.6。末端有子枝时收至起宽的一半，末梢的枝细到 1。
- 枝条用二次曲线，分 16 段取 17 个点，沿法线加 `sin(πt)` 包络下最大 ±1.1 的抖动。控制点横向按 16–40 的因子弯曲，向上抬 18–34。
- 随机种子由持久的需求标识 session_id 与节点 id 共同生成（对 JSON 数组做 FNV-1a 哈希，再用 J(i)=fract(sin(i·127.1+311.7)·43758.5453) 取样）。新需求分配唯一 session_id，恢复、刷新、重播和改答案沿用它；不使用时间戳。相同题目与依赖可因需求不同而长成不同树形，同一需求的几何保持稳定
- 先用 192 组确定性候选在靠近枝尖的位置找空位，再用同样的枝形往枝条内侧找。子枝仍放不下花簇时再尝试放宽角度。优先选整簇边界错开且花心间距至少 25 的位置，其次选整簇边界错开且花心间距最大的位置。28 题样例验收花心间距至少 13、花簇分开，且每题都能实际点开。
- 每根枝在 11/16 处留一根侧枝，长度参数 7–15，枝头再上提 3。末梢另留一根 6–12 的短杈。
- 墨迹用 1.3 的位移，粗度超过 3 的枝和树干叠干笔纹理，透明度 0.12。

## 花 / 叶 / 果

- 待答用半开的暖色花苞，沿原画法整体放大到 1.4 倍。花苞和花簇共用同一个位置，默认在枝条曲线的 72%–90% 处。距枝尖少于 16 个单位时，每次往内收 0.025，最靠内可以到 42%。枝尖附近放不下整簇时，再找 42%–72% 的空位。
- 已答画三朵五瓣花，花瓣描边宽 0.55，花心半径是花瓣半径的 0.55 倍。主花以题目为花心，花瓣半径 4.2、花瓣中心离花心 4.9。左下小花偏移 (−7.5, 5.5)，对应半径和距离为 2.6、3，透明度 0.90。右下小花偏移 (7, 6.5)，对应数值为 2.2、2.6，透明度 0.85。两朵小花只作装饰。
- 待定用圆形暂停符号，节点可回看补充文字。
- needs_review：一片顺着枝方向的黄叶（椭圆，9×3.6），透明度 0.75
- 保存后每章挂一颗半径 9 的果，对应的末梢枝头垂一根短梗。果子按方案章节顺序标 1 到 N，和章节列表相同。已可阅读的果子用朱砂底、浅色字，等待生成的果子用浅底、深色字和虚线边。果实位置留出花簇和其他果子的空间。

## 晕染

- 每题有一块晕染，中心从花心向枝条一侧偏 4、向下偏 2。横、纵半径分别为 26–40、18–30，8 个控制点各乘 0.72–1.14 后连成轮廓，随枝条生长淡入到 0.24。位移强度 18，模糊标准差 8。

## 文字与悬停

- 树上只显示果子的编号。右上角显示话题与整棵树的进度，答题时底栏显示本轮还剩几题。
- 每个节点有一块 r 11 的透明感应区。点击或按回车可打开圆麻薯的气泡，作答或回看该节点。回看已答的花后点 ×，麻薯回到还没答完的那题，未确认的选择保留；按 Esc 只关闭，焦点回到那朵花。
- 果梗只绘制，不接收指针事件。果实保留独立的扩大感应区。悬停时提示章名和状态，键盘聚焦时读屏可读到编号和章名。点击、回车或空格打开已生成的章节。
- 点「够了，先出方案」时，麻薯在底部气泡里说明还有几题没答，没答的会记成「待定」，写进方案的「待确认」。即使已答完也询问，显示「就先出方案」和「再答几题」两个选项。
- 同一会话和 revision 刷新后，已确认的本轮草稿仍显示花朵或暂停符号，可回看、修改和提交。汇总提示草稿只存于本机浏览器，存储不可用时提示刷新会丢失。

## 布局

- 页眉左侧用圆麻薯提问表情作小图标，和「需求生长树」排在一起。话题与进度在右侧，树居中。
- 桌面上，约 64 像素的圆麻薯停在当前芽旁。纸色气泡伸向旁边空处，避开当前芽。题目、「为什么问这个」、选项、待定和补充都在气泡内。气泡必须完整显示：放不下时宁可盖住别的芽，也不压矮成要滚动；四周都放不下才改用底部面板。选择题的补充框默认显示一行，随文字增高。有效的建议在对应选项旁显示「AI 建议」。
- 宽度不超过 720 像素时，圆麻薯仍跟着芽，气泡变为底部卡片。树和缩放按钮留在卡片上方，长内容在卡片内部滚动。
- 答题底栏显示轮次、剩余题数、进度小圆点和「够了，先出方案」。点进度可以回看本轮答案。本轮答齐、又没在倒数时，底栏多一个「交给 AI」，点了直接交。最窄的屏幕上这时省掉轮次和小圆点，页头仍有轮次。
- 本轮答齐且黄叶复核完后，开花表情的麻薯先在最后确认的题旁接一句，约 1.5 秒后提着装花的小篮子飞走。气泡写「这一轮 N 题都定了，我送去给 AI 啦～」，下面显示 5 秒倒数和「等等，我再看看」。窄屏把气泡放在树和底栏之间。
- 5 秒后自动交给 AI。点「等等，我再看看」或按 Esc 会取消倒数并打开答案列表，列表里可以回看、修改和点「交给 AI」。接话时点 × 或按 Esc 跳过这句，篮子马上出发。接话或倒数时点树上的题目会先停下倒数：只看不改、关掉那朵花后，本轮仍答齐且页面状态没变，篮子回来重新倒数 5 秒；点「改」就不再自动交，改完确认时照常从接话开始。本轮没答齐时看别的花，关掉也不会交。切到别的窗口或标签页时倒数照走，到点就交。提交失败后可在答案列表重试。
- AI 暂停或还没连上时，最近答过的花旁显示带 `zzz` 的睡着表情。气泡在桌面靠着麻薯，在窄屏放在树和底栏之间。点麻薯复制提醒，成功时提示去跟 AI 的聊天窗口粘贴，失败时在气泡里显示原文。两个结果都可以点「再复制一次」。页头也可以复制提醒。AI 恢复在线时，麻薯就地睁眼约 1 秒，再回到常态。
- 完成页上，开花表情的麻薯留在树旁。树下标题为「问过的，都结成了果。」，说明为「N 颗果子＝方案的 N 章，点果子或章名都能打开」。下方按编号列出全部章节，桌面两列，宽度不超过 720 像素时一列。长章名换行，内容超过一屏时随页面向下滚动。最后一章下面是「打开完整方案」。
- 树用 SVG 的 `xMidYMid meet` 等比居中。镜头取树干、枝杈、花簇和预留果实的墨迹范围，四周各留 2 个单位。答题时取框宽为 `max(820, 墨迹宽 + 140)`，高为 `max(840, 墨迹高 / 0.9)`。保存后取框宽为 `max(490, 墨迹宽 + 64)`，高为 `max(560, 墨迹高 / 0.9)`，让编号更易读。

## 动画

- 每轮生长时树干在 550 毫秒内长出新的一段，枝条在 250 毫秒后开始抽长，同轮每多一层依赖延迟 200 毫秒，每根枝用 850 毫秒完成，缓动为 easeOutCubic。晕染色块随该枝的进度淡入。
- 确认答案后立即开花。标为待定时立即显示暂停符号。
- 第一题打开后，焦点进入气泡。切换题目时，圆麻薯从上一个芽飘到新芽，气泡随之换题。
- 一轮提交后，问题卡显示「正在想下一轮的问题…」，超过 60 秒提示可以回看回答。用户确认先出方案后，显示「正在准备保存…」。
- 保存后，果子每隔 60 毫秒依次长出，每颗约用 1 秒。
- 系统开启减少动态效果时，树、圆麻薯和气泡直接显示终态。送答案时直接显示气泡、倒数文字和「等等，我再看看」。

## 网页行为与树的几何（开发参考）

这一节原在 contract.md。跑访谈的 AI 不用读；改网页、树的画法或回归检查时以它和上面各节为准。

The approved visual basis is v7.html and the colors above. The old Claude prototype is an interaction reference. Production contains no prototype questions, simulated answers, fast-forward or fake-generation controls.

The workbench opens the first available question in a speech bubble beside round mochi (圆麻薯). Activating any node brings its question or saved answer into the same bubble. The bubble contains the question, rationale, answer controls, and deferral. Choice questions show an optional expanding note field and mark valid AI suggestions without selecting them. Activating one option confirms a single-choice answer and advances to the next available question. Multi-choice and text answers confirm with **好了**. At widths of 720 pixels or less, the bubble becomes a bottom sheet with internal scrolling and the mascot stays by the bud. Focus moves into the bubble when it opens. Reduced motion shows the final positions immediately.

确认普通答案后，芽开成花。选待定时显示暂停符号。点「没看懂，换个说法」展开「哪里没看懂？（可不填）」。点「请 AI 换个说法」后，树上显示问号，麻薯说「好，我让 AI 换个说法再问你」。这题算本轮已交，决定还没定。单选用所选项的 `reply`，多选优先用题目的 `reply`，再看第一个所选项。文本题用题目的 `reply`。没有台词时轮换模板，待定题用待定模板。约 1.5 秒后转到下一题。减少动态效果时直接换位置。

Store confirmed, deferred and unclear drafts in `localStorage`. While the page is open, a revision change clears drafts for submitted, reopened, and invalidated questions. Save retained drafts under the new revision. On page load, restore drafts only for the same `session_id` and `revision` in the same browser and origin. Guard storage access and keep drafts in memory when storage is unavailable. Unconfirmed form input stays in memory. Submitted answers recover through `/state`.

本轮答齐且没有待复核的黄叶时，麻薯先在最后确认的题旁接一句，约 1.5 秒后带着答案飞走。开启减少动态效果时直接显示倒数，最后一题点了「没看懂」时先显示静止的接话。页面倒数 5 秒后自动 `POST /submit`。待定和没看懂都算本轮已答。如果最后确认的是黄叶，同样先接话再倒数。接话时点 × 或按 Esc 跳过接话，直接开始倒数。接话或倒数时点树上的题目会停下倒数；只读看完关掉时，若本轮仍可提交且 revision 没变，就重新倒数 5 秒；点了「改」则不再恢复。页面切到后台时倒数照走，到点就交。点「等等，我再看看」或按 Esc 可在倒数时打开答案列表并取消交卷。改完并再次确认时，符合条件就从接话开始。本轮可提交且没在倒数时，底栏显示「交给 AI」（无障碍名称「这一轮交给 AI」），点了直接提交；刷新后恢复草稿、在答案列表点 × 关掉、自动提交被取消时都靠它。自动提交失败时显示原有错误，把仍然有效的草稿留在答案列表里供重试。

底栏显示轮次、剩余题数和进度小圆点。点「够了，先出方案」会取消交卷，麻薯在底部气泡里确认。气泡说明还有几题没答，没答的会记成「待定」，写进方案的「待确认」。即使本轮都答完也要确认。点「就先出方案」提交请求，点「再答几题」关闭气泡并保留草稿。

Waiting loops a visual extension, without adding rounds/nodes or cumulative tree height. While the AI is online and preparing the next round, the card shows “正在想下一轮的问题…”, then after 60 seconds “还在想，可以先回看本轮回答”. After the user requests a plan, it shows “正在准备保存…”. The card shows elapsed seconds, including after the last yellow leaf is reviewed. While the AI is online it also shows “生长中”. Timers use a process-local server start timestamp and a browser monotonic clock, survive polling and reconnect, and reset for a genuinely new wait/job. Transport loss reconnects. The human can edit during waiting. All transitive dependencies participate in review. A changed upstream invalidates in-progress review input even when the affected node was already `needs_review`. Unrelated unconfirmed form input survives in the open page. Reduced motion keeps text and stops movement.

等待出题或写文档时，如果页面判定 AI 已暂停或还没连上，麻薯就在最近答过的花旁睡着，气泡提示可以点它复制提醒。页头也能复制。复制成功后，气泡请用户去跟 AI 的聊天窗口粘贴，也可以再复制一次。复制失败时提供原文供手动复制。页面收到 AI 恢复在线的状态时，麻薯睁眼约 1 秒，随后恢复平常的显示。

### Current checks

node --test tests/acceptance.test.mjs tests/document.test.mjs tests/tree-layout.test.mjs tests/wait-flow.test.mjs

python tests/browser_acceptance.py --work <folder>

python tests/browser_acceptance.py --scenario tree --layout-fixture four --work <folder>

python tests/seeded_growth.py --work <folder>

The controlled browser checks use explicitly synthetic input. The four-round fixture preserves the earlier approved 28-question/seven-root shape; the six-round fixture covers the v7 reference geometry. Both are canonical v1 fixtures outside production. They include actual hit testing, entity-overlap checks and root-to-fruit navigation. A separate current-conversation transport actor and real-requirement replay establish model/writer execution; measured requests and real UI times are receipts, never generated by the fixture service.

### Sparse-tree framing (r3)
Branch generation follows v7: root branches alternate on the appropriate round's trunk segment, children start at 70–80% of their primary parent's quadratic Bezier, their length derives from the parent's length, and their width is max(1.6, parent_width * 0.45). Branch angles, control points and organic perturbations use stable seeds derived from the persisted requirement `session_id` plus node ID. A new requirement gets a unique identity once; refresh, replay, answer edits, revisions and title changes do not reseed it. No clock or timestamp participates, and no geometry seed is stored in tree.json. The first root side and final twigs use the same requirement identity. Deterministic collision resolution re-samples up to 192 candidates within the v7 limits: root angular jitter ±11°, child jitter ±13°, root length factor 0.85–1.15, child factor 0.45–0.70 (minimum 62), root attachment 30–75%, child attachment 70–80%, horizontal curvature factor 10–32 and upward control-point lift 10–24. It prefers a 25-unit endpoint gap and otherwise retains the largest feasible gap; it cannot escape those limits or force endpoints onto rows. Regression coverage checks actual symbol separation as well as parameter bounds. The filled taper has a smooth cubic outline. Fine side twigs also curve; the artificial pair of trunk rungs from r5 is removed. Trunk segment height remains clamp(40 + 12 * question_count, 70, 130).

The entire ink illustration, including its final leader, flowers and fruit, is centred horizontally and vertically in the tree viewport. The viewBox retains at least the previous 1000 by 910 scale and remains fixed throughout a replay; centring changes its origin rather than enlarging the tree. preserveAspectRatio is xMidYMid meet.

A completed interview replays its recorded growth when opened: successive trunk segments and branches, flowers, the 1.4-second tapered leader, then fruit. The replay button repeats this display without changing answers, revision, confirmation counts or document state. Each round takes 1.1 seconds plus 0.2 seconds per same-round dependency depth. Reduced-motion mode shows the full final tree immediately. Fruit is smaller again (5.2-unit radius) with a muted #9a7b6d body, a short stalk and a small leaf. Its hit area remains larger than its painted body; the stalk is paint-only so it cannot intercept the question node at its attachment. There is one fruit per root; clicking opens the matching chapter of the validated writer HTML. The desktop panel remains raised and retains its own overflow area.

The complete flag alone cannot display a successful saved interview: every node must also be answered. A mismatch displays the real count and a state-consistency message, with no fruit. Ready document links additionally require matching source session and revision. tests/tree-layout.test.mjs checks the parent-curve attachment, taper, curved outlines, stable seed geometry and centred frame. The public browser regression checks replay, fruit/chapter navigation, reduced motion and both 28-node fixtures. Historical forced-layer and enlarged-fruit behavior remains superseded by the v7 restoration.
