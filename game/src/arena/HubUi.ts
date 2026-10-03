import { L, otherLangLabel, toggleLang } from '../i18n';
import { track } from '../backend/telemetry';
import { cityById } from '../world/cities';
import { newRoomCode, normalizeCode, type HubLike, type HubRoom } from '../net/Hub';
import { arenaConfig as A } from '../config/arena';
import { GE_TOKENS } from './uiTokens';

/**
 * The room browser (房间大厅): the first screen of the online arena when the link names no room.
 * Other people are visible before anything else — a live "N online · M rooms" counter and the
 * public rooms — and three actions get you playing:
 *   🤖 Quick play vs AI → your own room, the round vs AI starts at once; it is listed as
 *                          "warm-up vs AI", and anyone who joins restarts it as a real match
 *   ➕ Create room      → public (listed, anyone can join) or private (invite link / code only)
 *   🔢 Join by code     → a friend's room
 * Room states: waiting (green, Join) · warm-up vs AI (amber, Join — the host restarts with you) ·
 * playing (Watch, or Drop in on an AI seat; "ends in ~N s") · results (Join — next round soon) ·
 * full (disabled). Names and cities are other people's input: textContent only.
 */
export type HubChoice = { kind: 'room'; code: string; from: 'quick' | 'list' | 'code' | 'create'; create: boolean; pub: boolean; warmup: boolean };

