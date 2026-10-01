/**
 * CrazyGames HTML5 SDK v3 adapter.
 *
 * Docs (official):
 *   https://docs.crazygames.com/sdk/intro/          — script URL, SDK.init(), SDK.environment
 *   https://docs.crazygames.com/sdk/video-ads/      — ad.requestAd('midgame'|'rewarded', {adStarted, adFinished, adError})
 *   https://docs.crazygames.com/sdk/game/           — gameplayStart/Stop, loadingStart/Stop, happytime,
 *                                                    inviteLink / getInviteParam / showInviteButton, settings.muteAudio
 *   https://docs.crazygames.com/requirements/ads/   — mute audio + pause while an ad plays
 *   https://docs.crazygames.com/sdk/game/          — multiplayer: updateRoom({roomId, isJoinable, inviteParams}),
 *                                                    leftRoom(), addJoinRoomListener(fn(inviteParams)),
 *                                                    inviteParams, isInstantMultiplayer, hide/showInviteButton
 *   https://docs.crazygames.com/sdk/user/           — getUser() → {username, profilePictureUrl} | null,
 *                                                    addAuthListener(fn(user))
 *   https://docs.crazygames.com/requirements/multiplayer/ — room info, invite link, instant multiplayer,
 *                                                    keep rooms across rounds, disableChat, show the username
 * (docs.crazygames.com is blocked from the build sandbox; the API was cross-checked against the
 *  docs' search snippets, the typed @adlad/plugin-crazygames v1.1.0 wrapper, and the JS bridge of
 *  the official Defold extension, github.com/defold/extension-crazygames
 *  crazygames/lib/web/lib_crazygames.js @99601c1 (2026-09-08), which calls the same v3 script.)
 *
 * Rules implemented here:
 *  - Mute/pause only when the ad actually STARTS (adStarted), resume on adFinished OR adError.
 *  - Reward only on adFinished for 'rewarded'; adError ⇒ no reward.
 *  - SDK.environment 'disabled' (non-CrazyGames domain) ⇒ every call throws, so we go no-op.
 *    'local' (localhost) ⇒ demo ads, useful for testing with ?platform=crazygames.
 *  - settings.muteAudio (platform-wide mute) is forwarded as a pause/resume-free
 *    `muteAudio` getter + listener — see `onMuteSettingChange`.
 */
import { loadScript, safeCall, withTimeout } from './loadScript';
import {
  INVITE_PARAM,
  MIDROLL_MIN_GAP_MS,
  roomFromLocation,
  type Platform,
  type RoomReport,
  type PlatformName,
  type RewardedPlacement,
} from './Platform';

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
/**
 * Also drive CrazyGames' footer "Invite" button (show while the room is joinable, hide otherwise).
 * The docs mark it deprecated in favour of updateRoom's room data but still supported; keep it on
 * until CrazyGames QA says the room data alone is enough.
 */
const USE_INVITE_BUTTON = true;
/** Set on the reload that follows an in-game "join friend" request: our URL's room wins then. */
const JOIN_FLAG = 'cgjoin';
/** Safety net: if the SDK never calls back, give control back to the game. */
const AD_SAFETY_TIMEOUT_MS = 120_000;

type CgEnvironment = 'crazygames' | 'local' | 'disabled';
type CgAdType = 'midgame' | 'rewarded';

interface CgAdError {
  code?: string;
  message?: string;
}

interface CgAdCallbacks {
  adStarted(): void;
  adFinished(): void;
  adError(error: CgAdError | string): void;
}

interface CgSdk {
  init(): Promise<void>;
  environment?: CgEnvironment;
  ad: {
    requestAd(type: CgAdType, callbacks: CgAdCallbacks): unknown;
  };
  game: {
    gameplayStart(): unknown;
    gameplayStop(): unknown;
    loadingStart(): unknown;
    loadingStop(): unknown;
    happytime(): unknown;
    inviteLink(params: Record<string, string>): unknown;
    getInviteParam?(key: string): string | null;
    showInviteButton?(params: Record<string, string>): unknown;
    hideInviteButton?(): unknown;
    settings?: { muteAudio?: boolean; disableChat?: boolean };
    addSettingsChangeListener?(listener: (settings: { muteAudio?: boolean }) => void): void;
    /** True when the player arrived through a CrazyGames "play with friends" entry point. */
    isInstantMultiplayer?: boolean;
    /** Invite params of the friend this player is joining (parsed by the SDK), or null. */
    inviteParams?: Record<string, string | number | boolean> | null;
    /** Only supplied fields are updated. */
    updateRoom?(room: { roomId?: string; isJoinable?: boolean; inviteParams?: Record<string, string | number | boolean> }): unknown;
    leftRoom?(): unknown;
    addJoinRoomListener?(listener: (inviteParams: Record<string, string | number | boolean> | null) => void): unknown;
  };
  /** SDK v3 user module (docs.crazygames.com/sdk/user/); getUser() resolves null for guests. */
  user?: {
    getUser?(): Promise<CgUser | null>;
    addAuthListener?(listener: (user: CgUser | null) => void): unknown;
  };
}

