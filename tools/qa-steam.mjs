// Smoke-test the packaged Steam app (Linux build under Xvfb): window opens from app://, the lobby
// renders, Quick play vs AI reaches a round, no page errors. Screenshots → renders/review/steam/.
//   xvfb-run -a node tools/qa-steam.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const bin = resolve(root, 'release/steam/GROW EVERYTHING-linux-x64/GROW EVERYTHING');
const shots = resolve(root, 'renders/review/steam');
mkdirSync(shots, { recursive: true });
const port = 9333;
const proc = spawn(bin, [`--remote-debugging-port=${port}`, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'], { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s) && !/GPU|gles|dbus|viz|Fontconfig/i.test(s)) process.stderr.write(s); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
for (let i = 0; i < 40 && !browser; i++) { await wait(500); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null); }
if (!browser) throw new Error('app did not expose a debug port');
let page;
for (let i = 0; i < 40 && !page; i++) { page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://')); if (!page) await wait(500); }
if (!page) throw new Error('no app:// page');
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const bad = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
console.log('url', page.url());
await page.waitForSelector('#ge-hub [data-a="quick"]', { timeout: 120000 });
await page.screenshot({ path: resolve(shots, 'steam-lobby.jpg'), type: 'jpeg', quality: 80 });
console.log('lobby ok');
const t0 = Date.now();
await page.click('#ge-hub [data-a="quick"]', { force: true });
await page.waitForFunction(() => !document.querySelector('#ge-hub'), null, { timeout: 240000 });
console.log(`round started after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await wait(8000);
await page.screenshot({ path: resolve(shots, 'steam-round.jpg'), type: 'jpeg', quality: 80 });
const title = await page.title();
console.log('title', title, '| page errors', errors.length, errors.slice(0, 3), '| http errors', bad.slice(0, 5));
await browser.close().catch(() => {});
proc.kill();
process.exit(errors.length ? 1 : 0);