const CSS = `
#ge-hub { ${GE_TOKENS} position: fixed; inset: 0; z-index: 6; font-family: 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; color: var(--ge-ink); -webkit-font-smoothing: antialiased;
  display: grid; grid-template-rows: auto minmax(0, 1fr); gap: var(--ge-s4);
  padding: calc(var(--ge-s4) + var(--ge-st)) calc(max(16px, 3vw) + var(--ge-sr)) calc(var(--ge-s4) + var(--ge-sb)) calc(max(16px, 3vw) + var(--ge-sl));
  background: linear-gradient(180deg, rgba(12,13,15,.78), rgba(12,13,15,.42) 32%, rgba(12,13,15,.5) 70%, rgba(12,13,15,.86)); }
#ge-hub [hidden] { display: none !important; }
/* The hub owns the screen: no touch DASH / fullscreen corner / story HUD over it. */
body:has(#ge-hub) .ge-dash, body:has(#ge-hub) .ge-full, body:has(#ge-hub) #hud { display: none !important; }
#ge-hub .short { display: none; }
#ge-hub button, #ge-hub input { font: inherit; }
#ge-hub button { cursor: pointer; }
#ge-hub button:focus-visible, #ge-hub input:focus-visible { outline: 2px solid var(--ge-accent); outline-offset: 2px; }
#ge-hub .top { display: flex; align-items: center; justify-content: space-between; gap: var(--ge-s3); min-width: 0; }
#ge-hub .brand { font-size: var(--ge-fs-xs); font-weight: 800; letter-spacing: .3em; color: var(--ge-accent); white-space: nowrap; }
#ge-hub .title { font-size: clamp(24px, 3vw, 36px); font-weight: 900; letter-spacing: .06em; line-height: 1.05; white-space: nowrap; }
#ge-hub .title small { display: block; font-size: var(--ge-fs-xs); font-weight: 700; letter-spacing: .2em; color: var(--ge-muted); margin-top: var(--ge-s1); }
#ge-hub .tools { display: flex; gap: var(--ge-s2); align-items: center; flex-shrink: 0; }
#ge-hub .live { display: inline-flex; align-items: center; gap: 10px; min-height: var(--ge-tap); box-sizing: border-box; padding: 6px 18px; border-radius: 999px; background: rgba(16,18,20,.74); border: 1px solid rgba(123,224,138,.4); font-size: 17px; font-weight: 800; white-space: nowrap; font-variant-numeric: tabular-nums; }
#ge-hub .live b { font-size: 22px; }
#ge-hub .live .dot { opacity: .45; font-weight: 400; }
#ge-hub .live i { width: 10px; height: 10px; flex-shrink: 0; border-radius: 50%; background: var(--ge-ok); box-shadow: 0 0 0 0 rgba(123,224,138,.6); animation: ge-pulse 2s ease-out infinite; }
#ge-hub .live b { color: var(--ge-ok); }
#ge-hub .live.wait { border-color: var(--ge-line); color: var(--ge-muted); font-weight: 700; }
#ge-hub .live.wait i { background: var(--ge-warn); }
@keyframes ge-pulse { 0% { box-shadow: 0 0 0 0 rgba(123,224,138,.55); } 70%, 100% { box-shadow: 0 0 0 7px rgba(123,224,138,0); } }
#ge-hub .main { display: grid; grid-template-columns: minmax(300px, 380px) minmax(0, 1fr); gap: var(--ge-s4); min-height: 0; }
#ge-hub .panel { display: flex; flex-direction: column; min-height: 0; background: var(--ge-panel); border: 1px solid var(--ge-line); border-radius: var(--ge-r3); padding: var(--ge-s3); backdrop-filter: blur(8px); box-sizing: border-box; }
#ge-hub .play { gap: var(--ge-s3); overflow-y: auto; overscroll-behavior: contain; align-self: start; max-height: 100%; }
#ge-hub .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--ge-tap); box-sizing: border-box; border: 0; border-radius: var(--ge-r2); padding: 10px 16px; font-weight: 800; letter-spacing: .05em; background: rgba(255,255,255,.12); color: var(--ge-ink); white-space: nowrap; }
#ge-hub .btn:hover:not(:disabled) { background: rgba(255,255,255,.18); }
#ge-hub .btn:active:not(:disabled) { transform: translateY(1px); }
#ge-hub .btn:disabled { opacity: .45; cursor: default; }
#ge-hub .btn.primary { background: var(--ge-accent); color: var(--ge-accent-ink); }
#ge-hub .btn.primary:hover:not(:disabled) { background: #ffc46e; }
#ge-hub .btn.outline { background: rgba(255,179,71,.12); color: var(--ge-accent); box-shadow: 0 0 0 1px var(--ge-accent) inset; }
#ge-hub .btn.outline:hover:not(:disabled) { background: rgba(255,179,71,.2); }
#ge-hub .quick { width: 100%; min-height: 76px; flex-direction: column; gap: 2px; font-size: 22px; letter-spacing: .08em; line-height: 1.15; box-shadow: 0 10px 28px rgba(255,160,60,.35); animation: ge-cta 2.4s ease-in-out infinite; }
#ge-hub .quick small { font-size: var(--ge-fs-sm); font-weight: 700; letter-spacing: .02em; opacity: .82; white-space: normal; text-align: center; }
@keyframes ge-cta { 0%, 100% { box-shadow: 0 10px 28px rgba(255,160,60,.3), 0 0 0 0 rgba(255,179,71,.5); } 50% { box-shadow: 0 10px 28px rgba(255,160,60,.3), 0 0 0 7px rgba(255,179,71,0); } }
#ge-hub .sect { display: grid; gap: var(--ge-s2); }
#ge-hub .lbl { font-size: var(--ge-fs-xs); font-weight: 800; letter-spacing: .16em; color: var(--ge-dim); }
#ge-hub .row { display: flex; gap: var(--ge-s2); align-items: stretch; min-width: 0; }
#ge-hub .row > .grow { flex: 1 1 auto; min-width: 0; }
#ge-hub .seg { display: inline-flex; flex: 0 0 auto; padding: 3px; gap: 3px; border-radius: var(--ge-r2); background: rgba(0,0,0,.32); border: 1px solid var(--ge-line); }
#ge-hub .seg { display: grid; grid-template-columns: 1fr 1fr; }
#ge-hub .seg button { min-height: var(--ge-tap); padding: 4px 8px; line-height: 1.2; border: 0; border-radius: 9px; background: transparent; color: var(--ge-muted); font-size: var(--ge-fs-sm); font-weight: 800; white-space: nowrap; }
#ge-hub .seg button small { display: block; font-size: 10.5px; font-weight: 600; color: var(--ge-dim); letter-spacing: 0; }
#ge-hub .seg button[aria-checked="true"] { background: rgba(255,255,255,.14); color: var(--ge-ink); box-shadow: 0 0 0 1px rgba(255,255,255,.18) inset; }
#ge-hub .hint { font-size: var(--ge-fs-xs); color: var(--ge-dim); line-height: 1.45; }
#ge-hub input.code, #ge-hub input.nick { min-width: 0; min-height: var(--ge-tap); box-sizing: border-box; padding: 8px 12px; border-radius: var(--ge-r2); border: 1px solid rgba(255,255,255,.18); background: rgba(0,0,0,.32); color: var(--ge-ink); font-size: var(--ge-fs-lg); }
#ge-hub input.code { letter-spacing: .22em; font-weight: 800; text-transform: uppercase; }
#ge-hub input.code::placeholder { letter-spacing: .06em; font-weight: 600; text-transform: none; color: var(--ge-dim); }
#ge-hub input.code[aria-invalid="true"] { border-color: var(--ge-bad); }
#ge-hub .err { font-size: var(--ge-fs-xs); color: var(--ge-bad); font-weight: 700; }
#ge-hub .nickrow { display: flex; align-items: center; gap: var(--ge-s2); font-size: var(--ge-fs-sm); font-weight: 700; color: var(--ge-muted); }
#ge-hub .nickrow input { flex: 1; min-height: 40px; font-size: var(--ge-fs-md); }
#ge-hub .sep { height: 1px; background: var(--ge-line); margin: 2px 0; }
/* Room list */
#ge-hub .rooms-h { display: flex; align-items: baseline; justify-content: space-between; gap: var(--ge-s2); margin: 2px 2px var(--ge-s3); }
#ge-hub .rooms-h .t { font-size: var(--ge-fs-sm); font-weight: 800; letter-spacing: .14em; color: var(--ge-muted); }
#ge-hub .rooms-h .t b { color: var(--ge-ink); margin-left: 4px; }
#ge-hub .rooms-h .s { font-size: var(--ge-fs-xs); color: var(--ge-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ge-hub .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: grid; align-content: start; gap: var(--ge-s2); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; padding-right: 2px; }
#ge-hub .card { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--ge-s3); padding: 10px 12px; border-radius: var(--ge-r2); background: var(--ge-card); border: 1px solid var(--ge-line); border-left: 3px solid var(--ge-line); }
#ge-hub .card.waiting { border-left-color: var(--ge-ok); }
#ge-hub .card.warmup { border-left-color: var(--ge-accent); }
#ge-hub .card.playing, #ge-hub .card.results { border-left-color: rgba(200,204,210,.45); }
#ge-hub .card.full { opacity: .62; }
#ge-hub .card .l1 { display: flex; align-items: center; gap: var(--ge-s2); min-width: 0; }
#ge-hub .card .nm { font-size: var(--ge-fs-lg); font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
#ge-hub .card .l2 { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; font-size: var(--ge-fs-sm); color: var(--ge-muted); }
#ge-hub .card .l2 .seats { font-weight: 800; color: var(--ge-ink); font-variant-numeric: tabular-nums; }
#ge-hub .card .l2 .why { color: var(--ge-dim); }
#ge-hub .st { flex: 0 0 auto; font-size: var(--ge-fs-xs); font-weight: 800; letter-spacing: .06em; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
#ge-hub .st.waiting { color: #0b2a12; background: var(--ge-ok); }
#ge-hub .st.warmup { color: var(--ge-accent-ink); background: var(--ge-accent); }
#ge-hub .st.playing, #ge-hub .st.results { color: var(--ge-ink); background: rgba(200,204,210,.22); }
#ge-hub .st.full { color: var(--ge-muted); background: rgba(255,255,255,.08); border: 1px solid var(--ge-line); }
#ge-hub .st b { font-variant-numeric: tabular-nums; margin-left: 4px; }
#ge-hub .card .l2 .eta { color: var(--ge-warn); font-variant-numeric: tabular-nums; }
#ge-hub .card .btn { min-width: 92px; }
#ge-hub .card .btn.join { background: var(--ge-ok); color: #0b2a12; }
#ge-hub .card .btn.join:hover:not(:disabled) { background: #93eca0; }
#ge-hub .card .btn.warm { background: var(--ge-accent); color: var(--ge-accent-ink); }
#ge-hub .card .btn.warm:hover:not(:disabled) { background: #ffc46e; }
#ge-hub .list:has(> .empty) { align-content: stretch; }
#ge-hub .empty { display: grid; place-items: center; align-content: center; gap: var(--ge-s3); min-height: 180px; padding: var(--ge-s4); text-align: center; color: var(--ge-muted); font-size: var(--ge-fs-md); line-height: 1.6; border: 1px dashed rgba(255,255,255,.14); border-radius: var(--ge-r2); }
#ge-hub .empty .ic { font-size: 30px; line-height: 1; }
#ge-hub .empty b { color: var(--ge-ink); }
#ge-hub .skel { height: 62px; border-radius: var(--ge-r2); background: linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.09), rgba(255,255,255,.04)); background-size: 200% 100%; animation: ge-skel 1.4s linear infinite; }
@keyframes ge-skel { from { background-position: 200% 0; } to { background-position: 0 0; } }
#ge-hub .starting { display: none; }
#ge-hub.busy .main, #ge-hub.busy .tools { pointer-events: none; opacity: .3; transition: opacity .2s; }
#ge-hub.busy .starting { display: flex; position: fixed; inset: 0; z-index: 20; background: rgba(16,18,20,.78); backdrop-filter: blur(3px); align-items: center; justify-content: center; flex-direction: column; gap: 14px; font-size: 22px; font-weight: 800; letter-spacing: .08em; color: #ffb347; text-shadow: 0 2px 12px rgba(0,0,0,.6); pointer-events: none; }
#ge-hub .starting i { width: 34px; height: 34px; border-radius: 50%; border: 4px solid rgba(255,179,71,.25); border-top-color: #ffb347; animation: ge-spin .8s linear infinite; }
@keyframes ge-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #ge-hub .starting i { animation-duration: 2.4s; } }
@media (prefers-reduced-motion: reduce) { #ge-hub .quick, #ge-hub .live i, #ge-hub .skel { animation: none !important; } }
/* Medium widths: the room list keeps the room. */
@media (max-width: 1000px) { #ge-hub .main { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); } #ge-hub .title small { display: none; } }
/* Narrow portrait: one column, the list scrolls under the actions. */
@media (max-width: 700px) {
  #ge-hub { gap: var(--ge-s3); padding-inline: calc(12px + var(--ge-sl)) calc(12px + var(--ge-sr)); }
  #ge-hub .main { display: flex; flex-direction: column; overflow-y: auto; }
  #ge-hub .panel { flex: 0 0 auto; }
  #ge-hub .list { overflow: visible; }
  #ge-hub .title { font-size: 22px; }
  #ge-hub .top { flex-wrap: wrap; }
  #ge-hub .live { font-size: var(--ge-fs-md); } #ge-hub .live b { font-size: 18px; }
}
/* Phones in landscape / short windows: compact everything, both columns stay. */
@media (max-height: 520px) and (min-width: 561px) {
  #ge-hub { gap: var(--ge-s2); padding: calc(6px + var(--ge-st)) calc(10px + var(--ge-sr)) calc(6px + var(--ge-sb)) calc(10px + var(--ge-sl)); }
  #ge-hub .top > div:first-child { display: flex; align-items: baseline; gap: var(--ge-s2); min-width: 0; }
  #ge-hub .title { font-size: 20px; } #ge-hub .brand { font-size: 9.5px; letter-spacing: .2em; } #ge-hub .title small { display: none; }
  #ge-hub .live { min-height: 36px; padding: 4px 14px; font-size: var(--ge-fs-md); } #ge-hub .live b { font-size: 17px; }
  #ge-hub .seg button { min-height: 40px; } #ge-hub .seg button small { display: none; }
  #ge-hub .main { grid-template-columns: minmax(260px, 330px) minmax(0, 1fr); gap: var(--ge-s2); }
  #ge-hub .panel { padding: 8px; border-radius: var(--ge-r2); }
  #ge-hub .play { gap: 8px; }
  #ge-hub .quick { min-height: 54px; font-size: 18px; } #ge-hub .quick small { font-size: var(--ge-fs-xs); }
  #ge-hub .hint, #ge-hub .sep { display: none; } #ge-hub .lbl { font-size: 9.5px; letter-spacing: .12em; }
  #ge-hub .sect { gap: 6px; }
  #ge-hub .seg button { padding: 4px 8px; }
  #ge-hub .btn { letter-spacing: .02em; }
  #ge-hub .long { display: none; } #ge-hub .short { display: inline; }
  #ge-hub .nickrow input { min-height: 38px; }
  #ge-hub .rooms-h { margin-bottom: 6px; } #ge-hub .rooms-h .s { display: none; }
  #ge-hub .card { padding: 6px 8px; gap: var(--ge-s2); } #ge-hub .card .nm { font-size: var(--ge-fs-md); } #ge-hub .card .l2 { margin-top: 2px; font-size: var(--ge-fs-xs); } #ge-hub .card .btn { min-width: 76px; padding: 8px 10px; }
  #ge-hub .empty { min-height: 0; flex: 1; font-size: var(--ge-fs-sm); padding: var(--ge-s3); }
}
`;

