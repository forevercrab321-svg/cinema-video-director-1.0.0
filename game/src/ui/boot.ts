/**
 * Bridge to the boot screen that game/index.html renders inline (so it shows before any bundle
 * has downloaded): progress steps while the game starts, then a full-screen bilingual message
 * if the browser cannot run it. The inline script owns the markup and the wording; when it is
 * missing (an embed with its own HTML) every call is a no-op.
 */
export type BootStep = 'textures' | 'world' | 'ready';
export type BootFailure = 'webgl' | 'crash';

interface BootScreen {
  started(): void;
  step(step: BootStep): void;
  done(): void;
  fail(kind: BootFailure, detail?: string): void;
}

const screen = (): BootScreen | undefined => (window as unknown as { __GROW_BOOT__?: BootScreen }).__GROW_BOOT__;

export const boot = {
  /** The entry module is running: syntax and module loading are no longer a risk. */
  started: (): void => screen()?.started(),
  step: (s: BootStep): void => screen()?.step(s),
  /** First frame is up: fade the boot screen out. */
  done: (): void => screen()?.done(),
  fail(kind: BootFailure, error?: unknown): void {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : error === undefined ? undefined : String(error);
    const s = screen();
    if (s) s.fail(kind, detail);
    else document.body.textContent = kind === 'webgl' ? 'This browser cannot run 3D graphics (WebGL 2).' : `Startup failed: ${detail ?? ''}`;
  },
};
