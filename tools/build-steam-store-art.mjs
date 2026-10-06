// Steam store / library images composed from the press-kit art (in-game renders, no HUD text) with
// the game title only — Steam capsules may carry the game name and art, nothing else.
//   node tools/build-steam-store-art.mjs   → release/steam-store/*.png
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'release/steam-store');
const b64 = (p) => `data:image/png;base64,${readFileSync(resolve(root, p)).toString('base64')}`;
// HUD-free Halloween Town renders from tools/steam-shots.mjs (player machine centred, dusk sky on top).
const art = b64('release/steam-store/art/art-halloween-160s.png'); // 1920×1080
const hero = b64('release/steam-store/art/art-hero-160s.png'); // 1920×620

const css = `
*{margin:0;box-sizing:border-box}body{background:transparent}
.c{position:relative;overflow:hidden;font-family:'Liberation Sans',Arial,Helvetica,sans-serif}
.bg{position:absolute;background-repeat:no-repeat}
.shade{position:absolute;inset:0}
.t{position:absolute;font-weight:700;line-height:.9;letter-spacing:-.01em;text-shadow:0 .04em .12em rgba(0,0,0,.55)}
.t b{display:block;color:#fff;font-weight:700}
.t i{display:block;font-style:normal;background:linear-gradient(180deg,#ffc56b,#c97a2a);-webkit-background-clip:text;color:transparent;filter:drop-shadow(0 .04em .08em rgba(0,0,0,.5))}`;

// Background helper: show source region (x,y,w,h) of an image of size (iw,ih) scaled into W×H.
const region = (img, iw, ih, x, y, w, h, W, H) => {
  const s = Math.max(W / w, H / h);
  return `background-image:url(${img});background-size:${iw * s}px ${ih * s}px;background-position:${-x * s}px ${-y * s}px;inset:0`;
};
const title = (size, style) => `<div class="t" style="font-size:${size}px;${style}"><b>GROW</b><i>EVERYTHING</i></div>`;

const top = 'background:linear-gradient(180deg,rgba(10,8,24,.85) 0%,rgba(10,8,24,.45) 34%,rgba(10,8,24,0) 52%)';
const bottom = 'background:linear-gradient(0deg,rgba(10,8,24,.95) 0%,rgba(10,8,24,.75) 26%,rgba(10,8,24,0) 50%)';
const jobs = [
  // name, W, H, html
  ['header_capsule_920x430', 920, 430,
    `<div class="bg" style="${region(art, 1920, 1080, 200, 0, 1500, 701, 920, 430)}"></div><div class="shade" style="${top}"></div>
     ${title(74, 'left:34px;top:26px')}`],
  ['small_capsule_462x174', 462, 174,
    `<div class="bg" style="${region(art, 1920, 1080, 300, 0, 1600, 603, 462, 174)}"></div><div class="shade" style="background:rgba(10,8,24,.45)"></div>
     ${title(58, 'left:22px;top:30px')}`],
  ['main_capsule_1232x706', 1232, 706,
    `<div class="bg" style="${region(art, 1920, 1080, 260, 0, 1570, 900, 1232, 706)}"></div><div class="shade" style="${top}"></div>
     ${title(104, 'left:48px;top:34px')}`],
  ['vertical_capsule_748x896', 748, 896,
    `<div class="bg" style="${region(art, 1920, 1080, 600, 120, 740, 886, 748, 896)}"></div><div class="shade" style="${bottom}"></div>
     ${title(104, 'left:42px;bottom:56px')}`],
  ['library_capsule_600x900', 600, 900,
    `<div class="bg" style="${region(art, 1920, 1080, 670, 120, 600, 900, 600, 900)}"></div><div class="shade" style="${bottom}"></div>
     ${title(86, 'left:34px;bottom:60px')}`],
  ['library_hero_3840x1240', 3840, 1240, `<div class="bg" style="${region(hero, 1920, 620, 0, 0, 1920, 620, 3840, 1240)}"></div>`],
  // Web-portal icons (Newgrounds, itch.io cover) from the same key art.
  ['portal_icon_630x500', 630, 500,
    `<div class="bg" style="${region(art, 1920, 1080, 430, 60, 1040, 825, 630, 500)}"></div><div class="shade" style="${top}"></div>
     ${title(62, 'left:28px;top:24px')}`],
  ['portal_icon_512x512', 512, 512,
    `<div class="bg" style="${region(art, 1920, 1080, 560, 60, 800, 800, 512, 512)}"></div><div class="shade" style="${top}"></div>
     ${title(54, 'left:24px;top:22px')}`],
  ['library_logo_1280x720', 1280, 720, title(190, 'left:60px;top:190px')],
];

const browser = await chromium.launch();
for (const [name, W, H, body] of jobs) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(`<style>${css}</style><div class="c" style="width:${W}px;height:${H}px">${body}</div>`);
  await page.screenshot({ path: resolve(out, `${name}.png`), omitBackground: name.startsWith('library_logo') });
  await page.close();
  console.log(name);
}
await browser.close();
