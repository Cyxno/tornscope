import { describe, expect, it } from "vitest";
import { coarseDeviceLabel } from "../src/services/notifications.js";

/**
 * Device labeling for the Settings → Devices list (Part 30): coarse platform
 * facts from the user agent the browser already sent — never raw UA strings,
 * never "Unknown device" where platform facts exist, never model-level
 * fingerprinting.
 */
describe("coarse device labels", () => {
  it("labels an installed iPhone with its iOS version", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    expect(coarseDeviceLabel(ua)).toBe("iPhone · iOS 17.5");
  });

  it("labels an iPad", () => {
    const ua = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
    expect(coarseDeviceLabel(ua)).toBe("iPad · iOS 16.6");
  });

  it("labels Android with its version", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
    expect(coarseDeviceLabel(ua)).toBe("Android · 14");
  });

  it("labels desktop platforms with their browser", () => {
    expect(coarseDeviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")).toBe("Windows · Chrome");
    expect(coarseDeviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")).toBe("Mac · Safari");
    expect(coarseDeviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe("Linux · Firefox");
  });

  it("degrades to a plain 'Device' when the user agent is missing", () => {
    expect(coarseDeviceLabel(null)).toBe("Device");
    expect(coarseDeviceLabel("")).toBe("Device");
  });
});