export interface HubUiHooks {
  name(): string;
  setName(n: string): string;
  onStory?: () => void;
}

/** "about N s" / "about N min" until a round ends. */
function etaText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return L('即将结束', 'ending now');
  if (s >= 120) {
    const m = Math.round(s / 60);
    return L(`约 ${m} 分钟后结束`, `ends in ~${m} min`);
  }
  const r = Math.max(5, Math.round(s / 5) * 5);
  return L(`约 ${r} 秒后结束`, `ends in ~${r} s`);
}

export class HubUi {
  private readonly el = document.createElement('div');
  private readonly style = document.createElement('style');
  private pub = true;
  private resolve: ((c: HubChoice) => void) | null = null;
  private readonly clock: number;

  constructor(
    private readonly hub: HubLike,
    private readonly hooks: HubUiHooks,
  ) {
    this.style.textContent = CSS;
    document.head.appendChild(this.style);
    this.el.id = 'ge-hub';
    this.el.setAttribute('role', 'main');
    this.el.innerHTML = `
      <div class="top">
        <div><div class="brand">GROW EVERYTHING</div><div class="title">${L('房间大厅', 'Room browser')}<small>${L('和 AI 玩、开房间等好友，或加入路人的房间', 'Play vs AI, open a room for friends, or join a stranger’s room')}</small></div></div>
        <div class="tools"><span class="live wait" role="status" aria-live="polite"><i></i><span class="txt">${L('正在连接大厅…', 'Connecting…')}</span></span><button class="btn" data-a="lang" aria-label="${L('Switch to English', '切换到中文')}">${otherLangLabel()}</button>${hooks.onStory ? `<button class="btn" data-a="story" aria-label="${L('剧情模式', 'Story')}">📖</button>` : ''}</div>
      </div>
      <div class="main">
        <section class="panel play" aria-label="${L('开始游戏', 'Play')}">
          <button class="btn primary quick" data-a="quick">🤖 ${L('快速开始 · 和 AI 玩', 'Quick play vs AI')}<small>${L('马上开局 · 有真人加入就自动重开对战', 'Starts now · restarts as a real match when someone joins')}</small></button>
          <div class="sect">
            <div class="lbl">${L('创建房间', 'CREATE A ROOM')}</div>
            <div class="seg" role="radiogroup" aria-label="${L('谁可以加入', 'Who can join')}">
              <button role="radio" data-pub="1">🌐 ${L('公开', 'Public')}<small>${L('任何人可加入', 'anyone can join')}</small></button><button role="radio" data-pub="0">🔒 ${L('私密', 'Private')}<small>${L('仅邀请链接', 'invite link only')}</small></button>
            </div>
            <button class="btn outline" data-a="create">➕ ${L('创建房间', 'Create room')}</button>
            <div class="hint pubhint"></div>
          </div>
          <div class="sect">
            <div class="lbl">${L('输入房间号', 'JOIN BY CODE')}</div>
            <form class="row codeform" novalidate>
              <input class="code grow" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="🔢 ${L('房间号', 'Room code')}" aria-label="${L('房间号', 'Room code')}">
              <button class="btn" type="submit">${L('加入', 'Join')}</button>
            </form>
            <div class="err" role="alert" hidden></div>
          </div>
          <div class="sep"></div>
          <label class="nickrow">${L('昵称', 'Name')} <input class="nick" maxlength="16" aria-label="${L('昵称', 'Name')}"></label>
        </section>
        <section class="panel roomspanel" aria-label="${L('公开房间', 'Public rooms')}">
          <div class="rooms-h"><span class="t">${L('公开房间', 'PUBLIC ROOMS')}<b class="n"></b></span><span class="s">${L('绿色：等人中，直接加入 · 琥珀色：房主在和 AI 热身，你一来就重开', 'Green: waiting, join now · Amber: host is warming up vs AI and restarts with you')}</span></div>
          <div class="list" role="list"></div>
        </section>
      </div><div class="starting" role="status" aria-live="polite"><i></i><span>${L('正在开局…', 'Starting…')}</span></div>`;
    document.body.appendChild(this.el);
    this.wire();
    this.renderPub();
    this.render();
    hub.onChange(() => this.render());
    // "ends in ~N s" counts down between announcements.
    this.clock = window.setInterval(() => this.tickEta(), 1000);
  }

