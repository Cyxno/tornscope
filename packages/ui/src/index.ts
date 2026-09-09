/**
 * Design tokens - the single source of truth mirror for the TornScope look.
 * The runtime CSS lives in apps/web/src/app.css (Tailwind v4 @theme); these
 * constants exist for any non-CSS consumer (docs, email templates, future
 * non-Svelte surfaces). Keep both lists in sync - v0.2 "precision calm".
 */

export const tokens = {
  color: {
    bg: "#0a0a0c",
    bgRaise: "#0f0f12",
    surface: "#141417",
    surface2: "#1a1a1f",
    surface3: "#212128",
    border: "#232329",
    borderStrong: "#34343c",
    fg: "#f4f4f1",
    fgMuted: "#a2a2ab",
    fgFaint: "#7d7d87",
    accent: "#2dd4bf",
    accentStrong: "#14b8a6",
    positive: "#3fd68f",
    negative: "#f87171",
    warning: "#f0b24a",
    info: "#a78bfa",
  },
  radius: { card: "16px", tile: "12px", control: "8px", chip: "999px" },
  controlHeight: { sm: "30px", md: "34px" },
  chart: { height: { sm: 240, md: 320, lg: 360 } },
} as const;

export type Tokens = typeof tokens;
