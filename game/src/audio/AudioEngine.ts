import type { GameEvent } from '../game/Game';

/**
 * Procedural audio (design §45–46), WebAudio only — no sample files. Everything scales with
 * size: small pickups tick, big ones thud and crunch, collapses rumble, and the motor drone
 * drops in pitch as the machine grows. Music is a quiet step sequencer that gains layers per
 * tier (pulse → kick → bass → industrial percussion). Starts on the first user gesture;
 * `M` toggles mute. Presentation only: the simulation never waits on audio.
 */
import { THEMES, type MusicTheme } from './themes';
import type { HornSound } from '../config/cosmetics';
import { loadSettings } from '../settings';

/**
 * Level trims for file tracks (public/music/*.mp3, normalised to about -14 LUFS). Measured in the
 * offline render (tools/render-music.mjs, raw): the procedural themes sit at about -36 LUFS and the
 * synth fanfare at about -24 LUFS at the output, so a full Suno mix is brought down to match and
 * never buries the sound effects.
 */
const FILE_TRACK_GAIN = 0.5;

/**
 * Presentation-only cues the arena sends on top of the shared GameEvent set (they never touch
 * the simulation): dash cooldown ready, and the crash stun from dashing into something too big.
 */
export type FeelEvent = { kind: 'dashReady' } | { kind: 'stun'; size: number };

