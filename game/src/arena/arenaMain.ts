import * as THREE from 'three';
import { L } from '../i18n';
import { AudioEngine } from '../audio/AudioEngine';
import { roundSecondsFor } from '../config/arena';
import { HALLOWEEN, isHalloween } from '../config/halloween';
import { createHalloweenFx } from '../world/halloweenFx';
import { bakeSkyEnvironment, forgetSkyBakes } from '../art/environment';
import { RenderPipeline } from '../art/postfx';
import { installContextRecovery, installRenderGuards, type AppContext } from '../app';
import { FIXED_DT } from '../game/Game';
import { LocalNet, RoomNet, SoloNet, type Net } from '../net/Net';
import { SupabaseNet } from '../net/SupabaseNet';
import { HubPresence, newRoomCode, type HubLike } from '../net/Hub';
import { backendConfigured, supabase } from '../backend/supabase';
import { startTelemetry, track } from '../backend/telemetry';
import { CITIES, cityById } from '../world/cities';
import type { CityDef } from '../world/city';
import { ArenaBot } from './ArenaBot';
import { ArenaGame } from './ArenaGame';
import { ArenaSession, type MatchState } from './ArenaSession';
import { ArenaUi } from './ArenaUi';
import { HubUi, type HubChoice } from './HubUi';
import { cleanName } from './nameFilter';
import type { CameraMode } from '../systems/CameraRig';
import { addCoins, award, progress, unlockGift } from './progress';
import type { GiftRule } from '../config/cosmetics';
import { createPlatform, PORTAL_BUILD, PUBLIC_GAME_URL } from '../platform/Platform';
import { boot } from '../ui/boot';
import type { CrazyGamesPlatform } from '../platform/CrazyGamesPlatform';

/**
 * Arena mode entry: pick the transport (claude.ai room → online with friends; ?net=local →
 * tabs of this browser; otherwise solo vs AI), run the lobby, and drive whichever ArenaGame the
 * session starts. While in the lobby, the selected city is shown as a slow flyover.
 */
