/**
 * Alibaba ModelStudio "token plan" (pay-per-token) endpoints.
 *
 * The token plan exposes two protocol surfaces on the same host:
 *   - OpenAI-compatible    -> /compatible-mode/v1   (direct, no-tools chat)
 *   - Anthropic-compatible -> /apps/anthropic       (agentic, via Agent SDK)
 *
 * `resolveAlibabaEndpoint` makes the optional ALIBABA_BASE_URL override
 * region-portable: ONE override value (a bare host OR a full URL with either
 * suffix) works for BOTH protocol paths by normalizing it to a host root first.
 */

export const ALIBABA_TOKEN_PLAN_HOST =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com";

const SUFFIXES = {
  openai: "/compatible-mode/v1",
  anthropic: "/apps/anthropic",
} as const;

const KNOWN_SUFFIXES = ["/compatible-mode/v1", "/apps/anthropic", "/v1"] as const;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The override flows into an outbound `fetch` URL (and `ANTHROPIC_BASE_URL`)
 * with the Alibaba bearer key attached, so a malformed value would silently
 * mis-send the credential. Reject the genuine footguns early with a clear
 * error: an unparseable URL, a non-http(s) scheme (e.g. a `htps://` typo or a
 * bare host with no scheme), or embedded `user:pass@` credentials.
 */
function assertValidOverride(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `ALIBABA_BASE_URL is not a valid absolute URL: "${raw}". ` +
        `Expected something like ${ALIBABA_TOKEN_PLAN_HOST}`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `ALIBABA_BASE_URL must use an http(s) scheme; got "${url.protocol}"`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "ALIBABA_BASE_URL must not contain embedded credentials (user:pass@host)",
    );
  }
}

export function resolveAlibabaEndpoint(
  kind: "openai" | "anthropic",
  override?: string | null,
): string {
  const suffix = SUFFIXES[kind];
  const trimmed = override?.trim();
  if (!trimmed) {
    return `${ALIBABA_TOKEN_PLAN_HOST}${suffix}`;
  }
  assertValidOverride(trimmed);
  let hostRoot = stripTrailingSlashes(trimmed);
  const matched = KNOWN_SUFFIXES.find((s) => hostRoot.endsWith(s));
  if (matched) {
    hostRoot = stripTrailingSlashes(hostRoot.slice(0, -matched.length));
  }
  return `${hostRoot}${suffix}`;
}
