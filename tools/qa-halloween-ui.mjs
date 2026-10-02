#!/usr/bin/env node
// QA (release gate, Halloween update): responsive / i18n / touch sweep of a solo Halloween round.
// For each viewport × language: lobby (Halloween city card, 6 seats, rules text) → grow HUD →
// half-time banner → boss rise → chase (boss tags, timer) → Egg Valley toast → honk → egg banner →
// results card. Captures JPEGs and a DOM layout audit per state (elements off-screen, clipped text,
// overlaps between HUD blocks, tap-target sizes for horn 📯 / dash / emotes on touch devices).
//
//   node tools/qa-halloween-ui.mjs [--views phoneL,phoneS,portrait,tablet,desktop] [--langs en,zh]
//        [--url http://127.0.0.1:4173/game/] [--out renders/review/qa/ui] [--tag dev]
// Report: <out>/ui-report-<tag>.json ; exit 1 on console/page errors or a hard layout failure.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const VIEWS = {
  phoneL: { width: 844, height: 390, touch: true },
  phoneS: { width: 667, height: 375, touch: true },
  portrait: { width: 390, height: 844, touch: true },
  tablet: { width: 1024, height: 768, touch: true },
  desktop: { width: 1920, height: 1080, touch: false },
};
const views = arg('--views', Object.keys(VIEWS).join(',')).split(',');
const langs = arg('--langs', 'en,zh').split(',');
const out = resolve(root, arg('--out', 'renders/review/qa/ui'));
const tag = arg('--tag', 'dev');
mkdirSync(out, { recursive: true });

let base = arg('--url', null);
let close = async () => {};
if (!base) {
  const vite = await import('vite');
  const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5203, strictPort: false, hmr: false } });
  await server.listen();
  base = `${server.resolvedUrls.local[0]}game/`;
  close = () => server.close();
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = { base, tag, runs: [] };
let hardFails = 0;

/** In-page layout audit: visible UI blocks, off-screen / clipped / overlapping elements, tap targets. */
function audit() {
  const vw = innerWidth;
  const vh = innerHeight;
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0 || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const named = {
    timer: '#arena .timer', board: '#arena .board', map: '#arena .map', feed: '#arena .feed', emotes: '#arena .emotes',
    horn: '#arena .emotes button[data-e="6"]', dash: '.ge-dash', banner: '#hud .banner', toast: '#hud .toast', panel: '#hud .panel',
    results: '#arena .res .card', lobby: '#arena .lobby', start: '#arena .cta', revive: '#arena .revive',
  };
  const blocks = {};
  for (const [k, sel] of Object.entries(named)) {
    const el = document.querySelector(sel);
    if (vis(el)) blocks[k] = { ...rect(el), text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 160) };
  }
  const offscreen = [];
  const clipped = [];
  for (const el of document.querySelectorAll('#arena *, #hud *, .ge-dash')) {
    if (!vis(el) || !(el.innerText || '').trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
      // Only report when no scrollable ancestor explains it.
      let p = el.parentElement;
      let scroll = false;
      while (p) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) { scroll = true; break; }
        p = p.parentElement;
      }
      if (!scroll) offscreen.push({ cls: el.className?.toString?.().slice(0, 40) || el.tagName, text: el.innerText.slice(0, 60), ...rect(el) });
    }
    const s = getComputedStyle(el);
    if (el.children.length === 0 && (s.overflow === 'hidden' || s.textOverflow === 'ellipsis' || s.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 2) clipped.push({ cls: el.className?.toString?.().slice(0, 40) || el.tagName, text: el.innerText.slice(0, 60), sw: el.scrollWidth, cw: el.clientWidth });
  }
  const keys = Object.keys(blocks).filter((k) => !['lobby', 'emotes', 'results', 'start'].includes(k));
  const overlaps = [];
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const a = blocks[keys[i]];
      const b = blocks[keys[j]];
      if ((keys[i] === 'horn' && keys[j] === 'emotes') || (keys[j] === 'horn' && keys[i] === 'emotes')) continue;
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 4 && iy > 4) overlaps.push(`${keys[i]}×${keys[j]} (${ix}×${iy})`);
    }
  const horn = blocks.horn;
  const hornHit = horn ? document.elementFromPoint(horn.x + horn.w / 2, horn.y + horn.h / 2)?.closest('button[data-e="6"]') !== null : false;
  const dash = blocks.dash;
  const dashHit = dash ? document.elementFromPoint(dash.x + dash.w / 2, dash.y + dash.h / 2)?.classList.contains('ge-dash') : false;
  const body = document.body.innerText;
  const realNames = ['Yang Yongxin', '杨永信', 'Hannibal', '汉尼拔', 'Norman Bates', '诺曼'].filter((n) => body.includes(n));
  const portalNames = ['The Shock Doctor', '电击院长', 'The Cannibal', '食人魔', 'The Motel Keeper', '汽车旅馆老板'].filter((n) => body.includes(n));
  return { realNames, portalNames, vw, vh, blocks, offscreen: offscreen.slice(0, 12), clipped: clipped.slice(0, 12), overlaps, hornHit, dashHit, tags: [...document.querySelectorAll('#arena .tag')].filter(vis).map((t) => t.innerText).slice(0, 10) };
}