interface CgUser {
  username?: string;
  profilePictureUrl?: string;
}

interface CgWindow {
  CrazyGames?: { SDK?: CgSdk };
}

export class CrazyGamesPlatform implements Platform {
  readonly name: PlatformName = 'crazygames';
  onPause: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onPlayerNameChange: ((name: string | null) => void) | null = null;
  onJoinRoomRequest: ((room: string) => void) | null = null;
  /** Called with true/false when the CrazyGames site-wide mute setting changes (honour it over in-game settings). */
  onMuteSettingChange: ((muted: boolean) => void) | null = null;

  private sdk: CgSdk | null = null;
  private ready = false;
  private inGameplay = false;
  private adBusy = false;
  private lastMidrollAt = Date.now();
  private loadingStopped = false;
  /** Last room state sent to the SDK ('' = none): reportRoom forwards changes only. */
  private roomKey = '';

  get adsAvailable(): boolean {
    return this.ready;
  }

  /** CrazyGames site-wide "mute audio" setting; takes priority over in-game audio settings. */
  get muteAudio(): boolean {
    return !!this.sdk?.game.settings?.muteAudio;
  }

  async init(): Promise<void> {
    const loaded = await loadScript(SDK_URL, 6000);
    if (!loaded) return;
    const sdk = (window as unknown as CgWindow).CrazyGames?.SDK;
    if (!sdk) return;
    const ok = await withTimeout(
      sdk.init().then(() => true),
      6000,
      false,
    );
    if (!ok) return;
    if (sdk.environment === 'disabled') return;
    this.sdk = sdk;
    this.ready = true;
    safeCall(() => sdk.game.loadingStart());
    try {
      sdk.game.addSettingsChangeListener?.((s) => {
        this.onMuteSettingChange?.(!!s?.muteAudio);
      });
    } catch {
      /* ignore */
    }
    // Log in / log out on CrazyGames while the game runs: offer the new username to the game.
    try {
      sdk.user?.addAuthListener?.((u) => {
        try {
          this.onPlayerNameChange?.(usernameOf(u));
        } catch {
          /* game handler error */
        }
      });
    } catch {
      /* ignore */
    }
    // "Join friend" from the CrazyGames UI while already playing.
    try {
      sdk.game.addJoinRoomListener?.((params) => {
        const room = params?.[INVITE_PARAM];
        if (room === undefined || room === null || room === '') return;
        const code = String(room);
        if (this.onJoinRoomRequest) {
          try {
            this.onJoinRoomRequest(code);
          } catch {
            /* ignore */
          }
        } else joinByReload(code);
      });
    } catch {
      /* ignore */
    }
    // Closing the tab / navigating away: the player is no longer in the room.
    addEventListener('pagehide', () => {
      if (this.roomKey) safeCall(() => sdk.game.leftRoom?.());
    });
  }

  reportRoom(room: RoomReport | null): void {
    const sdk = this.sdk;
    if (!sdk) return;
    const joinable = !!room && room.open !== false && room.players < room.maxPlayers;
    const key = room ? `${room.code}|${joinable ? 1 : 0}` : '';
    if (key === this.roomKey) return;
    const wasIn = this.roomKey !== '';
    this.roomKey = key;
    if (!room) {
      if (wasIn) safeCall(() => sdk.game.leftRoom?.());
      if (USE_INVITE_BUTTON) this.hideInviteButton();
      return;
    }
    safeCall(() => sdk.game.updateRoom?.({ roomId: room.code, isJoinable: joinable, inviteParams: { [INVITE_PARAM]: room.code } }));
    if (USE_INVITE_BUTTON) {
      if (joinable) this.showInviteButton(room.code);
      else this.hideInviteButton();
    }
  }

  instantMultiplayer(): boolean {
    return !!this.sdk?.game.isInstantMultiplayer;
  }

  async playerName(): Promise<string | null> {
    const get = this.sdk?.user?.getUser;
    if (!get || !this.sdk?.user) return null;
    const user = this.sdk.user;
    const u = await withTimeout(
      Promise.resolve()
        .then(() => get.call(user))
        .catch(() => null),
      2000,
      null,
    );
    return usernameOf(u);
  }

  loadingFinished(): void {
    if (!this.sdk || this.loadingStopped) return;
    this.loadingStopped = true;
    const sdk = this.sdk;
    safeCall(() => sdk.game.loadingStop());
  }

  gameplayStart(): void {
    if (this.inGameplay) return;
    this.inGameplay = true;
    const sdk = this.sdk;
    if (sdk && !this.adBusy) safeCall(() => sdk.game.gameplayStart());
  }

