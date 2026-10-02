# GROW EVERYTHING — Suno 音乐提示词包（可爱洗脑版，2026-09-26）

**风格方向**：游戏很可爱（大眼珠小机器越吃越大），所以音乐也要**可爱、明亮、洗脑**。要点：
- 大调、每分钟约 120 拍，一段 **2 小节的「一问一答」旋律反复出现**，听两遍就会哼；
- 音色像玩具：玩具钢琴、马林巴、八音盒、口哨、尤克里里、会「嘣」一下的弹簧贝斯；
- 前 3 秒就进主旋律，**不要人声**（第 6 首除外），适合无缝循环。

游戏里已经有同样思路的程序音乐（`game/src/audio/themes.ts`，试听：`renders/audio/`）。Suno 版是它的「高配替身」：导出后按文件名放进 `public/music/`，游戏会自动替换内置音乐。

## 在 Suno 里怎么操作

1. **Create → Custom**，打开 **Instrumental**（纯音乐）。
2. 把 **Style** 粘进「Style of Music」，**Structure** 粘进「Lyrics」（纯音乐也能用结构标签控制段落），**Exclude** 粘进「Exclude styles」。
3. 每条提示词生成 2–4 个版本，**挑前 5 秒最抓耳的那个**。
4. 导出 MP3 → 改名 → 放进 `public/music/` → 提交代码，下次部署就生效。
5. **版权**：只有**付费订阅（Pro / Premier）期间**生成的曲子才能商用。游戏要上平台赚钱，必须用付费账号生成，并截图保存生成记录。

---

## 1. 上海 — 《外滩大胃王》 → `shanghai.mp3`

- **Style**：`cute kawaii Chinese pop instrumental, toy guzheng plucks, bouncy pentatonic earworm hook, marimba, music box, springy boing bass, handclaps, bright C major, 120 BPM, playful arcade game music, super catchy, loopable, instrumental`
- **Exclude**：`vocals, singing, sad, dark, dramatic, slow, lo-fi hiss, heavy drums`
- **Structure**：
  ```
  [Intro: toy guzheng plays the hook alone]
  [Hook: call and answer, 2 bars, repeat]
  [Hook: add marimba and handclaps]
  [Bridge: music box sparkles, bass bounces]
  [Hook: full band, happy]
  [Outro: hook once more, clean loop point]
  ```

## 2. 纽约 — 《嘀嘀出租车》 → `newyork.mp3`

- **Style**：`cute cartoon swing instrumental, toy piano and ukulele, "honk honk" bicycle horn hits, bouncy walking bass with boing slides, finger snaps, whistling hook, F major, 116 BPM, playful big city adventure, catchy earworm, loopable, instrumental`
- **Exclude**：`vocals, rap, singing, dark, trap hi-hats, aggressive`
- **Structure**：
  ```
  [Intro: two horn honks, then the toy piano hook]
  [Hook: whistled melody, call and answer]
  [Hook: snaps and walking bass join]
  [Bridge: ukulele strums, playful stop-time]
  [Hook: everyone together]
  [Outro: honk honk, loop]
  ```

## 3. 巴黎 — 《铁塔下午茶华尔兹》 → `paris.mp3`

- **Style**：`cute music box waltz, accordion and glockenspiel, pizzicato strings, oom-pah-pah bouncy bass, 3/4 time, bright C major, 138 BPM, whimsical cartoon café, sweet and catchy earworm melody, loopable, instrumental`
- **Exclude**：`vocals, singing, sad, melancholic, slow, techno`
- **Structure**：
  ```
  [Intro: music box plays the waltz hook]
  [Hook: accordion, call and answer]
  [Hook: pizzicato strings and glockenspiel]
  [Bridge: playful little chase, speeds up slightly]
  [Hook: full, twinkly]
  [Outro: music box, loop]
  ```

## 4. 废料城（加分关） — 《哔啵垃圾场》 → `scrap.mp3`

