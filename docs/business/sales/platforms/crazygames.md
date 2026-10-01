# CrazyGames — 平台档案

> 调研日期：2026-09-24 · 负责人：平台发行 BD · 状态：**未提交**（需要用户注册开发者账号）
>
> 取证方式：本环境的网络出口屏蔽了 `docs.crazygames.com` / `developer.crazygames.com`，无法打开全文；以下内容来自**官方域名页面的搜索引擎摘要**，每条都注明 URL。提交前请用户在浏览器里打开对应页面再核对一次。

## 1. 提交入口、流程、审核时长

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 提交入口 | https://developer.crazygames.com/ （开发者门户，注册后上传 HTML5 构建） | [S1] |
| 流程 | 注册 → 上传 HTML5 包 + 填写描述、缩略图、操作说明 → QA 团队人工试玩审核 → **Basic Launch**（小流量测试）→ 数据达标后 **Full Launch** | [S2][S3] |
| Basic Launch 时长 | 上线满 **7 天且达到 500 次游玩**（两个条件都要满足）后结束；若一直不到 500 次，**21 天后自动结束** | [S3] |
| Basic Launch 期间 | **广告关闭，不分成**；SDK 可选；平台自动统计 KPI | [S3][S4][S9] |
| 晋级 Full Launch 看什么 | 平均游玩时长、转化率（开始后玩满 1 分钟的比例）、留存；参考线：优秀游戏平均时长常见 10 分钟以上、D1 留存 10–15% | [S3] |
| 首次 QA 审核时长 | **未查到**（官方文档只说 QA 团队会逐个试玩，没写天数） | [S2] |

## 2. 技术要求对照

| 要求（官方） | 来源 | 我们的现状 | 结论 |
| --- | --- | --- | --- |
| 初始下载 ≤ 50 MB，总大小 ≤ 250 MB；**进手机首页需初始下载 ≤ 20 MB** | [S5] | JS 约 1.3 MB + HDR 贴图 1.5 MB，`dist-web/` 全部 3.6 MB（含 0.7 MB 的 og.png，可不打进包） | ✅ 已满足 |
| 文件数 ≤ 1500 | [S5] | `dist-web/` 共 19 个文件 | ✅ 已满足 |
| **只能用相对路径，绝对路径会加载失败** | [S5] | `vite.web.config.mjs` 是 `base: '/'`，`dist-web/game/index.html` 引用 `/assets/...`、`/icons/...` 绝对路径；游戏入口在 `game/` 子目录 | ✅ **已完成**：`npm run build:portal` 产出 `dist-portal.zip`（`base: './'`，`index.html` 在 zip 根目录），已在子路径下启动验证 |
| 支持鼠标、键盘；若支持手机则支持触屏；桌面可横屏玩 | [S5] | 键盘 WASD/空格、鼠标转视角；手机虚拟摇杆 + 冲刺键，横屏锁定 | ✅ 已满足 |
| 只允许通过 CrazyGames SDK 请求的广告；视频广告不能打断游戏、不能突然出现 | [S6] | `CrazyGamesPlatform.ts`：只在复活/金币翻倍（激励）和局间（间隔 ≥ 180 秒）请求广告，播放时静音暂停 | ✅ 已满足（Full Launch 时 QA 会复核） |
| SDK：Basic Launch 可选，Full Launch 必须完整集成 | [S9] | 已集成 SDK v3：loadingStart/Stop、gameplayStart/Stop、happytime、激励/局间广告、inviteLink、showInviteButton | ✅ 已满足；⚠️ 适配层注释写明当时没能打开官方文档，是按搜索摘要和类型定义写的 → 提交前用 `?platform=crazygames` 本地跑一遍 |
| 不能交叉推广其他游戏/平台；社区链接（Discord、官网）只能放主菜单，且**不能直接指向可玩的网页版** | [S6][S7] | 分享面板会打开小红书/抖音/TikTok/X 等外部网站（分享用，不是推广）；设置页有隐私政策、用户协议链接 | ⚠️ 不确定：分享链接本身走 SDK `inviteLink` 是合规的；打开外部社交网站是否算违规未查到明确条款。稳妥做法：CrazyGames 上把隐私/协议页打进包内（相对路径），分享面板只保留「复制邀请链接」+ 系统分享 |
| 玩家必须能以游客身份直接开始；「用 CrazyGames 登录」按钮不能是主要行动按钮 | [S8] | 匿名即玩，无登录墙 | ✅ 已满足 |
| 内购只允许用 Xsolla，且需要平台选中 | [S4] | 目前商店只用游戏金币，Stripe 未接 | ✅ 已满足（平台上**不要**接 Stripe） |
| 多人：服务器可自备；要进「多人游戏」专区须通过 SDK 上报房间（`game.updateRoom`）、支持好友邀请/加入（`inviteParams`、`addJoinRoomListener`）、Instant Multiplayer、局间保留房间、`disableChat`，并**在游戏里显示 CrazyGames 用户名** | [S10][S14] | 2026-10-01 已接：`updateRoom({roomId, isJoinable, inviteParams:{room}})`（满 4 人时 isJoinable=false）、`leftRoom()`（离开页面）、底部 Invite 按钮随可加入状态 show/hide（文档标为 deprecated 但仍支持）、`inviteParams`/`getInviteParam` 进好友房间、`addJoinRoomListener` 游戏中被邀请时重载进新房间、`user.getUser()` 默认昵称 + `addAuthListener` 登录后更新（玩家自己输入过昵称则不覆盖）；Instant Multiplayer：默认流程本来就直接进新的私人房间；局间保留房间：结算后回同一房间大厅；无文字聊天（只有表情）→ `disableChat` 不适用 | ✅ 已接入（Chromium + SDK 桩测试通过；正式 QA 前在 CrazyGames 开发者门户的 SDK 预览里再跑一次） |

