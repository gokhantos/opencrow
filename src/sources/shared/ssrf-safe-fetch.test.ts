import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Unit tests for ssrf-safe-fetch.ts
// All network calls are mocked — this file belongs in the unit lane (*.test.ts)
// ---------------------------------------------------------------------------

import { isPrivateIp, validateUrl } from "./ssrf-safe-fetch";

// We test ssrfSafeFetch separately via mocked fetch in an isolated test file
// (see ssrf-safe-fetch.isolated.test.ts) because mock.module is required there.
// This file covers the pure, synchronous / deterministic exports only.

describe("isPrivateIp", () => {
  // --- loopback ---
  it("blocks 127.0.0.1", () => expect(isPrivateIp("127.0.0.1")).toBe(true));
  it("blocks 127.0.0.2", () => expect(isPrivateIp("127.0.0.2")).toBe(true));

  // --- 10/8 ---
  it("blocks 10.0.0.1", () => expect(isPrivateIp("10.0.0.1")).toBe(true));
  it("blocks 10.255.255.255", () => expect(isPrivateIp("10.255.255.255")).toBe(true));

  // --- 172.16/12 ---
  it("blocks 172.16.0.1", () => expect(isPrivateIp("172.16.0.1")).toBe(true));
  it("blocks 172.31.255.255", () => expect(isPrivateIp("172.31.255.255")).toBe(true));
  it("allows 172.15.0.1", () => expect(isPrivateIp("172.15.0.1")).toBe(false));
  it("allows 172.32.0.1", () => expect(isPrivateIp("172.32.0.1")).toBe(false));

  // --- 192.168/16 ---
  it("blocks 192.168.1.1", () => expect(isPrivateIp("192.168.1.1")).toBe(true));

  // --- link-local / AWS metadata ---
  it("blocks 169.254.169.254", () => expect(isPrivateIp("169.254.169.254")).toBe(true));
  it("blocks 169.254.0.1", () => expect(isPrivateIp("169.254.0.1")).toBe(true));

  // --- CGNAT ---
  it("blocks 100.64.0.1", () => expect(isPrivateIp("100.64.0.1")).toBe(true));
  it("blocks 100.127.255.255", () => expect(isPrivateIp("100.127.255.255")).toBe(true));
  it("allows 100.63.255.255", () => expect(isPrivateIp("100.63.255.255")).toBe(false));
  it("allows 100.128.0.0", () => expect(isPrivateIp("100.128.0.0")).toBe(false));

  // --- 0.0.0.0/8 ---
  it("blocks 0.0.0.0", () => expect(isPrivateIp("0.0.0.0")).toBe(true));

  // --- multicast / reserved ---
  it("blocks 224.0.0.1 (multicast)", () => expect(isPrivateIp("224.0.0.1")).toBe(true));
  it("blocks 240.0.0.1 (reserved)", () => expect(isPrivateIp("240.0.0.1")).toBe(true));
  it("blocks 255.255.255.255", () => expect(isPrivateIp("255.255.255.255")).toBe(true));

  // --- IPv6 loopback ---
  it("blocks ::1", () => expect(isPrivateIp("::1")).toBe(true));
  it("blocks ::", () => expect(isPrivateIp("::")).toBe(true));

  // --- IPv6 ULA ---
  it("blocks fc00::1", () => expect(isPrivateIp("fc00::1")).toBe(true));
  it("blocks fd00::1", () => expect(isPrivateIp("fd00::1")).toBe(true));

  // --- IPv6 link-local ---
  it("blocks fe80::1", () => expect(isPrivateIp("fe80::1")).toBe(true));

  // --- IPv6 multicast ---
  it("blocks ff02::1", () => expect(isPrivateIp("ff02::1")).toBe(true));

  // --- IPv4-mapped IPv6 ---
  it("blocks ::ffff:127.0.0.1", () => expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true));
  it("blocks ::ffff:10.0.0.1", () => expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true));
  it("blocks ::ffff:169.254.169.254", () =>
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true));
  it("blocks ::ffff:192.168.1.1", () => expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true));

  // --- IPv4-mapped IPv6 hex form (::ffff:7f00:1 = 127.0.0.1) ---
  it("blocks ::ffff:7f00:1 (127.0.0.1 hex-mapped)", () =>
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true));
  it("blocks ::ffff:a9fe:a9fe (169.254.169.254 hex-mapped)", () =>
    expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true));

  // --- Public IPs that must NOT be blocked ---
  it("allows 8.8.8.8", () => expect(isPrivateIp("8.8.8.8")).toBe(false));
  it("allows 1.1.1.1", () => expect(isPrivateIp("1.1.1.1")).toBe(false));
  it("allows 93.184.216.34", () => expect(isPrivateIp("93.184.216.34")).toBe(false));
  it("allows 2606:2800:220:1:248:1893:25c8:1946 (example.com v6)", () =>
    expect(isPrivateIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false));
});

