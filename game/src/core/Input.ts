import { L } from '../i18n';
/**
 * Keyboard + mouse + touch → intents (design §05). On touch screens the left half is a
 * floating joystick (drag from where the thumb lands), the right half turns the camera, and
 * a DASH button sits bottom-right. Gameplay reads intents only, so the
 * playtest bot can drive the same code path by writing `override`.
 */
export interface Intents {
  forward: number; // −1..1, camera-relative
  right: number;
  dash: boolean;
  restart: boolean;
}

/** Input types that take typed text (a checkbox/range/button does not). */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/**
 * True when a key event is aimed at a field the player is typing into (nickname, chat, …):
 * text-like `<input>`, `<textarea>`, `<select>` or any contenteditable element. Keyboard
 * shortcuts and game intents must ignore such events and must not preventDefault them.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

let typingGuardInstalled = false;
/**
 * Global guard for every `window` keydown shortcut in the app (mute M, emotes 1–6/H, camera V,
 * game intents): a keydown that starts in a text field stops at `document` during the bubble
 * phase, after the field's own handlers ran and without preventDefault, so the character is
 * typed and no window-level shortcut sees it. Escape still bubbles so panels can close.
 */
export function installTypingGuard(): void {
  if (typingGuardInstalled) return;
  typingGuardInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' && isTypingTarget(e.target)) e.stopPropagation();
  });
}

export class Input {
  private readonly keys = new Set<string>();
  private dashLatch = false;
  private restartLatch = false;
  /** When set (playtest bot), replaces keyboard intents. */
  override: Intents | null = null;
  onDrag: ((dx: number, dy: number) => void) | null = null;
  lastInputTime = -1;
  /** Touch joystick vector (screen space, −1..1, up = −y). */
  private stick = { x: 0, y: 0, id: -1, ox: 0, oy: 0 };
  private stickEl: HTMLElement | null = null;
  private knobEl: HTMLElement | null = null;

  constructor(target: HTMLElement) {
    installTypingGuard();
    addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return; // typing a name: no intents, no preventDefault
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) {
        if (e.code === 'Space') this.dashLatch = true;
        if (e.code === 'KeyR') this.restartLatch = true;
      }
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    // Focusing a text field mid-move must not leave a key stuck down (its keyup is still seen).
    addEventListener('focusin', (e) => {
      if (isTypingTarget(e.target)) this.keys.clear();
    });
    let dragging = false;
    let lx = 0;
    let ly = 0;
    let dragId = -1;
    target.addEventListener('pointerdown', (e) => {
      target.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch' && e.clientX < innerWidth * 0.5 && this.stick.id < 0) {
        this.ensureTouchUi();
        this.stick = { x: 0, y: 0, id: e.pointerId, ox: e.clientX, oy: e.clientY };
        this.placeStick(e.clientX, e.clientY, 0, 0);
        return;
      }
      dragging = true;
      dragId = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
    });
    target.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stick.id) {
        const R = 56;
        let dx = (e.clientX - this.stick.ox) / R;
        let dy = (e.clientY - this.stick.oy) / R;
        const m = Math.hypot(dx, dy);
        if (m > 1) {
          dx /= m;
          dy /= m;
        }
        this.stick.x = dx;
        this.stick.y = dy;
        this.placeStick(this.stick.ox, this.stick.oy, dx * R, dy * R);
        return;
      }
      if (!dragging || e.pointerId !== dragId) return;
      this.onDrag?.(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.stick.id) {
        this.stick = { x: 0, y: 0, id: -1, ox: 0, oy: 0 };
        if (this.stickEl) this.stickEl.style.opacity = '0';
        return;
      }
      if (e.pointerId === dragId) dragging = false;
    };
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    if (matchMedia('(pointer: coarse)').matches) this.ensureTouchUi();
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Joystick ring + DASH button, created on first touch (or on touch-first devices). */
  private ensureTouchUi(): void {
    if (this.stickEl) return;
    const css = document.createElement('style');
    css.textContent = `.ge-stick{position:fixed;width:112px;height:112px;margin:-56px 0 0 -56px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:rgba(16,18,20,.25);pointer-events:none;opacity:0;transition:opacity .15s;z-index:20}
.ge-knob{position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;background:rgba(255,179,71,.85)}
.ge-dash{position:fixed;right:calc(22px + env(safe-area-inset-right));bottom:calc(20px + env(safe-area-inset-bottom));width:84px;height:84px;border-radius:50%;border:0;background:rgba(255,179,71,.9);color:#16181a;font:900 14px system-ui,sans-serif;letter-spacing:.1em;z-index:20;touch-action:none}
@media (pointer:fine){.ge-dash{display:none}}`;
    document.head.appendChild(css);
    this.stickEl = document.createElement('div');
    this.stickEl.className = 'ge-stick';
    this.knobEl = document.createElement('div');
    this.knobEl.className = 'ge-knob';
    this.stickEl.appendChild(this.knobEl);
    document.body.appendChild(this.stickEl);
    const dash = document.createElement('button');
    dash.className = 'ge-dash';
    dash.type = 'button';
    dash.textContent = L('冲刺', 'DASH');
    dash.setAttribute('aria-label', 'Dash');
    dash.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dashLatch = true;
    });
    document.body.appendChild(dash);
  }

  private placeStick(x: number, y: number, kx: number, ky: number): void {
    if (!this.stickEl || !this.knobEl) return;
    this.stickEl.style.left = `${x}px`;
    this.stickEl.style.top = `${y}px`;
    this.stickEl.style.opacity = '1';
    this.knobEl.style.transform = `translate(${kx}px, ${ky}px)`;
  }

  read(): Intents {
    if (this.override) return this.override;
    const k = (a: string, b: string) => this.keys.has(a) || this.keys.has(b);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const intents: Intents = {
      forward: clamp((k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) - this.stick.y),
      right: clamp((k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0) + this.stick.x),
      dash: this.dashLatch,
      restart: this.restartLatch,
    };
    this.dashLatch = false;
    this.restartLatch = false;
    return intents;
  }
}
