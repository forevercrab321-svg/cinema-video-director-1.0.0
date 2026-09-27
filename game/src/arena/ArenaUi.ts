import * as THREE from 'three';
import { arenaConfig as A } from '../config/arena';
import { SLOT_COLORS, VEHICLES, VEHICLE_ORDER, type VehicleLook } from '../config/vehicles';
import { CITIES } from '../world/cities';
import type { ArenaGame, Standing } from './ArenaGame';
import { awards } from './comedy';
import { L } from '../i18n';
import type { ArenaSession } from './ArenaSession';
import { progress } from './progress';
import { ArenaPanels, type PanelHooks } from './ArenaPanels';

/**
 * Arena UI (DOM over the canvas): lobby, in-round overlay (timer, scoreboard, kill feed,
 * countdown, respawn, name tags) and the results podium. Chinese first, English secondary.
 * Player names are other people's input: always set with textContent.
 */
const CSS = `
#arena { position: fixed; inset: 0; pointer-events: none; font-family: 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; color: #f2efe8; -webkit-font-smoothing: antialiased; z-index: 5; }
#arena .hex { font-variant-numeric: tabular-nums; }
#arena [hidden] { display: none !important; }
#hud .hint { display: none; } /* story onboarding prompt: not used in the arena */
#arena button { font: inherit; cursor: pointer; pointer-events: auto; }
#arena button:focus-visible { outline: 2px solid #ffb347; outline-offset: 2px; }
#arena .lobby { position: absolute; inset: 0; display: grid; grid-template-rows: auto 1fr auto; gap: 16px; padding: 22px max(16px, 3vw); pointer-events: auto;
  background: linear-gradient(180deg, rgba(12,13,15,.72), rgba(12,13,15,.35) 30%, rgba(12,13,15,.35) 70%, rgba(12,13,15,.8)); }
#arena .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
#arena .brand { font-size: 13px; font-weight: 800; letter-spacing: .3em; color: #ffb347; }
#arena .title { font-size: clamp(26px, 3.4vw, 40px); font-weight: 900; letter-spacing: .06em; line-height: 1.05; }
#arena .title small { display: block; font-size: 12px; font-weight: 700; letter-spacing: .28em; opacity: .6; margin-top: 4px; }
#arena .chip { font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,.08); letter-spacing: .06em; }
#arena .net { font-weight: 700; } #arena .net.ok { color: #7be08a; } #arena .net.bad { color: #ff8a7a; } #arena .net.wait { color: #ffd27a; } #arena .net small { font-weight: 400; opacity: .7; }
#arena .chip b { color: #8be07a; }
#arena .cols { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.1fr) minmax(240px, 1fr); gap: 16px; min-height: 0; }
#arena .col { background: rgba(16,18,20,.62); border-radius: 14px; padding: 14px; overflow: auto; backdrop-filter: blur(8px); }
#arena .h { font-size: 11px; font-weight: 800; letter-spacing: .24em; opacity: .6; margin-bottom: 10px; }
#arena .city { display: grid; grid-template-columns: 38px 1fr; gap: 10px; width: 100%; text-align: left; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.04); color: inherit; border-radius: 10px; padding: 10px; margin-bottom: 8px; }
#arena .city[aria-pressed="true"] { border-color: #ffb347; background: rgba(255,179,71,.12); }
#arena .city:disabled { opacity: .45; cursor: default; }
#arena .city .lv { font-size: 22px; font-weight: 900; color: #ffb347; text-align: center; line-height: 1.2; }
#arena .city .lv small { display: block; font-size: 9px; letter-spacing: .14em; opacity: .7; }
#arena .city .nm { font-size: 16px; font-weight: 800; }
#arena .city .nm span { font-size: 11px; opacity: .6; margin-left: 6px; letter-spacing: .08em; }
#arena .city .tg { font-size: 12px; opacity: .7; margin-top: 2px; }
#arena .slot { display: grid; grid-template-columns: 12px 1fr auto; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.04); margin-bottom: 8px; min-height: 44px; }
#arena .slot i { width: 12px; height: 12px; border-radius: 3px; }
#arena .slot .n { font-weight: 800; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#arena .slot .n em { font-style: normal; font-size: 10px; font-weight: 800; letter-spacing: .12em; color: #16181a; background: #ffb347; border-radius: 3px; padding: 1px 5px; margin-left: 6px; }
#arena .slot .v { font-size: 11px; opacity: .65; }
#arena .slot .st { font-size: 11px; font-weight: 800; letter-spacing: .1em; }
#arena .slot.empty { opacity: .5; }
#arena .veh { display: grid; gap: 4px; width: 100%; text-align: left; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.04); color: inherit; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
#arena .veh[aria-pressed="true"] { border-color: #ffb347; background: rgba(255,179,71,.12); }
#arena .veh .nm { font-weight: 800; font-size: 15px; display: flex; align-items: center; gap: 8px; }
#arena .veh .nm i { width: 14px; height: 14px; border-radius: 50%; }
#arena .veh .bl { font-size: 11px; opacity: .65; }
#arena .bars { display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; font-size: 10px; letter-spacing: .08em; opacity: .85; margin-top: 4px; align-items: center; }
#arena .bars b { display: block; height: 4px; border-radius: 2px; background: rgba(255,255,255,.12); }
#arena .bars b i { display: block; height: 100%; border-radius: 2px; background: #ffb347; }
#arena .foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
#arena .rules { font-size: 12px; opacity: .75; line-height: 1.6; max-width: 62ch; }
#arena .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
#arena .btn { border: 0; border-radius: 10px; padding: 12px 18px; font-weight: 800; letter-spacing: .08em; background: rgba(255,255,255,.1); color: #f2efe8; }
#arena .btn.primary { background: #ffb347; color: #16181a; }
#arena .btn:disabled { opacity: .4; cursor: default; }
#arena label.tog { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; pointer-events: auto; }
#arena .nick { display: flex; gap: 8px; align-items: center; font-size: 12px; font-weight: 700; margin-bottom: 10px; }
#arena .nick input { flex: 1; min-width: 0; font: inherit; font-size: 14px; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.15); background: rgba(0,0,0,.3); color: inherit; }
#arena .invite .btn { margin-top: 8px; }
#arena .invite { font-size: 12px; line-height: 1.6; opacity: .8; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.08); }
#arena .coins { color: #ffd35a; font-weight: 800; }
#arena .timer { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); text-align: center; text-shadow: 0 2px 8px rgba(0,0,0,.5); }
#arena .timer b { display: block; font-size: 30px; font-weight: 900; letter-spacing: .06em; }
#arena .timer span { font-size: 11px; font-weight: 800; letter-spacing: .24em; opacity: .75; }
#arena .board { position: absolute; top: 18px; right: 18px; width: 250px; padding: 10px 12px; border-radius: 12px; background: rgba(16,18,20,.5); backdrop-filter: blur(6px); }
#arena .row { display: grid; grid-template-columns: 16px 10px 1fr auto; gap: 8px; align-items: center; padding: 5px 0; font-size: 13px; }
#arena .row .rk { font-weight: 900; opacity: .7; }
#arena .row i { width: 10px; height: 10px; border-radius: 3px; }
#arena .row .nm { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#arena .row .ms { font-weight: 800; }
#arena .row .lv2 { grid-column: 3 / 5; font-size: 10px; opacity: .7; letter-spacing: .08em; margin-top: -3px; }
#arena .row.me .nm { color: #ffb347; }
#arena .row.out { opacity: .4; }
#arena .feed { position: absolute; right: 18px; top: 220px; width: 280px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
#arena .feed div { font-size: 12px; font-weight: 700; padding: 5px 10px; border-radius: 8px; background: rgba(16,18,20,.55); animation: feed 5s forwards; }
#arena .feed .kill { border-left: 3px solid #ff6b5a; } #arena .feed .bonus { border-left: 3px solid #ffd35a; } #arena .feed .bad { border-left: 3px solid #ff6b8a; }
@keyframes feed { 0% { opacity: 0; transform: translateX(10px); } 6% { opacity: 1; transform: none; } 85% { opacity: 1; } 100% { opacity: 0; } }
#arena .warm { position: absolute; top: 84px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-radius: 12px; background: rgba(40,28,10,.82); border: 1px solid #ffb347; font-size: 13px; font-weight: 800; letter-spacing: .03em; white-space: nowrap; pointer-events: auto; z-index: 3; }
#arena .warm .btn { padding: 7px 11px; font-size: 12px; }
#arena .warm .ws { display: none; }
#arena .center { position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%); text-align: center; text-shadow: 0 3px 14px rgba(0,0,0,.6); }
#arena .center b { display: block; font-size: 96px; font-weight: 900; line-height: 1; }
#arena .center span { font-size: 15px; font-weight: 800; letter-spacing: .24em; }
#arena .combo { position: absolute; left: 290px; bottom: 30px; font-size: 22px; font-weight: 900; color: #ffd35a; text-shadow: 0 2px 8px rgba(0,0,0,.5); }
#arena .map { position: absolute; right: 18px; bottom: 64px; width: 184px; height: 184px; border-radius: 14px; background: rgba(16,18,20,.55); backdrop-filter: blur(6px); }
#arena .tag.edge { background: rgba(16,18,20,.75); }
#arena .combo small { font-size: 12px; color: #8be07a; letter-spacing: .08em; }
#arena .combo small.pw { color: #9fd8ff; }
#arena .tag .say { display: block; font-size: 26px; line-height: 1.1; text-align: center; margin: -34px 0 4px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.5)); }
#arena .tag.me { background: none; border: 0 !important; }
#arena .emotes { position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; }
#arena .emotes button { border: 0; border-radius: 10px; background: rgba(16,18,20,.55); font-size: 20px; width: 40px; height: 40px; }
#arena .res .awards { margin-top: 12px; display: grid; gap: 4px; font-size: 13px; text-align: center; }
#arena .res .awards b { color: #ffb347; }
#arena .tag { position: absolute; transform: translate(-50%, -100%); font-size: 11px; font-weight: 800; letter-spacing: .06em; padding: 2px 7px; border-radius: 6px; background: rgba(16,18,20,.55); white-space: nowrap; }
#arena .res { position: absolute; inset: 0; display: grid; place-items: center; padding-inline: 16px; background: rgba(12,13,15,.55); pointer-events: auto; }
#arena .res .card { width: min(560px, 100%); padding: 26px; border-radius: 16px; background: rgba(20,21,23,.9); box-shadow: 0 30px 80px rgba(0,0,0,.5); }
#arena .res h2 { margin: 0; font-size: 34px; font-weight: 900; letter-spacing: .08em; text-align: center; }
#arena .res .who { text-align: center; font-size: 15px; font-weight: 800; color: #ffb347; margin-top: 6px; letter-spacing: .1em; }
#arena .res table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 13px; }
#arena .res td, #arena .res th { padding: 8px 6px; text-align: right; }
#arena .res th { font-size: 10px; letter-spacing: .16em; opacity: .6; font-weight: 800; }
#arena .res td:nth-child(2), #arena .res th:nth-child(2) { text-align: left; }
#arena .res tr.me td { color: #ffb347; font-weight: 800; }
#arena .res .earn { text-align: center; margin-top: 14px; font-size: 13px; }
#arena .res .actions { justify-content: center; margin-top: 16px; }
#arena .notice { position: absolute; bottom: 10%; left: 50%; transform: translateX(-50%); z-index: 4; padding: 10px 16px; border-radius: 12px; background: rgba(40,16,30,.92); border: 1px solid #ff7eb6; font-size: 14px; font-weight: 800; letter-spacing: .04em; white-space: nowrap; animation: feed 4.2s forwards; }
#arena .revive { position: absolute; top: calc(40% + 80px); left: 50%; transform: translateX(-50%); white-space: nowrap; }
#arena .res .earn .btn { margin-left: 10px; padding: 8px 12px; font-size: 12px; }
/* ?clip=1 — clean frame for marketing captures: mass HUD, banners and name tags only. */
body.ge-clip #arena .board, body.ge-clip #arena .map, body.ge-clip #arena .emotes, body.ge-clip #arena .feed, body.ge-clip #arena .combo, body.ge-clip #hud .legend, body.ge-clip .ge-full, body.ge-clip .ge-dash { display: none !important; }
body.ge-clip #arena .timer { top: auto; bottom: 28px; }
body:has(#arena .lobby:not([hidden])) .ge-dash, body:has(#arena .res:not([hidden])) .ge-dash { display: none; }
/* Phones play in landscape: HUD hugs the corners, thumbs own the bottom corners. */
@media (pointer: coarse), (max-height: 520px) {
  #arena .timer { top: calc(4px + env(safe-area-inset-top)); bottom: auto; } #arena .timer b { font-size: 20px; } #arena .timer span { font-size: 9px; letter-spacing: .12em; }
  #arena .board { top: calc(6px + env(safe-area-inset-top)); right: calc(8px + env(safe-area-inset-right)); width: 150px; padding: 5px 8px; } #arena .row { font-size: 10.5px; gap: 5px; padding: 1px 0; grid-template-columns: 10px 8px 1fr auto; } #arena .row .lv2 { display: none; }
  #arena .map { width: 96px; height: 96px; top: calc(98px + env(safe-area-inset-top)); right: calc(8px + env(safe-area-inset-right)); bottom: auto; left: auto; }
  #arena .feed { top: calc(92px + env(safe-area-inset-top)); left: calc(8px + env(safe-area-inset-left)); right: auto; width: 230px; align-items: flex-start; } #arena .feed div { font-size: 10px; padding: 3px 8px; }
  #arena .combo { left: calc(168px + env(safe-area-inset-left)); bottom: auto; top: calc(8px + env(safe-area-inset-top)); font-size: 14px; }
  #arena .center b { font-size: 56px; } #arena .center span { font-size: 12px; }
  #arena .emotes { left: 50%; right: auto; transform: translateX(-50%); bottom: calc(8px + env(safe-area-inset-bottom)); flex-direction: row; } #arena .emotes button { width: 42px; height: 42px; font-size: 22px; }
  #arena .warm { top: calc(52px + env(safe-area-inset-top)); font-size: 11px; padding: 4px 5px 4px 10px; gap: 6px; } #arena .warm .btn { padding: 5px 8px; font-size: 11px; } #arena .warm .wl { display: none; } #arena .warm .ws { display: inline; }
  #arena .notice { bottom: auto; top: 30%; font-size: 12px; padding: 7px 12px; }
  #arena .tag { font-size: 10px; }
  #arena .res .card { padding: 14px 18px; max-height: 92vh; overflow-y: auto; } #arena .res h2 { font-size: 22px; } #arena .res table { margin-top: 8px; font-size: 11px; } #arena .res td, #arena .res th { padding: 4px 6px; }
}
@media (max-width: 860px) { #arena .lobby { display: block; overflow-y: auto; } #arena .lobby > * { margin-bottom: 14px; } #arena .col { overflow: visible; } #arena .cols { grid-template-columns: 1fr; } }
@media (pointer: coarse) and (orientation: landscape), (max-height: 520px) and (min-width: 600px) {
  #arena .lobby { display: block; overflow-y: auto; padding: calc(8px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) 12px calc(12px + env(safe-area-inset-left)); }
  #arena .lobby > * { margin-bottom: 10px; }
  #arena .title { font-size: 22px; } #arena .brand { font-size: 10px; } #arena .title small { font-size: 9px; }
  #arena .cols { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  #arena .col { padding: 10px; overflow: visible; } #arena .h { margin-bottom: 6px; }
  #arena .city, #arena .veh { padding: 7px 9px; margin-bottom: 6px; } #arena .slot { padding: 7px 9px; margin-bottom: 6px; min-height: 0; }
  #arena .veh .bars { display: none; } #arena .rules { font-size: 10.5px; }
  #arena .btn { padding: 10px 14px; }
}
`;