## 3. 收入分成与付款

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 分成比例 | **现行官方文档未公开具体比例**（FAQ 只写「广告收入分成 + 可选内购」）。旧版开发者条款（2021-02-11 PDF）写平台扣除 20% 广告收入——已过时，不能当现行条款引用。第三方文章称 2026 年 GameMaker 网页 Jam 条款为开发者 60% 广告 / 70% 内购——非官方开发者文档。**`platform-strategy.md` 里的「约 60% / 70%」需要以签约时门户显示的条款为准** | [S4][S11][S12] |
| Basic Launch | 广告关闭，无收入 | [S3] |
| 付款 | 每月付款，余额满 **€100** 才打款，不足滚到下月；支持银行电汇或 PayPal | [S4][S13] |

## 4. 预计流量（只列有出处的）

- 平台整体：官方 FAQ 称 **5000 万+ 月活玩家**，美国、英国等一线市场比例高。[S4]
- 单个新游戏在 Basic Launch 能拿到多少：**无公开数据**。官方只给出「7 天 + 500 次游玩」这个阶段门槛，并不承诺 500 次。

## 5. MEDDIC

| 维度 | 本交易 |
| --- | --- |
| **Metrics 衡量指标** | 平台看：平均游玩时长、1 分钟转化率、D1 留存（参考线 10–15%）[S3]。我们看：Basic Launch 7 天内游玩次数（门槛 500）、`match_start`/`lobby_view`、再来一局率 |
| **Economic buyer 决策人** | CrazyGames 发行/QA 团队（门户内审核，无具体联系人；支持邮箱见 FAQ 页）。**待确认**具体对接人 |
| **Decision criteria 决策标准** | 通过技术 + 质量 QA（相对路径、广告规范、游客可玩）；Basic Launch 数据相对同类游戏的排名 [S2][S3] |
| **Decision process 决策流程** | 门户提交 → QA 试玩（时长未查到）→ Basic Launch（≥7 天、≥500 次或 21 天）→ 数据评审 → Full Launch（开广告、更大推荐）|
| **Identify pain 对方痛点** | 平台需要能提高平均时长和留存的新游戏，多人专区需要真正「拉朋友一起玩」的游戏（他们专门写了多人要求）[S10] |
| **Champion 内部支持者** | 暂无。争取方式：把多人专区要求做齐（用户名 + 房间状态），Full Launch 后可以找对接人要推荐位 |

## 6. 提交文案（可直接复制）

**标题 / Title**：GROW EVERYTHING

**短描述（≤150 字符）**
- EN（120 字符）：`Eat anything smaller than you, grow, and swallow a whole city. 4-player online rooms with friends, AI fills empty seats.`
- 中（46 字）：`吃掉比你小的一切，越吃越大，最后吞掉整座城市！最多 4 人联机，好友没到齐就由 AI 补位。`

**长描述 / Long description**

EN:
> GROW EVERYTHING is a 3D arena "eat the city" game. Drive a small googly-eyed machine through Shanghai, New York or Paris and swallow everything smaller than you — trash cans, cars, buses, buildings — until you are big enough to bring down the Oriental Pearl Tower, the Empire State Building or the Eiffel Tower.
>
> Up to 4 players share the same city. Bigger machines eat smaller ones, so every chase can flip in a second. Invite friends with one link; empty seats are filled by AI rivals so a round always starts right away. Rounds last up to 5 minutes, each machine has 3 lives, and the round ends on the timer, when one machine is left, or when the landmark falls.
>
> Pick one of four machines — the balanced Collector, the wide-bladed Dozer, the fast Racer or the long-range Magnet — and unlock paint jobs, hats and horns with coins you earn in play. Cosmetics never make you stronger.

