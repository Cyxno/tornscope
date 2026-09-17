import { describe, expect, it } from "vitest";
import { PushKeyError, toApplicationServerKey, urlBase64ToUint8Array, VAPID_PUBLIC_KEY_BYTES } from "../src/lib/push";

/**
 * VAPID key decoding (the 1.0.2 iOS/PWA regression): the server serves a
 * base64URL public key — unpadded, may contain `-` and `_`. atob() only
 * accepts the standard alphabet, so the helper must normalize before
 * decoding and refuse malformed input with a categorized PushKeyError
 * instead of leaking atob's DOMException ("The string contains invalid
 * characters." on WebKit).
 */

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe("urlBase64ToUint8Array", () => {
  it("decodes plain base64 without padding", () => {
    // "QQ==" unpadded → 'A' → [0x41]
    const out = urlBase64ToUint8Array("QQ");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([0x41]);
  });

  it("decodes already-padded standard base64", () => {
    expect(Array.from(urlBase64ToUint8Array("QQ=="))).toEqual([0x41]);
    expect(Array.from(urlBase64ToUint8Array("QUI="))).toEqual([0x41, 0x42]);
  });

  it("decodes base64url `-` exactly as base64 `+`", () => {
    // "+" → 62: bytes 0xFB 0xEF... "++++" → fb ef bf; "----" must match.
    const standard = urlBase64ToUint8Array("++++");
    const urlsafe = urlBase64ToUint8Array("----");
    expect(Array.from(urlsafe)).toEqual(Array.from(standard));
    expect(Array.from(urlsafe)).not.toEqual(Array.from(urlBase64ToUint8Array("////")));
  });

  it("decodes base64url `_` exactly as base64 `/`", () => {
    expect(Array.from(urlBase64ToUint8Array("____"))).toEqual(Array.from(urlBase64ToUint8Array("////")));
    expect(Array.from(urlBase64ToUint8Array("//__"))).toEqual(Array.from(urlBase64ToUint8Array("////")));
  });

  it("decodes the production key shape: 87-char unpadded base64url → 65 bytes", () => {
    // 65 bytes encode to ceil(65/3)*4 = 88 padded chars; unpadded = 87.
    const raw = bytes(0x04, ...Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256));
    const base64url = Buffer.from(raw).toString("base64url");
    expect(base64url.length).toBe(87);
    const out = urlBase64ToUint8Array(base64url);
    expect(out.length).toBe(65);
    expect(Array.from(out)).toEqual(Array.from(raw));
  });

  it("tolerates surrounding whitespace and quoted values from mis-parsed env files", () => {
    expect(Array.from(urlBase64ToUint8Array("  QQ==\n"))).toEqual([0x41]);
    expect(Array.from(urlBase64ToUint8Array('"QQ=="'))).toEqual([0x41]);
    expect(Array.from(urlBase64ToUint8Array("'QQ=='"))).toEqual([0x41]);
  });

  it("rejects invalid characters with PushKeyError, never a raw DOMException", () => {
    for (const bad of ["", "   ", "ab!cd", "ab cd", "a+b/c?", "äöü", "a\tb"]) {
      let thrown: unknown;
      try {
        urlBase64ToUint8Array(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `input ${JSON.stringify(bad)} must throw`).toBeInstanceOf(PushKeyError);
      expect((thrown as Error).name).toBe("PushKeyError");
      if (bad.trim()) expect((thrown as Error).message).not.toContain(bad.trim());
    }
  });

  it("rejects impossible padding (length % 4 === 1)", () => {
    expect(() => urlBase64ToUint8Array("abcde")).toThrow(PushKeyError);
  });
});

describe("toApplicationServerKey", () => {
  it("accepts a valid 65-byte P-256 public key in base64url", () => {
    const raw = bytes(0x04, ...Array.from({ length: 64 }, (_, i) => (i * 13 + 5) % 256));
    const key = toApplicationServerKey(Buffer.from(raw).toString("base64url"));
    expect(key.length).toBe(VAPID_PUBLIC_KEY_BYTES);
    expect(Array.from(key)).toEqual(Array.from(raw));
  });

  it("rejects a decodable key with the wrong byte length", () => {
    // 32 bytes decodes fine but is not a P-256 public key.
    const wrongShape = Buffer.from(bytes(...Array.from({ length: 32 }, (_, i) => i))).toString("base64url");
    expect(() => toApplicationServerKey(wrongShape)).toThrow(/expected 65/);
  });

  it("the decoded applicationServerKey is a Uint8Array backed by its own buffer", () => {
    const key = toApplicationServerKey(Buffer.alloc(65, 7).toString("base64url"));
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.buffer.byteLength).toBe(65);
  });
});
