// Capture hunter review images: node tools/hunter-preview/shoot.mjs (with vite on :5198).
import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5198/tools/hunter-preview/';
const out = 'renders/review/hunters/';
const shots = [
  ['lineup', 'view=lineup'], ['quarter', 'view=quarter'], ['top', 'view=top'], ['back', 'view=back'], ['face', 'view=face'],
  ['poses-shock', 'view=poses&kind=shock'], ['poses-cannibal', 'view=poses&kind=cannibal'], ['poses-motel', 'view=poses&kind=motel'],
];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
for (const [name, qs] of shots) {
  await page.goto(`${base}?${qs}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.screenshot({ path: `${out}${name}.png` });
  if (name === 'lineup') console.log(JSON.stringify(await page.evaluate(() => window.__stats)));
}
await browser.close();
