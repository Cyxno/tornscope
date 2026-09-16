import { describe, expect, it } from "vitest";
import { accentRgbaFor, tealAreaFor } from "../src/lib/chart-colors";

/**
 * 1.0.1 regression: canvas-bound colors must use the legacy comma rgba()
 * form. ECharts 6 (zrender) re-parses gradient stops itself on the
 * emphasis/tooltip re-render path, and its parser rejects the modern
 * space-separated `rgb(r g b / a)` syntax — every hovered frame threw
 * `addColorStop(undefined)` and the Overview net-worth chart rendered blank
 * until the pointer left. These contracts pin the parseable form.
 */

const ZRENDER_PARSEABLE = /^rgba?\(\s?\d{1,3},\s?\d{1,3},\s?\d{1,3}(,\s?(0|1|0?\.\d+))?\)$/;

describe("canvas chart colors", () => {
  it("area gradient stops are zrender-parseable rgba() strings", () => {
    for (const mode of ["dark", "light"] as const) {
      const area = tealAreaFor("teal", mode) as { color: { colorStops: Array<{ color: string }> } };
      expect(area.color.colorStops).toHaveLength(2);
      for (const stop of area.color.colorStops) {
        expect(stop.color).toMatch(ZRENDER_PARSEABLE);
      }
    }
  });

  it("accentRgba emits legacy rgba() for every accent, theme and alpha", () => {
    for (const accent of ["teal", "blue", "indigo", "violet", "emerald", "amber", "rose"]) {
      for (const mode of ["dark", "light"] as const) {
        for (const alpha of [0, 0.08, 0.2, 1]) {
          expect(accentRgbaFor(accent, mode, alpha)).toMatch(ZRENDER_PARSEABLE);
        }
      }
    }
  });

  it("gradient stops keep distinct alphas (fade to transparent)", () => {
    const area = tealAreaFor("teal", "dark") as { color: { colorStops: Array<{ color: string }> } };
    expect(area.color.colorStops[0]!.color).not.toBe(area.color.colorStops[1]!.color);
  });
});
