/**
 * Player-name hygiene for public rooms. Portals require it for multiplayer games with typed
 * names (Poki: strict profanity filtering; CrazyGames/kids' audiences likewise), and every name a
 * player sees passes through here: our own nickname, and every peer name in the lobby/roster.
 *
 * Deliberately conservative: a flagged name is replaced by a neutral one, never shown "starred".
 *
 * Latin script is matched per TOKEN, never as a raw substring, so innocent names that merely
 * contain a bad string survive (the Scunthorpe problem: Dickens, Scunthorpe, Cassandra, Essex,
 * Matsushita, therapist). A name is normalised first — NFKC, lower case, look-alike digits and
 * symbols ("sh1t", "@ss"), camelCase split ("BigDick" → big dick), single letters spelled out
 * with separators re-joined ("f.u.c.k", "f u c k" → fuck) and stretched letters collapsed
 * ("fuuuck" → fuck) — then each token is checked against three lists:
 *   WORDS    the token must BE the word (short or ambiguous stems: ass, sex, dick, cum…);
 *   PREFIXES the token STARTS with it (inflections/compounds: shitty, bitches, retarded…);
 *   ANYWHERE the token contains it (no innocent English word does: fuck, nigger…).
 * Chinese has no word boundaries, so its (multi-character, unambiguous) stems match anywhere.
 */

/** Token must equal one of these. */
const WORDS = [
  'ass', 'asses', 'arse', 'sex', 'sexy', 'cum', 'cock', 'cocks', 'rape', 'raped', 'rapist', 'tit', 'tits', 'titty', 'hoe', 'hoes', 'nig',
  'dick', 'dicks', 'penis', 'penises', 'fuk', 'fuq', 'kys', 'boob', 'boobs', 'nazi', 'nazis', 'fag', 'fags', 'piss',
  'shit', 'shits', 'shitty', 'shitter', 'shitting', 'retard', 'retards', 'retarded', 'wank', 'wanker', 'wankers', 'wanking',
  'sb', 'cnm', 'nmsl', 'tmd', 'wtf', 'stfu',
];

/** Token starts with one of these. */
const PREFIXES = [
  'bitch', 'cunt', 'pussy', 'whore', 'slut', 'bastard', 'twat', 'jizz', 'faggot', 'dickhead', 'dickface',
  'asshole', 'arsehole', 'porn', 'vagina', 'hitler', 'rapist', 'motherf', 'cocksuck', 'dumbass', 'jackass', 'shithead',
];

/** Token contains one of these anywhere (compounds like "clusterfuck", "bullshit"). */
const ANYWHERE = ['fuck', 'nigger', 'nigga', 'faggot', 'bullshit', 'horseshit', 'dipshit', 'shithead'];

/** Phrases matched across word breaks ("kill yourself", "k y s"). */
const PHRASES = ['killyourself', 'killurself', 'kys'];

/** Chinese stems: matched anywhere in the name. */
const ZH = [
  '操你', '草你', '肏', '傻逼', '傻b', '煞笔', '沙比', '妈的', '你妈', '尼玛', '他妈', '去死', '鸡巴', '屌', '婊', '贱人',
  '强奸', '日你', '智障', '脑残',
];

/** Look-alike digits and symbols inside a word. */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' };

const MAX_LEN = 16;

/** Runs of 3+ identical letters → one ("fuuuck" → "fuck"); doubles stay ("ass", "cass"). */
const destretch = (s: string): string => s.replace(/([a-z])\1{2,}/g, '$1');

/** Every double letter → one ("fuuck" → "fuck", "biitch" → "bitch"). Used only on tokens that had doubles. */
const undouble = (s: string): string => s.replace(/([a-z])\1+/g, '$1');

/**
 * Latin tokens of a name, after normalisation. Exported for tests.
 * "xX_Sh1tLord_Xx" → ["xx", "shit", "lord", "xx"]; "f.u.c.k" → ["fuck"].
 */
export function nameTokens(raw: string): string[] {
  const s = raw
    .normalize('NFKC')
    // camelCase boundary before lower-casing: "BigDick" → "Big Dick" (not "McDonald"-style caps runs).
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    // Look-alike runs only when touching a letter ("a$$" → "ass"); bare numbers ("123") are separators.
    .replace(/[013456789@$!|+]+/g, (run, i: number, str: string) =>
      /[a-z]/.test(str[i - 1] ?? '') || /[a-z]/.test(str[i + run.length] ?? '') ? Array.from(run, (c) => LEET[c] ?? c).join('') : ' ',
    );
  const parts = s.split(/[^a-z]+/).filter(Boolean);
  // Re-join letters spelled out one at a time: "f u c k", "f.u.c.k" → "fuck".
  const out: string[] = [];
  let run = '';
  for (const p of parts) {
    if (p.length === 1) {
      run += p;
      continue;
    }
    if (run) out.push(run);
    run = '';
    out.push(p);
  }
  if (run) out.push(run);
  return out.map(destretch);
}

function badToken(t: string): boolean {
  const forms = /([a-z])\1/.test(t) ? [t, undouble(t)] : [t];
  return forms.some((f) => {
    const word = f === t ? WORDS : WORDS.map(undouble);
    const pre = f === t ? PREFIXES : PREFIXES.map(undouble);
    const any = f === t ? ANYWHERE : ANYWHERE.map(undouble);
    // An undoubled form must not shrink into a different short word ("pass" → "pas", "Bass" → "bas").
    if (f !== t && f.length < 4) return false;
    return word.includes(f) || pre.some((p) => f.startsWith(p)) || any.some((a) => f.includes(a));
  });
}

/** True when the name contains blocked language. */
export function isOffensiveName(raw: string): boolean {
  const lower = raw.normalize('NFKC').toLowerCase();
  const flatZh = lower.replace(/[\s._\-*+~'"`|/\\,:;()[\]{}<>^#%&=?]+/g, '');
  if (ZH.some((z) => flatZh.includes(z))) return true;
  const tokens = nameTokens(raw);
  if (tokens.some(badToken)) return true;
  // The whole name squashed into one token catches separators inside a word ("sh-it", "b_itch").
  const joined = tokens.join('');
  if (PHRASES.some((p) => joined === p || (p.length > 3 && joined.includes(p)))) return true;
  return tokens.length > 1 && joined.length <= 12 && badToken(joined) && !tokens.every((t) => t.length > 2);
}

/**
 * A displayable name: control/zero-width characters removed, whitespace collapsed, at most
 * 16 characters; `fallback` when empty or offensive.
 */
export function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = Array.from(s).slice(0, MAX_LEN).join('');
  if (!clipped || isOffensiveName(clipped)) return fallback;
  return clipped;
}
