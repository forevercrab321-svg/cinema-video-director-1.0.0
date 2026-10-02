// Capture the Halloween atmosphere review set: node tools/halloween-fx-preview/shoot.mjs [quality] (vite on :5199).
// Images → renders/review/halloween-fx/<view>-<state>[-<quality>].png; prints the FX layer's renderer.info per shot.
import { chromium } from 'playwright';
const port = process.env.PORT ?? '5199';
const base = `http://127.0.0.1:${port}/tools/halloween-fx-preview/`;
const out = 'renders/review/halloween-fx/';
const only = process.argv[2];
const shots = [
  ['play', 'normal'], ['play', 'locked'], ['play', 'hunt'], ['play', 'erupt'], ['play', 'caught'],
  ['chase', 'normal'], ['chase', 'hunt'],
  ['wide', 'normal'], ['wide', 'locked'], ['wide', 'hunt'],
  ['moon', 'normal'], ['moon', 'locked'],
];
const tiers = only ? [only] : ['medium'];
const pick = process.env.ONLY ? process.env.ONLY.split(',') : null;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
for (const quality of tiers)
  for (const [view, state] of process.env.STATS ? [['wide', 'hunt'], ['play', 'hunt'], ['play', 'normal']] : shots.filter(([v, st]) => !pick || pick.includes(v + '-' + st))) {
    await page.goto(`${base}?view=${view}&state=${state}&quality=${quality}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
    const name = `${view}-${state}${quality === 'medium' ? '' : '-' + quality}`;
    if (!process.env.STATS) await page.screenshot({ path: `${out}${name}.png` });
    console.log(name, JSON.stringify(await page.evaluate(() => window.__stats)));
  }
await browser.close();
