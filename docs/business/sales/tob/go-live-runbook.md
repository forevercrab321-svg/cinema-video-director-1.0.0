# 上线创收作战板（2026-09-26 起）

> 用户指令：「你现在安排跟操作上线创收的方向。」 负责：平台发行团队 `grow-platform-bd`。
> 原则：先把游戏放到**有广告分成、能最快到账**的平台上，同时拿到真实数据；注册账号、接受条款、填收款信息必须由 Zhuleli 本人完成（平台条款要求账号持有人本人同意，这也是团队红线）。

## 1. 收入从哪里来（按到账速度排序）

| # | 渠道 | 怎么赚钱 | 最快多久有收入 | 卡在哪 |
| --- | --- | --- | --- | --- |
| 1 | **GameDistribution** | 游戏被分发到它的几千个合作网站，广告收入分成（开发者约净收入 33%，出处见 `platforms/gamedistribution.md`） | **9/29 被拒**（"不符合目录"）；对方说有其他平台的数据可申请复审 | 等 CrazyGames 数据后复审 |
| 2 | **CrazyGames** | 广告分成；先过 Basic Launch（≥7 天、≥500 次游玩）才进正式上线 | 试运行期间**没有**广告收入，约 3–5 周后 | 需要你注册、提交 |
| 3 | **Armor Games / Addicting Games 赞助** | 一次性赞助或授权费 | 谈成即付 | Armor 未回复（9/30 跟进） |
| 4 | **itch.io、Newgrounds** | 曝光和评价为主，收入很少 | 当天上线 | 需要你注册 |
| 5 | 自有网站广告（Google H5 Games Ads） | 插屏 + 激励广告 | 数周（要申请 beta、AdSense 审核） | 需要**自己的域名**（vercel.app 子域名不行）和 AdSense 账号 |
| 6 | 外观内购 | 卖皮肤，不卖数值 | 平台邀请后（CrazyGames 通过 Xsolla） | 等平台数据 |

**结论（2026-10-01 更新）**：GD 被拒后，本周全力做 2（CrazyGames）和 4（itch.io、Newgrounds），并行推进 3；拿到 CrazyGames 数据后回头申请 GD 复审；5、6 放到第 2–4 周。

## 2. 已完成（团队，2026-09-26）

- ✅ 法律页填好并上线：运营者 Zhuleli，联系邮箱 cityhunters2025@gmail.com，适用纽约州法律，数据存于美国（Supabase）。网址：
  - 隐私政策 `https://grow-everything.vercel.app/legal/privacy.html`
  - 用户协议 `https://grow-everything.vercel.app/legal/terms.html`
  - 致谢 `https://grow-everything.vercel.app/legal/credits.html`
- ✅ 平台素材：5 张 1920×1080 真实游戏截图（`marketing/press-kit/screenshots/`），7 个尺寸的封面（`marketing/press-kit/covers/`）。
- ✅ 三个平台包可随时重打（通用 / GameDistribution / 无 SDK）。
- ⚠️ MSN Games 首封邮件被退信（`webgames@microsoft.com` 返回 550 拒收），该渠道暂缓，找到现行投稿入口前不再发送。

## 3. 需要你做的（按顺序，每步约 10 分钟）

### 第 1 步：把 Supabase 公开配置发给我（2 分钟）
Supabase 后台 → Project Settings → API，复制 **Project URL** 和 **anon public key** 发给我。
anon key 本来就会打包进网页，可以公开；**千万不要发 service_role key**。
没有它，平台版只能单人对战 AI，好友联机用不了。

### 第 2 步：GameDistribution（最快有广告收入）
1. 打开 https://gamedistribution.com/developers/ → Sign up，用 cityhunters2025@gmail.com 注册；**自己阅读并接受开发者协议**。
2. 后台 **Add game** → 游戏名 `GROW EVERYTHING` → 拿到 **Game ID**（一串 UUID），发给我。
3. 我用 Game ID 打 `dist-portal-gamedistribution.zip` 发给你；你上传 zip，粘贴 `platforms/gamedistribution.md` 第 6 节文案，上传封面和截图。
4. 按 GD 要求在后台的测试 iframe 里完整看完一次测试广告，激活 SDK → **Submit**。

### 第 3 步：CrazyGames（最大流量，拿数据）
1. https://developer.crazygames.com/ → 注册，**自己阅读并接受条款**，填收款信息（PayPal 或银行）。
2. 我发 `dist-portal.zip`（带联机配置）给你 → 门户 **Submit game** → HTML5 → 上传 → 粘贴 `platforms/crazygames.md` 第 6 节文案 → 上传封面 → Submit for review。
3. 条款里如有「Full Launch 后浏览器独占 2 个月」，截图发我，我来排其他平台的上线顺序。

### 第 4 步：itch.io + Newgrounds（当天上线）
- itch.io：https://itch.io/register → Upload new project → Kind: HTML → 上传 `dist-portal.zip` → 勾选「This file will be played in the browser」→ 视口 1280×720 → 粘贴 `platforms/itch-io.md` 文案 → 封面用 `cover-630x500.png` → Public。
- Newgrounds：https://www.newgrounds.com/projects/games → 新建 → 上传 zip → 粘贴 `platforms/newgrounds.md` 文案。

每完成一步回我一句「GD 注册好了，Game ID 是 …」这类话即可；门户里遇到不确定的选项，截图发我。

## 4. 团队接下来做的（不需要你操作）

| 什么时候 | 做什么 |
| --- | --- |
| 收到 Supabase 配置当天 | 重打三个平台包，在 640×480 和手机尺寸的 iframe 里回归测试，发给你 |
| 收到 Game ID 当天 | 打 GD 包，用 GD 官方测试模式验证 pre-roll、mid-roll、激励广告 |
| 9/30 | 查 Armor Games 回复；未回复则写跟进草稿给你确认 |
| 本周 | 查 Addicting Games、Y8、GamePix 现行投稿入口，建档后写首封邮件草稿 |
| 上线后每周五 | 数据卡：各平台游玩次数、平均时长、广告收入（只报后台真实数字） |
| 第 2 周 | 评估自有域名 + Google H5 Games Ads（要花钱买域名，先给你报价再决定） |

## 5. 已知风险

- **多人服务器费用**：GD 分发到几千个网站后，Supabase 实时连接数可能上涨；每周看一次，超过免费额度前提醒你。
- **Basic Launch 没收入**：CrazyGames 试运行期间无广告收入，不要把它当作第一笔收入来源。
- **截图里的黑色建筑**：部分逆光角度下建筑立面会变成纯黑（上海 70 秒截图），已排除出素材包，列入画面待修清单。
