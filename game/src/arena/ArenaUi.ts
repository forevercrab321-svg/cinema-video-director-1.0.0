import * as THREE from 'three';
import { arenaConfig as A, roundSecondsFor } from '../config/arena';
import { HALLOWEEN as HW, HUNTERS, hunterName, isHalloween } from '../config/halloween';
import { SLOT_COLORS, VEHICLES, VEHICLE_ORDER, type VehicleLook } from '../config/vehicles';
import { CITIES } from '../world/cities';
import type { ArenaGame, Standing } from './ArenaGame';
import { awards } from './comedy';
import { L, otherLangLabel, toggleLang } from '../i18n';
import type { ArenaSession } from './ArenaSession';
import { progress } from './progress';
import { ArenaPanels, type PanelHooks } from './ArenaPanels';
import { GE_TOKENS } from './uiTokens';
import type { HubLike } from '../net/Hub';

/**
 * Arena UI (DOM over the canvas): lobby, in-round overlay (timer, scoreboard, kill feed,
 * countdown, respawn, name tags) and the results podium. Chinese first, English secondary.
 * Player names are other people's input: always set with textContent.
 */
const CSS = `
/* Design tokens: one type scale, one spacing scale, one radius scale, one accent. */
#arena { ${GE_TOKENS} }
#arena { position: fixed; inset: 0; pointer-events: none; font-family: 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; color: var(--ge-ink); -webkit-font-smoothing: antialiased; z-index: 5; }
#arena .hex { font-variant-numeric: tabular-nums; }
#arena [hidden] { display: none !important; }
#hud .hint { display: none; } /* story onboarding prompt: not used in the arena */
#arena button { font: inherit; cursor: pointer; pointer-events: auto; }
#arena button:focus-visible, #arena summary:focus-visible, #arena input:focus-visible { outline: 2px solid var(--ge-accent); outline-offset: 2px; }
/* ── Lobby: top bar · three columns (each scrolls on its own) · action bar that never scrolls away ── */
#arena .lobby { position: absolute; inset: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: var(--ge-s4); pointer-events: auto;
  padding: calc(var(--ge-s4) + var(--ge-st)) calc(max(16px, 3vw) + var(--ge-sr)) calc(var(--ge-s4) + var(--ge-sb)) calc(max(16px, 3vw) + var(--ge-sl));
  background: linear-gradient(180deg, rgba(12,13,15,.74), rgba(12,13,15,.4) 30%, rgba(12,13,15,.4) 70%, rgba(12,13,15,.84)); }
#arena .top { display: flex; align-items: center; justify-content: space-between; gap: var(--ge-s3); min-width: 0; }
#arena .brand { font-size: var(--ge-fs-xs); font-weight: 800; letter-spacing: .3em; color: var(--ge-accent); white-space: nowrap; }
#arena .title { font-size: clamp(24px, 3vw, 36px); font-weight: 900; letter-spacing: .06em; line-height: 1.05; white-space: nowrap; }
#arena .title small { display: block; font-size: var(--ge-fs-xs); font-weight: 700; letter-spacing: .24em; color: var(--ge-muted); margin-top: var(--ge-s1); }
#arena .tools { display: flex; gap: var(--ge-s2); align-items: center; flex-shrink: 0; }
#arena .chip { display: inline-flex; align-items: center; gap: 6px; font-size: var(--ge-fs-sm); font-weight: 700; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,.08); letter-spacing: .04em; white-space: nowrap; }
#arena .chip b { color: #8be07a; }
#arena .net { font-weight: 800; } #arena .net.ok { color: var(--ge-ok); } #arena .net.bad { color: var(--ge-bad); } #arena .net.wait { color: var(--ge-warn); } #arena .net small { font-weight: 400; color: var(--ge-muted); }
#arena .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.1fr); gap: var(--ge-s4); min-height: 0; }
#arena .col { display: flex; flex-direction: column; min-height: 0; background: var(--ge-panel); border: 1px solid var(--ge-line); border-radius: var(--ge-r3); padding: var(--ge-s3) var(--ge-s3) 0; backdrop-filter: blur(8px); }
#arena .col > .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: var(--ge-s3); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
#arena .h { display: flex; align-items: center; gap: var(--ge-s2); font-size: var(--ge-fs-sm); font-weight: 800; letter-spacing: .14em; color: var(--ge-muted); margin: 2px 2px var(--ge-s3); }
#arena .h .step { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--ge-accent); color: var(--ge-accent-ink); font-size: 12px; letter-spacing: 0; }
#arena .h .sub { font-weight: 600; letter-spacing: .04em; color: var(--ge-dim); }
#arena .city { display: grid; grid-template-columns: 40px 1fr; gap: 10px; align-items: center; width: 100%; min-height: var(--ge-tap); text-align: left; border: 1px solid var(--ge-line); background: var(--ge-card); color: inherit; border-radius: var(--ge-r2); padding: 10px; margin-bottom: var(--ge-s2); }
#arena .city[aria-pressed="true"], #arena .veh[aria-pressed="true"] { border-color: var(--ge-accent); background: rgba(255,179,71,.14); box-shadow: 0 0 0 1px var(--ge-accent) inset; }
#arena .city:not(:disabled):hover, #arena .veh:hover { background: rgba(255,255,255,.09); }
#arena .city:disabled { opacity: .5; cursor: default; }
#arena .city .lv { font-size: 22px; font-weight: 900; color: var(--ge-accent); text-align: center; line-height: 1.1; }
#arena .city .lv small { display: block; font-size: 9px; letter-spacing: .04em; color: var(--ge-muted); }
#arena .city .nm { font-size: var(--ge-fs-lg); font-weight: 800; }
#arena .city .nm span { font-size: var(--ge-fs-xs); color: var(--ge-dim); margin-left: 6px; letter-spacing: .08em; }
#arena .city .tg { font-size: var(--ge-fs-sm); color: var(--ge-muted); margin-top: 2px; }
#arena .room { display: grid; gap: var(--ge-s2); padding: var(--ge-s3); margin-bottom: var(--ge-s3); border-radius: var(--ge-r2); background: rgba(255,255,255,.06); border: 1px solid var(--ge-line); font-size: var(--ge-fs-sm); line-height: 1.5; color: var(--ge-muted); }
#arena .room .rh { display: flex; align-items: center; justify-content: space-between; gap: var(--ge-s2); flex-wrap: wrap; }
#arena .room .code-row { display: flex; align-items: baseline; gap: var(--ge-s2); color: var(--ge-muted); }
#arena .room .code { font-size: 20px; font-weight: 900; letter-spacing: .18em; color: var(--ge-ink); font-variant-numeric: tabular-nums; }
#arena .room .btn { display: block; width: 100%; white-space: normal; text-align: center; line-height: 1.4; }
#arena .room .btn .apps { font-weight: 600; opacity: .85; }
#arena .room .gift { font-size: var(--ge-fs-xs); color: var(--ge-dim); }
#arena .nick { display: flex; gap: var(--ge-s2); align-items: center; font-size: var(--ge-fs-sm); font-weight: 700; color: var(--ge-muted); margin-bottom: var(--ge-s2); }
#arena .nick input { flex: 1; min-width: 0; min-height: 40px; box-sizing: border-box; font: inherit; font-size: var(--ge-fs-md); color: var(--ge-ink); padding: 7px 10px; border-radius: var(--ge-r1); border: 1px solid rgba(255,255,255,.18); background: rgba(0,0,0,.3); }
#arena .slot { display: grid; grid-template-columns: 12px 1fr auto; gap: 10px; align-items: center; padding: 8px 12px; border-radius: var(--ge-r2); background: var(--ge-card); margin-bottom: var(--ge-s2); min-height: var(--ge-tap); box-sizing: border-box; }
#arena .slot i { width: 12px; height: 12px; border-radius: 3px; }
#arena .slot .n { font-weight: 800; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#arena .slot .n em { font-style: normal; font-size: 10px; font-weight: 800; letter-spacing: .12em; color: var(--ge-accent-ink); background: var(--ge-accent); border-radius: 3px; padding: 1px 5px; margin-left: 6px; }
#arena .slot .v { font-size: var(--ge-fs-xs); color: var(--ge-muted); }
#arena .slot .st { font-size: 13px; font-weight: 800; letter-spacing: .04em; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
#arena .slot .st.host { color: #ffd479; background: rgba(255,196,64,.14); }
#arena .slot .st.ok { color: #0b2a12; background: #5fe08a; }
#arena .slot .st.no { color: #ffd9c2; background: rgba(255,120,60,.22); border: 1px solid rgba(255,140,80,.55); }
#arena .slot.ready { box-shadow: inset 0 0 0 2px rgba(95,224,138,.55); }
#arena .slot.unready { box-shadow: inset 0 0 0 1px rgba(255,140,80,.35); }
#arena .btn.is-ready { background: #5fe08a; color: #0b2a12; font-weight: 900; border-color: #5fe08a; }
#arena .btn.is-ready small, #arena .btn.cta small { display: block; font-size: 11px; font-weight: 700; opacity: .8; }
#arena .chip.wait-host { font-weight: 800; }
#arena .slot.empty { background: transparent; border: 1px dashed rgba(255,255,255,.14); }
#arena .slot.empty .n { font-weight: 700; color: var(--ge-muted); }
#arena .invite { font-size: var(--ge-fs-sm); line-height: 1.6; color: var(--ge-muted); margin-top: var(--ge-s2); }
#arena .invite .btn { margin-top: var(--ge-s2); }
#arena .veh { display: grid; gap: 4px; width: 100%; text-align: left; border: 1px solid var(--ge-line); background: var(--ge-card); color: inherit; border-radius: var(--ge-r2); padding: 10px 12px; margin-bottom: var(--ge-s2); }
#arena .veh .nm { font-weight: 800; font-size: 15px; display: flex; align-items: center; gap: 8px; }
#arena .veh .nm i { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
#arena .veh .nm span { color: var(--ge-dim); font-size: var(--ge-fs-xs); font-weight: 700; }
#arena .veh .bl { font-size: var(--ge-fs-sm); color: var(--ge-muted); }
#arena .bars { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 4px 8px; font-size: 10.5px; letter-spacing: .06em; color: var(--ge-muted); margin-top: 4px; align-items: center; }
#arena .veh:not([aria-pressed="true"]) .bars { display: none; }
#arena .bars b { display: block; height: 4px; border-radius: 2px; background: rgba(255,255,255,.14); }
#arena .bars b i { display: block; height: 100%; border-radius: 2px; background: var(--ge-accent); }
/* Action bar: condensed rules on the left, the one thing to press on the right. */
#arena .foot { position: relative; display: flex; align-items: center; justify-content: space-between; gap: var(--ge-s3) var(--ge-s4); min-width: 0; }
#arena .rules { min-width: 0; flex: 1 1 auto; font-size: var(--ge-fs-sm); color: var(--ge-muted); }
#arena .rules summary { display: flex; align-items: center; gap: var(--ge-s2); flex-wrap: wrap; list-style: none; cursor: pointer; pointer-events: auto; min-height: var(--ge-tap); border-radius: var(--ge-r2); }
#arena .rules summary::-webkit-details-marker { display: none; }
#arena .rules .rk { font-weight: 800; color: var(--ge-ink); padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,.1); white-space: nowrap; }
#arena .rules .rc { white-space: nowrap; padding: 6px 10px; border-radius: 999px; background: rgba(16,18,20,.55); border: 1px solid var(--ge-line); }
#arena .rules .rc b { color: var(--ge-accent); }
#arena .rules .more { color: var(--ge-accent); font-weight: 700; white-space: nowrap; }
#arena .rules[open] .more::after { content: ' ▾'; } #arena .rules:not([open]) .more::after { content: ' ▸'; }
#arena .rules .full { position: absolute; left: 0; bottom: calc(100% + var(--ge-s2)); z-index: 2; width: min(62ch, 100%); box-sizing: border-box; padding: var(--ge-s3) var(--ge-s4); border-radius: var(--ge-r2); background: rgba(20,21,23,.96); border: 1px solid var(--ge-line); box-shadow: 0 16px 40px rgba(0,0,0,.45); color: var(--ge-ink); line-height: 1.7; max-height: 50vh; overflow-y: auto; }
#arena .actions { display: flex; gap: var(--ge-s2); align-items: center; flex-wrap: wrap; justify-content: flex-end; }
#arena .foot .actions { flex: 0 0 auto; flex-wrap: nowrap; }
#arena .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--ge-tap); box-sizing: border-box; border: 0; border-radius: var(--ge-r2); padding: 10px 16px; font-weight: 800; letter-spacing: .06em; background: rgba(255,255,255,.12); color: var(--ge-ink); white-space: nowrap; }
#arena .btn:hover:not(:disabled) { background: rgba(255,255,255,.18); }
#arena .btn.primary { background: var(--ge-accent); color: var(--ge-accent-ink); }
#arena .btn.primary:hover:not(:disabled) { background: #ffc46e; }
#arena .btn.outline { background: rgba(255,179,71,.12); color: var(--ge-accent); box-shadow: 0 0 0 1px var(--ge-accent) inset; }
#arena .btn.icon { min-width: var(--ge-tap); padding-inline: 12px; }
#arena .btn:disabled { opacity: .45; cursor: default; }
#arena .btn:active:not(:disabled) { transform: translateY(1px); }
#arena .btn.cta { min-height: 56px; padding: 8px 26px; font-size: 18px; letter-spacing: .08em; flex-direction: column; gap: 0; line-height: 1.15; box-shadow: 0 8px 24px rgba(255,160,60,.35); }
#arena .btn.cta small { font-size: var(--ge-fs-xs); font-weight: 700; letter-spacing: .04em; opacity: .8; }
#arena .btn.cta:not(:disabled) { animation: ge-cta 2.4s ease-in-out infinite; }
@keyframes ge-cta { 0%, 100% { box-shadow: 0 8px 24px rgba(255,160,60,.3), 0 0 0 0 rgba(255,179,71,.5); } 50% { box-shadow: 0 8px 24px rgba(255,160,60,.3), 0 0 0 6px rgba(255,179,71,0); } }
@media (prefers-reduced-motion: reduce) { #arena .btn.cta { animation: none !important; } }
#arena label.tog { display: flex; align-items: center; gap: 8px; min-height: var(--ge-tap); padding: 0 10px; border-radius: var(--ge-r2); font-size: var(--ge-fs-sm); font-weight: 700; color: var(--ge-ink); pointer-events: auto; cursor: pointer; white-space: nowrap; }
#arena label.tog input { width: 18px; height: 18px; accent-color: var(--ge-accent); margin: 0; }
#arena .coins { color: #ffd35a; font-weight: 800; }
/* ── In round: timer top-centre, leaderboard top-right, feed under it, map bottom-right. The centre stays clear. ── */
#arena .timer { position: absolute; top: calc(14px + var(--ge-st)); left: 50%; transform: translateX(-50%); text-align: center; padding: 4px 14px 5px; border-radius: var(--ge-r2); background: rgba(16,18,20,.42); backdrop-filter: blur(4px); text-shadow: 0 1px 4px rgba(0,0,0,.5); }
#arena .timer b { display: block; font-size: 28px; font-weight: 900; letter-spacing: .06em; line-height: 1.1; }
#arena .timer span { font-size: var(--ge-fs-xs); font-weight: 800; letter-spacing: .16em; color: var(--ge-muted); white-space: nowrap; }
#arena .timer .lock { display: table; margin: 2px auto 0; font-style: normal; font-size: var(--ge-fs-xs); font-weight: 800; letter-spacing: .06em; color: var(--ge-muted); white-space: nowrap; }
#arena .timer .lock.open { color: var(--ge-accent-ink); background: var(--ge-accent); border-radius: 999px; padding: 1px 8px; animation: ge-open .6s ease-out 3; }
@keyframes ge-open { 0% { transform: scale(1); } 40% { transform: scale(1.15); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { #arena .timer .lock.open { animation: none; } }
#arena .board { position: absolute; top: calc(14px + var(--ge-st)); right: calc(16px + var(--ge-sr)); width: 230px; padding: 8px 12px; border-radius: var(--ge-r2); background: rgba(16,18,20,.5); backdrop-filter: blur(6px); }
#arena .row { display: grid; grid-template-columns: 14px 10px 1fr auto auto; gap: 7px; align-items: center; padding: 3px 0; font-size: 13px; }
#arena .row .rk { font-weight: 900; color: var(--ge-muted); }
#arena .row i { width: 10px; height: 10px; border-radius: 3px; }
#arena .row .nm { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#arena .row .hp { font-size: 10px; letter-spacing: -.02em; color: #ff8f8f; }
#arena .row .ms { font-weight: 800; text-align: right; min-width: 52px; }
#arena .row .lv2 { grid-column: 3 / 6; font-size: 10.5px; color: var(--ge-muted); letter-spacing: .06em; margin-top: -2px; }
#arena .row:not(.me) .lv2 { display: none; }
#arena .row.me .nm { color: var(--ge-accent); }
#arena .row.out { opacity: .45; }
#arena .feed { position: absolute; right: calc(16px + var(--ge-sr)); top: calc(168px + var(--ge-st)); width: 280px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
#arena .feed div { font-size: var(--ge-fs-sm); font-weight: 700; padding: 5px 10px; border-radius: var(--ge-r1); background: rgba(16,18,20,.6); animation: feed 5s forwards; }
#arena .feed .kill { border-left: 3px solid #ff6b5a; } #arena .feed .bonus { border-left: 3px solid #ffd35a; } #arena .feed .bad { border-left: 3px solid #ff6b8a; }
@keyframes feed { 0% { opacity: 0; transform: translateX(10px); } 6% { opacity: 1; transform: none; } 85% { opacity: 1; } 100% { opacity: 0; } }
#arena .warm { position: absolute; top: calc(84px + var(--ge-st)); left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 14px; border-radius: var(--ge-r2); background: rgba(40,28,10,.85); border: 1px solid var(--ge-accent); font-size: 13px; font-weight: 800; letter-spacing: .03em; white-space: nowrap; pointer-events: auto; z-index: 3; }
#arena .warm .btn { min-height: 36px; padding: 6px 12px; font-size: 12px; }
#arena .warm .ws { display: none; }
#arena .center { position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%); text-align: center; text-shadow: 0 3px 14px rgba(0,0,0,.6); }
#arena .center b { display: block; font-size: 96px; font-weight: 900; line-height: 1; }
#arena .center span { font-size: 15px; font-weight: 800; letter-spacing: .24em; }
#arena .combo { position: absolute; left: calc(290px + var(--ge-sl)); bottom: calc(30px + var(--ge-sb)); font-size: 22px; font-weight: 900; color: #ffd35a; text-shadow: 0 2px 8px rgba(0,0,0,.5); }
#arena .map { position: absolute; right: calc(16px + var(--ge-sr)); bottom: calc(64px + var(--ge-sb)); width: 184px; height: 184px; border-radius: var(--ge-r3); background: rgba(16,18,20,.55); backdrop-filter: blur(6px); }
#arena .tag.edge { background: rgba(16,18,20,.75); }
#arena .tag.hunter { background: rgba(120,0,24,.82); color: #fff; border: 1px solid #ff2d55; font-size: var(--ge-fs-sm); letter-spacing: .04em; }
#arena .timer.hunt { background: rgba(90,0,20,.62); box-shadow: 0 0 18px rgba(255,45,85,.35); }
#arena .combo small { font-size: 12px; color: #8be07a; letter-spacing: .08em; }
#arena .combo small.pw { color: #9fd8ff; }
#arena .tag .say { display: block; font-size: 26px; line-height: 1.1; text-align: center; margin: -34px 0 4px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.5)); }
#arena .tag.me { background: none; border: 0 !important; }
#arena .emotes { position: absolute; left: 50%; bottom: calc(16px + var(--ge-sb)); transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; }
#arena .emotes button { border: 0; border-radius: var(--ge-r2); background: rgba(16,18,20,.5); font-size: 20px; width: var(--ge-tap); height: var(--ge-tap); }
#arena .emotes button:hover { background: rgba(16,18,20,.75); }
#arena .res .awards { margin-top: 12px; display: grid; gap: 4px; font-size: 13px; text-align: center; }
#arena .res .awards b { color: var(--ge-accent); }
#arena .tag { position: absolute; transform: translate(-50%, -100%); font-size: var(--ge-fs-xs); font-weight: 800; letter-spacing: .06em; padding: 2px 7px; border-radius: 6px; background: rgba(16,18,20,.6); white-space: nowrap; }
#arena .res { position: absolute; inset: 0; display: grid; place-items: center; padding: calc(16px + var(--ge-st)) calc(16px + var(--ge-sr)) calc(16px + var(--ge-sb)) calc(16px + var(--ge-sl)); background: rgba(12,13,15,.55); pointer-events: auto; }
#arena .res .card { width: min(560px, 100%); box-sizing: border-box; max-height: 100%; overflow-y: auto; padding: 26px; border-radius: var(--ge-r3); background: rgba(20,21,23,.94); box-shadow: 0 30px 80px rgba(0,0,0,.5); }
#arena .res h2 { margin: 0; font-size: 34px; font-weight: 900; letter-spacing: .08em; text-align: center; }
#arena .res .who { text-align: center; font-size: 15px; font-weight: 800; color: var(--ge-accent); margin-top: 6px; letter-spacing: .1em; }
#arena .res table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 13px; }
#arena .res td, #arena .res th { padding: 8px 6px; text-align: right; }
#arena .res th { font-size: 10.5px; letter-spacing: .14em; color: var(--ge-muted); font-weight: 800; }
#arena .res td:nth-child(2), #arena .res th:nth-child(2) { text-align: left; }
#arena .res tr.me td { color: var(--ge-accent); font-weight: 800; }
#arena .res tbody tr + tr td { border-top: 1px solid var(--ge-line); }
#arena .res .earn { text-align: center; margin-top: 14px; font-size: 13px; }
#arena .res .actions { justify-content: center; margin-top: 16px; }
#arena .notice { position: absolute; bottom: 10%; left: 50%; transform: translateX(-50%); z-index: 4; padding: 10px 16px; border-radius: var(--ge-r2); background: rgba(40,16,30,.92); border: 1px solid #ff7eb6; font-size: 14px; font-weight: 800; letter-spacing: .04em; white-space: nowrap; animation: feed 4.2s forwards; }
#arena .revive { position: absolute; top: calc(40% + 80px); left: 50%; transform: translateX(-50%); white-space: nowrap; }
#arena .res .earn .btn { margin-left: 10px; padding: 8px 12px; font-size: 12px; }
/* Site-wide live count (hub directory): lobby top bar and a small HUD corner chip. Hidden unless the number is real. */
#arena .lead { display: flex; align-items: center; gap: var(--ge-s3); min-width: 0; }
#arena .btn.back { padding-inline: 12px; white-space: nowrap; }
#arena .btn.back .bs { display: none; }
#arena .hubcount { gap: 7px; color: var(--ge-ink); background: rgba(16,18,20,.62); box-shadow: 0 0 0 1px rgba(123,224,138,.32) inset; font-variant-numeric: tabular-nums; }
#arena .hubcount i { width: 8px; height: 8px; border-radius: 50%; background: var(--ge-ok); flex-shrink: 0; }
#arena .hubmini { position: absolute; left: calc(16px + var(--ge-sl)); top: calc(14px + var(--ge-st)); display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; background: rgba(16,18,20,.42); font-size: var(--ge-fs-xs); font-weight: 700; letter-spacing: .03em; color: var(--ge-muted); pointer-events: none; font-variant-numeric: tabular-nums; }
#arena .hubmini i { width: 6px; height: 6px; border-radius: 50%; background: var(--ge-ok); }
#arena .pubtog { min-height: 40px; padding: 0 2px; white-space: normal; line-height: 1.3; }
#arena .pubtog small { display: block; font-weight: 600; color: var(--ge-dim); font-size: var(--ge-fs-xs); }
#arena .pubstate { font-weight: 700; color: var(--ge-ink); }
/* ?clip=1 — clean frame for marketing captures: mass HUD, banners and name tags only. */
body.ge-clip #arena .hubmini, body.ge-clip #arena .board, body.ge-clip #arena .map, body.ge-clip #arena .emotes, body.ge-clip #arena .feed, body.ge-clip #arena .combo, body.ge-clip #hud .legend, body.ge-clip .ge-full, body.ge-clip .ge-dash { display: none !important; }
body.ge-clip #arena .timer { top: auto; bottom: 28px; }
body:has(#arena .lobby:not([hidden])) .ge-dash, body:has(#arena .res:not([hidden])) .ge-dash, body:has(#arena .lobby:not([hidden])) #hud { display: none; }
/* The first touch already asks for fullscreen; in the lobby the corner belongs to the rules button. */
body:has(#arena .lobby:not([hidden])) .ge-full { display: none; }
/* Medium desktop widths: tools collapse to icons before the top bar would wrap. */
@media (max-width: 1100px) { #arena .tools .lbl { display: none; } #arena .cols { gap: var(--ge-s3); } }
/* Narrow windows (half-screen desktop, portrait): one column that scrolls; the action bar stays pinned. */
@media (max-width: 760px) {
  #arena .lobby { gap: var(--ge-s3); padding-inline: calc(12px + var(--ge-sl)) calc(12px + var(--ge-sr)); }
  #arena .title small { display: none; }
  #arena .cols { display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; gap: var(--ge-s3); margin-inline: -4px; padding-inline: 4px; }
  #arena .col { flex: 0 0 auto; padding-bottom: 0; }
  #arena .col > .list { overflow: visible; }
  #arena .col.c-room { order: -1; }
  #arena .foot { flex-direction: column; align-items: stretch; gap: var(--ge-s2); }
  #arena .rules .rc { display: none; }
  #arena .rules .full { width: 100%; }
  #arena .foot .actions { justify-content: space-between; }
  #arena .foot .actions .cta { flex: 1 1 auto; }
}
/* Phones play in landscape: HUD hugs the corners, thumbs own the bottom corners. */
@media (pointer: coarse), (max-height: 520px) {
  #arena .timer { top: calc(4px + var(--ge-st)); padding: 2px 10px 3px; } #arena .timer b { font-size: 20px; } #arena .timer span, #arena .timer .lock { font-size: 9.5px; letter-spacing: .06em; }
  #arena .board { top: calc(6px + var(--ge-st)); right: calc(8px + var(--ge-sr)); width: 156px; padding: 4px 8px; } #arena .row { font-size: 11px; gap: 5px; padding: 1px 0; grid-template-columns: 10px 8px 1fr auto; } #arena .row .lv2, #arena .row .hp { display: none; } #arena .row .ms { min-width: 0; }
  #arena .map { width: 96px; height: 96px; top: calc(100px + var(--ge-st)); right: calc(8px + var(--ge-sr)); bottom: auto; left: auto; }
  #arena .feed { top: calc(84px + var(--ge-st)); left: calc(8px + var(--ge-sl)); right: auto; width: 230px; align-items: flex-start; } #arena .feed div { font-size: 10.5px; padding: 3px 8px; }
  #arena .combo { left: calc(168px + var(--ge-sl)); bottom: auto; top: calc(8px + var(--ge-st)); font-size: 14px; }
  #arena .center b { font-size: 56px; } #arena .center span { font-size: 12px; }
  #arena .emotes { left: 50%; right: auto; transform: translateX(-50%); bottom: calc(6px + var(--ge-sb)); flex-direction: row; gap: 4px; } #arena .emotes button { width: var(--ge-tap); height: var(--ge-tap); font-size: 20px; background: rgba(16,18,20,.4); }
  #arena .warm { top: calc(50px + var(--ge-st)); font-size: 11px; padding: 3px 4px 3px 10px; gap: 6px; } #arena .warm .btn { min-height: 32px; padding: 4px 9px; font-size: 11px; } #arena .warm .wl { display: none; } #arena .warm .ws { display: inline; }
  #arena .notice { bottom: auto; top: 30%; font-size: 12px; padding: 7px 12px; }
  #arena .tag { font-size: 10px; }
  #arena .hubmini { top: auto; bottom: calc(6px + var(--ge-sb)); left: calc(8px + var(--ge-sl)); font-size: 9.5px; padding: 2px 7px; }
  #arena .res .card { padding: 14px 18px; } #arena .res h2 { font-size: 22px; } #arena .res table { margin-top: 8px; font-size: 11px; } #arena .res td, #arena .res th { padding: 4px 6px; }
}
/* Landscape phones / short windows: compact top bar, three short scrolling columns, pinned action bar. */
@media (pointer: coarse) and (orientation: landscape) and (min-width: 561px), (max-height: 520px) and (min-width: 561px) {
  #arena .lobby { gap: var(--ge-s2); padding: calc(6px + var(--ge-st)) calc(10px + var(--ge-sr)) calc(6px + var(--ge-sb)) calc(10px + var(--ge-sl)); }
  #arena .top .bt { display: flex; align-items: baseline; gap: var(--ge-s2); min-width: 0; }
  #arena .btn.back { min-height: 40px; padding: 4px 10px; } #arena .btn.back .bl { display: none; } #arena .btn.back .bs { display: inline; }
  #arena .title { font-size: 20px; } #arena .brand { font-size: 9.5px; letter-spacing: .2em; } #arena .title small { display: none; }
  #arena .tools .lbl { display: none; } #arena .tools .chip { padding: 4px 10px; }
  #arena .btn { padding: 8px 12px; }
  #arena .cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; gap: var(--ge-s2); margin: 0; padding: 0; }
  #arena .col { padding: 8px 8px 0; border-radius: var(--ge-r2); }
  #arena .col > .list { overflow-y: auto; padding-bottom: 8px; }
  #arena .col.c-room { order: 0; }
  #arena .h { margin-bottom: 6px; font-size: var(--ge-fs-xs); } #arena .h .step { width: 18px; height: 18px; font-size: 11px; }
  #arena .city, #arena .veh { padding: 6px 8px; margin-bottom: 6px; } #arena .city { grid-template-columns: 24px 1fr; gap: 6px; } #arena .city .lv small { display: none; } #arena .city .lv { font-size: 18px; } #arena .city .nm { font-size: 14px; } #arena .city .nm span { display: none; } #arena .city .tg, #arena .veh .bl { font-size: var(--ge-fs-xs); }
  #arena .slot { padding: 6px 8px; margin-bottom: 6px; } #arena .slot .n { font-size: 13px; }
  #arena .veh .nm { font-size: 13.5px; } #arena .veh .nm span { display: none; } #arena .veh .bars { display: none; }
  #arena .room { padding: 8px; gap: 6px; margin-bottom: 8px; } #arena .room .btn .apps { display: none; } #arena .room .code { font-size: 16px; } #arena .room .gift { display: none; }
  #arena .nick { margin-bottom: 6px; } #arena .nick input { min-height: 36px; padding: 5px 8px; }
  #arena .foot { flex-direction: row; align-items: center; gap: var(--ge-s2); }
  #arena .rules .rc { display: none; } #arena .rules .full { font-size: 12px; max-height: 60vh; }
  #arena .foot .actions { flex: 0 1 auto; justify-content: flex-end; }
  #arena .btn.cta { min-height: 48px; font-size: 16px; padding: 4px 18px; }
}
@media (max-height: 520px) and (max-width: 700px) { #arena .foot label.tog { padding: 0 6px; } #arena .btn.cta small { display: none; } #arena .foot [data-a="join"] { padding-inline: 10px; } }
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
  /** Site directory (live count); null without a backend. */
  hub: HubLike | null = null;
  /** Leave for the hub screen (null where there is no hub: claude.ai rooms, local tabs, tests). */
  onHub: (() => void) | null = null;

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
        ? `<div class="rh">${linkLine}</div><div class="code-row">${L('房间号', 'Room')} <b class="code"></b></div>${this.pubControl()}<button class="btn outline" data-a="copy">📣 ${L('邀请好友', 'Invite friends')}<span class="apps">${L('（微信 / 抖音 / 小红书…）', ' (WhatsApp / TikTok / IG…)')}</span></button><div>${L('把链接发给好友就能一起玩（最多 4 人）', 'Send the link to friends to play together (up to 4)')}</div><div class="gift">🎁 ${L('分享就送派对帽，和好友打完一局送限定涂装', 'Share for a free Party Hat; play a match with a friend for an exclusive skin')}</div>`
        : s.net.kind === 'room'
          ? L('邀请好友：点页面右上角的 <b>Share</b>，给好友「可互动」或更高权限，再把链接发给他们。好友用自己的 Claude 账号登录打开即可加入。', 'Invite friends: click <b>Share</b> (top right), give them “can interact”, and send them the link. They join with their own Claude account.')
          : s.net.kind === 'local'
            ? L('本地多开测试：同一浏览器再开一个标签页即可加入。', 'Local test: open another tab in this browser to join.')
            : `${L('单人模式：AI 对手补满 4 个位置。', 'Solo: AI rivals fill the empty slots.')}<br><button class="btn outline" data-a="copy">📣 ${L('分享游戏给好友', 'Share the game')}</button>`;
    const onlineRoom = s.net.kind === 'online';
    const waiting = players.filter((p) => !p.isMe && p.id !== s.hostId() && !p.ready).length;
    const startLabel = s.warmupReady()
      ? `${L('先和 AI 热身', 'Warm up vs AI')}<small>${L('好友来了自动重开', 'restarts when a friend joins')}</small>`
      : L('开始比赛', 'Start');
    // Re-renders (presence updates) must not close the rules or jump the scroll position.
    const rulesOpen = (this.lobby.querySelector('details.rules') as HTMLDetailsElement | null)?.open ?? false;
    const scrolls = [...this.lobby.querySelectorAll<HTMLElement>('.cols, .list')].map((e) => e.scrollTop);
    const hadFocus = this.lobby.contains(document.activeElement);
    this.lobby.innerHTML = `
      <div class="top">
        <div class="lead">${this.onHub ? `<button class="btn back" data-a="hub" aria-label="${L('返回房间大厅', 'Back to the room browser')}">← <span class="bl">${L('返回房间大厅', 'Room browser')}</span><span class="bs">${L('大厅', 'Rooms')}</span></button>` : ''}<div class="bt"><div class="brand">GROW EVERYTHING</div><div class="title">${L('竞技场', 'Arena')}<small>${isHalloween(s.city) ? L(`最多 ${HW.maxPlayers} 人 · 万圣节大逃杀`, `Up to ${HW.maxPlayers} players · Halloween hunt`) : L('最多 4 人 · 吞下整座城市', 'Up to 4 players · eat the city')}</small></div></div></div>
        <div class="tools"><span class="chip hubcount" hidden><i></i><span></span></span><span class="chip coins" title="${L('金币', 'Coins')}">◎ ${prog.coins}</span><button class="btn icon" data-a="shop" aria-label="${L('商店', 'Shop')}">🛒<span class="lbl">${L('商店', 'Shop')}</span></button><button class="btn icon" data-a="lang" aria-label="${L('Switch to English', '切换到中文')}">${otherLangLabel()}</button><button class="btn icon" data-a="settings" aria-label="${L('设置', 'Settings')}">⚙</button><button class="btn icon" data-a="story" aria-label="${L('剧情模式', 'Story')}">📖<span class="lbl">${L('剧情模式', 'Story')}</span></button></div>
      </div>
      <div class="cols">
        <div class="col c-city"><div class="h"><span class="step">1</span>${L('选关卡', 'Pick a level')}${host ? '' : `<span class="sub">${L('由房主选择', 'host picks')}</span>`}</div><div class="list cities"></div></div>
        <div class="col c-veh"><div class="h"><span class="step">2</span>${L('选车辆', 'Pick a vehicle')}</div><div class="list vehs"></div></div>
        <div class="col c-room"><div class="h">${L('玩家', 'Players')}<span class="sub">${online}${s.net.kind === 'solo' ? '' : ` · <b>${peersN}</b> ${L('人在房间', 'in room')}`}${specs ? ` · ${specs} ${L('人观战', 'watching')}` : ''}</span></div><div class="list">
          ${onlineRoom ? `<div class="room invite">${invite}</div>` : ''}${s.net.kind === 'room' ? '' : `<label class="nick">${L('昵称', 'Name')} <input maxlength="16" aria-label="${L('昵称', 'Name')}"></label>`}<div class="slots"></div>
          ${onlineRoom ? '' : `<div class="invite">${invite}</div>`}</div></div>
      </div>
      <div class="foot">
        <details class="rules"><summary><span class="rk">📖 ${L('规则', 'Rules')}</span><span class="rc">🦷 ${L('大 <b>25%</b> 就能吞掉对手', '<b>25%</b> bigger eats')}</span><span class="rc">♥ ${L('每人 <b>3</b> 条命', '<b>3</b> lives')}</span><span class="rc">⏱ <b>${roundSecondsFor(s.city) / 60}</b> ${L('分钟一局', 'min')}</span>${isHalloween(s.city) ? `<span class="rc">👻 ${L('下半场被抓 = <b>0 分</b>', 'Caught in the 2nd half = <b>0</b>')}</span>` : ''}<span class="rc">⚡🧲🛡 ${L('道具', 'Power-ups')}</span><span class="more">${L('详情', 'Details')}</span></summary><div class="full">${L(
          `${isHalloween(s.city) ? `万圣节小镇：一局 ${roundSecondsFor(s.city) / 60} 分钟，最多 ${HW.maxPlayers} 人。上半场（${HW.huntAt / 60} 分钟）照常吃东西长大，结束时你的质量就是你的分数。下半场所有车变回小车，${HUNTERS.map((h) => hunterName(h)[0]).join('、')} 三个最恐怖的 BOSS 从中央广场爬出来追人：被抓到分数清零并出局。BOSS 吃不掉也打不过。下半场地图某个角落藏着隐身的蛋之谷，每局位置不同：找到她、在她身边按喇叭 📯 叫醒她，拿到煎蛋背包——隐身 10 秒（BOSS 看不见你）并且分数 +1/3。地图上其他所有万圣节东西（南瓜、墓碑、骷髅、吸血鬼、狼人、女巫……）上半场都能被你的车吃掉。最后按分数排名——上半场落后的人，只要活到最后，就可能反超。<br>` : ''}规则：比对手大 25% 就能把它整个吞掉（得到它 60% 的质量）。每人 3 条命，被吞后留 45% 质量重生。${A.roundSeconds / 60} 分钟结束，或只剩一人，或地标被拆完。金色箱子、连击、第一滴血、吞掉第一名（悬赏）、拆掉地标最后一块都有奖励；落后的人吃东西有追赶加成；道具箱：⚡加速、🧲强磁、🛡护盾（不会被吃）；冲刺撞上吃不动的东西会被眩晕并掉质量。`,
          `${isHalloween(s.city) ? `Halloween Town: a ${roundSecondsFor(s.city) / 60}-minute round for up to ${HW.maxPlayers} players. First half (${HW.huntAt / 60} min): eat and grow as usual — your mass at half time is your score. Second half: every machine shrinks back to small and the three bosses — ${HUNTERS.map((h) => hunterName(h)[1]).join(', ')} — crawl out of the central plaza to hunt you. Caught = score 0 and you're out. Bosses can't be eaten or beaten. Somewhere in the second half an invisible girl, Egg Valley, hides in a different corner every round: find her and HONK 📯 next to her to get her fried-egg backpack — 10 s of invisibility (the bosses can't see you) and +1/3 score. Everything else on the map (pumpkins, tombstones, skeletons, vampires, werewolves, witches…) is food for your machine in the first half. Final ranking is by score, so whoever is behind can still win by surviving.<br>` : ''}Rules: be 25% bigger than a rival to swallow it whole (you get 60% of its mass). 3 lives each; when eaten you respawn with 45% of your mass. The round ends after ${A.roundSeconds / 60} minutes, when one machine is left, or when the landmark is torn down. Golden crates, combos, first blood, the leader's bounty and the last landmark piece all pay extra; machines behind the leader get a catch-up bonus. Power-ups: ⚡ speed, 🧲 magnet, 🛡 shield (can't be eaten). Dashing into something you can't eat stuns you and costs mass.`,
        )}</div></details>
        <div class="actions">
          <button class="btn${me || host ? '' : ' primary cta'}" data-a="join">${me ? L('离开 · 观战', 'Leave · spectate') : L('加入比赛', 'Join')}</button>
          ${me && !host ? `<button class="btn ${s.ready ? 'is-ready' : 'primary cta'}" data-a="ready" aria-pressed="${s.ready}">${s.ready ? `✓ ${L('已准备', 'Ready')}<small>${L('点击取消', 'tap to undo')}</small>` : `${L('点我准备', 'Tap when ready')}<small>${L('房主等你准备好才能开始', 'the host starts once you are ready')}</small>`}</button>` : ''}
          ${host ? `<label class="tog"><input type="checkbox" id="arena-bots" ${s.bots ? 'checked' : ''}> ${L('AI 对手补位', 'Fill with AI')}</label><button class="btn primary cta" data-a="start" ${s.canStart() ? '' : 'disabled'}>${s.canStart() ? startLabel : `${L('等待准备', 'Waiting')}<small>${L(`${waiting} 人还没准备`, `${waiting} not ready yet`)}</small>`}</button>` : `<span class="chip wait-host">${s.ready ? L('✓ 已准备 · 等待房主开始', '✓ Ready · waiting for the host') : L('准备好后房主才能开始', 'Get ready so the host can start')}</span>`}
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
      const event = isHalloween(c.id);
      b.innerHTML = `<div class="lv">${event ? '🎃' : c.level || '★'}<small>${event ? L('活动', 'EVENT') : c.level ? L('关', 'LEVEL') : L('加分', 'BONUS')}</small></div><div><div class="nm"></div><div class="tg"></div></div>`;
      (b.querySelector('.nm') as HTMLElement).innerHTML = `${L(c.nameZh, c.name)}<span>${L(c.name.toUpperCase(), '')}</span>${locked ? ' 🔒' : ''}`;
      (b.querySelector('.tg') as HTMLElement).textContent = locked ? L(`赢下第 ${c.level - 1} 关解锁`, `Win level ${c.level - 1} to unlock`) : `${L(c.taglineZh ?? c.tagline, c.tagline)}${event ? L(` · ${HW.maxPlayers} 人 · ${roundSecondsFor(c.id) / 60} 分钟`, ` · ${HW.maxPlayers} players · ${roundSecondsFor(c.id) / 60} min`) : ''}`;
      b.onclick = () => {
        s.setCity(c.id);
        this.renderLobby();
      };
      cities.appendChild(b);
    }
    // Slots.
    const slots = this.lobby.querySelector('.slots') as HTMLElement;
    for (let i = 0; i < s.seats(); i++) {
      const p = players[i];
      const d = document.createElement('div');
      d.className = `slot${p ? '' : ' empty'}`;
      d.innerHTML = `<i style="background:#${SLOT_COLORS[i].toString(16).padStart(6, '0')}"></i><div><div class="n"></div><div class="v"></div></div><div class="st"></div>`;
      const n = d.querySelector('.n') as HTMLElement;
      if (p) {
        n.textContent = p.name;
        if (p.isMe) n.insertAdjacentHTML('beforeend', `<em>${L('你', 'you')}</em>`);
        (d.querySelector('.v') as HTMLElement).textContent = `${L(VEHICLES[p.vehicle].nameZh, VEHICLES[p.vehicle].name)}${p.guest ? L(' · 访客', ' · guest') : ''}`;
        const st = d.querySelector('.st') as HTMLElement;
        const isHostSlot = p.id === s.hostId();
        st.textContent = isHostSlot ? `👑 ${L('房主', 'Host')}` : p.ready ? `✓ ${L('已准备', 'Ready')}` : `… ${L('未准备', 'Not ready')}`;
        st.classList.add(isHostSlot ? 'host' : p.ready ? 'ok' : 'no');
        if (!isHostSlot) d.classList.add(p.ready ? 'ready' : 'unready');
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
      b.innerHTML = `<div class="nm"><i style="background:#${v.shell.toString(16).padStart(6, '0')}"></i>${L(v.nameZh, v.name)} <span>${L(v.name, '')}</span></div><div class="bl"></div>
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
        else if (a === 'hub') return this.onHub?.();
        else if (a === 'shop') return this.panels?.showShop();
        else if (a === 'settings') return this.panels?.showSettings();
        else if (a === 'lang') return toggleLang();
        else if (a === 'copy') {
          this.onShare?.();
          return;
        }
        this.renderLobby();
      };
    });
    if (rulesOpen) (this.lobby.querySelector('details.rules') as HTMLDetailsElement).open = true;
    this.lobby.querySelectorAll<HTMLElement>('.cols, .list').forEach((e, i) => (e.scrollTop = scrolls[i] ?? 0));
    // Keyboard / gamepad players land on the one button that matters (never steals focus from the name field).
    if (!hadFocus && document.activeElement === document.body && matchMedia('(pointer: fine)').matches) (this.lobby.querySelector('.cta:not(:disabled)') as HTMLElement | null)?.focus({ preventScroll: true });
    const bots = this.lobby.querySelector('#arena-bots') as HTMLInputElement | null;
    if (bots) bots.onchange = () => {
      s.setBots(bots.checked);
      this.renderLobby();
    };
    const pub = this.lobby.querySelector('#arena-pub') as HTMLInputElement | null;
    if (pub) pub.onchange = () => {
      s.setPublic(pub.checked);
      this.onPublic?.(pub.checked);
      this.renderLobby();
    };
    this.updateHubCount();
  }

  /** Telemetry hook: the host flipped public / friends-only. */
  onPublic: ((pub: boolean) => void) | null = null;

  /** Online rooms with a hub: the host picks public / friends-only; the others see which it is. */
  private pubControl(): string {
    const s = this.session;
    if (!this.hub || s.net.kind !== 'online') return '';
    if (s.isHost())
      return `<label class="tog pubtog"><input type="checkbox" id="arena-pub" ${s.pub ? 'checked' : ''}><span>${s.pub ? `🌐 ${L('公开 · 任何人可加入', 'Public · anyone can join')}` : `🔒 ${L('私密 · 仅邀请链接', 'Private · invite link only')}`}<small>${s.pub ? L('房间显示在房间大厅里；关掉 = 私密', 'Listed in the room browser; untick = private') : L('不在房间大厅里显示；勾上 = 公开', 'Not listed in the room browser; tick = public')}</small></span></label>`;
    return `<div class="pubstate">${s.pub ? `🌐 ${L('公开房间 · 房间大厅里可见', 'Public room · listed in the room browser')}` : `🔒 ${L('私密房间 · 仅邀请链接', 'Private room · invite link only')}`}</div>`;
  }

  /** The site-wide live count (lobby top bar + HUD corner); hidden unless the number is real. */
  updateHubCount(): void {
    const v = this.hub?.view();
    this.el.querySelectorAll<HTMLElement>('.hubcount').forEach((el) => {
      el.hidden = !v?.available;
      if (!v?.available) return;
      const n = v.capped ? `${v.online}+` : String(v.online);
      const rooms = v.rooms.length + v.privateRooms;
      (el.querySelector('span') as HTMLElement).textContent = el.classList.contains('hubmini')
        ? L(`${n} 人在线`, `${n} online`)
        : L(`${n} 人在线 · ${rooms} 个房间`, `${n} online · ${rooms} ${rooms === 1 ? 'room' : 'rooms'}`);
    });
  }

  // ── In round ──────────────────────────────────────────────────────────────
  renderRound(g: ArenaGame): void {
    const s = this.session;
    if (s.match.ph === 'lobby') return;
    if (!this.overlay.dataset.built) {
      this.overlay.dataset.built = '1';
      this.overlay.innerHTML = `<div class="hubmini hubcount" hidden aria-label="${L('在线人数', 'Players online')}"><i></i><span></span></div><div class="timer"><b class="hex">5:00</b><span></span><em class="lock" hidden></em></div><div class="board"></div><div class="feed"></div><div class="warm" hidden><span class="wl">🔥 ${L('热身中 · 等好友加入，好友一来自动重新开局', 'Warm-up · a friend joining restarts the round')}</span><span class="ws">🔥 ${L('热身中 · 好友来了自动重开', 'Warm-up · restarts when a friend joins')}</span><button class="btn primary" data-w="invite">📣 ${L('邀请', 'Invite')}</button><button class="btn" data-w="leave">${L('退出热身', 'Leave')}</button></div><div class="center"></div><button class="btn primary revive" hidden>📺 ${L('看广告复活 · 保留 75% 质量', 'Watch an ad: revive with 75% mass')}</button><div class="combo"></div><div class="tags"></div><canvas class="map" width="368" height="368" aria-label="minimap"></canvas><div class="emotes" aria-label="emotes"><button data-e="1" title="1">😂</button><button data-e="3" title="3">👋</button><button data-e="4" title="4">🐷</button><button data-e="6" title="H">📯</button><button class="cam" title="V" aria-label="${L('切换视角', 'Switch camera')}">🎥</button></div>`;
      this.overlay.querySelectorAll<HTMLButtonElement>('.emotes button[data-e]').forEach((b) => (b.onclick = () => this.onEmote?.(Number(b.dataset.e))));
      (this.overlay.querySelector('.emotes .cam') as HTMLButtonElement).onclick = () => this.onCamera?.();
      g.onFeed = (text, tone) => this.feed(text, tone);
      (this.overlay.querySelector('.revive') as HTMLButtonElement).onclick = () => this.onRevive?.();
      (this.overlay.querySelector('[data-w="invite"]') as HTMLButtonElement).onclick = () => this.onShare?.();
      (this.overlay.querySelector('[data-w="leave"]') as HTMLButtonElement).onclick = () => this.session.leaveWarmup();
      this.updateHubCount();
    }
    (this.overlay.querySelector('.warm') as HTMLElement).hidden = !(s.match.wu && s.isHost() && s.match.ph !== 'results');
    if (s.match.wj && this.joinedNoticeEp !== s.match.ep) {
      this.joinedNoticeEp = s.match.ep;
      this.notice(L(`${s.match.wj} 加入了！正式开局`, `${s.match.wj} joined! New round`));
    }
    (this.overlay.querySelector('.revive') as HTMLElement).hidden = !(this.adsAvailable && g.canRevive());
    const left = g.timeLeft(roundSecondsFor(g.city.id));
    (this.overlay.querySelector('.timer b') as HTMLElement).textContent = `${Math.floor(left / 60)}:${Math.floor(left % 60).toString().padStart(2, '0')}`;
    const climax = g.climaxTotal();
    const stage = g.hunt?.stage();
    (this.overlay.querySelector('.timer') as HTMLElement).classList.toggle('hunt', !!stage && stage !== 'grow');
    (this.overlay.querySelector('.timer span') as HTMLElement).textContent = g.hunt
      ? `${L(g.city.nameZh, g.city.name)} · ${stage === 'grow' ? L('🎃 距离下半场', '🎃 Hunt starts in') : stage === 'chase' ? L('👻 活下去！', '👻 Survive!') : L('👻 它们来了……', '👻 They are coming…')}`
      : `${L(g.city.nameZh, g.city.name)} · ${L(g.city.climaxNameZh, g.city.climaxName.replace(/^the /, ''))} ${climax - g.climaxLeft()}/${climax}`;
    // Landmark lock cue: countdown while it is solid, then a short "open" highlight.
    const lock = this.overlay.querySelector('.timer .lock') as HTMLElement;
    const opensIn = A.landmarkOpenSeconds - g.matchTime;
    const lmName = L(g.city.climaxNameZh, 'Landmark');
    if (climax > 0 && g.climaxLeft() > 0 && opensIn > 0) {
      lock.hidden = false;
      lock.classList.remove('open');
      const t = `${Math.floor(Math.ceil(opensIn) / 60)}:${(Math.ceil(opensIn) % 60).toString().padStart(2, '0')}`;
      lock.textContent = L(`🔒 ${lmName} ${t} 后开放`, `🔒 ${lmName} opens in ${t}`);
    } else if (climax > 0 && g.climaxLeft() > 0 && opensIn > -8) {
      lock.hidden = false;
      if (!lock.classList.contains('open')) {
        lock.classList.add('open');
        lock.textContent = L('🔓 可以推倒了!', '🔓 Topple it now!');
      }
    } else lock.hidden = true;
    // Scoreboard.
    const board = this.overlay.querySelector('.board') as HTMLElement;
    const hunt = g.hunt && g.hunt.start !== null ? g.hunt : null;
    if (hunt) {
      this.renderHuntBoard(g, hunt, board);
    } else {
    const rows = [...g.actors].sort((a, b) => (a.eliminated !== b.eliminated ? (a.eliminated ? 1 : -1) : b.mass - a.mass));
    board.textContent = '';
    rows.forEach((a, i) => {
      const r = document.createElement('div');
      r.className = `row${a === g.local ? ' me' : ''}${a.eliminated ? ' out' : ''}`;
      r.innerHTML = `<span class="rk">${i + 1}</span><i style="background:#${SLOT_COLORS[a.slot % SLOT_COLORS.length].toString(16).padStart(6, '0')}"></i><span class="nm"></span><span class="hp"></span><span class="ms hex"></span><span class="lv2"></span>`;
      (r.querySelector('.nm') as HTMLElement).textContent = (i === 0 && !a.eliminated ? '👑 ' : '') + a.name + (a === g.local ? L('（你）', ' (you)') : '');
      (r.querySelector('.ms') as HTMLElement).textContent = massText(a.mass);
      (r.querySelector('.hp') as HTMLElement).textContent = a.eliminated ? '' : '♥'.repeat(a.lives);
      (r.querySelector('.lv2') as HTMLElement).textContent = `${L('吞', 'ate')} ${a.kills} · ${L(a.vehicle.nameZh, a.vehicle.name)}${a.eliminated ? L(' · 出局', ' · out') : !a.alive ? L(' · 重生中', ' · respawning') : ''}`;
      board.appendChild(r);
    });
    }
    // Centre message.
    const center = this.overlay.querySelector('.center') as HTMLElement;
    const me = g.local;
    if (g.phase === 'countdown') center.innerHTML = `<b>${Math.max(1, Math.ceil(g.countdown))}</b><span>${L('准备', 'GET READY')}</span>`;
    else if (g.phase === 'playing' && g.matchTime < 1.2) center.innerHTML = `<b>GO</b><span>${L('开吃！', 'EAT!')}</span>`;
    else if (me && g.hunt?.caught.has(me.id)) center.innerHTML = `<span>${L('被抓住了 · 分数清零 · 观战中（点击切换视角）', 'Caught · score 0 · spectating (tap to switch)')}</span>`;
    else if (me && me.eliminated) center.innerHTML = `<span>${L(g.hunt && g.hunt.start === null ? '已出局 · 下半场会复活参加大逃杀' : '已出局 · 观战中（点击切换视角）', g.hunt && g.hunt.start === null ? 'Out · you come back for the second-half hunt' : 'Eliminated · spectating (tap to switch)')}</span>`;
    else if (me && !me.alive && !isFinite(me.respawnAt)) center.innerHTML = `<span>${L('广告播放中…', 'Ad playing…')}</span>`;
    else if (me && !me.alive) center.innerHTML = `<b>${Math.max(0, me.respawnAt - g.matchTime).toFixed(1)}</b><span>${L('重生中', 'RESPAWNING')}</span>`;
    else if (!me && s.match.wu) center.innerHTML = `<span>${L('房主正在热身 · 马上为你重新开局…', 'The host is warming up · a new round starts for you now…')}</span>`;
    else if (!me) center.innerHTML = `<span>${g.phase === 'playing' && !g.hunt?.locked() && (g.hunt ? HW.huntAt : A.roundSeconds) - g.matchTime > A.dropInCutoffSeconds ? L('观战中 · 有空位会自动加入', 'Spectating · you join as soon as a slot frees up') : L('观战中 · 下一局可加入', 'Spectating · join next round')}</span>`;
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
      const edible = me && g.eligible(o, me.power);
      ctx.fillStyle = o.def.climax ? (edible ? '#ffb347' : g.locked(o) ? 'rgba(170,176,186,.5)' : 'rgba(255,179,71,.55)') : edible ? 'rgba(140,224,122,.55)' : cls >= 7 ? 'rgba(210,214,220,.34)' : 'rgba(210,214,220,.18)';
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
      ctx.fillStyle = `#${SLOT_COLORS[a.slot % SLOT_COLORS.length].toString(16).padStart(6, '0')}`;
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
    // Villains (Halloween hunt): red rings with a white core, always on top.
    const hs = g.hunt?.stage();
    if (g.hunt && (hs === 'rise' || hs === 'chase')) {
      for (const h of g.hunt.hunters) {
        const x = mx(h.x);
        const z = mz(h.z);
        ctx.fillStyle = '#ff2d55';
        ctx.beginPath();
        ctx.arc(x, z, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, z, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Halloween, once the scores are locked: locked score, running / caught. */
  private renderHuntBoard(g: ArenaGame, h: NonNullable<ArenaGame['hunt']>, board: HTMLElement): void {
    board.textContent = '';
    for (const st of g.standings()) {
      const a = g.byId.get(st.id);
      if (!a) continue;
      const caught = h.caught.has(a.id);
      const r = document.createElement('div');
      r.className = `row${a === g.local ? ' me' : ''}${caught || a.left ? ' out' : ''}`;
      r.innerHTML = `<span class="rk">${st.rank}</span><i style="background:#${SLOT_COLORS[a.slot % SLOT_COLORS.length].toString(16).padStart(6, '0')}"></i><span class="nm"></span><span class="hp"></span><span class="ms hex"></span><span class="lv2"></span>`;
      (r.querySelector('.nm') as HTMLElement).textContent = (st.rank === 1 && !caught ? '👑 ' : '') + a.name + (a === g.local ? L('（你）', ' (you)') : '');
      (r.querySelector('.ms') as HTMLElement).textContent = massText(st.mass);
      (r.querySelector('.hp') as HTMLElement).textContent = caught ? '👻' : a.left ? '' : h.egg.stealthed(a) ? '🍳' : '🏃';
      (r.querySelector('.lv2') as HTMLElement).textContent = caught ? L('被抓 · 0 分', 'caught · 0') : a.left ? L('离开了', 'left') : L('锁定分数 · 还在逃', 'score locked · running');
      board.appendChild(r);
    }
  }

  /** Halloween: each villain's name over its head; off screen, an edge arrow when it is close. */
  private renderHunterTags(g: ArenaGame, host: HTMLElement, v: THREE.Vector3): void {
    const st = g.hunt?.stage();
    const on = !!g.hunt && (st === 'rise' || st === 'chase');
    g.hunt?.hunters.forEach((h, i) => {
      const key = `hunter-${i}`;
      let tag = this.tags.get(key);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'tag hunter';
        host.appendChild(tag);
        this.tags.set(key, tag);
      }
      const me = g.local?.alive ? g.local : null;
      const dist = me ? Math.hypot(h.x - me.x, h.z - me.z) : Infinity;
      v.set(h.x, HW.hunterHeight + 0.5, h.z).project(g.camera);
      const onScreen = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      const [zh, en] = hunterName(h.def);
      tag.hidden = !on || (!onScreen && dist > 45);
      if (tag.hidden) return;
      if (onScreen) {
        tag.classList.remove('edge');
        tag.style.transform = '';
        tag.textContent = `☠ BOSS · ${L(zh, en)}`;
        tag.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
        tag.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
      } else {
        let ex = v.z > 1 ? -v.x : v.x;
        let ey = v.z > 1 ? -v.y : v.y;
        const m = Math.max(Math.abs(ex), Math.abs(ey)) || 1;
        ex = (ex / m) * 0.9;
        ey = (ey / m) * 0.84;
        if (ex > 0.6) ey = Math.max(ey, -0.2);
        const arrow = Math.abs(ex) > Math.abs(ey) ? (ex > 0 ? '▶' : '◀') : ey > 0 ? '▲' : '▼';
        tag.classList.add('edge');
        tag.textContent = `${arrow} ☠ BOSS · ${L(zh, en)} · ${Math.round(dist)} m`;
        tag.style.left = `${((ex + 1) / 2) * innerWidth}px`;
        tag.style.top = `${((1 - ey) / 2) * innerHeight + 12}px`;
        tag.style.transform = ex < -0.6 ? 'translate(0, -50%)' : ex > 0.6 ? 'translate(-100%, -50%)' : 'translate(-50%, -50%)';
      }
    });
  }

  private renderTags(g: ArenaGame): void {
    const host = this.overlay.querySelector('.tags') as HTMLElement;
    const v = new THREE.Vector3();
    this.renderHunterTags(g, host, v);
    // Machines that left the roster (drop-in replaced them) lose their tag.
    for (const [id, tag] of this.tags) if (!g.byId.has(id) && !id.startsWith('hunter-')) (tag.remove(), this.tags.delete(id));
    for (const a of g.actors) {
      let tag = this.tags.get(a.id);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'tag';
        tag.style.borderBottom = `2px solid #${SLOT_COLORS[a.slot % SLOT_COLORS.length].toString(16).padStart(6, '0')}`;
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
