import { SIZE_CLASSES } from '../config/classes';
import { growthConfig } from '../config/growth';
import { massForDiameter } from '../systems/growth';

/**
 * HUD (design §43): mass, growth bar, tier, next unlock (bottom-left); the run objective
 * (top-left); transient layers: milestone banner (top centre), onboarding hint, bump toast,
 * and the end-of-run card. Nothing covers the centre of the screen during play.
 */
const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; font-family: 'Inter', system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; color: #f2efe8; -webkit-font-smoothing: antialiased; }
#hud .panel { position: absolute; left: calc(24px + env(safe-area-inset-left)); bottom: calc(22px + env(safe-area-inset-bottom)); width: 250px; padding: 14px 16px 12px; border-radius: 10px;
  background: linear-gradient(180deg, rgba(16,18,20,.52), rgba(16,18,20,.34)); box-shadow: 0 1px 0 rgba(255,255,255,.08) inset, 0 8px 24px rgba(0,0,0,.18); backdrop-filter: blur(6px); }
#hud .row { display: flex; align-items: baseline; justify-content: space-between; }
#hud .mass { font-size: 34px; font-weight: 800; line-height: 1; letter-spacing: .01em; font-variant-numeric: tabular-nums; display: inline-block; transform-origin: left center; }
#hud .mass small { font-size: 13px; font-weight: 700; opacity: .7; margin-left: 5px; letter-spacing: .14em; }
#hud .tierchip { font-size: 11px; font-weight: 800; letter-spacing: .14em; color: #16181a; background: #ffb347; border-radius: 4px; padding: 3px 7px; }
#hud .label { font-size: 10px; font-weight: 700; letter-spacing: .2em; opacity: .72; text-transform: uppercase; }
#hud .bar { position: relative; margin: 11px 0 9px; height: 8px; background: rgba(0,0,0,.4); border-radius: 4px; overflow: hidden; box-shadow: 0 0 0 1px rgba(255,255,255,.1) inset; }
#hud .bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(90deg, #d97a14, #ffb347); box-shadow: 0 0 10px rgba(255,160,60,.6); transition: width .18s ease-out; }
#hud .bar b { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(0,0,0,.45); }
#hud .next { font-size: 12px; font-weight: 700; letter-spacing: .08em; margin-top: 3px; }
#hud .next em { font-style: normal; color: #ffb347; }
#hud .obj { position: absolute; left: 24px; top: 20px; min-width: 250px; padding: 10px 14px; border-radius: 10px; background: rgba(16,18,20,.4); backdrop-filter: blur(6px); }
#hud .obj .txt { font-size: 13px; font-weight: 800; letter-spacing: .1em; margin-top: 4px; }
#hud .obj .txt em { font-style: normal; color: #ffb347; }
#hud .obj .bar { margin: 8px 0 2px; height: 5px; }
#hud .obj .bar i { background: linear-gradient(90deg, #c8452c, #ff7a45); box-shadow: 0 0 8px rgba(255,100,60,.6); }
#hud .banner { position: absolute; top: 11%; left: 50%; transform: translateX(-50%); text-align: center; opacity: 0; text-shadow: 0 2px 10px rgba(0,0,0,.55); white-space: nowrap; }
#hud .banner .big { font-size: 38px; font-weight: 900; line-height: 1.05; letter-spacing: .08em; }
#hud .banner .rule { width: 60%; height: 2px; margin: 8px auto 6px; background: linear-gradient(90deg, transparent, #ffb347, transparent); }
#hud .banner .sub { font-size: 13px; font-weight: 800; letter-spacing: .28em; color: #ffb347; }
#hud .hint { position: absolute; bottom: 12%; left: 50%; transform: translateX(-50%); font-size: 15px; font-weight: 800; letter-spacing: .2em; padding: 9px 18px; border-radius: 8px; background: rgba(18,20,22,.48); transition: opacity .4s; }
#hud .hint kbd { font: inherit; color: #ffb347; }
#hud .toast { position: absolute; top: 60%; left: 50%; transform: translateX(-50%); font-size: 12px; font-weight: 800; letter-spacing: .16em; color: #ffd9a8; opacity: 0; text-shadow: 0 1px 3px rgba(0,0,0,.8); white-space: nowrap; }
#hud .gain { position: absolute; left: 30px; bottom: 150px; font-size: 16px; font-weight: 800; color: #ffb347; opacity: 0; text-shadow: 0 1px 4px rgba(0,0,0,.5); }
#hud .end { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(460px, 86vw); padding: 26px 28px 22px; border-radius: 14px; text-align: center; opacity: 0;
  background: linear-gradient(180deg, rgba(20,20,22,.78), rgba(20,20,22,.6)); box-shadow: 0 20px 60px rgba(0,0,0,.4), 0 1px 0 rgba(255,255,255,.1) inset; backdrop-filter: blur(10px); }
