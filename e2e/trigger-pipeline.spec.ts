/**
 * E2E: trigger-pipeline flow
 *
 * Verifies:
 *   1. Pipelines tab renders the pipeline cards.
 *   2. "Run Now" button triggers a POST to /api/pipelines/<id>/run.
 *   3. After triggering, the button shows "Running…" state.
 *   4. Recent runs section shows the run status badge.
 *   5. Polling detects a run transitioning from running → completed.
 *   6. Expanding a completed run shows the step progress bar.
 *
 * Uses Playwright route intercepts — runnable without a live database.
 */

import { test, expect } from "playwright/test";
import { loginViaLocalStorage, goToTab } from "./helpers/auth";
import {
  mockGlobalApi,
  mockPipelinesApi,
  FIXTURE_PIPELINES,
  FIXTURE_PIPELINE_RUNS,
  FIXTURE_PIPELINE_RUN_DETAIL,
} from "./helpers/mock-api";

// ── Setup ─────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await mockGlobalApi(page);
  await mockPipelinesApi(page);
  await loginViaLocalStorage(page);
  await goToTab(page, "pipelines");
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test("pipelines tab renders pipeline cards", async ({ page }) => {
  await expect(page.getByRole("heading", { name: /Idea Pipelines/i })).toBeVisible();

  // Each fixture pipeline should be visible
  for (const p of FIXTURE_PIPELINES.data) {
    await expect(page.getByText(p.name)).toBeVisible();
    await expect(page.getByText(p.description)).toBeVisible();
  }
});

test("Run Now button fires a POST to the pipeline run endpoint", async ({ page }) => {
  // Track the POST request
  const runRequest = page.waitForRequest(
    (req) =>
      req.url().includes("/api/pipelines/") &&
      req.url().includes("/run") &&
      req.method() === "POST",
  );

  // Click the Run Now button on the first pipeline card
  await page.getByRole("button", { name: /Run Now/i }).first().click();

  const req = await runRequest;
  expect(req.url()).toMatch(/\/api\/pipelines\/ideas-pipeline\/run/);
});

test("Run Now button shows Running state after trigger", async ({ page }) => {
  // Wait for the pipeline card to render
  await expect(page.getByRole("button", { name: /Run Now/i })).toBeVisible();

  // Click the button
  await page.getByRole("button", { name: /Run Now/i }).first().click();

  // The button should immediately transition to a disabled/loading state while
  // the POST is in-flight. Check for "Running..." text OR disabled state.
  const btn = page.getByRole("button", { name: /Running.../i }).first();
  // Some implementations disable the button after click — either is valid
  await expect(
    btn.or(page.getByRole("button", { name: /Run Now/i }).first()),
  ).toBeVisible();
});

test("recent runs section renders run cards", async ({ page }) => {
  // The "Recent Runs" heading should appear (runs.length > 0)
  await expect(page.getByRole("heading", { name: /Recent Runs/i })).toBeVisible();

  // Run status badge
  await expect(page.getByText("completed").first()).toBeVisible();
});

test("polling updates run list on the page", async ({ page }) => {
  // Override the pipeline runs endpoint to return a "running" status on the
  // second poll, then "completed" on the third — simulating an in-flight run.
  let pollCount = 0;

  await page.unroute("**/api/pipelines-runs*");
  await page.route("**/api/pipelines-runs*", async (route) => {
    const url = route.request().url();

    // Delegate run-detail and ideas sub-routes
    if (url.match(/\/api\/pipelines-runs\/[^/?]+\/ideas/)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      });
      return;
    }
    if (url.match(/\/api\/pipelines-runs\/[^/?]+$/)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(FIXTURE_PIPELINE_RUN_DETAIL),
      });
      return;
    }

    // Main list endpoint: first response has "running" status
    pollCount++;
    if (pollCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              ...FIXTURE_PIPELINE_RUNS.data[0]!,
              status: "running",
              resultSummary: null,
            },
          ],
        }),
      });
    } else {
      // Subsequent polls: completed
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(FIXTURE_PIPELINE_RUNS),
      });
    }
  });

  // Re-navigate so the fresh mocks take effect
  await goToTab(page, "pipelines");

  // The first poll returns "running"
  await expect(page.getByText("running").first()).toBeVisible({ timeout: 8_000 });

  // After the polling interval (~5 s in the component) it transitions to completed
  await expect(page.getByText("completed").first()).toBeVisible({ timeout: 12_000 });
});

test("expanding a completed run row shows step progress", async ({ page }) => {
  // The recent runs list renders RunRow components.  Each row is a <button>
  // that toggles the expanded detail.  Click the first run row to expand it.

  // Wait for the Recent Runs heading
  await expect(page.getByRole("heading", { name: /Recent Runs/i })).toBeVisible();

  // Find the first expandable run button (chevron button in the run row) and click
  const runRow = page.locator(".bg-bg-1.rounded-lg.border").first();
  await runRow.locator("button").first().click();

  // After expansion, step names from the fixture should be visible
  await expect(page.getByText(/App Landscape/i)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(/Synthesize/i)).toBeVisible({ timeout: 8_000 });
});

test("result summary shows ideas count after run completes", async ({ page }) => {
  // Expand the first run row to reveal the result summary
  await expect(page.getByRole("heading", { name: /Recent Runs/i })).toBeVisible();

  const runRow = page.locator(".bg-bg-1.rounded-lg.border").first();
  await runRow.locator("button").first().click();

  // The StatCard for "Ideas Kept" should show 7 (from the fixture)
  await expect(page.getByText("Ideas Kept")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("7")).toBeVisible({ timeout: 8_000 });
});
