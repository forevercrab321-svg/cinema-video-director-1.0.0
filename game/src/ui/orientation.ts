/**
 * Phones play in LANDSCAPE. On touch devices held upright a full-screen "rotate your phone"
 * card covers the game; tapping it (or the ⛶ button) asks for fullscreen and, where the
 * browser allows it (Android Chrome), locks the orientation to landscape. iOS Safari cannot
 * lock orientation, so the card simply waits for the player to turn the phone.
 * Inside an iframe (the claude.ai artifact) fullscreen may be refused: everything degrades to
 * the rotate card, never to an error.
 *
 * iPhone: Safari has no fullscreen API for pages, so the address bar always stays. The only
 * true full screen is the home-screen app (manifest: display fullscreen, orientation landscape,
 * apple-mobile-web-app-capable). There the ⛶ button opens the "Add to Home Screen" steps, and
 * the first landscape session shows them once. Not on portal builds: a portal forbids sending
 * players off-site, and the portal page owns fullscreen there.
 */
import { L } from '../i18n';
import { PORTAL_BUILD } from '../platform/Platform';

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const HINT_KEY = 'grow-a2hs-hint';

export function installLandscapeMode(): void {
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (!coarse) return;
  const css = document.createElement('style');
  css.textContent = `
.ge-rotate { position: fixed; inset: 0; z-index: 50; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 24px;
  background: radial-gradient(ellipse at center, #26292d, #121315); color: #f2efe8; font: 800 18px system-ui, 'PingFang SC', sans-serif; letter-spacing: .08em; text-align: center; border: 0; width: 100%; }
.ge-rotate .phone { width: 56px; height: 96px; border: 4px solid #ffb347; border-radius: 12px; animation: ge-turn 1.8s ease-in-out infinite; }
.ge-rotate small { font-size: 12px; font-weight: 600; opacity: .7; letter-spacing: .04em; }
@keyframes ge-turn { 0%, 20% { transform: rotate(0); } 60%, 100% { transform: rotate(-90deg); } }
@media (orientation: portrait) { .ge-rotate { display: flex; } }
.ge-full { position: fixed; bottom: calc(8px + env(safe-area-inset-bottom)); left: calc(8px + env(safe-area-inset-left)); z-index: 30; border: 0; border-radius: 12px; width: 44px; height: 44px;
  background: rgba(16,18,20,.45); color: #f2efe8; font-size: 16px; }
:fullscreen .ge-full, .ge-full[hidden] { display: none; }
@media (orientation: portrait) { .ge-full { display: none; } }
.ge-a2hs { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(10,11,12,.72); border: 0; width: 100%; }
.ge-a2hs[hidden] { display: none; }
.ge-a2hs .card { background: #1e2124; color: #f2efe8; border-radius: 16px; padding: 18px 20px; max-width: 420px; width: 100%; font: 600 14px/1.5 system-ui, 'PingFang SC', sans-serif; text-align: left; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.ge-a2hs h3 { margin: 0 0 8px; font-size: 17px; letter-spacing: .04em; }
.ge-a2hs ol { margin: 8px 0 12px; padding-left: 22px; }
.ge-a2hs li { margin: 4px 0; }
.ge-a2hs .k { display: inline-block; border: 1px solid #ffb347; color: #ffb347; border-radius: 6px; padding: 0 6px; font-weight: 800; }
.ge-a2hs .row { display: flex; gap: 10px; justify-content: flex-end; }
.ge-a2hs button { border: 0; border-radius: 10px; padding: 10px 16px; font: 800 14px system-ui, sans-serif; color: #121315; background: #ffb347; }
.ge-a2hs button.ghost { background: transparent; color: #a8a39b; }`;
  document.head.appendChild(css);

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'ge-rotate';
  card.setAttribute('aria-label', L('请横屏游玩', 'Rotate to landscape'));
  card.innerHTML = `<div class="phone"></div><div>${L('请把手机横过来玩', 'ROTATE TO LANDSCAPE')}</div><small>${L('点一下进入全屏横屏（支持的手机会自动锁定方向）', 'Tap for fullscreen landscape (locks automatically where supported)')}</small>`;
  card.addEventListener('click', () => void goLandscape());
  document.body.appendChild(card);

  const full = document.createElement('button');
  full.type = 'button';
  full.className = 'ge-full';
  full.textContent = '⛶';
  full.title = L('全屏', 'Fullscreen');
  full.setAttribute('aria-label', full.title);
  full.addEventListener('click', () => void goLandscape());
  document.body.appendChild(full);

  if (IOS && !STANDALONE && !PORTAL_BUILD) {
    // iPhone in Safari: the button explains the home-screen app (the only real full screen).
    const sheet = buildA2hsSheet();
    document.body.appendChild(sheet);
    full.addEventListener('click', () => (sheet.hidden = false));
    let seen = false;
    try {
      seen = localStorage.getItem(HINT_KEY) === '1';
    } catch {
      /* storage blocked */
    }
    if (!seen) {
      // Once per device: the first time the phone is held in landscape, after the first touch
      // (so the sheet never covers the very first screen).
      const showOnce = () => {
        if (matchMedia('(orientation: landscape)').matches) {
          sheet.hidden = false;
          removeEventListener('pointerup', showOnce, true);
          matchMedia('(orientation: landscape)').removeEventListener('change', showOnce);
        }
      };
      addEventListener('pointerup', showOnce, { capture: true });
      matchMedia('(orientation: landscape)').addEventListener('change', showOnce);
    }
  } else if (!document.fullscreenEnabled || STANDALONE) full.hidden = true;

  // The first touch anywhere is also a good moment to go fullscreen + landscape.
  addEventListener('pointerdown', () => void goLandscape(), { once: true, capture: true });
}