for (const v of views) {
  const vp = VIEWS[v];
  for (const lang of langs) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.touch && vp.width < 1000, hasTouch: vp.touch });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    const run = { view: v, lang, states: {} };
    const shot = async (state) => {
      await p.evaluate(() => window.__ARENA__.render());
      const file = `${out}/${tag}-${v}-${lang}-${state}.jpg`;
      await p.screenshot({ path: file, type: 'jpeg', quality: 72 });
      const a = await p.evaluate(audit);
      run.states[state] = { file: file.replace(root + '/', ''), ...a };
      console.log(`${v}/${lang}/${state}: names real=[${a.realNames}] portal=[${a.portalNames}] off=${a.offscreen.length} clip=${a.clipped.length} overlaps=[${a.overlaps.join(', ')}] horn=${a.blocks.horn ? `${a.blocks.horn.w}x${a.blocks.horn.h}@${a.blocks.horn.x},${a.blocks.horn.y} hit=${a.hornHit}` : '—'} dash=${a.blocks.dash ? `${a.blocks.dash.w}x${a.blocks.dash.h} hit=${a.dashHit}` : '—'}`);
      return a;
    };
    const step = (s) => p.evaluate((x) => window.__ARENA__.step(x), s);
    try {
      await p.goto(`${base}?mode=arena&net=solo&test=1&quality=low&name=Tester&lang=${lang}`);
      await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });
      await p.evaluate(() => window.__ARENA__.session.setCity('halloween'));
      await step(0.5);
      await p.waitForTimeout(400);
      const lob = await shot('lobby');
      run.lobbyText = await p.evaluate(() => {
        const t = document.querySelector('#arena .lobby')?.innerText ?? '';
        return { halloween: /Halloween Town|万圣节小镇/.test(t), event: /EVENT|活动/.test(t), seats: (t.match(/[0-9]\s*\/\s*6/) || [null])[0], rules: /Egg Valley|蛋之谷/.test(document.querySelector('#arena .lobby')?.innerHTML ?? '') };
      });
      void lob;
      await p.evaluate(() => { window.__ARENA__.session.start(); });
      for (let i = 0; i < 8; i++) await step(0.5);
      await shot('grow');
      await p.evaluate(() => (window.__ARENA__.game().matchTime = 299.4));
      await step(0.8);
      await shot('halftime');
      await step(3.2);
      await shot('rise');
      await step(4.5);
      await shot('chase');
      // Egg Valley: park next to her (toast), then honk through the real horn button (tap / click).
      const egg = await p.evaluate(() => window.__ARENA__.summary().hunt.egg);
      const park = () => p.evaluate(({ x, z }) => { const g = window.__ARENA__.game(); if (!g.local?.alive) return false; g.local.x = x + 2; g.local.z = z + 2; g.local.speed = 0; g.local.invulnerableUntil = g.matchTime + 1; return true; }, egg);
      await park();
      await step(0.3);
      await park();
      await shot('egg-toast');
      const horn = await p.$('#arena .emotes button[data-e="6"]');
      run.hornTapped = horn ? await (vp.touch ? horn.tap({ timeout: 3000 }) : horn.click({ timeout: 3000 })).then(() => true, (e) => String(e).split('\n')[0]) : 'no horn button';
      await park();
      await step(0.2);
      await shot('egg-banner'); // the HUD banner is a real-time 3 s animation: capture right away
      for (let i = 0; i < 3; i++) { await park(); await step(0.15); }
      const s1 = await p.evaluate(() => window.__ARENA__.summary());
      run.eggWokenByHornButton = s1.hunt.egg.by === s1.me;
      // End: jump to the end of the hunt.
      await p.evaluate(() => { const g = window.__ARENA__.game(); g.matchTime = g.hunt.endsAt() - 0.3; });
      await step(1.5);
      await p.waitForTimeout(300);
      const r = await shot('results');
      run.resultsRows = await p.evaluate(() => document.querySelectorAll('#arena .res tbody tr').length);
      void r;
    } catch (e) {
      run.exception = String(e);
      hardFails++;
    }
    run.errors = errors;
    if (errors.length) hardFails++;
    console.log(`== ${v}/${lang}: lobby=${JSON.stringify(run.lobbyText)} eggByHorn=${run.eggWokenByHornButton} resultsRows=${run.resultsRows} errors=${errors.length}${run.exception ? ' EXC ' + run.exception : ''}`);
    report.runs.push(run);
    await ctx.close();
  }
}
writeFileSync(`${out}/ui-report-${tag}.json`, JSON.stringify(report, null, 1));
await browser.close();
await close();
process.exit(hardFails ? 1 : 0);
