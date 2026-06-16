import type { ToolDefinition, ToolResult } from "./types";
import { createLogger } from "../logger";
import { requireString, getString, getNumber, getEnum } from "./input-helpers";
import { isToolError } from "./input-helpers";
import { rateLimitError, serviceError, inputError } from "./error-helpers";

import { getErrorMessage } from "../lib/error-serialization";
const log = createLogger("tool:web-fetch");

const MAX_BODY_BYTES = 1_048_576; // 1 MB
const MAX_REDIRECTS = 5;
const MAX_REQUESTS_PER_MINUTE = 10;
const DEFAULT_TIMEOUT_S = 15;
const MAX_TIMEOUT_S = 30;

// ---------------------------------------------------------------------------
// Rate limiting (module-level sliding window)
// ---------------------------------------------------------------------------

const requestTimestamps: number[] = [];

/** Exported for testing only. */
export function resetRateLimit(): void {
  requestTimestamps.length = 0;
}

function pruneOldTimestamps(): void {
  const cutoff = Date.now() - 60_000;
  while (requestTimestamps.length > 0 && (requestTimestamps[0] ?? 0) < cutoff) {
    requestTimestamps.shift();
  }
}

function checkRateLimit(): string | null {
  pruneOldTimestamps();
  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    return "Rate limit exceeded: max 10 requests per minute.";
  }
  return null;
}

function recordRequest(): void {
  requestTimestamps.push(Date.now());
}

// ---------------------------------------------------------------------------
// SSRF Prevention
// ---------------------------------------------------------------------------

function parseIpv4Octets(ip: string): readonly number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  return octets;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  if (octets.length < 2) return false;
  const a = octets[0]!;
  const b = octets[1]!;

  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local, AWS/GCP/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (CGNAT / Tailscale: 100.64.x.x – 100.127.x.x)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 (IETF protocol assignments) and 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0) return true;
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  if (a >= 224) return true;

  return false;
}

/**
 * Reject any address that resolves to a loopback, private, link-local, CGNAT,
 * multicast, or reserved range. IPv4 is parsed by numeric octet range (not
 * string prefix), and IPv4-mapped / IPv4-compatible IPv6 addresses are unwrapped
 * so that e.g. `::ffff:127.0.0.1` and `::ffff:7f00:1` are caught.
 */
export function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Strip an IPv6 zone identifier (e.g. fe80::1%eth0) before any checks.
  const bare = normalized.split("%")[0] ?? normalized;

  // IPv4-mapped / IPv4-compatible IPv6 (::ffff:a.b.c.d or ::a.b.c.d).
  const mappedV4 = bare.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedV4) {
    const octets = parseIpv4Octets(mappedV4[1]!);
    return octets ? isPrivateIpv4(octets) : true;
  }

  // IPv4-mapped IPv6 in hex form (::ffff:7f00:1 == 127.0.0.1).
  const mappedHex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const octets = [
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ];
    return isPrivateIpv4(octets);
  }

  // Pure IPv6 ranges.
  if (bare.includes(":")) {
    if (bare === "::1" || bare === "::") return true; // loopback / unspecified
    if (bare.startsWith("fc") || bare.startsWith("fd")) return true; // fc00::/7 ULA
    if (bare.startsWith("fe80")) return true; // link-local
    if (bare.startsWith("fe9") || bare.startsWith("fea") || bare.startsWith("feb")) {
      return true; // remainder of fe80::/10 link-local block
    }
    if (bare.startsWith("ff")) return true; // ff00::/8 multicast
    // Anything else that parsed as IPv6 but isn't a normal global address:
    // be conservative only for clearly-local forms above; allow global v6.
    return false;
  }

  // Plain IPv4.
  const octets = parseIpv4Octets(bare);
  if (!octets) return false;
  return isPrivateIpv4(octets);
}