/** Small-pickup streak: each chained tick climbs a major-pentatonic step (semitones), then resets. */
const STREAK_STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const STREAK_WINDOW = 0.7;
const VICTORY_TRACK_GAIN = 0.4;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private motor: { osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private tier = 1;
  private step = 0;
  private nextStepTime = 0;
  private timer: number | null = null;
  private muted = false;
  private lastTick = 0;
  private streak = 0;
  private lastStreak = -9;
  /** City theme (null = the original industrial loop) and an optional file track override. */
  private theme: MusicTheme | null = null;
  private themeId = '';
  /** File BGM decoded to a buffer so it loops sample-accurately (an <audio loop> leaves the MP3
   *  encoder gap at every seam). `trackReq` guards against a stale decode after a theme switch. */
  private trackSrc: AudioBufferSourceNode | null = null;
  private trackGain: GainNode | null = null;
  private trackReq = 0;
  private trackLive = false;
  /** music/victory.mp3 when present (a Suno jingle); otherwise the synth fanfare plays. */
  private victoryTrack: HTMLAudioElement | null = null;
  private tension = 1;
  /** Player volume settings (0–1), applied on top of the mix levels. */
  private vol = loadSettings();
  /** Held by platform ads: silent until released, independent of the player's mute. */
  private adHold = false;

  /** Window/document listeners, removed again in dispose(). */
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  /** The context reached 'running' from a gesture unlock (iOS Safari); until then every gesture retries. */
  private unlocked = false;

  constructor() {
    // Mobile Safari only lets audio start inside a gesture it trusts: touchend / pointerup / click
    // (not touchstart / pointerdown), and a context created or resumed anywhere else stays
    // suspended. So every gesture (not just the first) creates or resumes the context — iOS also
    // drops it to 'interrupted' after a call, Siri or the app switcher.
    const gesture = () => this.start();
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) this.listen(window, type, gesture);
    this.listen(window, 'keydown', (e) => {
      if ((e as KeyboardEvent).code === 'KeyM') this.setMuted(!this.muted);
    });
    // Backgrounded tab or app: silence the whole graph (music, motor, file tracks) and resume
    // on return. pagehide/pageshow cover the iOS app switcher and the back-forward cache.
    const sync = () => this.syncRunning();
    this.listen(document, 'visibilitychange', sync);
    this.listen(window, 'pagehide', sync);
    this.listen(window, 'pageshow', sync);
  }

  private listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn, { passive: true });
    this.listeners.push([target, type, fn]);
  }

  /** Run the context only while the page is visible and the player has sound on. */
  private syncRunning(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const want = document.visibilityState === 'visible' && !this.muted;
    if (want && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    else if (!want && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    if (!want) this.victoryTrack?.pause();
  }

  /** Called from user gestures: create the context on the first one, resume / unlock it on any. */
  private start(): void {
    if (this.ctx) {
      if (!this.unlocked) this.unlock(this.ctx);
      this.syncRunning();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.unlock(ctx);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted || this.adHold ? 0 : 0.8;
    this.sfx = ctx.createGain();
    this.music = ctx.createGain();
    this.music.gain.value = 0.22 * this.vol.music;
    this.sfx.gain.value = this.vol.sfx;
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    this.master.connect(comp).connect(ctx.destination);
    // One second of white noise, reused by every noisy voice.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.startMotor();
    if (this.themeId) this.loadTrack(this.themeId);
    this.loadVictory();
    this.nextStepTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.syncRunning();
  }

  /**
   * iOS unlock: resume() plus a one-sample silent buffer started inside the gesture. Only counts
   * once the context actually reports 'running' (a pointerdown alone does not unlock on iOS).
   * Skipped while muted or hidden: the unmute click / return to the page is a gesture of its own.
   */
  private unlock(ctx: AudioContext): void {
    if (document.visibilityState !== 'visible' || this.muted) return;
    void ctx
      .resume()
      .then(() => {
        if (ctx.state === 'running') this.unlocked = true;
      })
      .catch(() => undefined);
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    src.onended = () => src.disconnect();
  }

  /** Switch the BGM to a city's theme. A file at music/<id>.mp3 (e.g. a Suno export) wins if present. */
  setTheme(id: string): void {
    if (id === this.themeId) return;
    this.themeId = id;
    this.theme = THEMES[id] ?? null;
    this.step = 0;
    this.tension = 1;
    if (this.ctx) this.loadTrack(id);
  }

  /** Last stretch of a round: the loop speeds up a little. */
  setTension(on: boolean): void {
    this.tension = on ? 1.1 : 1;
    if (this.trackSrc && this.ctx) this.trackSrc.playbackRate.setTargetAtTime(this.tension, this.ctx.currentTime, 0.3);
  }

  private loadTrack(id: string): void {
    const req = ++this.trackReq;
    this.trackSrc?.stop();
    this.trackSrc?.disconnect();
    this.trackSrc = null;
    this.trackLive = false;
    const ctx = this.ctx;
    if (!ctx) return;
    const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
    fetch(`${base}music/${id}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((data) => ctx.decodeAudioData(data))
      .then((buf) => {
        if (req !== this.trackReq || this.ctx !== ctx) return;
        if (!this.trackGain) {
          this.trackGain = ctx.createGain();
          this.trackGain.gain.value = FILE_TRACK_GAIN;
          this.trackGain.connect(this.music);
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = this.tension;
        src.connect(this.trackGain);
        src.start();
        this.trackSrc = src;
        this.trackLive = true; // the sequencer stays quiet while a real track plays
      })
      .catch(() => undefined); // no file (or undecodable): the procedural theme keeps playing
  }

  private loadVictory(): void {
    const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.addEventListener('canplaythrough', () => {
      if (!this.ctx || this.victoryTrack) return;
      const g = this.ctx.createGain();
      g.gain.value = VICTORY_TRACK_GAIN;
      this.ctx.createMediaElementSource(el).connect(g).connect(this.sfx);
      this.victoryTrack = el;
    }, { once: true });
    el.src = `${base}music/victory.mp3`;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMaster();
    this.syncRunning();
  }

  /** Ads (portal SDKs) must play over silence: hold the mix at zero until released. */
  setAdHold(on: boolean): void {
    this.adHold = on;
    this.applyMaster();
  }

  setVolumes(music: number, sfx: number): void {
    this.vol = { music, sfx };
    if (!this.ctx) return;
    this.music.gain.setTargetAtTime(0.22 * music, this.ctx.currentTime, 0.05);
    this.sfx.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.05);
  }

  private applyMaster(): void {
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted || this.adHold ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    this.listeners.length = 0;
    void this.ctx?.close();
  }

  // ── Motor drone ─────────────────────────────────────────────────────────────
  private startMotor(): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter);
    sub.connect(filter);
    filter.connect(gain).connect(this.sfx);
    osc.start();
    sub.start();
    this.motor = { osc, sub, filter, gain };
  }

  /** Per frame: speed01 = speed / top speed, diameter in metres. */
  update(speed01: number, diameter: number, tier: number): void {
    this.tier = tier;
    if (!this.ctx || !this.motor) return;
    const t = this.ctx.currentTime;
    // Small machine whines (~180 Hz), city-scale machine growls (~35 Hz).
    const base = 190 / Math.pow(Math.max(0.35, diameter) / 0.35, 0.5);
    const f = Math.max(28, base * (0.8 + 0.5 * speed01));
    this.motor.osc.frequency.setTargetAtTime(f, t, 0.08);
    this.motor.sub.frequency.setTargetAtTime(f / 2, t, 0.08);
    this.motor.filter.frequency.setTargetAtTime(250 + 900 * speed01, t, 0.1);
    this.motor.gain.gain.setTargetAtTime(0.03 + 0.07 * speed01 * Math.min(1, 0.4 + diameter * 0.2), t, 0.12);
  }

  // ── Event sounds ────────────────────────────────────────────────────────────
  handle(e: GameEvent | FeelEvent): void {
    if (!this.ctx) return;
    switch (e.kind) {
      case 'absorb':
        if (e.cls <= 2) this.tick(e.size);
        else {
          this.thud(e.cls, e.size);
          if (e.cls >= 5) this.boom(Math.min(0.55, 0.25 + (e.cls - 5) * 0.08), 0.5 + e.cls * 0.05);
        }
        break;
      case 'dashReady':
        this.ready();
        break;
      case 'stun':
        this.clank(e.size);
        this.dizzy();
        break;
      case 'crunch':
        this.crunch(e.cls, e.size);
        break;
      case 'collapse':
        this.rumble(1.6, 0.9);
        break;
      case 'bump':
        this.thump(70, 0.25);
        break;
      case 'dash':
        this.whoosh();
        this.rev();
        break;
      case 'unlock':
        this.chime([0, 7], 0.18);
        break;
      case 'tier':
        this.chime([0, 4, 7, 12], 0.35);
        this.rumble(0.8, 0.4);
        this.riser(0.55);
        break;
      case 'win':
        this.boom(0.6, 0.9);
        this.chime([0, 4, 7, 12, 16, 19], 0.5);
        this.rumble(2.5, 1);
        break;
      case 'beep':
        this.beep(e.high ? 1320 : 660, e.high ? 0.5 : 0.18);
        break;
      case 'eaten':
        this.boom(0.55, 0.8);
        this.sweep(420, 70, 0.9);
        this.rumble(1.2, 0.8);
        break;
      case 'landmark':
        this.boom(0.7, 1.6);
        this.rumble(4, 1.2);
        this.chime([0, -5, -12], 0.4);
        for (const at of [0.35, 0.8, 1.3, 1.9]) this.crackle(at, 0.25);
        break;
      case 'boing':
        this.boing();
        break;
      case 'burp':
        this.burp();
        break;
      case 'pop':
        this.popSound();
        break;
      case 'horn':
        this.horn(e.horn ?? 'clown');
        break;
    }
  }

  /** Cartoon spring: a sine that wobbles down in pitch. */
  private boing(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.45);
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 22;
    depth.gain.value = 60;
    lfo.connect(depth).connect(osc.frequency);
    const g = ctx.createGain();
    osc.connect(g).connect(this.sfx);
    this.env(g, t, 0.28, 0.005, 0.45);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.5);
    lfo.stop(t + 0.5);
  }

  /** A satisfied burp: low buzzy saw with a rattling amplitude and falling pitch. */
  private burp(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.25;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.linearRampToValueAtTime(70, t + 0.55);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 420;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 31;
    depth.gain.value = 0.18;
    lfo.connect(depth).connect(g.gain);
    osc.connect(f).connect(g).connect(this.sfx);
    this.env(g, t, 0.35, 0.03, 0.55);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.65);
    lfo.stop(t + 0.65);
  }

  /** Bubble-gum pop. */
  private popSound(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.08);
    const g = ctx.createGain();
    osc.connect(g).connect(this.sfx);
    this.env(g, t, 0.4, 0.002, 0.1);
    osc.start(t);
    osc.stop(t + 0.15);
    const v = this.noiseVoice('bandpass', 2500, 1.5, 0.08);
    this.env(v.gain, t, 0.15, 0.002, 0.06);
  }

  /** Horn by cosmetic id; the default clown horn is two detuned squares, "honk-honk". */
  private horn(kind: HornSound): void {
    if (kind === 'duck') return this.duck();
    if (kind === 'bike') return this.bell();
    if (kind === 'trombone') return this.trombone();
    if (kind === 'air') return this.airHorn();
    const ctx = this.ctx!;
    for (const k of [0, 0.22]) {
      const t = ctx.currentTime + k;
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1800;
      for (const hz of [370, 466]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(hz, t);
        o.frequency.linearRampToValueAtTime(hz * 0.94, t + 0.16);
        o.connect(f);
        o.start(t);
        o.stop(t + 0.2);
      }
      f.connect(g).connect(this.sfx);
      this.env(g, t, 0.12, 0.01, 0.17);
    }
  }

  /** One pitched voice through a lowpass, with a pitch path of [time offset, Hz] points. */
  private voice(type: OscillatorType, path: [number, number][], dur: number, peak: number, cutoff: number, at = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = type;
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    o.frequency.setValueAtTime(path[0][1], t);
    for (const [dt, hz] of path.slice(1)) o.frequency.linearRampToValueAtTime(hz, t + dt);
    o.connect(f).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
    this.env(g, t, peak, 0.01, dur);
  }

  /** Rubber duck: a nasal squeak that bends up then down, twice. */
  private duck(): void {
    for (const k of [0, 0.2]) this.voice('sawtooth', [[0, 900], [0.05, 1250], [0.14, 820]], 0.15, 0.1, 2600, k);
  }

  /** Bicycle bell: two bright inharmonic sines, "ring-ring". */
  private bell(): void {
    for (const k of [0, 0.16]) for (const hz of [2350, 3480, 5100]) this.voice('sine', [[0, hz]], 0.5, hz > 3000 ? 0.04 : 0.08, 8000, k);
  }

  /** Sad trombone: "wah wah wah waaah", falling. */
  private trombone(): void {
    const notes: [number, number, number][] = [[0, 294, 0.28], [0.32, 277, 0.28], [0.64, 262, 0.28], [0.96, 247, 0.9]];
    for (const [at, hz, dur] of notes) this.voice('sawtooth', dur > 0.5 ? [[0, hz], [0.2, hz * 1.02], [0.4, hz * 0.98], [0.6, hz * 1.02], [0.85, hz * 0.97]] : [[0, hz]], dur, 0.1, 900, at);
  }

  /** Stadium air horn: loud detuned saws, one long blast. */
  private airHorn(): void {
    for (const hz of [466, 470, 587]) this.voice('sawtooth', [[0, hz * 0.97], [0.05, hz]], 0.7, 0.06, 2400);
  }

  private beep(freq: number, dur: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    osc.connect(g).connect(this.sfx);
    this.env(g, t, 0.08, 0.004, dur);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Falling pitch: the "you got eaten" drop. */
  private sweep(from: number, to: number, dur: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g = ctx.createGain();
    osc.connect(f).connect(g).connect(this.sfx);
    this.env(g, t, 0.12, 0.01, dur);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noiseVoice(type: BiquadFilterType, freq: number, q: number, dur: number): { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    src.connect(filter).connect(gain).connect(this.sfx);
    src.start(ctx.currentTime, Math.random() * 0.5);
    src.stop(ctx.currentTime + dur + 0.05);
    return { src, filter, gain };
  }

  /** Light mechanical tick for small pickups (rate-limited so bursts do not buzz). */
  private tick(size: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    if (t - this.lastTick < 0.035) return;
    this.lastTick = t;
    // Chained pickups climb a pentatonic ladder (a combo you can hear); a pause resets it.
    this.streak = t - this.lastStreak < STREAK_WINDOW ? Math.min(STREAK_STEPS.length - 1, this.streak + 1) : 0;
    this.lastStreak = t;
    const base = Math.max(500, 1150 - size * 700) * Math.pow(2, STREAK_STEPS[this.streak] / 12) * (1 + (Math.random() - 0.5) * 0.03);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.45, t + 0.06);
    const g = ctx.createGain();
    osc.connect(g).connect(this.sfx);
    this.env(g, t, 0.07 + Math.min(0.03, this.streak * 0.004), 0.003, 0.07);
    osc.start(t);
    osc.stop(t + 0.1);
    // A soft click transient on top so it reads as "plink", not a beep.
    const v = this.noiseVoice('highpass', 3500, 0.7, 0.02);
    this.env(v.gain, t, 0.05, 0.001, 0.015);
  }

  /** Sub-bass impact under big meals, rivals and collapses: felt more than heard. */
  private boom(level: number, dur: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + dur * 0.7);
    const g = ctx.createGain();
    osc.connect(g).connect(this.sfx);
    this.env(g, t, level, 0.006, dur);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    const v = this.noiseVoice('lowpass', 900, 0.5, 0.12);
    v.filter.frequency.exponentialRampToValueAtTime(120, t + 0.12);
    this.env(v.gain, t, level * 0.6, 0.002, 0.1);
  }

  /** Dash cooldown ready: a tiny two-note glint, quiet enough to live under everything. */
  private ready(): void {
    this.voice('sine', [[0, 1760]], 0.05, 0.035, 6000);
    this.voice('sine', [[0, 2637]], 0.08, 0.03, 6000, 0.05);
  }

  /** Dash kick: the motor revs up hard for a moment. */
  private rev(): void {
    this.voice('sawtooth', [[0, 110], [0.08, 260], [0.28, 150]], 0.3, 0.07, 1200);
  }

  /** Metal-on-concrete crash for the stun: inharmonic partials + a bright noise hit + body thump. */
  private clank(size: number): void {
    const t = this.ctx!.currentTime;
    for (const hz of [523, 1187, 1911]) this.voice('square', [[0, hz], [0.2, hz * 0.97]], 0.22, 0.03, 4000);
    const v = this.noiseVoice('bandpass', 2600, 1.4, 0.12);
    this.env(v.gain, t, 0.3, 0.002, 0.1);
    this.thump(Math.max(40, 90 - size * 4), 0.35);
  }

  /** Cartoon dizzy: a wobbling descending whistle while the machine sees stars. */
  private dizzy(): void {
    this.voice('sine', [[0, 1500], [0.15, 1250], [0.3, 1420], [0.45, 1100], [0.6, 1260], [0.75, 950]], 0.75, 0.035, 5000, 0.12);
  }

  /** Rising power-up sweep for the tier change. */
  private riser(dur: number): void {
    const t = this.ctx!.currentTime;
    const v = this.noiseVoice('bandpass', 300, 2.5, dur);
    v.filter.frequency.exponentialRampToValueAtTime(4000, t + dur);
    v.gain.gain.setValueAtTime(0.0001, t);
    v.gain.gain.exponentialRampToValueAtTime(0.12, t + dur * 0.9);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  /** Debris crackle, delayed: masonry breaking up as the landmark comes down. */
  private crackle(at: number, level: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + Math.random() * 700;
    f.Q.value = 0.9;
    const g = ctx.createGain();
    src.connect(f).connect(g).connect(this.sfx);
    this.env(g, t, level, 0.004, 0.35);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.4);
  }

  private thump(freq: number, level: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.25);
    const g = ctx.createGain();
    osc.connect(g).connect(this.sfx);
    this.env(g, t, level, 0.005, 0.3);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  /** Mass arriving in the hopper: a low body thud that deepens with class. */
  private thud(cls: number, size: number): void {
    this.thump(Math.max(30, 140 - cls * 14 - size * 4), Math.min(0.5, 0.15 + cls * 0.05));
    const v = this.noiseVoice('lowpass', 600 - cls * 50, 0.7, 0.25);
    this.env(v.gain, this.ctx!.currentTime, 0.12 + cls * 0.02, 0.005, 0.2);
  }

  /** Metal crushed / structure torn: bandpassed noise crackle + low body. */
  private crunch(cls: number, size: number): void {
    const t = this.ctx!.currentTime;
    const dur = 0.25 + cls * 0.06;
    const v = this.noiseVoice('bandpass', 1800 - cls * 150, 1.2, dur);
    v.filter.frequency.exponentialRampToValueAtTime(300, t + dur);
    this.env(v.gain, t, Math.min(0.7, 0.2 + cls * 0.06), 0.004, dur);
    this.thump(Math.max(28, 90 - size * 3), Math.min(0.6, 0.2 + cls * 0.05));
  }

  private rumble(dur: number, level: number): void {
    const t = this.ctx!.currentTime;
    const v = this.noiseVoice('lowpass', 160, 0.8, dur);
    v.gain.gain.setValueAtTime(0.0001, t);
    v.gain.gain.exponentialRampToValueAtTime(level, t + 0.08);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private whoosh(): void {
    const t = this.ctx!.currentTime;
    const v = this.noiseVoice('bandpass', 400, 0.9, 0.35);
    v.filter.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
    this.env(v.gain, t, 0.12, 0.05, 0.28);
  }

  /**
   * Victory fanfare for finishing 1st (~3.5 s): the BGM ducks, a toy-brass "da-da-da-DAAA"
   * climbs a C-major arpeggio, a music-box sparkle runs up and a final chord rings with a clap.
   * A file at music/victory.mp3 (e.g. a Suno jingle) plays instead when present.
   */
  victory(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.05;
    // Duck the BGM for the jingle: the file's length when one is loaded, else the synth fanfare's.
    const dur = this.victoryTrack && Number.isFinite(this.victoryTrack.duration) ? this.victoryTrack.duration + 0.2 : 3.6;
    this.music.gain.cancelScheduledValues(t0);
    this.music.gain.setTargetAtTime(0.03 * this.vol.music, t0, 0.05);
    this.music.gain.setTargetAtTime(0.22 * this.vol.music, t0 + dur, 0.4);
    if (this.victoryTrack) {
      this.victoryTrack.currentTime = 0;
      void this.victoryTrack.play().catch(() => this.playVictorySynth(t0));
      return;
    }
    this.playVictorySynth(t0);
  }

  private playVictorySynth(t0: number): void {
    const ctx = this.ctx!;
    const C5 = 523.25;
    const tone = (semi: number, at: number, len: number, level: number, wave: OscillatorType, detune = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(3200, at);
      f.frequency.exponentialRampToValueAtTime(1200, at + len);
      const g = ctx.createGain();
      f.connect(g).connect(this.sfx);
      for (const d of detune ? [-detune, detune] : [0]) {
        const o = ctx.createOscillator();
        o.type = wave;
        o.frequency.value = C5 * Math.pow(2, semi / 12);
        o.detune.value = d;
        o.connect(f);
        o.start(at);
        o.stop(at + len + 0.05);
      }
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level, at + 0.015);
      g.gain.setTargetAtTime(level * 0.7, at + 0.05, 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    };
    // "da-da-da-DAAA": G C E | G(long) — toy brass (detuned square) with a triangle doubling.
    const brass: [number, number, number][] = [[-5, 0, 0.14], [0, 0.16, 0.14], [4, 0.32, 0.14], [7, 0.48, 0.5], [4, 1.02, 0.12], [7, 1.16, 1.6]];
    for (const [s, at, len] of brass) {
      tone(s, t0 + at, len, 0.07, 'square', 7);
      tone(s - 12, t0 + at, len, 0.08, 'triangle');
    }
    // Final chord under the long note.
    for (const s of [-12, -5, 0, 4]) tone(s, t0 + 1.16, 1.9, 0.05, 'triangle');
    // Music-box sparkle run.
    [12, 16, 19, 24, 28, 31, 36].forEach((s, i) => tone(s, t0 + 1.16 + i * 0.06, 0.6, 0.035, 'sine'));
    // Claps on the hits.
    for (const at of [0.48, 1.16]) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1500;
      const g = ctx.createGain();
      src.connect(f).connect(g).connect(this.sfx);
      g.gain.setValueAtTime(0.25, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.12);
      src.start(t0 + at, Math.random() * 0.5);
      src.stop(t0 + at + 0.15);
    }
  }

  /** Short synth chord/arpeggio (semitones above A3) for unlocks, tiers and the win. */
  private chime(semis: number[], level: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    semis.forEach((s, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 220 * Math.pow(2, s / 12);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2200;
      const g = ctx.createGain();
      osc.connect(f).connect(g).connect(this.sfx);
      const st = t + i * 0.07;
      this.env(g, st, level * 0.25, 0.01, 0.6);
      osc.start(st);
      osc.stop(st + 0.7);
    });
  }

  // ── Music: 16-step sequencer, 104 BPM, layers unlock per tier ───────────────
  private schedule(): void {
    const ctx = this.ctx!;
    const stepDur = 60 / ((this.theme?.bpm ?? 104) * this.tension) / 4;
    while (this.nextStepTime < ctx.currentTime + 0.12) {
      if (!this.trackLive) {
        if (this.theme) this.playThemeStep(this.theme, this.step % this.theme.steps, this.nextStepTime);
        else this.playStep(this.step % 16, this.nextStepTime);
      }
      this.step++;
      this.nextStepTime += stepDur;
    }
  }

  private playStep(i: number, t: number): void {
    const ctx = this.ctx!;
    const out = this.music;
    const hit = (freq: number, dur: number, level: number, type: OscillatorType = 'sine', drop = 0.5) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * drop), t + dur);
      const g = ctx.createGain();
      osc.connect(g).connect(out);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    };
    const hat = (level: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = ctx.createGain();
      src.connect(f).connect(g).connect(out);
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.06);
    };
    // Tier 1: soft pulse and hats.
    if (i % 4 === 2) hat(0.15);
    if (i % 8 === 0) hit(440, 0.12, 0.1, 'triangle', 1);
    // Tier 2: kick.
    if (this.tier >= 2 && i % 4 === 0) hit(120, 0.28, 0.9, 'sine', 0.3);
    // Tier 3: bass line (A minor riff).
    const bass = [55, 0, 55, 0, 65.4, 0, 55, 0, 49, 0, 49, 0, 73.4, 0, 65.4, 0];
    if (this.tier >= 3 && bass[i]) hit(bass[i], 0.2, 0.35, 'sawtooth', 0.98);
    // Tier 4: industrial clank on the backbeat.
    if (this.tier >= 4 && (i === 4 || i === 12)) {
      hit(310, 0.18, 0.25, 'square', 0.4);
      hat(0.4);
    }
  }

  /** One step of a city theme: lead from tier 1, drums from tier 2, bass from 3, accents from 4. */
  private playThemeStep(th: MusicTheme, i: number, t: number): void {
    const ctx = this.ctx!;
    const out = this.music;
    const note = (semi: number) => th.root * Math.pow(2, semi / 12);
    const voice = (freq: number, wave: OscillatorType, level: number, decay: number, opts: { pluck?: boolean; tremolo?: boolean; detune?: number; drop?: number } = {}) => {
      const oscs: OscillatorNode[] = [];
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(opts.pluck ? 4200 : 2400, t);
      if (opts.pluck) f.frequency.exponentialRampToValueAtTime(700, t + decay);
      for (const d of opts.detune ? [-opts.detune, opts.detune] : [0]) {
        const o = ctx.createOscillator();
        o.type = wave;
        o.frequency.setValueAtTime(freq, t);
        if (opts.drop) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.drop), t + decay);
        o.detune.value = d;
        o.connect(f);
        oscs.push(o);
      }
      f.connect(g).connect(out);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + (opts.pluck ? 0.004 : 0.02));
      if (opts.tremolo) {
        // Pipa-style tremolo: fast amplitude flutter over the decay.
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 18;
        depth.gain.value = level * 0.5;
        lfo.connect(depth).connect(g.gain);
        lfo.start(t);
        lfo.stop(t + decay + 0.05);
      }
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      for (const o of oscs) {
        o.start(t);
        o.stop(t + decay + 0.05);
      }
    };
    const noise = (hp: number, level: number, dur: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hp;
      const g = ctx.createGain();
      src.connect(f).connect(g).connect(out);
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.start(t, Math.random() * 0.5);
      src.stop(t + dur + 0.02);
    };
    const lead = th.lead.pattern[i];
    if (lead !== null && lead !== undefined) voice(note(lead), th.lead.wave, th.lead.level, th.lead.decay, th.lead);
    if (th.hat.includes(i)) noise(7500, 0.12, 0.05);
    if (this.tier >= 2 && th.kick.includes(i)) voice(120, 'sine', 0.8, 0.28, { drop: 0.3 });
    if (this.tier >= 2 && th.snare.includes(i)) noise(1800, 0.35, 0.14);
    const bass = th.bass.pattern[i];
    if (this.tier >= 3 && bass !== null && bass !== undefined) voice(note(bass), th.bass.wave, th.bass.level, 0.3, th.bass.boing ? { drop: 0.86 } : {});
    const bell = th.bell?.pattern[i];
    if (this.tier >= 2 && th.bell && bell !== null && bell !== undefined) voice(note(bell), 'sine', th.bell.level, 0.9, { pluck: true });
    if (this.tier >= 4 && th.accent?.steps.includes(i)) for (const c of th.accent.chord) voice(note(c), th.accent.wave, th.accent.level, th.accent.decay);
  }
}
