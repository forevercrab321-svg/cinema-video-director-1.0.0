import { arenaConfig as A } from '../config/arena';
import { L } from '../i18n';
import { HATS, HORNS, SKINS, type GiftRule } from '../config/cosmetics';
import { CITIES } from '../world/cities';

/**
 * Per-viewer campaign progress (browser storage: a convenience, not an account record).
 * Winning a level unlocks the next one; coins are earned by rank and kills.
 */
export interface Progress {
  coins: number;
  /** Highest unlocked campaign level (1 = first city). */
  unlocked: number;
  wins: number;
  /** Finished rounds (drives the AI difficulty ramp, see botSkill). */
  played: number;
  /** Owned cosmetic ids (skins and horns share one list; free items are always owned). */
  owned: string[];
  skin: string;
  horn: string;
  hat: string;
  /** Friend gifts earned so far (see GiftRule). */
  gifts: GiftRule[];
}

const KEY = 'grow-arena-progress-v1';

export function progress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Progress>;
      const owned = Array.isArray(p.owned) ? p.owned.filter((x): x is string => typeof x === 'string') : [];
      return {
        coins: Math.max(0, Number(p.coins) || 0),
        unlocked: Math.max(1, Number(p.unlocked) || 1),
        wins: Math.max(0, Number(p.wins) || 0),
        played: Math.max(0, Number(p.played) || Number(p.wins) || 0),
        owned,
        skin: typeof p.skin === 'string' && isOwned(owned, p.skin) ? p.skin : 'stock',
        horn: typeof p.horn === 'string' && isOwned(owned, p.horn) ? p.horn : 'clown',
        hat: typeof p.hat === 'string' && isOwned(owned, p.hat) ? p.hat : 'none',
        gifts: Array.isArray(p.gifts) ? p.gifts.filter((g): g is GiftRule => g === 'share' || g === 'friend1' || g === 'friend3') : [],
      };
    }
  } catch {
    /* storage unavailable: play without saved progress */
  }
  return { coins: 0, unlocked: 1, wins: 0, played: 0, owned: [], skin: 'stock', horn: 'clown', hat: 'none', gifts: [] };
}

function save(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Record a finished round; returns what was earned for the results card. */
export function award(rank: number, kills: number, cityLevel: number): { coins: number; unlocked: string | null } {
  const p = progress();
  const coins = (A.coinsByRank[rank - 1] ?? 10) + kills * A.coinsPerKill;
  p.coins += coins;
  p.played++;
  let unlocked: string | null = null;
  if (rank === 1) {
    p.wins++;
    if (cityLevel >= p.unlocked) {
      const next = CITIES.find((c) => c.level === cityLevel + 1);
      if (next) {
        p.unlocked = next.level;
        unlocked = L(next.nameZh, next.name);
      }
    }
  }
  save(p);
  return { coins, unlocked };
}

const ALL = [...SKINS, ...HORNS, ...HATS];

function priceOf(id: string): number | null {
  const it = ALL.find((x) => x.id === id);
  return !it || it.gift ? null : it.price; // gifts are never for sale
}

function isOwned(owned: string[], id: string): boolean {
  const it = ALL.find((x) => x.id === id);
  return !!it && ((it.price === 0 && !it.gift) || owned.includes(id));
}

/** Grant the items behind a friend-gift rule; returns the newly unlocked items (for a toast). */
export function unlockGift(rule: GiftRule): { id: string; name: string; nameZh: string }[] {
  const p = progress();
  if (p.gifts.includes(rule)) return [];
  p.gifts.push(rule);
  const items = ALL.filter((x) => x.gift === rule && !p.owned.includes(x.id));
  for (const it of items) p.owned.push(it.id);
  save(p);
  return items;
}

export function owns(id: string): boolean {
  return isOwned(progress().owned, id);
}

/** Spend coins on a cosmetic; false when unknown, already owned or too expensive. */
export function buy(id: string): boolean {
  const p = progress();
  const price = priceOf(id);
  if (price === null || isOwned(p.owned, id) || p.coins < price) return false;
  p.coins -= price;
  p.owned.push(id);
  save(p);
  return true;
}

export function equip(id: string): void {
  const p = progress();
  if (!isOwned(p.owned, id)) return;
  if (SKINS.some((x) => x.id === id)) p.skin = id;
  else if (HORNS.some((x) => x.id === id)) p.horn = id;
  else if (HATS.some((x) => x.id === id)) p.hat = id;
  save(p);
}

/** Rewarded-ad bonus: add coins earned outside a normal round. */
export function addCoins(n: number): void {
  const p = progress();
  p.coins += Math.max(0, Math.round(n));
  save(p);
}

/**
 * AI rival skill for this viewer's next round (0..1): rookie on the first round, ramping to full
 * over arenaConfig.botSkillRounds finished rounds — a new player's first match is softer.
 */
export function botSkill(played = progress().played): number {
  if (played >= A.botSkillRounds) return 1;
  return A.botSkillRookie + ((1 - A.botSkillRookie) * played) / A.botSkillRounds;
}
