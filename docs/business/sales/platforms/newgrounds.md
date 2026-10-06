# Newgrounds — 平台档案

> 调研日期：2026-09-24 · 负责人：平台发行 BD · 状态：**未发布**（可自助发布，发布后进入社区评审）
>
> 取证说明：本环境屏蔽了 `newgrounds.com`，且搜索引擎几乎没有收录 newgrounds.com 的官方帮助页。以下凡是来自**社区维基**（newgrounds.wiki.gg / fandom，由玩家维护，非官方）或第三方教程的内容都单独标注「非官方」，可信度低，**上传前请用户在 Newgrounds 上传页面上核对**。

## 1. 提交入口、流程、审核时长

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 提交入口 | https://www.newgrounds.com/projects/games （创建游戏项目；同一页面的「API Tools」可拿 Newgrounds.io 的 App ID） | [S1]（官方 newgrounds.io 页面） |
| 流程 | 注册账号 → 新建游戏项目 → 上传 HTML5 **zip** → 填写信息 → Publish | [S2]（第三方教程：Construct、GDevelop） |
| 审核 | 没有平台方的上线前审核；游戏发布后先进入 **Under Judgment（评审中）**，由用户打 0–5 星，平均分决定保留还是被「Blam」删除 | [S3]（非官方社区维基） |
| 审核时长 | **未查到**官方说法 | — |

## 2. 技术要求对照

| 要求 | 来源 | 我们的现状 | 结论 |
| --- | --- | --- | --- |
| 接受 HTML5 zip | [S2]（第三方） | 可打 zip | ✅ |
| 文件大小上限：第三方资料称 250 MB；社区维基称超过 10 MB 要私信站长审批（两者矛盾，维基可能过时） | [S4]（均非官方） | 包约 2.9 MB（不含 og.png） | ✅ 按两种说法都在限额内 |
| 相对路径 / zip 根目录 `index.html` | 未查到官方条款 | `base: '/'` 绝对路径 | ❌ 需要改（与所有 zip 平台相同，README 技术改动 A） |
| SDK | 不强制；可选接 Newgrounds.io（奖章、排行榜、云存档），官方有 JS 库 | [S1][S5] | 未接 | ✅ 不需要（奖章/排行榜以后可加）|
| 广告 / 外链 / 多人服务器 | **未查到**官方条款 | 我们在 Newgrounds 上无广告（`WebPlatform`）；Supabase 外连 | ⚠️ 不确定 |
| 邀请链接 | — | iframe 里 `location.origin` 不是 Newgrounds 游戏页 | ❌ 需要改（README 技术改动 B） |
| 手机 | 未查到 | 已支持横屏触控 | ⚠️ 不确定 Newgrounds 手机端嵌入表现 |

## 3. 收入分成与付款

- 官方页面：**未查到**。
- 社区维基（非官方）：Newgrounds 有面向创作者的广告收入分成计划（注册后在账户页开通），满 **$100** 打款，不足累积到下月——来源为玩家维护的维基，**可能过时**。[S6]
- 结论：不把 Newgrounds 当收入来源，只当曝光渠道。

## 4. 预计流量

- **无公开数据**（未找到 Newgrounds 官方公布的站点月活或新游戏曝光数据）。

## 5. MEDDIC

| 维度 | 本交易 |
| --- | --- |
| **Metrics** | 评审期得分（决定去留）、Newgrounds 页面 views、带 `utm_source=newgrounds` 的 `match_start` |
| **Economic buyer** | 无单一决策人：评审期由社区用户打分决定 [S3]（非官方） |
| **Decision criteria** | 社区玩家是否觉得好玩、有趣——Newgrounds 用户偏爱搞笑、有个性的作品（大眼珠、打嗝、喇叭是加分项） |
| **Decision process** | 发布 → Under Judgment（社区评分）→ 保留进入 Portal / 被删除 |
| **Identify pain** | 社区需要有梗、有个性的原创网页游戏；我们需要第 1 天就能发布的额外曝光 |
| **Champion** | 可争取：在 Newgrounds 论坛发 devlog，邀请活跃用户试玩打分 |

## 6. 提交文案（可直接复制）

