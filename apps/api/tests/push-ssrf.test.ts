import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/services/push-ssrf.js";

/**
 * DNS/SSRF guard: push endpoints must resolve to PUBLIC addresses only.
 * All private, loopback, link-local, ULA and CGNAT ranges are rejected.
 * IPv4-mapped IPv6 forms are checked recursively.
 */
describe("isPrivateAddress", () => {
  it("accepts public IPv4", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.2.3.4")).toBe(false);
    expect(isPrivateAddress("203.0.113.1")).toBe(false);
  });

  it("rejects loopback (127.x)", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("127.1.2.3")).toBe(true);
  });

  it("rejects RFC1918 private (10.x, 172.16-31.x, 192.168.x)", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.255.255.255")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("192.168.0.1")).toBe(true);
  });

  it("rejects link-local (169.254.x)", () => {
    expect(isPrivateAddress("169.254.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true); // metadata endpoint
  });

  it("rejects IPv6 loopback and ULA", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
  });

  it("rejects IPv4-mapped private addresses (::ffff:x.x.x.x)", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
  });

  it("accepts public IPv6", () => {
    expect(isPrivateAddress("2606:4700:3031::6815:4086")).toBe(false);
    expect(isPrivateAddress("2001:db8::1")).toBe(false);
  });

  it("rejects invalid IP strings", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});
