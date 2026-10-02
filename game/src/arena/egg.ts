import * as THREE from 'three';
import { skipAO } from '../art/layers';
import { EGG, HALLOWEEN as H } from '../config/halloween';
import { EggGirlModel, type EggGirlState } from '../entities/EggGirlModel';
import { createSeededRandom } from '../core/rng';
import { L } from '../i18n';
import { HORN } from './comedy';
import type { Actor, ArenaGame } from './ArenaGame';

/**
 * 蛋之谷 / Egg Valley (docs/halloween-mode.md): an invisible girl hiding in a different corner of
 * Halloween Town every round. She appears when the hunt's chase starts. Close by, golden egg
 * sparkles give her away; next to her a machine HONKS to wake her, and she hands over her fried-egg
 * backpack: EGG.stealthSeconds of invisibility (the bosses can neither see nor catch you) and the
 * machine's locked score grows by EGG.scoreBonus. Once per round; the host decides who woke her
 * first (`eg` in the signed match message); every page applies it the same way.
 */
export class EggValley {
  /** Where she hides this round (same on every page: picked from the round seed). */
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  private readonly model: EggGirlModel;
  private state: EggGirlState = 'hidden';
  private stateT = 0;
  /** Who woke her and when (null until then). */
  by: string | null = null;
  at = 0;
  private readonly stealthUntil = new Map<string, number>();
  private readonly ghosted = new Map<string, { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[]>();
  private backpack: THREE.Object3D | null = null;
  private hintedLocal = false;
  private botHonkAt = 0;

  constructor(private readonly g: ArenaGame) {
    const spot = pickSpot(g);
    this.x = spot.x;
    this.z = spot.z;
    this.heading = Math.atan2(spot.x, spot.z); // facing back toward the middle of the map
    this.model = new EggGirlModel(EGG.height);
    skipAO(this.model.root);
    this.model.root.visible = false;
    g.scene.add(this.model.root);
  }

  /** She is out (hint / ghost) from the chase until someone wakes her. */
  private active(): boolean {
    const h = this.g.hunt;
    return !!h && h.stage() === 'chase' && !this.by;
  }

  stealthed(a: Actor): boolean {
    return this.g.matchTime < (this.stealthUntil.get(a.id) ?? -1);
  }

  /** Host: the machine that just woke her (honking within reach), or null. */
  detect(): Actor | null {
    if (!this.active()) return null;
    const g = this.g;
    for (const a of g.actors) {
      if (!a.alive || a.left || g.hunt?.caught.has(a.id)) continue;
      if (Math.hypot(a.x - this.x, a.z - this.z) > EGG.wakeRange + a.diameter * 0.5) continue;
      if (a.emote === HORN && g.time < a.sayUntil) return a;
    }
    return null;
  }

  /** Host: AI rivals that stumble on her honk now and then. */
  botsHonk(): void {
    const g = this.g;
    if (!this.active() || g.time < this.botHonkAt) return;
    this.botHonkAt = g.time + 1;
    for (const a of g.actors) {
      if (a.kind !== 'bot' || !a.alive || !a.owned || Math.hypot(a.x - this.x, a.z - this.z) > EGG.wakeRange) continue;
      if (g.random() < EGG.botHonkChance) {
        a.emote = HORN;
        a.emoteSeq++;
        g.sayFor(a, '📯', 2.2);
      }
    }
  }

  /** Everyone: the host's word that `id` woke her at match time `at` (idempotent). */
  apply(id: string, at: number): boolean {
    if (this.by) return false;
    const g = this.g;
    const a = g.byId.get(id);
    this.by = id;
    this.at = at;
    this.setState('reveal');
    this.stealthUntil.set(id, at + EGG.stealthSeconds);
    g.hunt?.addBonus(id, EGG.scoreBonus);
    // A warm golden pop, not a flash: she must stay visible while she hands the backpack over.
    g.effects.burst(this.x, 1.2, this.z, new THREE.Color(0xc98a1a), 16, 0.05, 3);
    g.effects.pulse(this.x, this.z, 4, 0.8);
    const [zh, en] = [EGG.nameZh, EGG.name];
    if (a) {
      g.onFeed?.(L(`🍳 ${a.name} 叫醒了${zh}！隐身 ${EGG.stealthSeconds} 秒，分数 +1/3`, `🍳 ${a.name} woke ${en}! Invisible for ${EGG.stealthSeconds}s, score +1/3`), 'bonus');
      if (a === g.local) {
        g.hud.showBanner(L(`${zh}的煎蛋背包！`, `${en.toUpperCase()}'S EGG PACK!`), L(`隐身 ${EGG.stealthSeconds} 秒 · BOSS 看不见你 · 分数 +1/3`, `Invisible ${EGG.stealthSeconds}s · bosses can't see you · score +1/3`), 3);
        g.onEvent?.({ kind: 'unlock', cls: 1 });
        g.effects.addTrauma(0.25);
      }
      this.mountBackpack(a);
    }
    return true;
  }

  private mountBackpack(a: Actor): void {
    const pack = this.model.makeBackpackCopy(0.5);
    pack.position.set(0, 1.05, 0.15);
    a.model.root.add(pack);
    this.backpack = pack;
  }

  private setState(s: EggGirlState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
  }

  /** Every frame (after the simulation). */
  update(dt: number): void {
    const g = this.g;
    this.stateT += dt;
    if (this.active()) {
      // Close enough to someone this page watches: a translucent ghost with golden sparkles.
      const f = g.local?.alive ? g.local : null;
      const d = f ? Math.hypot(f.x - this.x, f.z - this.z) : Infinity;
      this.setState(d < EGG.ghostRange ? 'hint' : 'hidden');
      if (f && d < EGG.hintRange && Math.floor(g.time * 4) % 3 === 0) g.effects.pop(this.x + (g.random() - 0.5) * 1.6, 0.4 + g.random() * 1.6, this.z + (g.random() - 0.5) * 1.6, 0.06);
      if (f && d < EGG.ghostRange && !this.hintedLocal) {
        this.hintedLocal = true;
        g.hud.toast(L(`有人藏在这里…… 按喇叭 📯 叫醒她！`, `Someone is hiding here… HONK 📯 to wake her!`));
      }
    } else if (this.by) {
      const s = g.matchTime - this.at;
      this.setState(s < 1.2 ? 'reveal' : s < 2.4 ? 'give' : 'gone');
    }
    this.model.update(dt, this.x, this.z, this.heading, g.city.groundHeight(this.x, this.z), this.state, this.stateT);
    // Stealth look: the machine fades to a faint ghost while it lasts.
    for (const a of g.actors) {
      const on = this.stealthed(a) && a.alive;
      if (on !== this.ghosted.has(a.id)) this.ghost(a, on);
      if (on) a.ring.visible = a === g.local;
    }
    if (this.backpack && this.by && !this.stealthed(g.byId.get(this.by)!)) {
      this.backpack.parent?.remove(this.backpack);
      this.backpack = null;
    }
  }

  /** Swap a machine's materials for faint transparent copies (and back). */
  private ghost(a: Actor, on: boolean): void {
    if (on) {
      const saved: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
      a.model.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || o === this.backpack) return;
        saved.push({ mesh: m, mat: m.material });
        const fade = (mm: THREE.Material) => {
          const c = mm.clone();
          c.transparent = true;
          c.opacity = a === this.g.local ? 0.35 : 0.12;
          c.depthWrite = false;
          return c;
        };
        m.material = Array.isArray(m.material) ? m.material.map(fade) : fade(m.material);
      });
      this.ghosted.set(a.id, saved);
      if (a === this.g.local) this.g.hud.toast(L('👻 隐身中', '👻 INVISIBLE'));
    } else {
      for (const { mesh, mat } of this.ghosted.get(a.id) ?? []) {
        const cur = mesh.material;
        for (const c of Array.isArray(cur) ? cur : [cur]) c.dispose();
        mesh.material = mat;
      }
      this.ghosted.delete(a.id);
      if (a === this.g.local && a.alive) this.g.hud.toast(L('隐身结束 · 快跑！', 'Visible again · RUN!'));
    }
  }

  dispose(): void {
    for (const a of this.g.actors) if (this.ghosted.has(a.id)) this.ghost(a, false);
    this.backpack?.parent?.remove(this.backpack);
    this.g.scene.remove(this.model.root);
    this.model.dispose();
  }
}

