/**
 * Shared auth helpers for OpenCrow E2E tests.
 *
 * The dashboard is token-gated. We inject the token via localStorage so
 * that every API call made by the React app is already authorized without
 * having to interact with the login form.
 *
 * TOKEN resolution order:
 *   1. E2E_TOKEN env var (preferred for CI)
 *   2. OPENCROW_WEB_TOKEN env var (the same var the server reads)
 *   3. Hard-coded dev fallback "dev" (only works against a server started
 *      without a token, i.e. OPENCROW_WEB_TOKEN=dev or unset)
 */

import type { Page } from "playwright/test";

export const E2E_TOKEN =
  process.env.E2E_TOKEN ?? process.env.OPENCROW_WEB_TOKEN ?? "dev";

/**
 * Navigate to the app and inject the auth token into localStorage so that
 * subsequent API calls succeed without going through the login modal.
 */
export async function loginViaLocalStorage(page: Page): Promise<void> {
  // Visit root first so localStorage is scoped to the correct origin.
  await page.goto("/");

  // Inject the token the same way the TokenModal's handleSubmit does it.
  await page.evaluate((token: string) => {
    localStorage.setItem("opencrow_web_token", token);
  }, E2E_TOKEN);

  // Hard-reload so the React app picks up the injected token and proceeds
  // to render the authenticated view.
  await page.reload();
}

/**
 * Navigate to a hash-based tab and wait for the content container to settle.
 * Hash routing is synchronous in the SPA — no network navigation needed.
 */
export async function goToTab(page: Page, tab: string): Promise<void> {
  await page.evaluate((t: string) => {
    location.hash = t;
  }, tab);
  // Give the React state update a tick to flush.
  await page.waitForTimeout(300);
}
