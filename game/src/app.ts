import type * as THREE from 'three';
import type { MaterialLibrary } from './art/materials';
import type { Quality, RenderPipeline } from './art/postfx';
import type { Input } from './core/Input';

/** What every mode shares: one renderer, one material library, one input, the HDRI. */
export interface AppContext {
  renderer: THREE.WebGLRenderer;
  lib: MaterialLibrary;
  input: Input;
  quality: Quality;
  testMode: boolean;
  seed: number;
  params: URLSearchParams;
  hdri: { texture: THREE.Texture; rotationFor: (sun: THREE.Vector3) => number } | null;
}

/**
 * WebGL context loss (phones after an app switch, GPU driver resets, too many contexts) without a
 * page reload: three.js re-creates its GPU state on restore and re-uploads geometry and textures
 * from their CPU copies, so the round, the room and the portal SDK session survive. Only what was
 * rendered on the GPU is gone — `onRestored` re-bakes it (the PMREM environments). While the
 * context is lost three skips draw calls; the simulation and the network keep running.
 * Last resort: if the browser never gives the context back (10 s while visible), reload.
 */
export function installContextRecovery(renderer: THREE.WebGLRenderer, onRestored: () => void): void {
  const canvas = renderer.domElement;
  let note: HTMLElement | null = null;
  let timer = 0;
  const arm = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (document.hidden ? arm() : location.reload()), 10000);
  };
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // allow restoration instead of a permanent black canvas
    if (!note) {
      note = document.createElement('div');
      note.textContent = 'GRAPHICS RESET · RESTORING…';
      note.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:rgba(22,24,26,.85);color:#ffb347;font:800 14px system-ui,sans-serif;letter-spacing:.2em;z-index:20;pointer-events:none';
      document.body.appendChild(note);
    }
    arm();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    window.clearTimeout(timer);
    note?.remove();
    note = null;
    try {
      onRestored();
    } catch (err) {
      console.warn('[gl] restore failed, reloading', err);
      location.reload();
    }
  });
}

/**
 * Live-loop guard: adaptive quality (every 2 s under 28 fps lowers render scale by 0.25 down
 * to 1, then drops GTAO). Returns the per-frame hook.
 */
export function installRenderGuards(renderer: THREE.WebGLRenderer, pipeline: () => RenderPipeline, resize: () => void): (dt: number) => void {
  let perfFrames = 0;
  let perfTime = 0;
  let warmup = 3;
  return (dt: number) => {
    if (warmup > 0) {
      warmup -= dt; // shader compilation hitches at start are not a performance signal
      return;
    }
    perfFrames++;
    perfTime += dt;
    if (perfTime < 2) return;
    const avg = perfFrames / perfTime;
    perfFrames = 0;
    perfTime = 0;
    if (avg >= 28) return;
    const pr = renderer.getPixelRatio();
    if (pr > 1.01) {
      renderer.setPixelRatio(Math.max(1, pr - 0.25));
      resize();
    } else pipeline().disableAO();
  };
}