  gameplayStop(): void {
    if (!this.inGameplay) return;
    this.inGameplay = false;
    const sdk = this.sdk;
    if (sdk && !this.adBusy) safeCall(() => sdk.game.gameplayStop());
  }

  happy(): void {
    const sdk = this.sdk;
    if (sdk) safeCall(() => sdk.game.happytime());
  }

  async rewarded(_placement: RewardedPlacement): Promise<boolean> {
    const ok = await this.showAd('rewarded');
    if (ok) this.lastMidrollAt = Date.now();
    return ok;
  }

  async midroll(): Promise<void> {
    if (Date.now() - this.lastMidrollAt < MIDROLL_MIN_GAP_MS) return;
    this.lastMidrollAt = Date.now();
    await this.showAd('midgame');
  }

  inviteLink(room: string): string | null {
    const sdk = this.sdk;
    if (!sdk) return null;
    try {
      const r = sdk.game.inviteLink({ [INVITE_PARAM]: room });
      return typeof r === 'string' && r.length > 0 ? r : null;
    } catch {
      return null;
    }
  }

  async inviteLinkAsync(room: string): Promise<string> {
    const sdk = this.sdk;
    if (sdk) {
      try {
        const r = await withTimeout(
          Promise.resolve(sdk.game.inviteLink({ [INVITE_PARAM]: room })),
          3000,
          null,
        );
        if (typeof r === 'string' && r.length > 0) return r;
      } catch {
        /* fall through */
      }
    }
    return pageInviteUrl(room);
  }

  invitedRoom(): string | null {
    const sdk = this.sdk;
    // After an in-game "join friend" reload, the SDK still reports the invite the page opened with.
    if (hasJoinFlag()) return roomFromLocation();
    const fromParams = sdk?.game.inviteParams?.[INVITE_PARAM];
    if (fromParams !== undefined && fromParams !== null && fromParams !== '') return String(fromParams);
    if (sdk?.game.getInviteParam) {
      try {
        const v = sdk.game.getInviteParam(INVITE_PARAM);
        if (v) return v;
      } catch {
        /* ignore */
      }
    }
    return roomFromLocation();
  }

  /** CrazyGames' own "Invite" button in the site UI (instant multiplayer). */
  showInviteButton(room: string): void {
    const sdk = this.sdk;
    if (sdk?.game.showInviteButton) safeCall(() => sdk.game.showInviteButton!({ [INVITE_PARAM]: room }));
  }

  hideInviteButton(): void {
    const sdk = this.sdk;
    if (sdk?.game.hideInviteButton) safeCall(() => sdk.game.hideInviteButton!());
  }

  private showAd(type: CgAdType): Promise<boolean> {
    const sdk = this.sdk;
    if (!sdk || !this.ready || this.adBusy) return Promise.resolve(false);
    this.adBusy = true;
    const wasPlaying = this.inGameplay;
    if (wasPlaying) safeCall(() => sdk.game.gameplayStop());

    return new Promise<boolean>((resolve) => {
      let paused = false;
      let done = false;
      const finish = (earned: boolean): void => {
        if (done) return;
        done = true;
        window.clearTimeout(safety);
        this.adBusy = false;
        if (paused) {
          paused = false;
          try {
            this.onResume?.();
          } catch {
            /* game handler error must not break the ad flow */
          }
        }
        if (this.inGameplay) safeCall(() => sdk.game.gameplayStart());
        resolve(earned);
      };
      const safety = window.setTimeout(() => finish(false), AD_SAFETY_TIMEOUT_MS);
      try {
        sdk.ad.requestAd(type, {
          adStarted: () => {
            if (done || paused) return;
            paused = true;
            try {
              this.onPause?.();
            } catch {
              /* ignore */
            }
          },
          adFinished: () => finish(true),
          adError: () => finish(false),
        });
      } catch {
        finish(false);
      }
    });
  }
}

function usernameOf(u: CgUser | null | undefined): string | null {
  return typeof u?.username === 'string' && u.username ? u.username : null;
}

function hasJoinFlag(): boolean {
  try {
    return new URLSearchParams(location.search).has(JOIN_FLAG);
  } catch {
    return false;
  }
}

/** Reload this page into room `code` (the online transport cannot switch rooms in place). */
function joinByReload(code: string): void {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get(INVITE_PARAM) === code) return;
    u.searchParams.set(INVITE_PARAM, code);
    u.searchParams.set(JOIN_FLAG, '1');
    location.replace(u.toString());
  } catch {
    /* ignore */
  }
}

/**
 * Invite URL when the SDK gives none. On CrazyGames we must not send players to our own site
 * (no links to a playable off-portal version), so this is this page + ?room=, never PUBLIC_GAME_URL.
 */
function pageInviteUrl(room: string): string {
  try {
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set(INVITE_PARAM, room);
    return u.toString();
  } catch {
    return `?${INVITE_PARAM}=${encodeURIComponent(room)}`;
  }
}