**标题**：GROW EVERYTHING

**短描述（≤150 字符）**
- EN：`Eat anything smaller than you, grow, swallow a whole city. Then survive Halloween Town, where three bosses hunt you down.`
- 中：`吃掉比你小的一切，越吃越大，吞掉整座城市！万圣节小镇里三个 BOSS 追着你跑。`

**长描述**（2026-10-06 更新：万圣节小镇、6 人、新 BOSS 名）
- EN：Start small. Eat a trash can. Eat a car. Eat a bus. Eat your friend. GROW EVERYTHING is a 3D "eat the city" arena: drive a googly-eyed machine through Shanghai, New York, Paris or Halloween Town and swallow everything smaller than you until you can take down the landmark. Bigger eats smaller, so every chase can flip in a second. In Halloween Town you grow for the first half, then everyone shrinks and three bosses (the Net-Addiction Shock Doctor, Dr. Cannibal and the Psycho Motel Keeper) crawl out to hunt you. Get caught and your score is gone. Find the hidden Egg Valley and honk to turn invisible. Quick play starts instantly against AI; share one link to play with friends. Cosmetics only, no pay-to-win.
- 中：从小开始，吃垃圾桶、吃汽车、吃公交车、吃掉你的朋友。在上海、纽约、巴黎或万圣节小镇里吃掉比你小的一切，直到推倒地标。万圣节小镇上半场吃东西长大，下半场所有车变小，戒网瘾电击院长、食人魔医生、惊魂旅馆老板三个 BOSS 爬出来追人，被抓分数清零。找到藏起来的蛋之谷按喇叭就能隐身。快速开始马上和 AI 开局，发一个链接就能和朋友一起玩。只卖外观，不卖变强。

**玩法说明**
- EN：Eat anything smaller than you to grow. Smaller rivals are food too — bigger ones will eat you. Dashing into something too big stuns you and costs mass. Grow big enough to topple the landmark.
- 中：吃比你小的东西长大；小对手也能吃，大对手会吃你。冲刺撞上吃不动的东西会眩晕掉质量。长到够大就能推倒地标。

**操作说明**
- EN：WASD move · mouse look · SPACE dash · 1–6 emotes · H horn · M mute. Mobile (landscape): drag left side to move, DASH bottom-right.
- 中：WASD 移动 · 鼠标转视角 · 空格冲刺 · 1–6 表情 · H 喇叭 · M 静音。手机横屏：左侧拖动移动，右下角冲刺。

**标签**：EN `io, multiplayer, 3d, eating, city, destruction, funny, driving, arena, halloween` · 中 `io、多人、3D、吞噬、城市、破坏、搞笑、驾驶、竞技`

## 7. 下一步（用户操作）

1. 注册 https://www.newgrounds.com → 打开 https://www.newgrounds.com/projects/games → **Create a new project**（新建游戏项目）。
2. 上传平台构建 zip → 按页面提示设置画布尺寸（建议 1280×720）→ 粘贴第 6 节文案、选分级（Everyone）、填标签 → 上传图标/缩略图。
3. **先核对页面上显示的文件大小上限和规则**，截图存档到本目录，更新本档案第 2、3 节。
4. 点 **Publish**。发布后在社群里请朋友去评分，帮游戏平稳度过 Under Judgment。

## 来源

- [S1] https://www.newgrounds.io/ （官方：Newgrounds.io API、项目页 newgrounds.com/projects/games、API Tools）
- [S2] 第三方教程：https://www.construct.net/en/tutorials/publish-game-newgrounds-27 ； https://gdevelop.io/page/how-to-publish-your-game-on-newgrounds-and-why-you-should-do-it
- [S3] 非官方社区维基：https://newgrounds.wiki.gg/wiki/Under_Judgment
- [S4] 非官方：https://newgrounds.wiki.gg/wiki/Submission_to_Newgrounds （10 MB 说法）；250 MB 说法来自搜索摘要中的第三方资料，未能定位官方原文
- [S5] 官方 JS 库：https://github.com/PsychoGoldfishNG/newgrounds.io-for-javascript-html5
- [S6] 非官方社区维基：https://newgrounds.fandom.com/wiki/Revenue_Sharing
