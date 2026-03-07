/** Account verification utilities — replaces Python verify scripts. */

import {
  launchXBrowser,
  createGraphQLInterceptor,
  PROFILE_OPERATIONS,
} from "../../sources/x/shared";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type VerifyResult =
  | {
      readonly ok: true;
      readonly username: string;
      readonly display_name: string;
      readonly profile_image_url?: string;
      readonly avatar_url?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

// ── X/Twitter ────────────────────────────────────────────────────────────────

export async function verifyXAccount(
  authToken: string,
  ct0: string,
): Promise<VerifyResult> {
  const session = await launchXBrowser(authToken, ct0);

  try {
    const page = await session.context.newPage();
    page.setDefaultTimeout(15_000);

    const { handler, responses } = createGraphQLInterceptor(PROFILE_OPERATIONS);
    page.on("response", handler);

    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/i/flow/login")) {
      return { ok: false, error: "Credentials expired or invalid" };
    }

    const avatarEl = await page.$('[data-testid="AppTabBar_Profile_Link"]');
    if (!avatarEl) {
      return { ok: false, error: "Could not find profile link — cookies may be expired" };
    }

    const profileHref = await avatarEl.getAttribute("href");
    const username = profileHref?.replace(/^\//, "") ?? "";

    if (!username) {
      return { ok: false, error: "Could not extract username" };
    }

    await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    let displayName = "";
    let profileImageUrl = "";

    const nameEl = await page.$('[data-testid="UserName"] span');
    if (nameEl) {
      displayName = (await nameEl.textContent()) ?? "";
    }

    const avatarImg = await page.$('[data-testid="UserAvatar"] img');
    if (avatarImg) {
      profileImageUrl = (await avatarImg.getAttribute("src")) ?? "";
    }

    if (!displayName && responses.length > 0) {
      const profileData = responses[0] as Record<string, unknown>;
      const data = (profileData?.data ?? {}) as Record<string, unknown>;
      const user = (data?.user ?? {}) as Record<string, unknown>;
      const result = (user?.result ?? {}) as Record<string, unknown>;
      const legacy = (result?.legacy ?? {}) as Record<string, unknown>;
      displayName = String(legacy?.name ?? username);
      profileImageUrl = String(legacy?.profile_image_url_https ?? "").replace("_normal", "");
    }

    await page.close();

    return {
      ok: true,
      username,
      display_name: displayName || username,
      profile_image_url: profileImageUrl,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Verification failed",
    };
  } finally {
    await session.cleanup();
  }
}

// ── Reddit ───────────────────────────────────────────────────────────────────

interface CookieEntry {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly [key: string]: unknown;
}

function buildCookieHeader(cookiesJson: string, domainFilter: string): string {
  try {
    const cookies = JSON.parse(cookiesJson) as CookieEntry[];
    if (!Array.isArray(cookies)) return "";
    return cookies
      .filter((c) => c.name && c.value && c.domain?.includes(domainFilter))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  } catch {
    return "";
  }
}

export async function verifyRedditAccount(
  cookiesJson: string,
): Promise<VerifyResult> {
  try {
    const cookieHeader = buildCookieHeader(cookiesJson, "reddit.com");
    if (!cookieHeader) {
      return { ok: false, error: "No valid Reddit cookies found" };
    }

    const resp = await fetch("https://www.reddit.com/api/me.json", {
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
    });

    if (!resp.ok) {
      return { ok: false, error: `Reddit API returned ${resp.status}` };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const userKind = data.kind as string | undefined;

    if (userKind !== "t2" && !data.name) {
      return { ok: false, error: "Cookies expired or invalid" };
    }

    const snoo = (data.subreddit ?? data.data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      username: String(data.name ?? ""),
      display_name: String(
        snoo.display_name_prefixed ?? snoo.title ?? data.name ?? "",
      ),
      avatar_url: String(snoo.icon_img ?? data.icon_img ?? ""),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }
}

// ── Product Hunt ─────────────────────────────────────────────────────────────

export async function verifyPHAccount(
  cookiesJson: string,
): Promise<VerifyResult> {
  try {
    const cookieHeader = buildCookieHeader(cookiesJson, "producthunt.com");
    if (!cookieHeader) {
      return { ok: false, error: "No valid Product Hunt cookies found" };
    }

    const resp = await fetch("https://www.producthunt.com/frontend/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookieHeader,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        operationName: "Viewer",
        variables: {},
        query: "query Viewer { viewer { user { id username name headline profileImage } } }",
      }),
    });

    if (!resp.ok) {
      return { ok: false, error: `Product Hunt API returned ${resp.status}` };
    }

    const body = (await resp.json()) as Record<string, unknown>;
    const gqlData = (body.data ?? {}) as Record<string, unknown>;
    const viewer = (gqlData.viewer ?? {}) as Record<string, unknown>;
    const user = (viewer.user ?? null) as Record<string, unknown> | null;

    if (!user) {
      return { ok: false, error: "Cookies expired or invalid" };
    }

    return {
      ok: true,
      username: String(user.username ?? ""),
      display_name: String(user.name ?? ""),
      avatar_url: String(user.profileImage ?? ""),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }
}