- **Style**：`cute robot chiptune pop, 8-bit bleeps and bloops, toy synth lead, clanky metal toy percussion, bouncy square bass, happy G major, 124 BPM, adorable little robot, catchy earworm hook, arcade, loopable, instrumental`
- **Exclude**：`vocals, singing, dark, industrial noise, distortion, scary`
- **Structure**：
  ```
  [Intro: robot beep-boop call]
  [Hook: chiptune melody, call and answer]
  [Hook: clanky toy drums join]
  [Bridge: bleep solo]
  [Hook: full]
  [Outro: power-down beep, loop]
  ```

## 5. 胜利音乐 — 《大胃王冠军》 → `victory.mp3`

第 1 名时播放。游戏只需要**开头 4–6 秒**。Suno 生成的曲子会更长，导出后用任意剪辑工具（剪映、Audacity）**只留开头的「哒哒哒——当！」**，末尾做 0.5 秒淡出。

- **Style**：`short triumphant cute victory fanfare jingle, toy brass and glockenspiel, rising arpeggio then big happy final chord, sparkly music box run, handclaps, C major, cartoon game win sound, joyful, instrumental`
- **Exclude**：`vocals, singing, long intro, sad, epic orchestral, dark`
- **Structure**：
  ```
  [Intro: da-da-da-DAAA fanfare]
  [Final chord with sparkles]
  [End]
  ```

## 6.（可选）短视频主题歌 — 《长大长大》（带人声，不进游戏）

留给以后 TikTok / 抖音用：一段洗脑的可爱合唱，一个 8–10 秒的循环片段就够。**现在是 ToB 阶段，这首可以先不做。**

- **Style**：`cute kawaii bubblegum pop, chipmunk-style cute vocals, toy piano, handclaps, bouncy, super catchy chant, 124 BPM, C major`
- **Lyrics**：
  ```
  [Chorus]
  Nom nom nom, I'm getting big!
  Eat the can, eat the car, eat the city!
  Grow grow grow, grow everything!
  Nom nom nom — one more bite!
  ```

## 7. 万圣节小镇（Halloween Town，2026-10-02）

这张图的一局分两半，各用一首（玩法见 `docs/halloween-mode.md`）：

| 文件 | 什么时候放 | 情绪 |
| --- | --- | --- |
| `halloween.mp3` | 上半场：吃糖果、长大 | **诡异但可爱**，像动画片里的怪物派对，一样洗脑 |
| `halloween-hunt.mp3` | 下半场：三个恐怖角色追所有人 | **紧张的追逐**，心跳感、越听越慌，但不刺耳、不一直很吵 |

写提示词的规矩：
- 只描述风格，**不写任何现成歌曲或电影配乐的名字**，也不要求模仿某一首的旋律（避免版权问题）。
- **纯音乐**。最多只留无歌词的「呜——」合声或一声怪笑，不要唱词。
- 要能**无缝循环**：开头不要淡入，结尾回到开头的和弦，不要淡出。
- 时长 1:30–3:00，响度约 −14 LUFS（和其他城市一致，游戏里会统一压到 BGM 的音量）。

游戏里已有同思路的程序音乐兜底（`themes.ts` 里的 `halloween` 和 `halloween-hunt`，试听：`renders/review/audio/bgm-halloween.wav`、`bgm-halloween-hunt.wav`）。把 Suno 导出的文件放进 `public/music/`，游戏会自动换成它。

### 7a. 上半场 — 《糖果墓园摇摆舞》 → `halloween.mp3`

