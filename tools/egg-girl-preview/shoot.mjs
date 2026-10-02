// Capture egg-girl review images: node tools/egg-girl-preview/shoot.mjs (with vite on :5211).
import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5211/tools/egg-girl-preview/';
const out = 'renders/review/egg-girl/';
const only = process.argv[2];
const shots = [
  ['front-vs-ref', 'view=front', 1400, 900], ['quarter', 'view=quarter'], ['back', 'view=back'], ['face', 'view=face'],
  ['backpack', 'view=bag'], ['hint', 'view=hint'], ['top', 'view=top'], ['states', 'view=states'], ['side', 'view=side'],
];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [name, qs, w = 1280, h = 720] of shots) {
  if (only && !only.split(',').includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${base}?${qs}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.screenshot({ path: `${out}${name}.jpg`, type: 'jpeg', quality: 88 });
  if (name === 'front-vs-ref' || only) console.log(name, JSON.stringify(await page.evaluate(() => window.__stats)));
  await page.close();
}
await browser.close();
