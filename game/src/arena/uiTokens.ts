/**
 * Arena design tokens: one type scale, one spacing scale, one radius scale, one accent, and the
 * status colours. Shared by the room lobby / HUD (ArenaUi, scoped to #arena) and the hub screen
 * (HubUi, scoped to #ge-hub), so both read as one product.
 */
export const GE_TOKENS = `--ge-accent: #ffb347; --ge-accent-ink: #16181a; --ge-ink: #f2efe8; --ge-muted: rgba(242,239,232,.78); --ge-dim: rgba(242,239,232,.62);
  --ge-panel: rgba(16,18,20,.74); --ge-card: rgba(255,255,255,.05); --ge-line: rgba(255,255,255,.1); --ge-ok: #7be08a; --ge-bad: #ff8a7a; --ge-warn: #ffd27a;
  --ge-s1: 4px; --ge-s2: 8px; --ge-s3: 12px; --ge-s4: 16px; --ge-s5: 24px; --ge-r1: 8px; --ge-r2: 12px; --ge-r3: 16px;
  --ge-fs-xs: 11px; --ge-fs-sm: 12.5px; --ge-fs-md: 14px; --ge-fs-lg: 16px; --ge-tap: 44px;
  --ge-st: env(safe-area-inset-top, 0px); --ge-sr: env(safe-area-inset-right, 0px); --ge-sb: env(safe-area-inset-bottom, 0px); --ge-sl: env(safe-area-inset-left, 0px);`;