const STAT = (v: number, lo: number, hi: number) => Math.round(Math.max(0.08, Math.min(1, (v - lo) / (hi - lo))) * 100);

export class ArenaUi {
  readonly el = document.createElement('div');
  private readonly lobby: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly results: HTMLElement;
  private readonly tags = new Map<string, HTMLElement>();
  private lastFeedAt = 0;
  private mapAt = 0;
  /** Epoch whose "friend joined, new round" notice was already shown. */
  private joinedNoticeEp = -1;
  onStory: (() => void) | null = null;
  onEmote: ((id: number) => void) | null = null;
  onShare: (() => void) | null = null;
  /** Toggle follow / first-person camera (🎥 button; V on a keyboard). */
  onCamera: (() => void) | null = null;
  /** Runs before a Start click starts the round (portal ad break tied to the click); never rejects. */
  onBeforeStart: (() => Promise<void>) | null = null;
  /** Rewarded ads (platform SDK): null / false hides the ad buttons. */
  adsAvailable = false;
  onRevive: (() => void) | null = null;
  onDoubleCoins: ((coins: number) => Promise<boolean>) | null = null;
  /** Share URL for this room (portal SDKs build their own invite links). */
  inviteUrl: () => Promise<string> = async () => location.href;
  /** Shop and settings modals (hooks set by the arena entry). */
  panels!: ArenaPanels;