/**
 * Her hiding place: behind one of the map's giants (on the side away from the plaza), in a
 * graveyard corner or by a wall corner — from the round seed, so every page agrees.
 */
function pickSpot(g: ArenaGame): { x: number; z: number } {
  const b = g.city.bounds;
  const c: { x: number; z: number }[] = [];
  for (const r of g.city.fxHints?.roosts ?? []) {
    const d = Math.hypot(r.x, r.z) || 1;
    const off = 4 + r.h * 0.15;
    c.push({ x: r.x + (r.x / d) * off, z: r.z + (r.z / d) * off });
  }
  const gy = g.city.fxHints?.graveyard;
  if (gy) for (const [x, z] of [[gy.minX + 3, gy.minZ + 3], [gy.maxX - 3, gy.minZ + 3], [gy.minX + 3, gy.maxZ - 3], [gy.maxX - 3, gy.maxZ - 3]]) c.push({ x, z });
  const m = 8;
  for (const [x, z] of [[b.minX + m, b.minZ + m], [b.maxX - m, b.minZ + m], [b.minX + m, b.maxZ - m], [b.maxX - m, b.maxZ - m]]) c.push({ x, z });
  const ok = c.filter((p) => p.x > b.minX + 3 && p.x < b.maxX - 3 && p.z > b.minZ + 3 && p.z < b.maxZ - 3 && Math.hypot(p.x, p.z) > H.huntSafeRadius && !g.isBlocked(p.x, p.z, 1.2, 0, null));
  const list = ok.length ? ok : c;
  const rand = createSeededRandom(g.seed ^ 0xe66);
  return list[Math.floor(rand() * list.length) % list.length] ?? { x: b.maxX - m, z: b.maxZ - m };
}
