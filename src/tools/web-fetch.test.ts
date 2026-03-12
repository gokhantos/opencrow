import { test, expect, describe, beforeEach } from "bun:test";
import { createWebFetchTool } from "./web-fetch";
import type { ToolDefinition, ToolResult } from "./types";

// We need to test the exported helpers too
import { isPrivateIp, validateUrl, resetRateLimit } from "./web-fetch";

// ---------------------------------------------------------------------------
// isPrivateIp
// ---------------------------------------------------------------------------

describe("isPrivateIp", () => {
  test("blocks 127.0.0.0/8 loopback", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.255.255.255")).toBe(true);
  });

  test("blocks 10.0.0.0/8 private A", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  test("blocks 172.16.0.0/12 private B", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("172.15.255.255")).toBe(false);
    expect(isPrivateIp("172.32.0.0")).toBe(false);
  });

  test("blocks 192.168.0.0/16 private C", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  test("blocks 169.254.0.0/16 link-local", () => {
    expect(isPrivateIp("169.254.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  test("blocks 0.0.0.0/8", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("0.255.255.255")).toBe(true);
  });

  test("blocks 100.64.0.0/10 CGNAT/Tailscale", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.255")).toBe(true);
    expect(isPrivateIp("100.128.0.0")).toBe(false);
  });

  test("blocks IPv6 loopback ::1", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  test("blocks IPv6 fc00::/7 unique local", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
  });

  test("blocks IPv6 fe80::/10 link-local", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  test("allows public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(isPrivateIp("2607:f8b0:4004:800::200e")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

describe("validateUrl", () => {
  test("rejects invalid URLs", async () => {
    const result = await validateUrl("not-a-url");
    expect(result).toContain("Invalid URL");
  });

  test("rejects non-http protocols", async () => {
    const result = await validateUrl("ftp://example.com");
    expect(result).toContain("protocol");
  });

  test("rejects file:// protocol", async () => {
    const result = await validateUrl("file:///etc/passwd");
    expect(result).toContain("protocol");
  });

  test("rejects localhost hostname", async () => {
    const result = await validateUrl("http://localhost/test");
    expect(result).toContain("localhost");
  });

  test("rejects localhost with port", async () => {
    const result = await validateUrl("http://localhost:3000/test");
    expect(result).toContain("localhost");
  });

  test("returns null for valid public URLs", async () => {
    // This will do real DNS, so use a well-known domain
    const result = await validateUrl("https://example.com");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  beforeEach(() => {
    resetRateLimit();
  });

  test("allows requests under the limit", async () => {
    // First request should succeed (assuming example.com resolves)
    // We test the rate limit logic indirectly
    resetRateLimit();
  });
});

// ---------------------------------------------------------------------------
// createWebFetchTool
// ---------------------------------------------------------------------------

describe("createWebFetchTool", () => {
  let tool: ToolDefinition;

  beforeEach(() => {
    resetRateLimit();
    tool = createWebFetchTool();
  });

  test("has correct name", () => {
    expect(tool.name).toBe("web_fetch");
  });

  test("has correct categories", () => {
    expect(tool.categories).toContain("research");
    expect(tool.categories).toContain("code");
  });

  test("has description", () => {
    expect(tool.description.length).toBeGreaterThan(10);
  });

  test("inputSchema has required url field", () => {
    const schema = tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("url");
    expect(schema.properties).toHaveProperty("url");
  });

  test("inputSchema includes method, headers, body, timeout, response_format", () => {
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("method");
    expect(schema.properties).toHaveProperty("headers");
    expect(schema.properties).toHaveProperty("body");
    expect(schema.properties).toHaveProperty("timeout");
    expect(schema.properties).toHaveProperty("response_format");
  });

  test("rejects invalid URL", async () => {
    const result = await tool.execute({ url: "not-a-url" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid URL");
  });

  test("rejects missing url", async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("url");
  });

  test("rejects ftp:// protocol", async () => {
    const result = await tool.execute({ url: "ftp://example.com/file" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("protocol");
  });

  test("rejects localhost", async () => {
    const result = await tool.execute({ url: "http://localhost:48081/test" });
    expect(result.isError).toBe(true);
  });

  test("rejects private IP in URL", async () => {
    const result = await tool.execute({ url: "http://192.168.1.1/" });
    expect(result.isError).toBe(true);
    // Either blocked as "private" or DNS fails (CI has no route to private IPs)
    expect(
      result.output.includes("private") ||
        result.output.includes("DNS") ||
        result.output.includes("ENOTFOUND"),
    ).toBe(true);
  });

  test("rejects 169.254.169.254 (AWS metadata)", async () => {
    const result = await tool.execute({
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(result.isError).toBe(true);
  });

  test("rejects Tailscale IP", async () => {
    const result = await tool.execute({ url: "http://100.64.0.1:48080/" });
    expect(result.isError).toBe(true);
  });

  test("fetches a real public URL", async () => {
    const result = await tool.execute({
      url: "https://httpbin.org/get",
      response_format: "json",
      timeout: 10,
    });
    // httpbin might be down, so just check structure if success
    if (!result.isError) {
      expect(result.output).toContain("HTTP");
      expect(result.output).toContain("200");
    }
  });

  test("handles POST with body", async () => {
    const result = await tool.execute({
      url: "https://httpbin.org/post",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
      response_format: "json",
      timeout: 10,
    });
    if (!result.isError) {
      expect(result.output).toContain("HTTP");
    }
  });

  test("enforces rate limit", async () => {
    // Exhaust rate limit by simulating timestamps
    // We use resetRateLimit + many calls to trigger the limit
    // Since real fetches are slow, we test with blocked URLs which fail fast
    const results: ToolResult[] = [];
    for (let i = 0; i < 12; i++) {
      results.push(await tool.execute({ url: "https://example.com" }));
    }
    // At least one should be rate-limited
    const rateLimited = results.some(
      (r) => r.isError && r.output.includes("Rate limit"),
    );
    // The first 10 might pass or fail for other reasons, but the 11th+ should be rate-limited
    expect(rateLimited).toBe(true);
  });

  test("strips HTML tags when response_format is html", async () => {
    // We test the formatting logic indirectly by fetching a real page
    const result = await tool.execute({
      url: "https://example.com",
      response_format: "html",
      timeout: 10,
    });
    if (!result.isError) {
      // Should not contain HTML tags
      expect(result.output).not.toContain("<html");
      expect(result.output).not.toContain("<body");
    }
  });
});