export async function runArena(ctx: AppContext): Promise<void> {
  const { renderer, lib, input, quality, testMode, params } = ctx;
  // Portal SDK (CrazyGames / Poki) or our own site; never throws, bounded wait.
  const portal = await createPlatform();
  // Name: ?name= › the one typed here before › the portal account (CrazyGames asks multiplayer games to show it) › random.
  const randomName = `${L('玩家', 'Player')}${Math.floor(Math.random() * 900 + 100)}`;
  // Camera: follow view or first-person cab view (V / 🎥), remembered across visits.
  let camMode: CameraMode = savedCameraMode();
  const toggleCamera = (): void => {
    camMode = camMode === 'first' ? 'third' : 'first';
    try {
      localStorage.setItem('grow-arena-camera', camMode);
    } catch {
      /* private mode */
    }
    game?.setCameraMode(camMode);
    ui.notice(camMode === 'first' ? L('🎥 第一人称视角', '🎥 First-person view') : L('🎥 第三人称视角', '🎥 Follow view'));
    track('camera_mode', { mode: camMode });
  };
  let nickname = cleanName(params.get('name') ?? savedName() ?? (await portal.playerName()), randomName);
  const platform = portal.name;
  let game: ArenaGame | null = null;
  let preview: ArenaGame | null = null;
  let pipeline: RenderPipeline | null = null;
  let shownResultsEp = -1;
  const audio = testMode ? null : new AudioEngine();

  // A WebGL context loss empties the HDRI's PMREM (prefiltered on the GPU): sky bakes from then on.
  let hdriLost = false;
  const envFor = (scene: THREE.Scene, city: CityDef) => {
    // The daylight HDRI would light a night map like noon: Halloween Town bakes its own moonlit sky.
    const hdri = isHalloween(city.id) || hdriLost ? null : ctx.hdri;
    scene.environment = hdri?.texture ?? bakeSkyEnvironment(renderer, city.palette);
    scene.environmentRotation.y = hdri?.rotationFor(city.palette.sunDirection) ?? 0;
    scene.environmentIntensity = city.palette.envIntensity;
  };
  if (!testMode)
    installContextRecovery(renderer, () => {
      hdriLost = true;
      forgetSkyBakes(renderer);
      for (const g of [game, preview]) if (g) envFor(g.scene, g.city);
    });
  const usePipeline = (g: ArenaGame) => {
    pipeline?.dispose();
    pipeline = new RenderPipeline(renderer, g.scene, g.camera, quality);
    resize();
  };
  const buildPreview = (cityId: string) => {
    const city = cityById(cityId) ?? CITIES[0];
    if (preview?.city === city) return;
    preview?.dispose();
    preview = new ArenaGame(input, lib, city, 7, null, [], () => false);
    audio?.setTheme(city.id);
    preview.hud.dispose();
    envFor(preview.scene, city);
    if (isHalloween(city.id)) preview.attachAtmosphere(createHalloweenFx({ bounds: city.bounds, quality, seed: 7 }));
    usePipeline(preview);
  };

  let flyT = 0;
  let loadedSignal = false;
  const loaded = () => {
    if (loadedSignal) return;
    loadedSignal = true;
    portal.loadingFinished();
    // The first screen is up (room browser or lobby). runArena only returns after the player has
    // chosen in the room browser, so the boot screen must not wait for that (it hid the browser).
    boot.step('ready');
    requestAnimationFrame(() => requestAnimationFrame(() => boot.done()));
  };
  if (!testMode) void startTelemetry(nickname, platform);

  // Site directory (Postgres RPC, net/Hub.ts): live "N online" and the public room list. Needs
  // only the backend, so it runs on our site and on portals alike; never in the test harness.
  // ?hub=demo (dev builds only) fakes it for screenshots in a sandbox without Supabase.
  const demoHub = import.meta.env.DEV && params.get('hub') === 'demo';
  const hub: HubLike | null = demoHub ? (await import('./hubDemo')).demoHub(params.get('hubstate')) : testMode ? null : HubPresence.start();

  let net: Net | null = null;
  let choice: HubChoice | null = null;
  // The room browser stays up (showing "Starting…") until the lobby's live loop takes over, or for
  // Quick play until the warm-up round has started: the player never looks at a frozen frame.
  let stopHubLoop: (() => void) | null = null;
  let disposeHub: (() => void) | null = null;
  const want = params.get('net');
  if (want === 'local') net = new LocalNet(params.get('room') ?? 'dev', nickname);
  else if (want !== 'solo') {
    // claude.ai artifact → its room; stand-alone build with a backend → a public room code.
    if (want !== 'online') net = await RoomNet.connect();
    const linked = portal.invitedRoom() ?? params.get('room');
    // No room in the link: the room browser is the first screen (vs AI, create, code, public rooms).
    // [platform-room] A portal's instant-multiplayer launch (CrazyGames) goes straight into a new room.
    if (!net && hub && want === null && !linked && !portal.instantMultiplayer?.() && (backendConfigured() || demoHub)) ({ choice, stopLoop: stopHubLoop, dispose: disposeHub } = await showHub(hub));
    if (!net && backendConfigured()) {
      // Invite links keep working exactly as before (any code the old flow accepted).
      const code = choice ? choice.code : (linked ?? newRoomCode()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || newRoomCode();
      const url = new URL(location.href);
      url.searchParams.set('room', code);
      history.replaceState(null, '', url);
      net = await SupabaseNet.connect(code, nickname);
      const reload = (performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload';
      if (linked && !choice && !reload) track('room_join', { source: 'link' });
    }
  }
  const modeLabel = !net ? L('单人', 'Solo') : net.kind === 'room' || net.kind === 'online' ? L('在线房间', 'Online room') : net.kind === 'local' ? L('本地多开', 'Local tabs') : L('单人', 'Solo');
  net ??= new SoloNet(nickname);
  track('lobby_view', { mode: net.kind });

  /**
   * The room browser over a slow flyover of the first city; resolves with the player's choice. It then
   * shows "Starting…": `stopLoop` ends its flyover loop, `dispose` removes it.
   */
  async function showHub(h: HubLike): Promise<{ choice: HubChoice; stopLoop: () => void; dispose: () => void }> {
    buildPreview(CITIES[0].id);
    h.setSource(() => ({ room: null, state: 'hub', announce: null }));
    track('room_browser_view', {});
    const hubUi = new HubUi(h, {
      name: () => nickname,
      setName: (n) => {
        nickname = cleanName(n, nickname);
        try {
          localStorage.setItem('grow-arena-name', nickname);
        } catch {
          /* private mode */
        }
        return nickname;
      },
      onStory: () => {
        location.hash = 'story';
        location.reload();
      },
    });
    let last = performance.now();
    resize();
    renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      flyover(dt);
      render();
    });
    loaded();
    const c = await hubUi.show();
    return { choice: c, stopLoop: () => renderer.setAnimationLoop(null), dispose: () => hubUi.dispose() };
  }

  let lobbyDirty = true;
  let lobbySig = '';
  const session: ArenaSession = new ArenaSession(
    net,
    {
      startGame(state: MatchState, localId: string | null): ArenaGame {
        const city = cityById(state.city) ?? CITIES[0];
        preview?.dispose();
        preview = null;
        game?.dispose();
        const g = new ArenaGame(input, lib, city, state.seed, localId, state.roster, (): boolean => session.isHost());
        game = g;
        g.setCameraMode(camMode);
        g.onEvent = (e) => audio?.handle(e);
        audio?.setTheme(city.id);
        track('match_start', { city: city.id, humans: state.roster.filter((r) => r.kind === 'player').length, bots: state.roster.filter((r) => r.kind === 'bot').length, player: localId !== null });
        envFor(g.scene, city);
        if (isHalloween(city.id)) g.attachAtmosphere(createHalloweenFx({ bounds: city.bounds, quality, seed: state.seed }));
        usePipeline(g);
        ui.resetRound();
        ui.hideResults();
        ui.renderLobby();
        disposeHub?.(); // Quick play's "Starting…" ends when its round exists
        return g;
      },
      endGame() {
        game?.dispose();
        game = null;
        ui.hideResults();
        ui.resetRound();
        buildPreview(session.city);
        ui.renderLobby();
      },
      changed() {
        lobbyDirty = true;
      },
    },
    nickname,
  );
  const ui = new ArenaUi(session, modeLabel);
  // Public / friends-only: the creator's choice; a joiner from the public list knows it is public
  // (so a joiner who becomes host keeps it listed); anyone else adopts the room's own setting.
  if (choice) session.setPublic(choice.pub, choice.create);
  if (hub) {
    const room = net instanceof SupabaseNet ? net : null;
    hub.setSource(() => ({
      room: room ? room.room : null,
      state: session.hubState(),
      announce:
        room && session.isHost() && room.connected()
          ? { code: room.room, host: session.name, city: session.city, humans: session.lobbyPlayers().length, bots: session.bots, phase: session.roomPhase(), public: session.pub, since: session.since, left: session.roundLeft() }
          : null,
    }));
    ui.hub = hub;
    hub.onChange(() => ui.updateHubCount());
    // Back to the room browser: a fresh page without the room (the room hears our goodbye on pagehide).
    if (net.kind === 'online' || net.kind === 'solo')
      ui.onHub = () => {
        track('room_browser_back', { phase: session.match.ph });
        const u = new URL(location.href);
        u.searchParams.delete('room');
        u.searchParams.delete('net');
        location.assign(u.toString());
      };
    ui.onPublic = (pub) => track('room_public', { pub });
  }
  // [platform-room] Portal login while running (CrazyGames): adopt the account name unless the player typed one.
  portal.onPlayerNameChange = (n) => void (n && !params.get('name') && !savedName() && (session.setNickname(n), ui.renderLobby()));
  const prog0 = progress();
  session.setCosmetics(prog0.skin, prog0.horn, prog0.hat);
  ui.installPanels({
    equipped: (skin, horn, hat) => session.setCosmetics(skin, horn, hat),
    invite: () => inviteInfo(),
    externalLinks: portal.name === 'web' && !PORTAL_BUILD,
    shared: (channel) => {
      track('share_click', { channel });
      gift('share');
    },
    previewHorn: (horn) => audio?.handle({ kind: 'horn', horn }),
    volumes: (music, sfx) => audio?.setVolumes(music, sfx),
    changed: () => ui.renderLobby(),
  });
  // Ads: silence the mix while one plays; solo rounds also freeze (online rounds cannot pause).
  let adPaused = false;
  portal.onPause = () => {
    adPaused = true;
    audio?.setAdHold(true);
  };
  portal.onResume = () => {
    adPaused = false;
    audio?.setAdHold(false);
  };
  ui.adsAvailable = portal.adsAvailable;
  ui.inviteUrl = () => (net instanceof SupabaseNet ? portal.inviteLinkAsync(net.room) : Promise.resolve(location.href));
  ui.onRevive = () => {
    const g = game;
    if (!g?.reviveHold()) return;
    track('ad_revive', {});
    void portal.rewarded('revive').then((ok) => {
      if (game === g) g.reviveRelease(ok);
      track('ad_revive_result', { ok });
    });
  };
  ui.onDoubleCoins = async (coins) => {
    track('ad_double', {});
    const ok = await portal.rewarded('double_coins');
    if (ok) addCoins(coins);
    track('ad_double_result', { ok });
    return ok;
  };
  let gameplayOn = false;
  let tipShown = testMode;
  try {
    tipShown ||= localStorage.getItem('grow-arena-tip') === '1';
  } catch {
    /* storage unavailable: show the tip every session */
  }
  // CrazyGames' site-wide mute wins over our own audio settings.
  const cg = portal as Partial<CrazyGamesPlatform>;
  if (portal.name === 'crazygames') {
    if (cg.muteAudio) audio?.setMuted(true);
    cg.onMuteSettingChange = (m) => audio?.setMuted(m);
  }
  /** Friend gifts: announce newly unlocked items (lobby notice, or a toast in a round). */
  const gift = (rule: GiftRule): void => {
    const items = unlockGift(rule);
    if (!items.length) return;
    const names = items.map((x) => L(x.nameZh, x.name)).join(' · ');
    ui.notice(`🎁 ${L('好友礼物已解锁', 'Friend gift unlocked')}: ${names}`);
    track('gift_unlock', { rule });
  };
  const inviteInfo = async (): Promise<{ url: string; text: string }> => {
    const room = net instanceof SupabaseNet ? net.room : null;
    // Share a clean link: never my name, language or test flags; just the room when there is one.
    let url = await ui.inviteUrl();
    if (url === location.href || /[?&](name|lang|test)=/.test(url)) {
      const clean = new URL(location.origin + location.pathname);
      if (room) clean.searchParams.set('room', room);
      url = clean.toString();
    }
    // Attribution: invited players arrive tagged (the share sheet adds the channel as utm_medium).
    if (url.startsWith(location.origin) || url.startsWith(PUBLIC_GAME_URL)) {
      const u = new URL(url);
      u.searchParams.set('utm_source', 'invite');
      url = u.toString();
    }
    const text = room
      ? L(`来 GROW EVERYTHING 和我一起吞掉整座城市！房间 ${room}，点链接直接加入 👉`, `Come eat the city with me in GROW EVERYTHING! Room ${room} — tap to join 👉`)
      : L('来玩 GROW EVERYTHING：从一个易拉罐吃到整座城市，最多 4 人联机！👉', 'Play GROW EVERYTHING: start as a can, end up eating the whole city — up to 4 players! 👉');
    return { url, text };
  };
  ui.onShare = () => void ui.panels.showShare();
  if (portal.userBreak) ui.onBeforeStart = () => portal.userBreak?.() ?? Promise.resolve();

  ui.onEmote = (id) => {
    game?.emote(id);
    track('emote', { id });
  };
  addEventListener('keydown', (e) => {
    if (!game || e.repeat) return;
    const m = /^Digit([1-6])$/.exec(e.code);
    if (m) game.emote(Number(m[1]));
    else if (e.code === 'KeyH') game.emote(6);
    else if (e.code === 'KeyV' && !(e.target instanceof HTMLInputElement)) toggleCamera();
  });
  ui.onCamera = toggleCamera;
  // Quick play opened a fresh room: start the warm-up vs AI at once (the room is listed as
  // "warming up", and the first stranger to join restarts it as a real match).
  if (choice?.warmup) {
    const since = Date.now();
    const iv = window.setInterval(() => {
      const waited = Date.now() - since;
      if (session.match.ph !== 'lobby' || waited > 15_000) {
        disposeHub?.();
        return window.clearInterval(iv);
      }
      if ((session.net.connected() || waited > 3000) && session.isHost() && session.warmupReady() && session.canStart()) {
        window.clearInterval(iv);
        void (ui.onBeforeStart?.() ?? Promise.resolve()).catch(() => undefined).then(() => session.start());
      }
    }, 250);
  }
  ui.onStory = () => {
    location.hash = 'story';
    location.reload();
  };
  buildPreview(session.city);

  function resize(): void {
    renderer.setSize(innerWidth, innerHeight);
    pipeline?.setSize(innerWidth, innerHeight);
    const cam = (game ?? preview)?.camera;
    if (cam) {
      cam.aspect = innerWidth / innerHeight;
      cam.updateProjectionMatrix();
    }
  }
  addEventListener('resize', resize);
  renderer.domElement.addEventListener('click', () => {
    if (game?.local?.eliminated || (game && !game.local)) game.nextSpectate();
  });

  function tick(dt: number): void {
    if (adPaused && net?.kind === 'solo') return;
    session.update(dt);
    // First-run tip, once per browser, just after GO.
    if (!tipShown && game?.local?.alive && game.phase === 'playing' && game.matchTime > 1.4) {
      tipShown = true;
      const touch = matchMedia('(pointer: coarse)').matches;
      game.hud.toast(touch ? L('左手拖动移动 · 吃比你小的东西和对手 · 右下角冲刺', 'Drag left to move · eat anything smaller, rivals too · DASH bottom-right') : L('WASD 移动 · 吃比你小的东西和对手 · 空格冲刺', 'WASD to move · eat anything smaller, rivals too · SPACE to dash'));
      try {
        localStorage.setItem('grow-arena-tip', '1');
      } catch {
        /* ignore */
      }
    }
    // Portal gameplay events: "playing" only while the local machine is alive in a live round.
    const playingNow = !!game && game.phase === 'playing' && !!game.local?.alive;
    if (playingNow !== gameplayOn) {
      gameplayOn = playingNow;
      if (playingNow) portal.gameplayStart();
      else portal.gameplayStop();
    }
    // [platform-room] Room info for the portal (CrazyGames updateRoom / invite button); the adapter forwards changes only.
    portal.reportRoom?.(net instanceof SupabaseNet ? { code: net.room, players: session.net.peers().length, maxPlayers: session.seats() } : null);
    if (game) {
      game.step(dt);
      audio?.setTension(game.phase === 'playing' && game.timeLeft(roundSecondsFor(game.city.id)) < 30);
      // Halloween: the chase gets its own score from the moment the scores lock.
      if (game.hunt) audio?.setTheme(game.hunt.stage() === 'grow' ? game.city.id : 'halloween-hunt');
      ui.renderRound(game);
      if (session.match.ph === 'results' && shownResultsEp !== session.match.ep) {
        shownResultsEp = session.match.ep;
        const standings = session.match.standings ?? game.standings();
        const me = standings.find((s) => s.id === session.selfId());
        const earned = me && !testMode ? award(me.rank, me.kills, game.city.level, game.hunt ? HALLOWEEN.coinsByRank : undefined) : { coins: 0, unlocked: null };
        ui.showResults(standings, session.selfId(), earned);
        if (me?.rank === 1) {
          portal.happy();
          audio?.victory();
        }
        // Played with real friends (other humans who were in the room from the start)?
        if (me && !testMode) {
          const friends = session.match.roster.filter((r) => r.kind === 'player' && r.id !== session.selfId()).length;
          if (friends >= 1) gift('friend1');
          if (friends >= 3) gift('friend3');
        }
        // Natural break: an interstitial while the results card is up (rate-limited in the adapter).
        if (!testMode) window.setTimeout(() => void portal.midroll(), 1500);
        const mine = standings.find((x) => x.id === session.selfId());
        track('match_end', { city: game.city.id, rank: mine?.rank ?? null, mass: mine ? Math.round(mine.mass) : null, kills: mine?.kills ?? null, deaths: mine?.deaths ?? null, seconds: Math.round(game.matchTime), landmark: game.climaxLeft() === 0 });
        if (session.isHost()) void submitMatch(session, game, standings);
      }
    } else if (preview) {
      flyover(dt);
      if (session.city !== preview.city.id) buildPreview(session.city);
    }
    // Lobby re-renders only when something it shows changed (presence updates arrive at 30 Hz).
    if (lobbyDirty && session.match.ph === 'lobby') {
      lobbyDirty = false;
      const sig = JSON.stringify([session.lobbyPlayers(), session.hostId(), session.city, session.bots, session.net.peers().length, session.vehicle, session.ready, session.canStart(), (session.net as { status?: string }).status, session.pub]);
      if (sig !== lobbySig) {
        lobbySig = sig;
        ui.renderLobby();
      }
    }
  }

  /** Lobby / hub flyover around the city centre. */
  function flyover(dt: number): void {
    if (!preview) return;
    flyT += dt * 0.05;
    const b = preview.city.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.55;
    preview.camera.position.set(cx + Math.cos(flyT) * r, 55, cz + Math.sin(flyT) * r);
    preview.camera.lookAt(cx, 0, cz);
  }

  function render(): void {
    const g = game ?? preview;
    if (!g || !pipeline) return;
    renderer.info.reset();
    const focus = g.cameraTarget();
    pipeline.setAoScale(0.6 + (focus?.diameter ?? 2) * 0.9);
    pipeline.output?.setTime(g.time);
    g.sky.userData.uniforms.uTime.value = g.time;
    g.world.dressing.update(g.time, g.rig.distance * 0.85);
    g.camera.updateMatrixWorld();
    g.world.cull(g.camera);
    pipeline.render();
  }

  resize();
  loaded();
  // The live loop takes over from the room browser's flyover; "Starting…" stays up for Quick play
  // until its warm-up round is running (see the auto-start above).
  stopHubLoop?.();
  if (!choice?.warmup) disposeHub?.();
  if (!testMode) {
    const adapt = installRenderGuards(renderer, () => pipeline!, resize);
    let last = performance.now();
    let acc = 0;
    renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;
      while (acc >= FIXED_DT) {
        tick(FIXED_DT);
        acc -= FIXED_DT;
      }
      const me = game?.local;
      if (me) audio?.update(Math.min(1, Math.abs(me.speed) / game!.topSpeed(me)), me.diameter, me.tier);
      render();
      adapt(dt);
    });
  } else render();

  // Test hooks (deterministic stepping in test mode; the transport stays asynchronous).
  (window as unknown as Record<string, unknown>).__ARENA__ = {
    ready: true,
    session,
    game: () => game,
    preview: () => preview,
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, objects: (game ?? preview)?.world.objects.length ?? 0 }),
    step: (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) tick(FIXED_DT);
      return summary();
    },
    render: () => render(),
    summary: () => summary(),
    /** Let every local machine be driven by the AI (automated playtests). */
    autopilot: (on: boolean) => {
      autopilot = on;
    },
  };
  let autopilot = false;
  // Autopilot: the local machine uses the AI rival's brain through the same intents path.
  let botBrain = new ArenaBot(1234);
  let brainFor: ArenaGame | null = null;
  const readInput = input.read.bind(input);
  input.read = () => {
    const g = game;
    if (!autopilot || !g?.local || !g.local.alive) return readInput();
    if (brainFor !== g) {
      brainFor = g;
      botBrain = new ArenaBot(1234); // fresh brain per round (no targets from the last world)
    }
    const i = botBrain.intents(g, g.local);
    const sy = Math.sin(g.rig.yaw);
    const cy = Math.cos(g.rig.yaw);
    // Invert the camera mapping so the game turns these back into the bot's world direction.
    return { forward: -sy * i.dx - cy * i.dz, right: cy * i.dx - sy * i.dz, dash: i.dash, restart: false };
  };

  function summary() {
    const g = game;
    return {
      phase: session.match.ph,
      ep: session.match.ep,
      host: session.hostId(),
      me: session.selfId(),
      isHost: session.isHost(),
      city: session.match.city,
      peers: session.net.peers().length,
      lobby: session.lobbyPlayers().map((p) => ({ id: p.id, name: p.name, vehicle: p.vehicle, ready: p.ready })),
      t: g?.matchTime ?? 0,
      climaxLeft: g?.climaxLeft() ?? null,
      grants: g?.grants.size ?? 0,
      actors: g?.actors.map((a) => ({ id: a.id, name: a.name, kind: a.kind, owned: a.owned, mass: Math.round(a.mass), d: +a.diameter.toFixed(2), x: +a.x.toFixed(1), z: +a.z.toFixed(1), lives: a.lives, alive: a.alive, out: a.eliminated, kills: a.kills, objects: a.objects })) ?? [],
      standings: session.match.standings ?? null,
      hunt: g?.hunt
        ? { egg: { x: g.hunt.egg.x, z: g.hunt.egg.z, by: g.hunt.egg.by, stealth: g.actors.filter((a) => g.hunt!.egg.stealthed(a)).map((a) => a.id) }, bonus: Object.fromEntries(g.hunt.bonus), start: g.hunt.start, stage: g.hunt.stage(), caught: [...g.hunt.caught.keys()], scores: Object.fromEntries(g.hunt.scores), hunters: g.hunt.hunters.map((h) => ({ x: +h.x.toFixed(1), z: +h.z.toFixed(1), pose: h.pose, target: h.target?.id ?? null })) }
        : null,
    };
  }
}