export async function validateUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Rejected protocol: ${parsed.protocol} — only http/https allowed.`;
  }

  const hostname = parsed.hostname;
  const lowerHost = hostname.toLowerCase();
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost")) {
    return "Rejected hostname: localhost is not allowed.";
  }

  // If the hostname is already a literal IP (incl. bracketed IPv6 like [::1]),
  // check it directly — no DNS lookup needed and rebinding cannot apply.
  const literalIp = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIpLiteral(literalIp)) {
    if (isPrivateIp(literalIp)) {
      return `Rejected: ${literalIp} is a private/reserved address.`;
    }
    return null;
  }

  try {
    const addrs = await resolveDns(hostname);
    if (addrs.length === 0) {
      return `DNS resolution returned no addresses for ${hostname}.`;
    }
    for (const addr of addrs) {
      if (isPrivateIp(addr)) {
        return `Rejected: hostname resolves to private IP ${addr}.`;
      }
    }
  } catch (err) {
    return `DNS resolution failed for ${hostname}: ${getErrorMessage(err)}`;
  }

  return null;
}

/** True when the string is a literal IPv4 or IPv6 address (not a hostname). */
function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true; // any colon ⇒ IPv6 literal
  return parseIpv4Octets(host) !== null;
}

// ---------------------------------------------------------------------------
// DNS resolution (Bun.dns or node:dns fallback)
// ---------------------------------------------------------------------------

async function resolveDns(hostname: string): Promise<readonly string[]> {
  // Bun.dns.resolve returns { address: string }[] — use dynamic access to avoid type issues
  const bunGlobal = globalThis as Record<string, unknown>;
  const bunObj = bunGlobal.Bun as
    | { dns?: { resolve: (h: string) => Promise<Array<{ address: string }>> } }
    | undefined;

  if (bunObj?.dns) {
    const results = await bunObj.dns.resolve(hostname);
    return results.map((r) => r.address);
  }

  const dns = await import("node:dns");
  const results = await dns.promises.resolve4(hostname);
  return results;
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

type ResponseFormat = "json" | "text" | "html";

function detectFormat(contentType: string): ResponseFormat {
  if (contentType.includes("json")) return "json";
  if (contentType.includes("html")) return "html";
  return "text";
}

function formatBody(raw: string, format: ResponseFormat): string {
  if (format === "json") {
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }
  if (format === "html") {
    return raw
      .replace(/<[^>]*>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return raw;
}

function formatResponse(
  status: number,
  statusText: string,
  contentType: string,
  body: string,
  truncated: boolean,
): string {
  const lines = [
    `HTTP ${status} ${statusText}`,
    `Content-Type: ${contentType}`,
    "",
    body,
  ];
  if (truncated) {
    lines.push("\n[... truncated at 1 MB ...]");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fetch with redirect handling
// ---------------------------------------------------------------------------

interface FetchOptions {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly timeoutMs: number;
}

async function fetchWithRedirects(
  initialUrl: string,
  opts: FetchOptions,
): Promise<Response> {
  let currentUrl = initialUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // Re-resolve and re-validate the hostname's IPs on EVERY hop (including the
    // first), immediately before connecting. This shrinks the DNS-rebinding
    // TOCTOU window: a stale validation from executeWebFetch cannot be reused,
    // and each redirect target is re-checked here rather than only by the
    // earlier validateUrl call.
    //
    // Residual limitation: Bun's fetch() resolves DNS again internally and we
    // cannot pin the socket to the IP we validated, so a sub-millisecond rebind
    // between our resolve and Bun's connect is theoretically possible. True
    // hardening would require connecting to a pinned, pre-validated IP (e.g. a
    // custom dispatcher/agent or Host-header pinning) — not currently available
    // with Bun's fetch. This is the strongest feasible mitigation today.
    const hopError = await validateUrl(currentUrl);
    if (hopError) {
      throw new Error(`Blocked (SSRF): ${hopError}`);
    }

    const response = await fetch(currentUrl, {
      method: i === 0 ? opts.method : "GET",
      headers: opts.headers,
      body: i === 0 ? opts.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    const status = response.status;
    if (status < 300 || status >= 400) {
      return response;
    }

    // Handle redirect
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    // Resolve the redirect target; it is re-validated at the top of the next
    // loop iteration before the connection is made.
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
}

// ---------------------------------------------------------------------------
// Read body with size limit
// ---------------------------------------------------------------------------

async function readBodyLimited(
  response: Response,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: "", truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      const excess = totalBytes - MAX_BODY_BYTES;
      const trimmed = value.slice(0, value.byteLength - excess);
      chunks.push(trimmed);
      truncated = true;
      reader.cancel().catch((err) => log.debug("Reader cancel failed", err));
      break;
    }
    chunks.push(value);
  }

  const decoder = new TextDecoder();
  const text =
    chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
    decoder.decode();
  return { text, truncated };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL or call an API. Supports GET/POST/PUT/DELETE/PATCH with custom headers and body. Use for web scraping, API calls, or downloading content.",
    categories: ["research", "code"] as const,
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch (must be http:// or https://).",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
          description: "HTTP method (default GET).",
        },
        headers: {
          type: "object",
          description: "Request headers as key-value pairs.",
        },
        body: {
          type: "string",
          description: "Request body for POST/PUT/PATCH.",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default 15, max 30).",
        },
        response_format: {
          type: "string",
          enum: ["json", "text", "html"],
          description:
            "How to format the response body. Auto-detected from Content-Type if not specified.",
        },
      },
      required: ["url"],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      return executeWebFetch(input);
    },
  };
}

async function executeWebFetch(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  // Extract and validate inputs
  const url = requireString(input, "url");
  if (isToolError(url)) return url;

  const method =
    getEnum(input, "method", [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
    ] as const) ?? "GET";

  const headers = (input.headers ?? {}) as Record<string, string>;
  const body = getString(input, "body");
  const timeoutS = getNumber(input, "timeout", {
    min: 1,
    max: MAX_TIMEOUT_S,
    defaultVal: DEFAULT_TIMEOUT_S,
  });
  const responseFormat = getEnum(input, "response_format", [
    "json",
    "text",
    "html",
  ] as const);

  // Validate URL (SSRF prevention)
  const urlError = await validateUrl(url);
  if (urlError) {
    return inputError(urlError);
  }

  // Rate limit check
  const rateLimitMsg = checkRateLimit();
  if (rateLimitMsg) {
    const oldestTs = requestTimestamps[0] ?? Date.now();
    const retryAfterMs = Math.max(0, oldestTs + 60_000 - Date.now());
    return rateLimitError(
      `Rate limit exceeded: max ${MAX_REQUESTS_PER_MINUTE} requests per minute.`,
      retryAfterMs,
    );
  }
  recordRequest();

  // Execute fetch
  try {
    const response = await fetchWithRedirects(url, {
      method,
      headers,
      body,
      timeoutMs: timeoutS * 1000,
    });

    const contentType = response.headers.get("content-type") ?? "text/plain";
    const format = responseFormat ?? detectFormat(contentType);
    const { text, truncated } = await readBodyLimited(response);
    const formatted = formatBody(text, format);

    log.info("fetch completed", {
      url,
      status: response.status,
      bytes: text.length,
    });

    return {
      output: formatResponse(
        response.status,
        response.statusText,
        contentType,
        formatted,
        truncated,
      ),
      isError: false,
    };
  } catch (err) {
    const message = getErrorMessage(err);
    log.error("fetch failed", { url, error: message });
    return serviceError(`Fetch failed: ${message}`);
  }
}
