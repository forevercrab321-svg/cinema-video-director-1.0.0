import * as THREE from 'three';
import type { AppContext } from './app';
import { createProgressiveEnvironment } from './art/environment';
import { MaterialLibrary } from './art/materials';
import type { Quality } from './art/postfx';
import { buildTextureKit } from './art/textures';
import { Input } from './core/Input';
import { boot } from './ui/boot';
import { installLandscapeMode } from './ui/orientation';
import { setWorldDetail } from './world/World';

/**
 * GROW EVERYTHING — entry point.
 *   ?mode=story|arena  (default arena; ?test=1 defaults to story for the story playtests; #story also works)
 *   ?net=local&room=X  arena over BroadcastChannel between tabs (tests); on claude.ai the room capability is used
 *   ?test=1          no RAF loop; the playtest harness advances time through window.__GROW__ / __ARENA__
 *   ?seed=N          deterministic layout / effects seed
 *   ?quality=high|medium|low   render tier (default: high on desktop, medium on touch devices);
 *                    also #high / #medium / #low where the query string is unavailable (hosted page)
 *   ?tonemap=agx|aces|neutral  tone mapping curve for look development (default agx)
 */
performance.mark('grow:boot');
boot.started();
const params = new URLSearchParams(location.search);
const testMode = params.has('test');
const seed = Number(params.get('seed') ?? 1337);
const touch = matchMedia('(pointer: coarse)').matches;
const hashQuality = ['high', 'medium', 'low'].includes(location.hash.slice(1)) ? (location.hash.slice(1) as Quality) : null;
const quality = (params.get('quality') as Quality | null) ?? hashQuality ?? (touch ? 'medium' : 'high');
const mode = params.get('mode') ?? (location.hash === '#story' ? 'story' : testMode ? 'story' : 'arena');
// [platform-room] Start the portal SDK now (download + loadingStart overlap the texture generation); the arena awaits the same instance.
if (mode !== 'story') void import('./platform/Platform').then((m) => m.createPlatform());

// No WebGL 2 (blocked, hardware acceleration off, old browser): three.js throws while creating
// the context. Show the bilingual "can't run 3D" screen instead of a blank page.
function createRenderer(): THREE.WebGLRenderer | null {
  try {
    return new THREE.WebGLRenderer({ antialias: quality === 'low', preserveDrawingBuffer: testMode, powerPreference: 'high-performance' });
  } catch (e) {
    console.error(e);
    boot.fail('webgl', e);
    return null;
  }
}

async function start(renderer: THREE.WebGLRenderer): Promise<void> {
  // Code-split by mode, fetched now so the chunk downloads while the textures below are generated.
  const modeModule = mode === 'story' ? import('./story').then((m) => () => m.runStory(ctx)) : import('./arena/arenaMain').then((m) => () => m.runArena(ctx));
  modeModule.catch(() => undefined); // awaited below, where a failed chunk download becomes the startup error
  // Shader error checks call getProgramInfoLog after every link, which blocks on the driver and
  // defeats parallel shader compilation (seconds of first-frame stall on mobile). Dev/test only.
  renderer.debug.checkShaderErrors = import.meta.env.DEV || testMode;
  // Retina at 2× under an MSAA HalfFloat chain + GTAO + bloom exhausts integrated GPUs (black
  // frames, GPU resets). Cap the render scale; the live loop lowers it further if frames drop.
  // Low is the weak-phone tier: native CSS pixels only, whatever the device.
  const maxPixelRatio = quality === 'low' ? 1 : touch ? 1.25 : quality === 'high' ? 1.5 : 1.25;
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const TONEMAPS = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping } as const;
  renderer.toneMapping = TONEMAPS[(params.get('tonemap') as keyof typeof TONEMAPS) ?? 'agx'] ?? THREE.AgXToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? 1.0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false; // count every pass of a frame (composer renders the scene more than once)
  document.body.appendChild(renderer.domElement);

  // Real photographed HDRI for image-based lighting (1.5 MB, ~75 s on 3G). It never blocks the
  // first frame: the game starts on a sky bake held in the same PMREM target and the HDRI is
  // decoded into that target when the download lands (scenes pick it up without a rebuild).
  // Test runs wait for it so captures stay deterministic.
  const hdriUrl = `${import.meta.env.BASE_URL}hdri/pedestrian_overpass_1k.hdr`;
  const hdriSource = fetch(hdriUrl)
    .then((r) => (r.ok ? r.blob() : null))
    .catch(() => null)
    .then((blob) => (blob ? URL.createObjectURL(blob) : hdriUrl));
  boot.step('textures');
  // Texture resolution and anisotropic filtering per tier (sampling cost and memory on phones).
  const anisotropy = quality === 'high' ? 8 : quality === 'medium' ? 4 : 2;
  const kit = buildTextureKit(quality === 'low' ? 256 : 512, Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy()));
  const lib = new MaterialLibrary(kit, quality);
  setWorldDetail(quality);
  const input = new Input(renderer.domElement);
  const hdri = createProgressiveEnvironment(renderer, hdriSource);
  const ctx: AppContext = { renderer, lib, input, quality, testMode, seed, params, hdri };
  void hdri.loaded.then(async (ok) => {
    const url = await hdriSource;
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    if (!ok) ctx.hdri = null; // rounds started from now on use their own city's sky bake
  });
  if (testMode) await hdri.loaded;
  installLandscapeMode();
  // Perf tooling (tools/perf-measure.mjs): the renderer in test runs, and a first-frame mark.
  if (testMode || params.has('perf')) (window as unknown as Record<string, unknown>).__GROW_RENDERER__ = renderer;
  boot.step('world');
  const run = await modeModule;
  await run();
  boot.step('ready');
  requestAnimationFrame(() => {
    performance.mark('grow:first-frame');
    requestAnimationFrame(() => boot.done());
  });
}

const renderer = createRenderer();
if (renderer) {
  // Any exception before the game is up would otherwise leave a blank page.
  await start(renderer).catch((e: unknown) => {
    console.error(e);
    renderer.setAnimationLoop(null);
    boot.fail('crash', e);
  });
}