  constructor(
    private readonly session: ArenaSession,
    private readonly modeLabel: string,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el.id = 'arena';
    this.el.innerHTML = `<div class="lobby"></div><div class="overlay" hidden></div><div class="res" hidden></div>`;
    document.body.appendChild(this.el);
    if (new URLSearchParams(location.search).get('clip') === '1') document.body.classList.add('ge-clip');
    this.lobby = this.el.querySelector('.lobby') as HTMLElement;
    this.overlay = this.el.querySelector('.overlay') as HTMLElement;
    this.results = this.el.querySelector('.res') as HTMLElement;
    this.renderLobby();
  }

  installPanels(hooks: PanelHooks): void {
    this.panels = new ArenaPanels(this.el, hooks);
  }

  // ── Lobby ─────────────────────────────────────────────────────────────────
  renderLobby(): void {
    const s = this.session;
    const inLobby = s.match.ph === 'lobby';
    this.lobby.hidden = !inLobby;
    this.overlay.hidden = inLobby;
    if (!inLobby) return;
    const host = s.isHost();
    const players = s.lobbyPlayers();
    const me = players.find((p) => p.isMe);
    const specs = s.spectators().length;
    const prog = progress();
    const online = this.modeLabel;
    const peersN = s.net.peers().length;
    // Online rooms: say whether the realtime link is up, so "only me online" is never a mystery.
    const link = s.net as { status?: string; statusDetail?: string };
    const linkLine =
      link.status === 'connected'
        ? `<span class="net ok">🟢 ${L('联机已连接', 'Online: connected')}</span>`
        : link.status === 'error'
          ? `<span class="net bad">🔴 ${L('联机服务连接失败，正在重试；现在只能和 AI 玩', 'Online service unreachable, retrying — AI only for now')} <small>(${(link.statusDetail ?? '').replace(/[<>&"]/g, '')})</small></span>`
          : `<span class="net wait">⏳ ${L('正在连接联机服务…', 'Connecting to the online service…')}</span>`;
    const invite =
      s.net.kind === 'online'
        ? `${linkLine}<br>${L('房间号', 'Room')} <b class="code"></b> · ${L('把链接发给好友就能一起玩（最多 4 人）', 'Send the link to friends to play together (up to 4)')}<br>🎁 ${L('分享就送派对帽，和好友打完一局送限定涂装', 'Share for a free Party Hat; play a match with a friend for an exclusive skin')}<br><button class="btn primary" data-a="copy">📣 ${L('邀请好友（微信 / 抖音 / 小红书…）', 'Invite friends (WhatsApp / TikTok / IG…)')}</button>`
        : s.net.kind === 'room'
          ? L('邀请好友：点页面右上角的 <b>Share</b>，给好友「可互动」或更高权限，再把链接发给他们。好友用自己的 Claude 账号登录打开即可加入。', 'Invite friends: click <b>Share</b> (top right), give them “can interact”, and send them the link. They join with their own Claude account.')
          : s.net.kind === 'local'
            ? L('本地多开测试：同一浏览器再开一个标签页即可加入。', 'Local test: open another tab in this browser to join.')
            : `${L('单人模式：AI 对手补满 4 个位置。', 'Solo: AI rivals fill the empty slots.')}<br><button class="btn primary" data-a="copy">📣 ${L('分享游戏给好友', 'Share the game')}</button>`;
    this.lobby.innerHTML = `
      <div class="top">
        <div><div class="brand">GROW EVERYTHING</div><div class="title">${L('竞技场', 'Arena')}<small>${L('最多 4 人 · 吞下整座城市', 'Up to 4 players · eat the city')}</small></div></div>
        <div class="actions"><span class="chip">${online} · <b>${peersN}</b> ${L('人在线', 'online')}${specs ? ` · ${specs} ${L('人观战', 'watching')}` : ''}</span><span class="chip coins">◎ ${prog.coins}</span><button class="btn" data-a="shop">🛒 ${L('商店', 'Shop')}</button><button class="btn" data-a="settings" aria-label="${L('设置', 'Settings')}">⚙</button><button class="btn" data-a="story">${L('剧情模式', 'Story')}</button></div>
      </div>
      <div class="cols">
        <div class="col"><div class="h">${L('关卡', 'Levels')}${host ? '' : L(' · 由房主选择', ' · host picks')}</div><div class="cities"></div></div>
        <div class="col"><div class="h">${L('玩家', 'Players')}</div>${s.net.kind === 'room' ? '' : `<label class="nick">${L('昵称', 'Name')} <input maxlength="16" aria-label="${L('昵称', 'Name')}"></label>`}<div class="slots"></div>
          <div class="invite">${invite}</div></div>
        <div class="col"><div class="h">${L('选择车辆', 'Vehicle')}</div><div class="vehs"></div></div>
      </div>
      <div class="foot">
        <div class="rules">${L(
          `规则：比对手大 25% 就能把它整个吞掉（得到它 60% 的质量）。每人 3 条命，被吞后留 45% 质量重生。${A.roundSeconds / 60} 分钟结束，或只剩一人，或地标被拆完。金色箱子、连击、第一滴血、吞掉第一名（悬赏）、拆掉地标最后一块都有奖励；落后的人吃东西有追赶加成；道具箱：⚡加速、🧲强磁、🛡护盾（不会被吃）；冲刺撞上吃不动的东西会被眩晕并掉质量。`,
          `Rules: be 25% bigger than a rival to swallow it whole (you get 60% of its mass). 3 lives each; when eaten you respawn with 45% of your mass. The round ends after ${A.roundSeconds / 60} minutes, when one machine is left, or when the landmark is torn down. Golden crates, combos, first blood, the leader's bounty and the last landmark piece all pay extra; machines behind the leader get a catch-up bonus. Power-ups: ⚡ speed, 🧲 magnet, 🛡 shield (can't be eaten). Dashing into something you can't eat stuns you and costs mass.`,
        )}</div>
        <div class="actions">
          <button class="btn" data-a="join">${me ? L('离开 · 观战', 'Leave · spectate') : L('加入比赛', 'Join')}</button>
          ${me && !host ? `<button class="btn" data-a="ready">${s.ready ? L('取消准备', 'Not ready') : L('准备', 'Ready')}</button>` : ''}
          ${host ? `<label class="tog"><input type="checkbox" id="arena-bots" ${s.bots ? 'checked' : ''}> ${L('AI 对手补位', 'Fill with AI')}</label><button class="btn primary" data-a="start" ${s.canStart() ? '' : 'disabled'}>${s.warmupReady() ? L('先和 AI 热身 · 好友来了自动重开', 'Warm up vs AI · restarts when a friend joins') : L('开始比赛', 'Start')}</button>` : `<span class="chip">${L('等待房主开始', 'Waiting for the host')}</span>`}
        </div>
      </div>`;
    // Cities.
    const cities = this.lobby.querySelector('.cities') as HTMLElement;
    for (const c of CITIES) {
      const locked = c.level > prog.unlocked;
      const b = document.createElement('button');
      b.className = 'city';
      b.setAttribute('aria-pressed', String(s.city === c.id));
      b.disabled = !host || locked;
      b.innerHTML = `<div class="lv">${c.level || '★'}<small>${c.level ? L('关', 'LEVEL') : L('加分', 'BONUS')}</small></div><div><div class="nm"></div><div class="tg"></div></div>`;
      (b.querySelector('.nm') as HTMLElement).innerHTML = `${L(c.nameZh, c.name)}<span>${L(c.name.toUpperCase(), '')}</span>${locked ? ' 🔒' : ''}`;
      (b.querySelector('.tg') as HTMLElement).textContent = locked ? L(`赢下第 ${c.level - 1} 关解锁`, `Win level ${c.level - 1} to unlock`) : L(c.taglineZh ?? c.tagline, c.tagline);
      b.onclick = () => {
        s.setCity(c.id);
        this.renderLobby();
      };
      cities.appendChild(b);
    }
    // Slots.
    const slots = this.lobby.querySelector('.slots') as HTMLElement;
    for (let i = 0; i < A.maxPlayers; i++) {
      const p = players[i];
      const d = document.createElement('div');
      d.className = `slot${p ? '' : ' empty'}`;
      d.innerHTML = `<i style="background:#${SLOT_COLORS[i].toString(16).padStart(6, '0')}"></i><div><div class="n"></div><div class="v"></div></div><div class="st"></div>`;
      const n = d.querySelector('.n') as HTMLElement;
      if (p) {
        n.textContent = p.name;
        if (p.isMe) n.insertAdjacentHTML('beforeend', `<em>${L('你', 'you')}</em>`);
        (d.querySelector('.v') as HTMLElement).textContent = `${L(VEHICLES[p.vehicle].nameZh, VEHICLES[p.vehicle].name)}${p.guest ? L(' · 访客', ' · guest') : ''}`;
        (d.querySelector('.st') as HTMLElement).textContent = p.id === s.hostId() ? L('房主', 'Host') : p.ready ? L('已准备', 'Ready') : L('未准备', 'Not ready');
      } else {
        n.textContent = s.bots ? L('AI 对手', 'AI rival') : L('等待玩家…', 'Waiting for a player…');
        (d.querySelector('.v') as HTMLElement).textContent = s.bots ? L('开局时自动补位', 'Joins when the round starts') : L('空位', 'Open slot');
      }
      slots.appendChild(d);
    }
    // Vehicles.
    const vehs = this.lobby.querySelector('.vehs') as HTMLElement;
    for (const id of VEHICLE_ORDER) {
      const v = VEHICLES[id];
      const b = document.createElement('button');
      b.className = 'veh';
      b.setAttribute('aria-pressed', String(s.vehicle === id));
      b.innerHTML = `<div class="nm"><i style="background:#${v.shell.toString(16).padStart(6, '0')}"></i>${L(v.nameZh, v.name)} <span style="opacity:.6;font-size:11px">${L(v.name, '')}</span></div><div class="bl"></div>
        <div class="bars"><span>${L('速度', 'Speed')}</span><b><i style="width:${STAT(v.speed, 0.7, 1.3)}%"></i></b><span>${L('加速', 'Accel')}</span><b><i style="width:${STAT(v.accel, 0.6, 1.4)}%"></i></b><span>${L('吸取', 'Reach')}</span><b><i style="width:${STAT(v.reach, 0.6, 1.7)}%"></i></b><span>${L('吞噬', 'Bite')}</span><b><i style="width:${STAT(2 - v.eatRatio, 0.85, 1.12)}%"></i></b></div>`;
      (b.querySelector('.bl') as HTMLElement).textContent = L(v.blurbZh, v.blurb);
      b.onclick = () => {
        s.setVehicle(id as VehicleLook);
        this.renderLobby();
      };
      vehs.appendChild(b);
    }
    const code = this.lobby.querySelector('.invite .code');
    if (code) code.textContent = new URL(location.href).searchParams.get('room') ?? '';
    const nick = this.lobby.querySelector('.nick input') as HTMLInputElement | null;
    if (nick) {
      nick.value = s.name;
      nick.onchange = () => {
        s.setNickname(nick.value);
        try {
          localStorage.setItem('grow-arena-name', s.name);
        } catch {
          /* private mode */
        }
        this.renderLobby();
      };
    }
    this.lobby.querySelectorAll('[data-a]').forEach((el) => {
      (el as HTMLButtonElement).onclick = () => {
        const a = (el as HTMLElement).dataset.a;
        if (a === 'join') s.setJoined(!me);
        else if (a === 'ready') s.setReady(!s.ready);
        else if (a === 'start') void (this.onBeforeStart?.() ?? Promise.resolve()).catch(() => undefined).then(() => s.start());
        else if (a === 'story') this.onStory?.();
        else if (a === 'shop') return this.panels?.showShop();
        else if (a === 'settings') return this.panels?.showSettings();
        else if (a === 'copy') {
          this.onShare?.();
          return;
        }
        this.renderLobby();
      };
    });
    const bots = this.lobby.querySelector('#arena-bots') as HTMLInputElement | null;
    if (bots) bots.onchange = () => {
      s.setBots(bots.checked);
      this.renderLobby();
    };
  }

  // ── In round ──────────────────────────────────────────────────────────────
  renderRound(g: ArenaGame): void {
    const s = this.session;
    if (s.match.ph === 'lobby') return;
    if (!this.overlay.dataset.built) {
      this.overlay.dataset.built = '1';
      this.overlay.innerHTML = `<div class="timer"><b class="hex">5:00</b><span></span></div><div class="board"></div><div class="feed"></div><div class="warm" hidden><span class="wl">🔥 ${L('热身中 · 等好友加入，好友一来自动重新开局', 'Warm-up · a friend joining restarts the round')}</span><span class="ws">🔥 ${L('热身中 · 好友来了自动重开', 'Warm-up · restarts when a friend joins')}</span><button class="btn primary" data-w="invite">📣 ${L('邀请', 'Invite')}</button><button class="btn" data-w="leave">${L('退出热身', 'Leave')}</button></div><div class="center"></div><button class="btn primary revive" hidden>📺 ${L('看广告复活 · 保留 75% 质量', 'Watch an ad: revive with 75% mass')}</button><div class="combo"></div><div class="tags"></div><canvas class="map" width="368" height="368" aria-label="minimap"></canvas><div class="emotes" aria-label="emotes"><button data-e="1" title="1">😂</button><button data-e="3" title="3">👋</button><button data-e="4" title="4">🐷</button><button data-e="6" title="H">📯</button><button class="cam" title="V" aria-label="${L('切换视角', 'Switch camera')}">🎥</button></div>`;
      this.overlay.querySelectorAll<HTMLButtonElement>('.emotes button[data-e]').forEach((b) => (b.onclick = () => this.onEmote?.(Number(b.dataset.e))));
      (this.overlay.querySelector('.emotes .cam') as HTMLButtonElement).onclick = () => this.onCamera?.();
      g.onFeed = (text, tone) => this.feed(text, tone);
      (this.overlay.querySelector('.revive') as HTMLButtonElement).onclick = () => this.onRevive?.();
      (this.overlay.querySelector('[data-w="invite"]') as HTMLButtonElement).onclick = () => this.onShare?.();
      (this.overlay.querySelector('[data-w="leave"]') as HTMLButtonElement).onclick = () => this.session.leaveWarmup();
    }
    (this.overlay.querySelector('.warm') as HTMLElement).hidden = !(s.match.wu && s.isHost() && s.match.ph !== 'results');
    if (s.match.wj && this.joinedNoticeEp !== s.match.ep) {
      this.joinedNoticeEp = s.match.ep;
      this.notice(L(`${s.match.wj} 加入了！正式开局`, `${s.match.wj} joined! New round`));
    }
    (this.overlay.querySelector('.revive') as HTMLElement).hidden = !(this.adsAvailable && g.canRevive());
    const left = Math.max(0, A.roundSeconds - g.matchTime);
    (this.overlay.querySelector('.timer b') as HTMLElement).textContent = `${Math.floor(left / 60)}:${Math.floor(left % 60).toString().padStart(2, '0')}`;
    const climax = g.world.objects.filter((o) => o.def.climax).length;
    (this.overlay.querySelector('.timer span') as HTMLElement).textContent = `${L(g.city.nameZh, g.city.name)} · ${L(g.city.climaxNameZh, g.city.climaxName.replace(/^the /, ''))} ${climax - g.climaxLeft()}/${climax}`;
    // Scoreboard.
    const board = this.overlay.querySelector('.board') as HTMLElement;
    const rows = [...g.actors].sort((a, b) => (a.eliminated !== b.eliminated ? (a.eliminated ? 1 : -1) : b.mass - a.mass));
    board.textContent = '';
    rows.forEach((a, i) => {
      const r = document.createElement('div');
      r.className = `row${a === g.local ? ' me' : ''}${a.eliminated ? ' out' : ''}`;
      r.innerHTML = `<span class="rk">${i + 1}</span><i style="background:#${SLOT_COLORS[a.slot % 4].toString(16).padStart(6, '0')}"></i><span class="nm"></span><span class="ms hex"></span><span class="lv2"></span>`;
      (r.querySelector('.nm') as HTMLElement).textContent = (i === 0 && !a.eliminated ? '👑 ' : '') + a.name + (a === g.local ? L('（你）', ' (you)') : '');
      (r.querySelector('.ms') as HTMLElement).textContent = massText(a.mass);
      (r.querySelector('.lv2') as HTMLElement).textContent = `${'♥'.repeat(a.lives)}${'♡'.repeat(Math.max(0, A.lives - a.lives))} · ${L('吞', 'ate')} ${a.kills} · ${L(a.vehicle.nameZh, a.vehicle.name)}${a.eliminated ? L(' · 出局', ' · out') : !a.alive ? L(' · 重生中', ' · respawning') : ''}`;
      board.appendChild(r);
    });
    // Centre message.
    const center = this.overlay.querySelector('.center') as HTMLElement;
    const me = g.local;
    if (g.phase === 'countdown') center.innerHTML = `<b>${Math.max(1, Math.ceil(g.countdown))}</b><span>${L('准备', 'GET READY')}</span>`;
    else if (g.phase === 'playing' && g.matchTime < 1.2) center.innerHTML = `<b>GO</b><span>${L('开吃！', 'EAT!')}</span>`;
    else if (me && me.eliminated) center.innerHTML = `<span>${L('已出局 · 观战中（点击切换视角）', 'Eliminated · spectating (tap to switch)')}</span>`;
    else if (me && !me.alive && !isFinite(me.respawnAt)) center.innerHTML = `<span>${L('广告播放中…', 'Ad playing…')}</span>`;
    else if (me && !me.alive) center.innerHTML = `<b>${Math.max(0, me.respawnAt - g.matchTime).toFixed(1)}</b><span>${L('重生中', 'RESPAWNING')}</span>`;
    else if (!me && s.match.wu) center.innerHTML = `<span>${L('房主正在热身 · 马上为你重新开局…', 'The host is warming up · a new round starts for you now…')}</span>`;
    else if (!me) center.innerHTML = `<span>${g.phase === 'playing' && A.roundSeconds - g.matchTime > A.dropInCutoffSeconds ? L('观战中 · 有空位会自动加入', 'Spectating · you join as soon as a slot frees up') : L('观战中 · 下一局可加入', 'Spectating · join next round')}</span>`;
    else center.textContent = '';
    const combo = this.overlay.querySelector('.combo') as HTMLElement;
    const cu = me && me.alive ? g.catchUp(me) : 1;
    const parts: string[] = [];
    if (me && me.combo >= 2 && g.time <= me.comboUntil) parts.push(`${L('连击', 'Combo')} ×${Math.min(A.comboMax, 1 + A.comboStep * (me.combo - 1)).toFixed(1)}`);
    if (cu > 1.05) parts.push(`<small>${L('追赶加成', 'Catch-up')} +${Math.round((cu - 1) * 100)}%</small>`);
    if (me && me.alive) {
      const t = g.matchTime;
      for (const [until, label] of [[me.speedUntil, L('⚡ 加速', '⚡ Speed')], [me.magnetUntil, L('🧲 强磁', '🧲 Magnet')], [me.shieldUntil, L('🛡 护盾', '🛡 Shield')]] as const) if (t < until) parts.push(`<small class="pw">${label} ${Math.ceil(until - t)}s</small>`);
    }
    combo.innerHTML = parts.join('<br>');
    this.renderTags(g);
    if (performance.now() - this.mapAt > 90) {
      this.mapAt = performance.now();
      this.renderMap(g);
    }
  }

  /** North-up minimap: standing structures, landmark parts, golden crates and every machine. */
  private renderMap(g: ArenaGame): void {
    const cv = this.overlay.querySelector('canvas.map') as HTMLCanvasElement | null;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const b = g.city.bounds;
    const W = cv.width;
    const pad = 14;
    const k = (W - pad * 2) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const mx = (x: number) => pad + (x - b.minX) * k;
    const mz = (z: number) => pad + (z - b.minZ) * k;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.fillRect(pad, pad, (b.maxX - b.minX) * k, (b.maxZ - b.minZ) * k);
    const me = g.local;
    for (const o of g.world.objects) {
      if (o.state === 'absorbed') continue;
      const cls = o.def.objectClass;
      if (o.def.bonus || o.def.power) {
        ctx.fillStyle = o.def.power === 'speed' ? '#3fa9ff' : o.def.power === 'magnet' ? '#b05cff' : o.def.power === 'shield' ? '#3fe0c0' : '#ffd35a';
        ctx.beginPath();
        ctx.arc(mx(o.x), mz(o.z), 3, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      if (cls < 6 && !o.def.climax) continue;
      const edible = me && g.world.isEligible(o, me.power);
      ctx.fillStyle = o.def.climax ? (edible ? '#ffb347' : 'rgba(255,179,71,.55)') : edible ? 'rgba(140,224,122,.55)' : cls >= 7 ? 'rgba(210,214,220,.34)' : 'rgba(210,214,220,.18)';
      ctx.save();
      ctx.translate(mx(o.x), mz(o.z));
      ctx.rotate(-o.yaw);
      const [w, , d] = o.def.size;
      ctx.fillRect((-w / 2) * k, (-d / 2) * k, Math.max(2, w * k), Math.max(2, d * k));
      ctx.restore();
    }
    for (const a of g.actors) {
      if (!a.alive) continue;
      const x = mx(a.x);
      const z = mz(a.z);
      const r = Math.max(4, (a.diameter / 2) * k);
      ctx.fillStyle = `#${SLOT_COLORS[a.slot % 4].toString(16).padStart(6, '0')}`;
      ctx.beginPath();
      ctx.arc(x, z, r, 0, Math.PI * 2);
      ctx.fill();
      if (me && me.alive && a !== me) {
        const threat = g.canEat(a, me);
        const prey = g.canEat(me, a);
        if (threat || prey) {
          ctx.strokeStyle = threat ? '#ff4d4d' : '#8be07a';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, z, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (a === me) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, z, r + 2, 0, Math.PI * 2);
        ctx.moveTo(x, z);
        ctx.lineTo(x - Math.sin(a.heading) * (r + 12), z - Math.cos(a.heading) * (r + 12));
        ctx.stroke();
      }
    }
  }

  private renderTags(g: ArenaGame): void {
    const host = this.overlay.querySelector('.tags') as HTMLElement;
    const v = new THREE.Vector3();
    // Machines that left the roster (drop-in replaced them) lose their tag.
    for (const [id, tag] of this.tags) if (!g.byId.has(id)) (tag.remove(), this.tags.delete(id));
    for (const a of g.actors) {
      let tag = this.tags.get(a.id);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'tag';
        tag.style.borderBottom = `2px solid #${SLOT_COLORS[a.slot % 4].toString(16).padStart(6, '0')}`;
        host.appendChild(tag);
        this.tags.set(a.id, tag);
      }
      v.set(a.x, a.diameter * 1.25 + 0.3, a.z).project(g.camera);
      const saying = g.time < a.sayUntil && !!a.say;
      const show = a.alive && (a !== g.local || saying);
      tag.hidden = !show;
      if (!show) continue;
      const danger = g.local && g.local.alive ? (g.canEat(a, g.local) ? ' ⚠' : g.canEat(g.local, a) ? ' ✓' : '') : '';
      const onScreen = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      if (onScreen) {
        tag.classList.remove('edge');
        tag.style.transform = '';
        tag.textContent = a === g.local ? '' : `${a.name} · ${massText(a.mass)}${danger}`;
        tag.classList.toggle('me', a === g.local);
        if (saying) {
          const b = document.createElement('span');
          b.className = 'say';
          b.textContent = a.say;
          tag.prepend(b);
        }
        tag.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
        tag.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
      } else {
        // Off screen: pin to the edge, pointing the way.
        let ex = v.z > 1 ? -v.x : v.x;
        let ey = v.z > 1 ? -v.y : v.y;
        const m = Math.max(Math.abs(ex), Math.abs(ey)) || 1;
        ex = (ex / m) * 0.9;
        ey = (ey / m) * 0.84;
        if (ex > 0.6) ey = Math.max(ey, -0.2); // keep clear of the minimap (bottom-right)
        const arrow = Math.abs(ex) > Math.abs(ey) ? (ex > 0 ? '▶' : '◀') : ey > 0 ? '▲' : '▼';
        const dist = g.local ? Math.round(Math.hypot(a.x - g.local.x, a.z - g.local.z)) : 0;
        tag.classList.add('edge');
        tag.textContent = `${arrow} ${a.name}${danger} · ${dist} m`;
        tag.style.left = `${((ex + 1) / 2) * innerWidth}px`;
        tag.style.top = `${((1 - ey) / 2) * innerHeight + 12}px`;
        tag.style.transform = ex < -0.6 ? 'translate(0, -50%)' : ex > 0.6 ? 'translate(-100%, -50%)' : 'translate(-50%, -50%)';
      }
    }
  }

  private feed(text: string, tone: 'kill' | 'info' | 'bonus' | 'bad'): void {
    const f = this.overlay.querySelector('.feed') as HTMLElement | null;
    if (!f) return;
    const now = performance.now();
    if (tone === 'info' && now - this.lastFeedAt < 400) return;
    this.lastFeedAt = now;
    const d = document.createElement('div');
    d.className = tone;
    d.textContent = text;
    f.prepend(d);
    while (f.children.length > 5) f.lastElementChild!.remove();
    setTimeout(() => d.remove(), 5200);
  }

  // ── Results ───────────────────────────────────────────────────────────────
  showResults(standings: Standing[], localId: string | null, earned: { coins: number; unlocked: string | null }): void {
    const champ = standings[0];
    this.results.hidden = false;
    this.results.innerHTML = `<div class="card"><h2>👑 ${L('冠军', 'Champion')}</h2><div class="who"></div>
      <table><thead><tr><th>#</th><th>${L('玩家', 'Player')}</th><th>${L('质量', 'Mass')}</th><th>${L('吞噬', 'Eats')}</th><th>${L('被吞', 'Eaten')}</th><th>${L('物件', 'Items')}</th></tr></thead><tbody></tbody></table>
      <div class="awards"></div><div class="earn"></div><div class="actions">${this.session.isHost() ? `<button class="btn primary" data-a="again">${L('再来一局', 'Rematch')}</button><button class="btn" data-a="lobby">${L('返回大厅', 'Lobby')}</button>` : `<span class="chip">${L('等待房主：再来一局或返回大厅…', 'Waiting for the host…')}</span>`}</div></div>`;
    (this.results.querySelector('.who') as HTMLElement).textContent = champ ? `${champ.name} · ${massText(champ.mass)}` : '';
    const tb = this.results.querySelector('tbody') as HTMLElement;
    for (const s of standings) {
      const tr = document.createElement('tr');
      if (s.id === localId) tr.className = 'me';
      for (const v of [String(s.rank), s.name + (s.alive ? '' : L(' · 出局', ' · out')), massText(s.mass), String(s.kills), String(s.deaths), String(s.objects)]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    const aw = this.results.querySelector('.awards') as HTMLElement;
    for (const x of awards(standings)) {
      const d = document.createElement('div');
      d.append(Object.assign(document.createElement('b'), { textContent: x.name }), ` · ${x.title}`);
      aw.appendChild(d);
    }
    (this.results.querySelector('.earn') as HTMLElement).innerHTML = localId && standings.some((s) => s.id === localId) ? `${L('获得', 'Earned')} <span class="coins">◎ ${earned.coins}</span> ${L('金币', 'coins')}${earned.unlocked ? ` · ${L('解锁新关卡', 'New level unlocked')}: <b>${earned.unlocked}</b>` : ''}` : L('观战中', 'Spectating');
    if (this.adsAvailable && earned.coins > 0 && this.onDoubleCoins) {
      const dbl = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: `📺 ${L('看广告金币翻倍', 'Watch an ad: double coins')}` });
      dbl.onclick = async () => {
        dbl.disabled = true;
        const ok = await this.onDoubleCoins!(earned.coins);
        dbl.textContent = ok ? `✓ +${earned.coins}` : L('广告暂不可用', 'No ad available');
      };
      (this.results.querySelector('.earn') as HTMLElement).appendChild(dbl);
    }
    const share = Object.assign(document.createElement('button'), { className: 'btn', textContent: `📣 ${L('分享 / 邀请好友', 'Share / invite')}` });
    share.onclick = () => this.onShare?.();
    (this.results.querySelector('.actions') as HTMLElement).appendChild(share);
    const b = this.results.querySelector('[data-a="lobby"]') as HTMLButtonElement | null;
    if (b) b.onclick = () => this.session.toLobby();
    const again = this.results.querySelector('[data-a="again"]') as HTMLButtonElement | null;
    if (again) again.onclick = () => this.session.rematch();
  }

  /** A short message over whatever screen is up (gift unlocks and similar). */
  notice(text: string): void {
    const n = document.createElement('div');
    n.className = 'notice';
    n.textContent = text;
    this.el.appendChild(n);
    window.setTimeout(() => n.remove(), 4200);
  }

  hideResults(): void {
    this.results.hidden = true;
  }

  resetRound(): void {
    this.overlay.dataset.built = '';
    this.overlay.innerHTML = '';
    this.tags.clear();
  }

  dispose(): void {
    this.el.remove();
  }
}

export function massText(kg: number): string {
  if (kg < 100) return `${kg.toFixed(1)} kg`;
  if (kg < 10000) return `${Math.round(kg).toLocaleString('en-US')} kg`;
  return `${(kg / 1000).toFixed(kg < 100000 ? 1 : 0)} t`;
}