- **Style**：`spooky cute Halloween novelty instrumental, playful monster party, toy harpsichord and cheesy combo organ hook in A minor, plucky pizzicato bass, xylophone skeleton-bone rattles, theremin-like whistle, finger snaps, bouncy 1960s cartoon rock-and-roll groove, 124 BPM, catchy creeping call and answer melody, funny not scary, loopable, instrumental`
- **Exclude**：`lyrics, singing, lead vocals, rap, gore, screaming, heavy metal, distortion, slow, sad, lo-fi hiss`
- **Structure**：
  ```
  [Intro: organ plays the creeping hook alone, no fade in]
  [Hook: call and answer, 2 bars, repeat]
  [Hook: pizzicato bass and finger snaps join]
  [Break: xylophone bone rattle, spooky "ooooh" choir, wordless]
  [Hook: full band, playful]
  [Bridge: harpsichord tiptoes, theremin whistle answers]
  [Hook: everyone together]
  [Outro: hook once more, ends on the opening chord, clean loop point]
  ```

### 7b. 下半场 — 《他们来了》 → `halloween-hunt.mp3`

- **Style**：`tense horror chase instrumental, driving low staccato string ostinato in E minor, heartbeat kick drum, dissonant brass and string stabs with minor seconds and tritones, eerie high music box bell, tremolo violins rising, ticking clock percussion, 150 BPM, suspenseful cartoon horror, scary but not gory, steady energy, loopable, instrumental`
- **Exclude**：`lyrics, singing, vocals, screaming, gore, dubstep, trap, heavy distortion, long silence, slow intro, fade out, happy`
- **Structure**：
  ```
  [Intro: heartbeat and low ostinato start immediately]
  [Chase: ostinato drives, tremolo strings climb]
  [Stab: dissonant hits, music box bell answers]
  [Chase: ticking percussion joins, tension builds]
  [Break: heartbeat alone for 2 bars, a distant wordless laugh]
  [Chase: full, relentless but not louder]
  [Outro: back to the opening ostinato, clean loop point]
  ```

**挑版本时注意**：下半场那首最容易越来越吵、越来越快。挑**从头到尾音量和速度都稳定**的版本；结尾突然加速或炸响的不要。上半场挑前 5 秒就能听出「万圣节」又能哼出来的。

**版权（请创意总监核对）**：Suno 的服务条款规定，**只有付费订阅期间生成的曲子才有商用权**，免费账号生成的歌只能非商用。这两首请用付费账号（Pro / Premier）生成，并截图保存生成记录；条款会变，生成前请在自己的套餐页面再确认一次。

---

## 已采用的版本（2026-09-26）

用户用 Suno 会员账号为每条提示词各生成了 a、b 两版。团队按「节拍稳不稳、能不能无缝循环、速度是否贴合提示词」挑选如下，想换哪一首直接说：

| 城市 | 采用 | 速度 | 循环长度 | 没选的那版 |
| --- | --- | --- | --- | --- |
| 上海 | a | 120 BPM（与提示词一致） | 112 秒 | b：前 4 秒节奏不稳，能循环的部分只有 62 秒 |
| 纽约 | b | 116 BPM（与提示词一致） | 83 秒 | a：前 30 秒节奏忽快忽慢，找不到对齐的循环点 |
| 巴黎 | a | 139 BPM，三拍子 | 93 秒 | b：同样能循环，音色更暗，玩具感弱一些 |
| 废料城 | b | 126 BPM | 46 秒 | a：前 27 秒节奏不稳，接缝相似度低 |
| 胜利 | a（Big Eater Champion） | 152 BPM | 取开头 6.4 秒 | b |

生成记录截图在 Google Drive 文件夹「GROW EVERYTHING music」。

## 放进游戏

| 文件 | 用在哪 |
| --- | --- |
| `public/music/shanghai.mp3` | 上海 |
| `public/music/newyork.mp3` | 纽约 |
| `public/music/paris.mp3` | 巴黎 |
| `public/music/scrap.mp3` | 废料城 |
| `public/music/victory.mp3` | 第 1 名的胜利音乐（替换内置合成号角） |
| `public/music/halloween.mp3` | 万圣节小镇上半场（还没生成时用内置程序音乐） |
| `public/music/halloween-hunt.mp3` | 万圣节小镇下半场「追杀」（还没生成时用内置程序音乐） |

BGM 建议 1:30–3:00、响度约 −14 LUFS；胜利音乐 4–6 秒。