#hud .end h2 { margin: 0; font-size: 30px; font-weight: 900; letter-spacing: .1em; }
#hud .end .sub { margin-top: 6px; font-size: 12px; font-weight: 800; letter-spacing: .3em; color: #ffb347; }
#hud .end .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 20px 0 16px; }
#hud .end .stats div { padding: 10px 4px; border-radius: 8px; background: rgba(255,255,255,.06); }
#hud .end .stats b { display: block; font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
#hud .end .stats span { font-size: 9px; font-weight: 700; letter-spacing: .18em; opacity: .6; }
#hud .end .keys { font-size: 12px; font-weight: 700; letter-spacing: .14em; opacity: .85; }
#hud .end .keys kbd { font: inherit; color: #ffb347; }
#hud .legend { position: absolute; right: 22px; bottom: 22px; font-size: 10px; font-weight: 700; letter-spacing: .16em; opacity: .75; text-align: right; line-height: 1.8; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
#hud .legend kbd { font: inherit; color: #ffb347; }
@media (max-width: 640px) { #hud .panel, #hud .obj { left: 12px; width: 210px; min-width: 0; } #hud .banner .big { font-size: 24px; } }
@media (pointer: coarse), (max-width: 700px) {
  #hud .legend { display: none; }
  #hud .panel { left: calc(8px + env(safe-area-inset-left)); right: auto; bottom: auto; top: calc(6px + env(safe-area-inset-top)); width: 150px; padding: 6px 10px 5px; }
  #hud .banner { top: 22%; }
}
@media (pointer: coarse) and (orientation: landscape), (max-height: 520px) {
  #hud .panel .label, #hud .panel .next { display: none; }
  #hud .panel { width: 140px; padding: 5px 9px 4px; }
  #hud .mass { font-size: 22px; }
  #hud .mass small { font-size: 11px; }
  #hud .next, #hud .label { font-size: 9px; }
  #hud .bar { margin: 6px 0 5px; height: 6px; }
  #hud .banner .big { font-size: 24px; }
  #hud .banner .sub { font-size: 10px; letter-spacing: .16em; }
  #hud .hint { font-size: 12px; }
}
`;

export interface EndStats {
  time: number;
  mass: number;
  objects: number;
  tier: number;
}

export class Hud {
  private readonly el = document.createElement('div');
  private readonly mass: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly tier: HTMLElement;
  private readonly tierName: HTMLElement;
  private readonly next: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly gain: HTMLElement;
  private readonly objText: HTMLElement;
  private readonly objBar: HTMLElement;
  private readonly objBarWrap: HTMLElement;
  private readonly end: HTMLElement;
  private shownMass = -1;
  private hintStage = -1;
  private objectiveKey = '';
  private endAnim: Animation | null = null;

  /** `legend` replaces the controls line (the arena has a camera toggle instead of restart). */
  constructor(legend?: string) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div class="obj"><div class="label">Objective</div><div class="txt"></div><div class="bar"><i></i></div></div>
      <div class="panel">
        <div class="row"><div class="label">Mass</div><div class="tierchip"></div></div>
        <div class="mass">0<small>KG</small></div>
        <div class="bar"><i></i><b style="left:25%"></b><b style="left:50%"></b><b style="left:75%"></b></div>
        <div class="label tiername"></div>
        <div class="next"></div>
      </div>
      <div class="gain"></div>
      <div class="banner"><div class="big"></div><div class="rule"></div><div class="sub"></div></div>
      <div class="hint"></div>
      <div class="toast"></div>
      <div class="end"></div>
      <div class="legend"><kbd>WASD</kbd> MOVE · <kbd>SPACE</kbd> DASH<br><kbd>DRAG</kbd> CAMERA · <kbd>M</kbd> SOUND · <kbd>R</kbd> RESTART</div>`;
    if (legend) (this.el.querySelector('.legend') as HTMLElement).innerHTML = legend;
    document.body.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.mass = q('.mass');
    this.bar = q('.panel .bar i');
    this.tier = q('.tierchip');
    this.tierName = q('.tiername');
    this.next = q('.next');
    this.banner = q('.banner');
    this.hint = q('.hint');
    this.toastEl = q('.toast');
    this.gain = q('.gain');
    this.objText = q('.obj .txt');
    this.objBar = q('.obj .bar i');
    this.objBarWrap = q('.obj .bar');
    this.end = q('.end');
  }

  update(mass: number, fraction: number, tier: number, nextClass: number | null, nextMass: number | null): void {
    const rounded = mass < 100 ? Math.round(mass * 10) / 10 : Math.round(mass);
    if (rounded !== this.shownMass) {
      this.shownMass = rounded;
      this.mass.firstChild!.nodeValue = formatMass(mass);
      this.mass.querySelector('small')!.textContent = mass >= 10000 ? 'T' : 'KG';
    }
    this.bar.style.width = `${(fraction * 100).toFixed(1)}%`;
    this.tier.textContent = `TIER ${tier}`;
    this.tierName.textContent = growthConfig.tiers[tier - 1].name;
    this.next.innerHTML = nextClass === null ? 'MAX SIZE' : `NEXT · <em>${SIZE_CLASSES[nextClass].label.toUpperCase()}</em> · ${formatMass(nextMass!)} ${nextMass! >= 10000 ? 't' : 'kg'}`;
  }

  /** The run goal, always visible: the warehouse promise, then the tear-down progress. */
  setObjective(cls: number, partsLeft: number, partsTotal: number, won: boolean): void {
    const key = `${cls >= 7 ? 7 : cls >= 6 ? 6 : 0}|${partsLeft}|${won}`;
    if (key === this.objectiveKey) return;
    this.objectiveKey = key;
    const need = massForDiameter(SIZE_CLASSES[7].requiredPower);
    if (won) {
      this.objText.innerHTML = 'WAREHOUSE DESTROYED · <em>FREE ROAM</em>';
      this.objBarWrap.style.display = 'none';
    } else if (cls >= 6) {
      const done = partsTotal - partsLeft;
      this.objText.innerHTML = cls >= 7 ? `TEAR DOWN THE WAREHOUSE · <em>${done}/${partsTotal}</em>` : `RIP THE SIGN OFF THE WAREHOUSE · <em>${done}/${partsTotal}</em>`;
      this.objBarWrap.style.display = 'block';
      this.objBar.style.width = `${((done / Math.max(1, partsTotal)) * 100).toFixed(1)}%`;
    } else {
      this.objText.innerHTML = `RECYCLE THE WAREHOUSE · <em>NEEDS ${formatMass(need)} t</em>`;
      this.objBarWrap.style.display = 'none';
    }
  }

  punch(amount: number): void {
    this.mass.animate([{ transform: 'scale(1.16)' }, { transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
    this.gain.textContent = `+${amount < 10 ? amount.toFixed(1) : Math.round(amount).toLocaleString('en-US')} kg`;
    this.gain.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-18px)' }], { duration: 700, easing: 'ease-out' });
  }

  showBanner(big: string, sub: string, seconds = 2.2): void {
    (this.banner.querySelector('.big') as HTMLElement).textContent = big;
    (this.banner.querySelector('.sub') as HTMLElement).textContent = sub;
    this.banner.animate(
      [
        { opacity: 0, transform: 'translateX(-50%) scale(.9)', letterSpacing: '.3em' },
        { opacity: 1, transform: 'translateX(-50%) scale(1.03)', letterSpacing: '.08em', offset: 0.12 },
        { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.8 },
        { opacity: 0, transform: 'translateX(-50%) scale(1)' },
      ],
      { duration: seconds * 1000, easing: 'ease-out' },
    );
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 1500 });
  }

  /** Contextual onboarding (design §44): 0 = move, 1 = collect, 2 = done. */
  setHint(stage: number): void {
    if (stage === this.hintStage) return;
    this.hintStage = stage;
    if (stage === 0) this.hint.innerHTML = '<kbd>WASD</kbd> MOVE';
    else if (stage === 1) this.hint.innerHTML = 'ROLL INTO THE GLOWING SCRAP';
    this.hint.style.opacity = stage >= 2 ? '0' : '1';
  }

  showEnd(s: EndStats): void {
    const mins = Math.floor(s.time / 60);
    const secs = Math.floor(s.time % 60).toString().padStart(2, '0');
    this.end.innerHTML = `
      <h2>SCRAP CITY RECYCLED</h2>
      <div class="sub">THE WAREHOUSE IS GONE</div>
      <div class="stats">
        <div><b>${mins}:${secs}</b><span>TIME</span></div>
        <div><b>${formatMass(s.mass)}</b><span>${s.mass >= 10000 ? 'TONNES' : 'KG'}</span></div>
        <div><b>${s.objects}</b><span>OBJECTS</span></div>
        <div><b>${s.tier}</b><span>TIER</span></div>
      </div>
      <div class="keys"><kbd>R</kbd> PLAY AGAIN · KEEP ROLLING TO EXPLORE</div>`;
    this.endAnim?.cancel();
    this.endAnim = this.end.animate(
      [
        { opacity: 0, transform: 'translate(-50%, -46%)' },
        { opacity: 1, transform: 'translate(-50%, -50%)', offset: 0.06 },
        { opacity: 1, transform: 'translate(-50%, -50%)', offset: 0.9 },
        { opacity: 0, transform: 'translate(-50%, -50%)' },
      ],
      { duration: 9000, easing: 'ease-out', delay: 1200, fill: 'forwards' },
    );
  }

  /** Arena mode: the story objective card is replaced by the arena scoreboard. */
  hideObjective(): void {
    (this.el.querySelector('.obj') as HTMLElement).style.display = 'none';
  }

  dispose(): void {
    this.el.remove();
  }

  hideEnd(): void {
    this.endAnim?.cancel();
    this.endAnim = null;
    this.end.style.opacity = '0';
  }
}

/** kg below 10 t (1 decimal under 100 kg), tonnes above. */
function formatMass(kg: number): string {
  if (kg < 100) return (Math.round(kg * 10) / 10).toFixed(1);
  if (kg < 10000) return Math.round(kg).toLocaleString('en-US');
  return (kg / 1000).toFixed(kg < 100000 ? 1 : 0);
}
