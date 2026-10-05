// Steam store / library images composed from the press-kit art (in-game renders, no HUD text) with
// the game title only — Steam capsules may carry the game name and art, nothing else.
//   node tools/build-steam-store-art.mjs   → release/steam-store/*.png
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'release/steam-store');
const b64 = (p) => `data:image/png;base64,${readFileSync(resolve(root, p)).toString('base64')}`;
const wide = b64('marketing/press-kit/covers/cover-1920x1080.png'); // car + street on the right half
const tall = b64('release/crazygames/cover-800x1200.png'); // car + street below y≈460

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

const jobs = [
  // name, W, H, html
  ['header_capsule_920x430', 920, 430,
    `<div class="bg" style="${region(wide, 1920, 1080, 860, 300, 1060, 495, 920, 430)}"></div>
     <div class="shade" style="background:linear-gradient(90deg,rgba(12,13,16,.94) 0%,rgba(12,13,16,.75) 42%,rgba(12,13,16,0) 70%)"></div>
     ${title(92, 'left:40px;top:118px')}`],
  ['small_capsule_462x174', 462, 174,
    `<div class="bg" style="${region(wide, 1920, 1080, 980, 360, 940, 354, 462, 174)}"></div>
     <div class="shade" style="background:linear-gradient(90deg,rgba(12,13,16,.95) 0%,rgba(12,13,16,.8) 50%,rgba(12,13,16,.1) 80%)"></div>
     ${title(50, 'left:18px;top:40px')}`],
  ['main_capsule_1232x706', 1232, 706,
    `<div class="bg" style="${region(wide, 1920, 1080, 700, 220, 1220, 700, 1232, 706)}"></div>
     <div class="shade" style="background:linear-gradient(90deg,rgba(12,13,16,.92) 0%,rgba(12,13,16,.7) 38%,rgba(12,13,16,0) 62%)"></div>
     ${title(128, 'left:56px;top:212px')}`],
  ['vertical_capsule_748x896', 748, 896,
    `<div class="bg" style="${region(tall, 800, 1200, 120, 470, 560, 671, 748, 896)}"></div>
     <div class="shade" style="background:linear-gradient(0deg,rgba(12,13,16,.95) 0%,rgba(12,13,16,.8) 30%,rgba(12,13,16,0) 55%)"></div>
     ${title(112, 'left:44px;bottom:60px')}`],
  ['library_capsule_600x900', 600, 900,
    `<div class="bg" style="${region(tall, 800, 1200, 190, 470, 420, 630, 600, 900)}"></div>
     <div class="shade" style="background:linear-gradient(0deg,rgba(12,13,16,.95) 0%,rgba(12,13,16,.8) 30%,rgba(12,13,16,0) 55%)"></div>
     ${title(88, 'left:36px;bottom:64px')}`],
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