中文：
> 《GROW EVERYTHING》是一款 3D「吞掉整座城市」竞技游戏。驾驶一台大眼珠小机器穿行在上海、纽约或巴黎，吃掉一切比你小的东西——垃圾桶、汽车、公交车、楼房——直到你大到能吞下东方明珠、帝国大厦或埃菲尔铁塔。
>
> 最多 4 名玩家同在一座城市：大的吃小的，追逐随时可能反转。一个链接就能邀请好友，空位由 AI 对手补上，随时开局。每局最长 5 分钟，每人 3 条命；时间到、只剩一台机器、或地标被吞掉时结束。
>
> 四种机器任选：均衡的「回收者」、铲子宽的「推土机」、速度快的「疾风」、远距离吸取的「磁吸车」。用游戏里赚的金币解锁涂装、帽子和喇叭——外观不会让你变强。

**玩法说明 / How to play**
- EN: Eat anything smaller than you to grow. Rivals smaller than you can be eaten too — and bigger ones can eat you. Dash into something too big and you get stunned and lose mass. Grow big enough to topple the city's landmark.
- 中：吃掉比你小的东西就能长大；比你小的对手也能吃，但比你大的对手也能吃掉你。冲刺撞上吃不动的东西会眩晕并掉质量。长到足够大，就能推倒城市地标。

**操作说明 / Controls**
- EN: Keyboard: WASD move · mouse to look · SPACE dash · 1–6 emotes · H horn · M mute. Touch: drag on the left to move, DASH button bottom-right (landscape).
- 中：键盘：WASD 移动 · 鼠标转视角 · 空格冲刺 · 1–6 表情 · H 喇叭 · M 静音。手机：横屏，左手拖动移动，右下角「冲刺」。

**标签 / Tags**（在门户的分类/标签里选最接近的）
- EN: `.io`, `multiplayer`, `3D`, `eating`, `grow`, `city`, `destruction`, `casual`, `driving`, `friends`
- 中：`.io`、`多人`、`3D`、`吞噬`、`成长`、`城市`、`破坏`、`休闲`、`驾驶`、`好友`

## 7. 下一步（用户操作）

1. 打开 https://developer.crazygames.com/ → 点 **Sign up / Log in** → 用公司或个人邮箱注册开发者账号；在账户里填写付款信息（PayPal 或银行）。
2. 在门户里打开 **Requirements** 和 **FAQ** 两页，核对本档案第 2、3 节（特别是当前分成比例截图存档到 `docs/business/sales/platforms/`）。
3. 用 `npm run build:portal` 生成 `dist-portal.zip`（本地 `.env.local` 先填 Supabase URL 和 anon key）。
4. 门户里点 **Submit game / Add new game** → 选 HTML5 → 上传 zip → 粘贴第 6 节标题、描述、玩法、操作 → 上传封面（`marketing/press-kit/covers/` 里按尺寸挑，以门户上传框提示为准）→ **Submit for review**。
5. 通过后进入 Basic Launch：在自有渠道（社群、达人）发 CrazyGames 链接，帮游戏在 7 天内过 500 次游玩门槛。

## 来源

- [S1] https://developer.crazygames.com/
- [S2] https://docs.crazygames.com/requirements/intro/
- [S3] https://docs.crazygames.com/resources/basic-launch-metrics/
- [S4] https://docs.crazygames.com/faq/
- [S5] https://docs.crazygames.com/requirements/technical/
- [S6] https://docs.crazygames.com/requirements/ads/
- [S7] https://docs.crazygames.com/requirements/gameplay/
- [S8] https://docs.crazygames.com/requirements/account-integration/
- [S9] https://docs.crazygames.com/requirements/intro/ （Basic Launch：无需定制、SDK 可选、无变现；Full Launch 须满足全部集成要求）
- [S10] https://docs.crazygames.com/requirements/multiplayer/
- [S11] https://files.crazygames.com/documents/developer_terms_20210211.pdf （旧版条款，仅作历史参考）；现行条款 PDF：https://files.crazygames.com/documents/developer_terms_20250818.pdf （摘要未显示比例）
- [S12] 第三方：https://app.cinevva.com/guides/publish-game-crazygames （非官方，仅作线索）
- [S13] https://docs.crazygames.com/payouts/
- [S14] https://docs.crazygames.com/sdk/game/ （多人房间 API；本环境打不开，接口名按搜索摘要 + 官方 Defold 扩展的 JS 桥 `github.com/defold/extension-crazygames` `crazygames/lib/web/lib_crazygames.js` 核对）