function savedCameraMode(): CameraMode {
  try {
    return localStorage.getItem('grow-arena-camera') === 'first' ? 'first' : 'third';
  } catch {
    return 'third';
  }
}

function savedName(): string | null {
  try {
    return localStorage.getItem('grow-arena-name');
  } catch {
    return null;
  }
}

/** Host → server: record the finished match (results and coins are written server-side). */
async function submitMatch(session: ArenaSession, game: ArenaGame, standings: import('./ArenaGame').Standing[]): Promise<void> {
  const sb = supabase();
  if (!sb || session.net.kind !== 'online') return;
  const uidOf = new Map(session.net.peers().map((p) => [p.id, p.by]));
  const rows = standings.map((st) => {
    const r = session.match.roster.find((x) => x.id === st.id);
    return { slot: r?.slot ?? 0, playerId: r?.kind === 'player' ? (uidOf.get(st.id) ?? null) : null, vehicle: r?.vehicle ?? 'collector', rank: st.rank, mass: st.mass, kills: st.kills, deaths: st.deaths, objects: st.objects, leftEarly: !!game.byId.get(st.id)?.left };
  });
  const reason = game.hunt ? (game.matchTime >= game.hunt.endsAt() - 1 ? 'time' : 'all_caught') : game.climaxLeft() === 0 ? 'landmark' : game.matchTime >= 299 ? 'time' : 'last_standing';
  await sb.functions.invoke('submit-match', { body: { room: (session.net as SupabaseNet).room, city: game.city.id, durationS: game.matchTime, endReason: reason, build: import.meta.env.VITE_BUILD_ID ?? 'dev', rows } }).catch(() => undefined);
}
