import * as THREE from 'three';
import { loadHdriEnvironment } from './art/environment';
import { MaterialLibrary } from './art/materials';
import type { Quality } from './art/postfx';
import { buildTextureKit } from './art/textures';
import { Input } from './core/Input';
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
const params = new URLSearchParams(location.search);
const testMode = params.has('test');
const seed = Number(params.get('seed') ?? 1337);
const touch = matchMedia('(pointer: coarse)').matches;
const hashQuality = ['high', 'medium', 'low'].includes(location.hash.slice(1)) ? (location.hash.slice(1) as Quality) : null;
const quality = (params.get('quality') as Quality | null) ?? hashQuality ?? (touch ? 'medium' : 'high');

const mode = params.get('mode') ?? (location.hash === '#story' ? 'story' : testMode ? 'story' : 'arena');
// [platform-room] Start the portal SDK now (download + loadingStart overlap the texture generation); the arena awaits the same instance.
if (mode !== 'story') void import('./platform/Platform').then((m) => m.createPlatform());
// Code-split by mode, fetched now so the chunk downloads while the textures below are generated.
const modeModule = mode === 'story' ? import('./story').then((m) => () => m.runStory(ctx)) : import('./arena/arenaMain').then((m) => () => m.runArena(ctx));

const renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', preserveDrawingBuffer: testMode, powerPreference: 'high-performance' });
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

// Real photographed HDRI for image-based lighting; each mode falls back to a sky bake. Only
// the DOWNLOAD starts now (overlapping the texture generation below); decoding + PMREM run
// after the materials exist — starting the whole load early measured ~1.5 s slower to first frame.
const hdriUrl = `${import.meta.env.BASE_URL}hdri/pedestrian_overpass_1k.hdr`;
const hdriBytes = fetch(hdriUrl)
  .then((r) => (r.ok ? r.blob() : null))
  .catch(() => null);
// Texture resolution and anisotropic filtering per tier (sampling cost and memory on phones).
const anisotropy = quality === 'high' ? 8 : quality === 'medium' ? 4 : 2;
const kit = buildTextureKit(quality === 'low' ? 256 : 512, Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy()));
const lib = new MaterialLibrary(kit, quality);
setWorldDetail(quality);
const input = new Input(renderer.domElement);
const hdri = await hdriBytes.then(async (blob) => {
  const url = blob ? URL.createObjectURL(blob) : hdriUrl;
  try {
    return await loadHdriEnvironment(renderer, url);
  } catch (e) {
    console.warn('HDRI unavailable, using sky bake', e);
    return null;
  } finally {
    if (blob) URL.revokeObjectURL(url);
  }
});
const ctx = { renderer, lib, input, quality, testMode, seed, params, hdri };
installLandscapeMode();
// Perf tooling (tools/perf-measure.mjs): the renderer in test runs, and a first-frame mark.
if (testMode || params.has('perf')) (window as unknown as Record<string, unknown>).__GROW_RENDERER__ = renderer;
const run = await modeModule;
await run();
requestAnimationFrame(() => performance.mark('grow:first-frame'));
