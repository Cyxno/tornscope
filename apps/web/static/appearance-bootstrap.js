/* Pre-paint appearance bootstrap — must run before the stylesheet so the
 * first paint already matches the stored preference (no flash). Served as a
 * static same-origin file because the CSP (script-src 'self') blocks inline
 * scripts. Keep the storage key and fallbacks in sync with
 * src/lib/appearance.svelte.ts. */
(function () {
  try {
    var s = JSON.parse(localStorage.getItem("tornscope.appearance.v1") || "{}");
    var theme = s.theme === "light" || s.theme === "dark" ? s.theme : "system";
    var dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var de = document.documentElement;
    de.dataset.theme = dark ? "dark" : "light";
    var accents = ["teal", "blue", "indigo", "violet", "emerald", "amber", "rose"];
    de.dataset.accent = accents.indexOf(s.accent) !== -1 ? s.accent : "teal";
    // Canvas/background preset — family-corrected: a preset from the other
    // theme's family falls back to that theme's default (the pre-1.0 look).
    var canvasDark = ["graphite", "midnight", "charcoal", "slate"];
    var canvasLight = ["paper", "warm", "mist"];
    var canvas = canvasDark.indexOf(s.canvas) !== -1 || canvasLight.indexOf(s.canvas) !== -1 ? s.canvas : null;
    de.dataset.canvas = dark
      ? (canvasDark.indexOf(canvas) !== -1 ? canvas : "graphite")
      : (canvasLight.indexOf(canvas) !== -1 ? canvas : "paper");
    de.dataset.density = s.density === "compact" ? "compact" : "comfortable";
    de.dataset.motion = s.motion === "reduced" || s.motion === "full" ? s.motion : "system";
    de.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {
    /* storage unavailable — dark defaults already set */
  }
})();
