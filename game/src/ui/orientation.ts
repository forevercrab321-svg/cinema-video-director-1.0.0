/**
 * Phones play in LANDSCAPE. On touch devices held upright a full-screen "rotate your phone"
 * card covers the game; tapping it (or the ⛶ button) asks for fullscreen and, where the
 * browser allows it (Android Chrome), locks the orientation to landscape. iOS Safari cannot
 * lock orientation, so the card simply waits for the player to turn the phone.
 * Inside an iframe (the claude.ai artifact) fullscreen may be refused: everything degrades to
 * the rotate card, never to an error.
 */
import { L } from '../i18n';

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
@media (orientation: portrait) { .ge-full { display: none; } }`;
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
  if (!document.fullscreenEnabled) full.hidden = true;

  // The first touch anywhere is also a good moment to go fullscreen + landscape.
  addEventListener('pointerdown', () => void goLandscape(), { once: true, capture: true });
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