/** "Add to Home Screen" steps for iPhone Safari (and Chrome on iOS, which shares the engine). */
function buildA2hsSheet(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ge-a2hs';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', L('全屏游玩', 'Play full screen'));
  el.innerHTML = `<div class="card">
    <h3>⛶ ${L('iPhone 上怎么全屏', 'Full screen on iPhone')}</h3>
    <div>${L('Safari 不允许网页自己全屏。把游戏加到主屏幕，从主屏幕打开就是真正的全屏横屏，没有地址栏。', 'Safari never lets a page go full screen. Add the game to your Home Screen and open it from there: true full-screen landscape, no address bar.')}</div>
    <ol>
      <li>${L('点 Safari 底部的', 'Tap Safari’s')} <span class="k">${L('分享', 'Share')}</span> ${L('按钮（方框带向上箭头）', 'button (the square with an arrow)')}</li>
      <li>${L('选', 'Choose')} <span class="k">${L('添加到主屏幕', 'Add to Home Screen')}</span></li>
      <li>${L('从主屏幕打开「Grow」', 'Open “Grow” from the Home Screen')}</li>
    </ol>
    <div class="row"><button type="button" class="ghost" data-a="never">${L('不再提示', 'Don’t show again')}</button><button type="button" data-a="ok">${L('知道了', 'Got it')}</button></div>
  </div>`;
  const close = (never: boolean) => {
    el.hidden = true;
    if (never) {
      try {
        localStorage.setItem(HINT_KEY, '1');
      } catch {
        /* storage blocked */
      }
    }
  };
  (el.querySelector('[data-a="ok"]') as HTMLButtonElement).onclick = () => close(false);
  (el.querySelector('[data-a="never"]') as HTMLButtonElement).onclick = () => close(true);
  el.addEventListener('click', (e) => {
    if (e.target === el) close(false);
  });
  return el;
}

async function goLandscape(): Promise<void> {
  try {
    if (document.fullscreenEnabled && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    /* refused (iframe / iOS): keep playing in the page */
  }
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o.lock?.('landscape');
  } catch {
    /* not supported (iOS) or not fullscreen: the rotate card handles it */
  }
}
