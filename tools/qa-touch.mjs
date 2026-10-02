#!/usr/bin/env node
// QA (release gate, Halloween update): real touch input on a phone-landscape page.
// Drives the floating joystick (left half) with CDP touch events, taps DASH and the horn 📯 with
// the touchscreen, and checks the game reacted: the machine moved forward, a dash fired, the
// horn emote went out. Also checks what sits under the thumb (the canvas, not a HUD block).
//   node tools/qa-touch.mjs [--url http://127.0.0.1:4181/] [--w 844 --h 390] [--city halloween]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const W = Number(arg('--w', 844));
const H = Number(arg('--h', 390));
const city = arg('--city', 'halloween');
const out = resolve(root, 'renders/review/qa/touch');
mkdirSync(out, { recursive: true });
let base = arg('--url', null);
let close = async () => {};
if (!base) {
  const vite = await import('vite');
  const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5211, strictPort: false, hmr: false } });
  await server.listen();
  base = `${server.resolvedUrls.local[0]}game/`;
  close = () => server.close();
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => m.type() === 'error' && !/sdk\.crazygames|ERR_TUNNEL|Failed to load resource/.test(m.text()) && errors.push(m.text()));
await p.goto(`${base}?mode=arena&net=solo&test=1&quality=low&lang=en&name=Thumb`);
await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });
const cdp = await ctx.newCDPSession(p);
const step = (s) => p.evaluate((x) => window.__ARENA__.step(x), s);
const me = () => p.evaluate(() => { const a = window.__ARENA__.game()?.local; return a ? { x: +a.x.toFixed(2), z: +a.z.toFixed(2), heading: +a.heading.toFixed(2), speed: +a.speed.toFixed(2), dashTime: a.dashTime, emote: a.emote, emoteSeq: a.emoteSeq, alive: a.alive } : null; });
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

await p.evaluate((c) => { const S = window.__ARENA__.session; S.setCity(c); S.start(); }, city);
for (let i = 0; i < 8; i++) await step(0.5);
const thumb = { x: Math.round(W * 0.2), y: Math.round(H * 0.7) };
const under = await p.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}` : null; }, thumb);
ok(/^canvas/.test(under ?? ''), `the joystick thumb spot (${thumb.x}, ${thumb.y}) lands on the canvas [${under}]`);
const before = await me();
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: thumb.x, y: thumb.y, id: 1 }] });
for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: thumb.x, y: thumb.y - k * 10, id: 1 }] });
const stick = await p.evaluate(() => document.querySelector('.ge-stick, .ge-joy, [class*="stick"]')?.getBoundingClientRect?.().width ?? null);
for (let i = 0; i < 4; i++) await step(0.25);
const held = await me();
await p.evaluate(() => window.__ARENA__.render());
await p.screenshot({ path: `${out}/touch-joystick-${W}x${H}.jpg`, type: 'jpeg', quality: 72 });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const moved = Math.hypot(held.x - before.x, held.z - before.z);
ok(moved > 1, `joystick drag up moves the machine (${moved.toFixed(2)} m in 1 s, speed ${held.speed}; stick ring ${stick ?? 'n/a'} px)`);
await step(0.5);
const dash = await p.$('.ge-dash');
const dashBox = dash ? await dash.boundingBox() : null;
ok(!!dashBox && dashBox.x + dashBox.width <= W && dashBox.y + dashBox.height <= H && dashBox.width >= 44, `DASH button on screen and ≥ 44 px (${JSON.stringify(dashBox)})`);
if (dash) await dash.tap();
await step(1 / 30);
const d = await me();
ok(d.dashTime > 0, `tapping DASH fires a dash (dashTime ${d.dashTime})`);
await step(1.5);
const horn = await p.$('#arena .emotes button[data-e="6"]');
const hb = horn ? await horn.boundingBox() : null;
ok(!!hb && hb.width >= 44 && hb.height >= 44 && hb.y + hb.height <= H, `horn 📯 on screen and ≥ 44 px (${JSON.stringify(hb)})`);
const seq0 = (await me()).emoteSeq;
if (horn) await horn.tap();
await step(1 / 30);
const h = await me();
ok(h.emote === 6 && h.emoteSeq === seq0 + 1, `tapping 📯 sends the horn emote (emote ${h.emote}, seq ${seq0}→${h.emoteSeq})`);
ok(errors.length === 0, `no page / console errors (SDK host blocked by the sandbox ignored) ${errors.slice(0, 3).join(' | ')}`);
writeFileSync(`${out}/touch-${W}x${H}.json`, JSON.stringify({ base, before, held, moved, dashBox, hornBox: hb, under, errors }, null, 1));
await browser.close();
await close();
process.exit(fails ? 1 : 0);
