# 平台 Pipeline（CRM）

> 每次推进都更新本表和下方的「推进记录」。阶段定义见 `.claude/skills/grow-platform-bd/SKILL.md`。
> **没有对方回复就写「未回复」，不推测。** 条款以门户或合同显示为准，档案里的数字都带出处。
> 最后更新：2026-09-30 · 本周执行顺序见 `go-live-runbook.md`

## 总表

| 平台 | 阶段 | 合作方式 | 分成（出处见档案） | 我们的包 | 下一步 | 负责 | 截止 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CrazyGames | 2 材料就绪 | 广告分成（Basic Launch 期间无广告收入） | 现行比例官方未公开 | `dist-portal.zip` | 用户注册开发者账号 → 提交 | 用户 + BD | D1 |
| itch.io | 2 材料就绪 | 自助发布；免费 + 可选打赏 | 默认 10%，可自设 | `dist-portal.zip` | 用户注册 → 发布 | 用户 + BD | D1 |
| Newgrounds | 2 材料就绪 | 自助发布；曝光为主 | 官方未查到 | `dist-portal.zip` | 用户注册 → 发布 | 用户 + BD | D1 |
| Y8 | 1 资格确认 | 送审；广告分成 | 开发者 50% | `dist-portal.zip`（SDK 要求待看） | 注册后读门户里的 SDK 要求 | 用户 → 工程 | D2 |
| GameDistribution | 4 审核中（2026-09-27 提交，修复版） | 分发到发行网络；广告分成 | 开发者得净收入 33% | `release/gamedistribution/grow-everything-gd.zip`（rev 2） | 等审核（官方最长约 3 周）；可选：激励广告测试 | 用户 | 10/18 |
| GamePix | 1 资格确认 | 独家或允许分发（上传时勾选） | 官方未查到 | `dist-portal-nosdk.zip` | 640×480 iframe 测试；用户注册 | 工程 + 用户 | D4 |
| Armor Games | 3 已联系（9/28 NEX 回复：问 AI 使用、回合偏长、操作飘、画面错误） | 策展；冠名或限时独占（邮件谈） | 官方未查到 | iframe 指向我们的网站 | 回复草稿待用户确认发送；先修对方指出的问题、发新版，再谈合作方式 | 用户 → BD + 工程 | 10/3 |
| MSN Games | X 退信（暂缓） | 广告分成计划（2007 年公布，现行条款未知） | 未查到 | `dist-portal.zip` | 9/24 首封邮件被退信（550 拒收）；先查现行投稿入口，查到前不再发送 | BD | — |
| Addicting Games | 1 资格确认 | 授权、赞助、独占 | 未查到 | 待定 | 用户在开发者中心提交；与 Armor 同期询价 | 用户 | D4 |
| Poki | 暂缓（已选多平台） | 一次性非独占授权费 | 按游戏单独定，无分成 | `dist-portal.zip` | 其他平台上线、有数据后再询价 | BD | D14+ |
| 国内（TapTap、4399、抖音/微信小游戏） | 暂缓 | — | — | 需要重做（小游戏无 DOM） | 需要软著、ICP、版号或小游戏备案；本阶段不做 | — | — |

## 推进记录

<!-- 格式：日期 · 平台 · 做了什么 · 对方原话或门户状态 · 下一步 -->

- 2026-09-30 · Armor Games · 收件箱查到 NEX（nex@armorgames.com，抄送 mygame@）9/28 回复，原话：「Thanks for reaching out to us with GROW EVERYTHING. Could you disclose if you used generative AI for anything? It does seem like rounds are a little longer than that 3-5 minute estimate. Gameplay seemed a bit fidgety and there were also graphical errors.」· 核对：回合计时 300 秒 + 3 秒倒计时 + 12 秒结算，首封邮件写的「3–5 分钟」不准确 · 已写回复草稿（Gmail 草稿，未发送）：如实说明 AI 使用（代码用 AI 编程助手、模型是代码生成的程序化几何、音乐用 Suno、无 AI 图片）；承认回合时长写错；请对方告知浏览器/设备和画面错误的样子，修好后发新版 · 等用户确认发送；联机修复验证通过后再发新版

- 2026-09-27 · GameDistribution · 首次提交后发现在线模式下看完广告卡在倒计时（实时连接未建立时开局消息被丢弃），修复并上传 rev 2；测试 iframe 中看完广告、正式开局、25 秒正常游戏；SDK = Yes，重新 Request Activation · 门户：In Review / Not Active · 等审核

- 2026-09-27 · GameDistribution · 用户注册开发者账号并验证邮箱；后台建了草稿「GROW EVERYTHING」（HTML5/JS、1280×720、Genre .IO、Android+iOS），拿到 Game ID · 门户：草稿，未上传 · 打 GD 包（修复了平台包读不到 .env.local 的问题，之前的平台包都不带联机配置）→ 用户上传并补全必填项

- 2026-09-26 · MSN Games · 复查发件箱：9/24 发往 webgames@microsoft.com 的邮件当即退信（Gmail 退信通知：550 5.4.1 Recipient address rejected: Access denied）· 未送达 · 暂缓，找到现行入口前不再发送
- 2026-09-26 · Armor Games · 复查收件箱 · 未回复 · 9/30 跟进
- 2026-09-26 · 全部 · 法律页信息填好（运营者 Zhuleli、cityhunters2025@gmail.com、纽约州法律、数据在美国）；5 张截图 + 7 个尺寸封面入素材包 · — · 等用户注册 GD / CrazyGames / itch.io / Newgrounds 并发来 Supabase 公开配置

- 2026-09-24 · Armor Games（mygame@armorgames.com）、MSN Games（webgames@microsoft.com）· 用户授权后，以 Zhuleli 署名从 cityhunters2025@gmail.com 发出首封邮件 · 未回复 · 9/30 跟进，10/8 收尾（最多跟进 2 次）
- 2026-09-24 · 全部 · 用户选定路线 A（多平台）；对外邮件一律写成 Gmail 草稿，由用户自己发送
- 2026-09-24 · 全部 · 建立 pipeline；通用包、GD 包、无 SDK 包已构建并通过测试 · — · 等用户选路线并注册账号
