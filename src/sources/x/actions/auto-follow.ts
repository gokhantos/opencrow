/** Auto-follow users by navigating to their profiles and clicking Follow. */

import type { Page, Response as PwResponse } from "playwright";
import type { AutofollowOutcome, FollowedUserFromPython } from "../follow/types";
import {
  launchXBrowser,
  validateCookies,
  extractOperation,
  delay,
  BASE_URL,
  PROFILE_OPERATIONS,
} from "../shared";
import { createLogger } from "../../../logger";

import { getErrorMessage } from "../../../lib/error-serialization";
const log = createLogger("x-auto-follow");

function extractUserInfo(
  responseBody: Record<string, unknown>,
): FollowedUserFromPython | null {
  try {
    const data = (responseBody.data ?? {}) as Record<string, unknown>;
    const user = (data.user ?? {}) as Record<string, unknown>;
    const result = (user.result ?? {}) as Record<string, unknown>;
    if (!result) return null;

    const legacy = (result.legacy ?? {}) as Record<string, unknown>;
    if (!legacy || Object.keys(legacy).length === 0) return null;

    return {
      user_id: String(result.rest_id ?? ""),
      username: String(legacy.screen_name ?? ""),
      display_name: String(legacy.name ?? ""),
      followers_count: Number(legacy.followers_count ?? 0),
      following_count: Number(legacy.friends_count ?? 0),
      verified: Boolean(result.is_blue_verified),
    };
  } catch {
    return null;
  }
}

async function followUser(
  page: Page,
  username: string,
): Promise<FollowedUserFromPython | null> {
  const capturedProfile: Record<string, unknown>[] = [];

  const handler = (response: PwResponse) => {
    if (response.status() !== 200) return;
    const op = extractOperation(response.url());
    if (op && PROFILE_OPERATIONS.has(op)) {
      response
        .json()
        .then((body) => capturedProfile.push(body as Record<string, unknown>))
        .catch(() => {});
    }
  };

  page.on("response", handler);

  try {
    const profileUrl = `${BASE_URL}/${username}`;
    log.info("Navigating to profile", { username });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });

    for (let i = 0; i < 30; i++) {
      await delay(500, 500);
      if (capturedProfile.length > 0) break;
    }

    await delay(1500, 3000);

    // Extract user info
    let userInfo: FollowedUserFromPython | null = null;
    for (const resp of capturedProfile) {
      userInfo = extractUserInfo(resp);
      if (userInfo) break;
    }

    if (!userInfo) {
      log.warn("No user info captured", { username });
      return null;
    }

    // Check if already following
    const unfollowBtn = await page.$(
      `button[aria-label="Following @${username}"]`,
    );
    if (unfollowBtn) {
      log.info("Already following", { username });
      return null;
    }

    // Find follow button
    let followBtn = await page.$(
      `button[aria-label="Follow @${username}"]`,
    );
    if (!followBtn) {
      followBtn = await page.$(
        'div[data-testid="placementTracking"] button:not([data-testid="userActions"])',
      );
      if (!followBtn) {
        log.warn("Follow button not found", { username });
        return null;
      }
    }

    // Human-like mouse move + click
    const box = await followBtn.boundingBox();
    if (box) {
      await page.mouse.move(
        box.x + box.width / 2 + (Math.random() * 6 - 3),
        box.y + box.height / 2 + (Math.random() * 6 - 3),
      );
      await delay(300, 700);
    }

    await followBtn.click();
    await delay(1000, 2000);

    // Verify follow
    const verifyBtn = await page.$(
      `button[aria-label="Following @${username}"]`,
    );
    if (!verifyBtn) {
      log.warn("Follow not verified", { username });
      return null;
    }

    return userInfo;
  } finally {
    page.removeListener("response", handler);
  }
}

export async function autoFollow(
  authToken: string,
  ct0: string,
  maxFollows: number = 3,
  usernames: string[] = [],
  alreadyFollowed: string[] = [],
  languages: string | null = null,
): Promise<AutofollowOutcome> {
  const validation = validateCookies(authToken, ct0);
  if (!validation.valid) {
    return { ok: false, reason: "error", detail: `Invalid cookies: ${validation.error}` };
  }

  if (usernames.length === 0) {
    return { ok: true, followed: [] };
  }

  const alreadySet = new Set(alreadyFollowed);
  const session = await launchXBrowser(authToken, ct0);

  try {
    const page = await session.context.newPage();

    try {
      // Login check
      log.info("Checking login state");
      await page.goto(`${BASE_URL}/home`, { waitUntil: "domcontentloaded" });
      await delay(2000, 4000);

      if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
        return { ok: false, reason: "error", detail: "Cookies expired - redirected to login" };
      }

      const toFollow = usernames
        .filter((u) => !alreadySet.has(u))
        .sort(() => Math.random() - 0.5)
        .slice(0, maxFollows);

      const followed: FollowedUserFromPython[] = [];

      for (const username of toFollow) {
        try {
          const result = await followUser(page, username);
          if (result) {
            followed.push(result);
            log.info("User followed", {
              username,
              followers: result.followers_count,
            });
          }
          await delay(8000, 15000);
        } catch (err) {
          log.warn("Follow failed", {
            username,
            error: err,
          });
          await delay(10000, 18000);
        }
      }

      return { ok: true, followed };
    } finally {
      await page.close();
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    return { ok: false, reason: "error", detail: msg };
  } finally {
    await session.cleanup();
  }
}
