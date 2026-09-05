/**
 * Design tokens - the single source of truth for the TornScope look.
 * The runtime CSS lives in apps/web/src/app.css (Tailwind v4 @theme); these
 * constants exist for any non-CSS consumer (docs, email templates, future
 * non-Svelte surfaces). Keep both lists in sync.
 */

export const tokens = {
  color: {
    bg: "#0a0d12",
    bgRaise: "#0e1219",
    surface: "#131822",
    surface2: "#171d29",
    border: "#232b3a",
    borderStrong: "#303a4e",
    fg: "#e6ebf4",
    fgMuted: "#8b95a8",
    fgFaint: "#5b6577",
    primary: "#38bdf8",
    primaryStrong: "#0ea5e9",
    positive: "#34d399",
    negative: "#f87171",
    warning: "#fbbf24",
  },
  radius: { card: "6px", chip: "4px" },
  chart: { height: { sm: 240, md: 320, lg: 360 } },
} as const;

export type Tokens = typeof tokens;
