/**
 * E2E: create-agent flow
 *
 * Verifies:
 *   1. Agents tab renders the agent list.
 *   2. "New Agent" button opens the create-agent modal.
 *   3. Form validation blocks submission when required fields are missing.
 *   4. Filling required fields and submitting creates the agent.
 *   5. The new agent appears in the list after creation.
 *
 * The test uses Playwright route intercepts to mock the REST API so it runs
 * without a live database. All assertions target real DOM outcomes — if the
 * UI logic regresses the test will fail.
 *
 * To run against a live stack: set E2E_BASE_URL and E2E_TOKEN in the
 * environment and remove the mockAgentsApi / mockGlobalApi calls so that
 * real HTTP traffic flows through.
 */

import { test, expect } from "playwright/test";
import { loginViaLocalStorage, goToTab } from "./helpers/auth";
import { mockGlobalApi, mockAgentsApi, FIXTURE_AGENTS } from "./helpers/mock-api";

// ── Setup ────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  // Install mocks before the app loads so the very first requests are
  // intercepted.  Route patterns are glob-matched by Playwright.
  await mockGlobalApi(page);
  await mockAgentsApi(page);
  await loginViaLocalStorage(page);
  await goToTab(page, "agents");
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test("agents tab renders the agent list", async ({ page }) => {
  // The PageHeader renders an h1 with the title "Agents"
  await expect(page.getByRole("heading", { name: /Agents/i })).toBeVisible();

  // Each fixture agent should appear as a card
  for (const agent of FIXTURE_AGENTS.data) {
    await expect(page.getByText(agent.name)).toBeVisible();
  }
});

test("New Agent button opens the create modal", async ({ page }) => {
  await page.getByRole("button", { name: /New Agent/i }).click();

  // Modal title should be visible
  await expect(page.getByRole("heading", { name: /New Agent/i })).toBeVisible();

  // Form fields: ID and Name inputs exist
  await expect(page.getByLabel(/ID/i)).toBeVisible();
  await expect(page.getByLabel(/Name/i)).toBeVisible();
});

test("form blocks submission when required fields are empty", async ({ page }) => {
  await page.getByRole("button", { name: /New Agent/i }).click();

  // Click submit without filling anything in
  await page.getByRole("button", { name: /Create Agent/i }).click();

  // The form should NOT call the API and should still show the modal;
  // browser required validation will prevent submission for the ID/Name inputs.
  // Playwright does not trigger constraint-validation popups as DOM events, so
  // we assert the modal is still open (not replaced by list view).
  await expect(page.getByRole("heading", { name: /New Agent/i })).toBeVisible();
});

test("fills form and creates a new agent successfully", async ({ page }) => {
  // Track outgoing POST to /api/agents
  const createRequest = page.waitForRequest(
    (req) =>
      req.url().includes("/api/agents") &&
      req.method() === "POST",
  );

  await page.getByRole("button", { name: /New Agent/i }).click();

  // Fill the ID field (kebab-case)
  await page.getByLabel(/ID/i).fill("e2e-test-agent");

  // Fill the Name field
  await page.getByLabel(/Name/i).fill("E2E Test Agent");

  // Submit the form
  await page.getByRole("button", { name: /Create Agent/i }).click();

  // The form should have fired the POST
  const req = await createRequest;
  const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
  expect(body["id"]).toBe("e2e-test-agent");
  expect(body["name"]).toBe("E2E Test Agent");
});

test("new agent appears in list after creation", async ({ page }) => {
  // Override the agents list mock after creation to include the new agent so
  // we can assert the re-fetched list reflects it.
  let callCount = 0;
  await page.unroute("**/api/agents");
  await page.route("**/api/agents", async (route) => {
    if (route.request().method() === "GET") {
      callCount++;
      if (callCount >= 2) {
        // Second+ GET (after creation) includes the new agent
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            configHash: "newcfghash001",
            data: [
              ...FIXTURE_AGENTS.data,
              {
                id: "e2e-test-agent",
                name: "E2E Test Agent",
                description: "",
                provider: "agent-sdk",
                model: "claude-sonnet-4-6",
                default: false,
                toolCount: 0,
                skillCount: 0,
              },
            ],
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(FIXTURE_AGENTS),
        });
      }
    } else if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          configHash: "newcfghash001",
          data: {
            id: "e2e-test-agent",
            name: "E2E Test Agent",
            description: "",
            provider: "agent-sdk",
            model: "claude-sonnet-4-6",
            default: false,
            toolCount: 0,
            skillCount: 0,
          },
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Re-navigate to flush the previous route and pick up the new mock
  await goToTab(page, "agents");

  // Open modal and create
  await page.getByRole("button", { name: /New Agent/i }).click();
  await page.getByLabel(/ID/i).fill("e2e-test-agent");
  await page.getByLabel(/Name/i).fill("E2E Test Agent");
  await page.getByRole("button", { name: /Create Agent/i }).click();

  // After creation the component calls loadAgents() which triggers a second GET
  await expect(page.getByText("E2E Test Agent")).toBeVisible({ timeout: 10_000 });
});

test("provider filter tabs are rendered", async ({ page }) => {
  // The FilterTabs component renders a row of tab buttons
  await expect(page.getByRole("button", { name: /All/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Agent SDK/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Anthropic/i })).toBeVisible();
});

test("search bar filters agents by name", async ({ page }) => {
  // Wait for the agent list to be rendered
  await expect(page.getByText(FIXTURE_AGENTS.data[0]!.name)).toBeVisible();

  // Type in the search bar
  await page.getByPlaceholder(/Search agents/i).fill("Research");

  // Only the Research Agent should remain visible
  await expect(page.getByText("Research Agent")).toBeVisible();
  await expect(page.getByText("Default Agent")).toBeHidden();
});