  /** Wait for the player's choice. */
  show(): Promise<HubChoice> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      if (matchMedia('(pointer: fine)').matches) (this.el.querySelector('.quick') as HTMLElement).focus({ preventScroll: true });
    });
  }

  dispose(): void {
    this.resolve = null;
    window.clearInterval(this.clock);
    this.el.remove();
    this.style.remove();
  }

  /** The choice is made: show "Starting…" (the room connects next, which can take a few seconds). */
  busy(): void {
    this.el.classList.add('busy');
  }

  private done(c: HubChoice): void {
    if (!this.resolve) return; // a second click while starting
    this.busy();
    const r = this.resolve;
    this.resolve = null;
    // Let "Starting…" paint before the room is built (that work blocks the page for a moment).
    requestAnimationFrame(() => requestAnimationFrame(() => r(c)));
  }

  private create(pub: boolean): void {
    track('room_create', { public: pub });
    this.done({ kind: 'room', code: newRoomCode(), from: 'create', create: true, pub, warmup: false });
  }

  private wire(): void {
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    q<HTMLButtonElement>('[data-a="quick"]').onclick = () => {
      // Your own public room with the warm-up vs AI started at once (strangers see it, may join).
      track('quick_play_ai', {});
      this.done({ kind: 'room', code: newRoomCode(), from: 'quick', create: true, pub: true, warmup: true });
    };
    q<HTMLButtonElement>('[data-a="create"]').onclick = () => this.create(this.pub);
    const story = this.el.querySelector('[data-a="story"]') as HTMLButtonElement | null;
    if (story) story.onclick = () => this.hooks.onStory?.();
    (this.el.querySelector('[data-a="lang"]') as HTMLButtonElement).onclick = () => toggleLang();
    this.el.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => {
      b.onclick = () => {
        this.pub = b.dataset.pub === '1';
        this.renderPub();
      };
    });
    const form = q<HTMLFormElement>('.codeform');
    const input = q<HTMLInputElement>('input.code');
    const err = q<HTMLElement>('.err');
    input.oninput = () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      input.removeAttribute('aria-invalid');
      err.hidden = true;
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const code = normalizeCode(input.value);
      if (!code) {
        input.setAttribute('aria-invalid', 'true');
        err.textContent = L('房间号是 4–8 位字母或数字', 'A room code is 4–8 letters or digits');
        err.hidden = false;
        input.focus();
        return;
      }
      track('room_join', { source: 'code' });
      const listed = this.hub.view().rooms.some((r) => r.code === code);
      this.done({ kind: 'room', code, from: 'code', create: false, pub: listed, warmup: false });
    };
    const nick = q<HTMLInputElement>('input.nick');
    nick.value = this.hooks.name();
    nick.onchange = () => (nick.value = this.hooks.setName(nick.value));
  }

  private renderPub(): void {
    this.el.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.pub === '1') === this.pub)));
    (this.el.querySelector('.pubhint') as HTMLElement).textContent = this.pub
      ? L('公开：房间出现在右边的列表里，好友和路人都能加入', 'Public: listed on the right, friends and strangers can join')
      : L('私密：不出现在列表里，只有拿到邀请链接或房间号的人能进', 'Private: not listed, only people with the invite link or code can join');
  }

  private render(): void {
    const v = this.hub.view();
    // Live count: only a real number, never 0 / 1 standing in for "unknown".
    const live = this.el.querySelector('.live') as HTMLElement;
    const txt = live.querySelector('.txt') as HTMLElement;
    live.classList.toggle('wait', !v.available);
    const rooms = v.rooms.length + v.privateRooms;
    const n = v.capped ? `${v.online}+` : String(v.online);
    if (v.available) txt.innerHTML = L(`<b>${n}</b> 人在线 <span class="dot">·</span> ${rooms} 个房间进行中`, `<b>${n}</b> online <span class="dot">·</span> ${rooms} ${rooms === 1 ? 'room' : 'rooms'}`);
    else txt.textContent = v.status === 'error' ? L('大厅暂时连不上', 'Lobby unreachable') : L('正在连接大厅…', 'Connecting…');
    live.hidden = v.status === 'off';
    (this.el.querySelector('.rooms-h .n') as HTMLElement).textContent = v.available && v.rooms.length ? String(v.rooms.length) : '';
    const list = this.el.querySelector('.list') as HTMLElement;
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.join ?? null;
    const scroll = list.scrollTop;
    list.textContent = '';
    if (v.status === 'error') {
      list.appendChild(this.emptyState('📡', L('暂时连不上在线大厅 — 可以先和 AI 玩，或创建房间把链接发给好友', 'Can’t reach the online lobby right now — play vs AI, or create a room and send friends the link')));
      return;
    }
    if (!v.ready) {
      for (let i = 0; i < 3; i++) list.appendChild(Object.assign(document.createElement('div'), { className: 'skel' }));
      return;
    }
    if (!v.rooms.length) {
      list.appendChild(this.emptyState('🛰', L('还没有公开房间 — <b>创建一个</b>，好友和路人都能加入', 'No public rooms yet — <b>create one</b> and friends and strangers can join'), true));
      return;
    }
    for (const r of v.rooms) list.appendChild(this.card(r));
    list.scrollTop = scroll;
    if (focusKey) (list.querySelector(`[data-join="${focusKey}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private tickEta(): void {
    const now = Date.now();
    this.el.querySelectorAll<HTMLElement>('.eta[data-ends]').forEach((e) => (e.textContent = etaText(Number(e.dataset.ends) - now)));
  }

  private emptyState(icon: string, html: string, withCreate = false): HTMLElement {
    const d = document.createElement('div');
    d.className = 'empty';
    d.setAttribute('role', 'listitem');
    d.innerHTML = `<div class="ic">${icon}</div><div>${html}</div>`;
    if (withCreate) {
      const b = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: `➕ ${L('创建公开房间', 'Create a public room')}` });
      b.onclick = () => this.create(true);
      d.appendChild(b);
    }
    return d;
  }

  private card(r: HubRoom): HTMLElement {
    const kind = r.full ? 'full' : r.phase;
    const now = Date.now();
    const left = r.endsAt ? r.endsAt - now : null;
    // Mid-round drop-in: a newcomer takes over an AI rival until the last seconds of the round.
    const dropIn = r.phase === 'playing' && !r.full && r.bots && left !== null && left > A.dropInCutoffSeconds * 1000;
    const d = document.createElement('div');
    d.className = `card ${kind}`;
    d.setAttribute('role', 'listitem');
    d.innerHTML = `<div><div class="l1"><span class="st ${kind}"></span><span class="nm"></span></div><div class="l2"><span class="city"></span><span class="seats"></span><span class="why"></span></div></div><button class="btn"></button>`;
    const chip = d.querySelector('.st') as HTMLElement;
    const btn = d.querySelector('.btn') as HTMLButtonElement;
    const label: Record<string, [string, string, string]> = {
      waiting: [L('等待中', 'Waiting'), L('加入', 'Join'), 'join'],
      warmup: [L('和 AI 热身', 'Warm-up vs AI'), L('加入', 'Join'), 'warm'],
      playing: [L('游戏中', 'Playing'), dropIn ? L('中途加入', 'Drop in') : L('观战', 'Watch'), ''],
      results: [L('结算中', 'Results'), L('加入', 'Join'), ''],
      full: [L('已满', 'Full'), L('已满', 'Full'), ''],
    };
    const [chipText, btnText, btnCls] = label[kind];
    chip.textContent = chipText;
    chip.appendChild(Object.assign(document.createElement('b'), { textContent: `${r.humans}/${r.max}` }));
    btn.textContent = btnText;
    if (btnCls) btn.classList.add(btnCls);
    btn.disabled = r.full;
    btn.dataset.join = r.code;
    const name = r.host || L('玩家', 'Player');
    (d.querySelector('.nm') as HTMLElement).textContent = L(`${name}的房间`, `${name}'s room`);
    const city = cityById(r.city);
    (d.querySelector('.city') as HTMLElement).textContent = city ? `📍 ${L(city.nameZh, city.name)}` : '';
    (d.querySelector('.seats') as HTMLElement).textContent = r.bots ? L('含 AI 对手', 'with AI rivals') : L('仅真人', 'humans only');
    const why = d.querySelector('.why') as HTMLElement;
    if (left !== null && (r.phase === 'playing' || (r.full && r.phase !== 'waiting'))) {
      why.className = 'eta';
      why.dataset.ends = String(r.endsAt);
      why.textContent = etaText(left);
    } else
      why.textContent =
        kind === 'warmup' ? L('你一进来就重开真人局', 'restarts as a real match when you join') : kind === 'results' ? L('下一局马上开始', 'next round soon') : kind === 'waiting' ? L('等人中，进来就能开', 'waiting for players') : '';
    btn.setAttribute('aria-label', `${btnText} · ${L(`${name}的房间`, `${name}'s room`)}`);
    btn.onclick = () => {
      if (r.full) return;
      track('room_join', { source: 'list', phase: r.phase });
      this.done({ kind: 'room', code: r.code, from: 'list', create: false, pub: true, warmup: false });
    };
    return d;
  }
}