describe("validateUrl", () => {
  // --- scheme checks ---
  it("accepts http", () => expect(validateUrl("http://example.com/")).toBeNull());
  it("accepts https", () => expect(validateUrl("https://example.com/path")).toBeNull());
  it("rejects file://", () =>
    expect(validateUrl("file:///etc/passwd")).not.toBeNull());
  it("rejects ftp://", () =>
    expect(validateUrl("ftp://example.com/")).not.toBeNull());
  it("rejects data URI", () =>
    expect(validateUrl("data:text/html,<h1>xss</h1>")).not.toBeNull());
  it("rejects javascript:", () =>
    expect(validateUrl("javascript:alert(1)")).not.toBeNull());

  // --- localhost ---
  it("rejects http://localhost", () =>
    expect(validateUrl("http://localhost/")).not.toBeNull());
  it("rejects http://localhost:8080", () =>
    expect(validateUrl("http://localhost:8080/")).not.toBeNull());
  it("rejects http://foo.localhost", () =>
    expect(validateUrl("http://foo.localhost/")).not.toBeNull());

  // --- embedded credentials ---
  it("rejects URL with username", () =>
    expect(validateUrl("https://user@example.com/")).not.toBeNull());
  it("rejects URL with username:password", () =>
    expect(validateUrl("https://user:pass@example.com/")).not.toBeNull());

  // --- private IP literals ---
  it("rejects http://127.0.0.1", () =>
    expect(validateUrl("http://127.0.0.1/")).not.toBeNull());
  it("rejects http://169.254.169.254 (metadata)", () =>
    expect(validateUrl("http://169.254.169.254/latest/meta-data/")).not.toBeNull());
  it("rejects http://10.0.0.1", () =>
    expect(validateUrl("http://10.0.0.1/")).not.toBeNull());
  it("rejects http://192.168.1.1", () =>
    expect(validateUrl("http://192.168.1.1/")).not.toBeNull());
  it("rejects http://[::1]", () =>
    expect(validateUrl("http://[::1]/")).not.toBeNull());
  it("rejects http://[fc00::1]", () =>
    expect(validateUrl("http://[fc00::1]/")).not.toBeNull());
  it("rejects http://[::ffff:127.0.0.1]", () =>
    expect(validateUrl("http://[::ffff:127.0.0.1]/")).not.toBeNull());

  // --- malformed ---
  it("rejects bare string", () => expect(validateUrl("not-a-url")).not.toBeNull());
  it("rejects empty string", () => expect(validateUrl("")).not.toBeNull());

  // --- valid public URLs ---
  it("accepts https://news.ycombinator.com", () =>
    expect(validateUrl("https://news.ycombinator.com/item?id=1")).toBeNull());
  it("accepts https://github.com", () =>
    expect(validateUrl("https://github.com/owner/repo")).toBeNull());
  it("accepts URL with path and query", () =>
    expect(
      validateUrl("https://example.com/article?id=42&page=1"),
    ).toBeNull());
  it("accepts public IPv4 literal", () =>
    expect(validateUrl("http://8.8.8.8/")).toBeNull());
});
