/**
 * Platform abstraction: one web build ships to our own site, CrazyGames and Poki.
 *
 * Usage (integrating engineer):
 *   const platform = await createPlatform();   // never throws, never hangs (>~6-8 s worst case)
 *   platform.onPause = () => { audio.mute(); game.pause(); };
 *   platform.onResume = () => { audio.unmute(); game.resume(); };
 *   platform.loadingFinished();                 // once assets are ready & the menu is interactive
 *   platform.gameplayStart();                   // player is actually playing
 *   platform.gameplayStop();                    // pause menu, death screen, round results, tab to menu
 *   await platform.midroll();                   // at natural breaks, *before* the next gameplayStart
 *   if (platform.adsAvailable && await platform.rewarded('revive')) { ...grant... }
 *
 * See the adapters for the SDK doc URLs and platform rules.
 */

export type PlatformName = 'web' | 'crazygames' | 'poki' | 'gamedistribution';

export type RewardedPlacement = 'revive' | 'double_coins';

export interface Platform {
  readonly name: PlatformName;
  /** Load/init the SDK (never throws; resolves even if the SDK is blocked). */
  init(): Promise<void>;
  loadingFinished(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  /** A joyful moment (big win) — CrazyGames happytime; no-op elsewhere. */
  happy(): void;
  /** Show a rewarded ad; resolves true only if the player earned the reward. Must call onPause/onResume around the ad so the game can mute audio. */
  rewarded(placement: RewardedPlacement): Promise<boolean>;
  /** Interstitial between rounds (may be a no-op / rate-limited by the platform). */
  midroll(): Promise<void>;
  /** Whether rewarded ads are available at all (hide the buttons if false). */
  readonly adsAvailable: boolean;
  /** A shareable invite URL for a room code, or null to use location.href. */
  inviteLink(room: string): string | null;
  /**
   * Async variant of inviteLink(): always resolves a usable URL (falls back to
   * location.href + ?room=). Needed on Poki, whose shareableURL() is async.
   */
  inviteLinkAsync(room: string): Promise<string>;
  /** Room code the player was invited to (from the invite link), or null. */
  invitedRoom(): string | null;
  /**
   * Optional: an ad break the portal wants tied to a player's click outside gameplay (called from
   * the lobby Start button before the round starts). GameDistribution plays its pre-roll/mid-roll here.
   */
  userBreak?(): Promise<void>;
  /** The portal account's display name (CrazyGames asks multiplayer games to show it), or null. Never rejects; bounded wait. */
  playerName(): Promise<string | null>;
  onPause: (() => void) | null;
  onResume: (() => void) | null;
}

/** Query-param name used for room codes in invite links on every platform. */
export const INVITE_PARAM = 'room';

/**
 * Minimum client-side gap between interstitials (ms). Platforms rate-limit too; 3 minutes is the
 * conservative end of the portals' guidance (CrazyGames QA checks ~3 min between midgame ads).
 */
export const MIDROLL_MIN_GAP_MS = 180_000;

const CRAZY_HOST = /(^|\.)crazygames\.[a-z.]+$/i;
const POKI_HOST = /(^|\.)(poki\.com|poki\.io|poki-gdn\.com)$/i;

function hostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Hostnames we can see: our own frame, the embedding page (referrer), and any ancestor origins. */
function candidateHosts(): string[] {
  const hosts: string[] = [];
  try {
    hosts.push(location.hostname);
  } catch {
    /* ignore */
  }
  try {
    hosts.push(hostOf(document.referrer));
  } catch {
    /* ignore */
  }
  try {
    const ao = location.ancestorOrigins as DOMStringList | undefined;
    if (ao) for (let i = 0; i < ao.length; i++) hosts.push(hostOf(ao.item(i)));
  } catch {
    /* ignore */
  }
  return hosts.filter((h) => h.length > 0);
}

/**
 * Build-time portal target (tools/build-portal.mjs <target>):
 *   ''                → decide at runtime from the host (our site, the generic portal zip)
 *   'gamedistribution' → GameDistribution SDK build
 *   'nosdk'           → no third-party SDK code at all (GamePix requires "GamePix SDK or none")
 *   'crazygames'      → CrazyGames SDK only (their terms: no other portal's SDK or branding in the build)
 * Constant-folded by Vite, so the unused adapters' dynamic imports are dropped from the bundle.
 */
export const PORTAL_TARGET: string = (import.meta.env.VITE_PORTAL as string | undefined) ?? '';

/** True in any zip we hand to a portal: they host the page, so we don't send players off-site. */
export const PORTAL_BUILD: boolean = import.meta.env.VITE_PORTAL_BUILD === '1';

/**
 * `?platform=crazygames|poki|web` wins (use it for local testing: CrazyGames'
 * SDK reports environment 'local' on localhost and shows demo ads; Poki's SDK
 * runs in debug mode off-portal). Otherwise hostname heuristics; default 'web'.
 * A build-time PORTAL_TARGET overrides both.
 */
export function detectPlatform(): PlatformName {
  if (PORTAL_TARGET === 'gamedistribution') return 'gamedistribution';
  if (PORTAL_TARGET === 'nosdk') return 'web';
  if (PORTAL_TARGET === 'crazygames') return 'crazygames';
  try {
    const q = new URLSearchParams(location.search).get('platform');
    if (q === 'crazygames' || q === 'poki' || q === 'web') return q;
  } catch {
    /* ignore */
  }
  const hosts = candidateHosts();
  if (hosts.some((h) => CRAZY_HOST.test(h))) return 'crazygames';
  if (hosts.some((h) => POKI_HOST.test(h))) return 'poki';
  return 'web';
}

/** Public web address of the game (invite links from portal iframes point here). */
export const PUBLIC_GAME_URL: string = (import.meta.env.VITE_PUBLIC_GAME_URL as string | undefined) ?? 'https://grow-everything.vercel.app/game/';

/** Build a clean invite URL for this page: the path plus ?room=<code> (and ?platform= if forced). */
export function fallbackInviteUrl(room: string): string {
  try {
    // A clean link: the inviter's name, language or test flags must not travel with it.
    // Framed on a portal CDN (itch.io, Newgrounds…) the page's own URL is not shareable, so
    // invites point at our public site; the room lives on the same backend either way.
    const framed = (() => {
      try {
        return window.top !== window;
      } catch {
        return true;
      }
    })();
    const u = new URL(framed ? PUBLIC_GAME_URL : location.origin + location.pathname);
    const keep = new URL(location.href).searchParams.get('platform');
    if (keep) u.searchParams.set('platform', keep);
    u.searchParams.set(INVITE_PARAM, room);
    return u.toString();
  } catch {
    return `?${INVITE_PARAM}=${encodeURIComponent(room)}`;
  }
}

/** Read ?room= from our own URL. */
export function roomFromLocation(): string | null {
  try {
    return new URLSearchParams(location.search).get(INVITE_PARAM);
  } catch {
    return null;
  }
}

/** Picks the adapter via detectPlatform(), calls init(), returns it. Never throws. */
export async function createPlatform(): Promise<Platform> {
  const name = detectPlatform();
  let platform: Platform;
  if (PORTAL_TARGET === 'gamedistribution') {
    const { GameDistributionPlatform } = await import('./GameDistributionPlatform');
    platform = new GameDistributionPlatform();
  } else if (PORTAL_TARGET !== 'nosdk' && name === 'crazygames') {
    const { CrazyGamesPlatform } = await import('./CrazyGamesPlatform');
    platform = new CrazyGamesPlatform();
  } else if (PORTAL_TARGET !== 'nosdk' && PORTAL_TARGET !== 'crazygames' && name === 'poki') {
    const { PokiPlatform } = await import('./PokiPlatform');
    platform = new PokiPlatform();
  } else {
    const { WebPlatform } = await import('./WebPlatform');
    platform = new WebPlatform();
  }
  try {
    await platform.init();
  } catch {
    /* adapters never throw, but be defensive */
  }
  return platform;
}
