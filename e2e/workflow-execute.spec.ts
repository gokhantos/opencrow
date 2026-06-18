/**
 * E2E: workflow-execute flow
 *
 * Verifies:
 *   1. Workflows tab renders the canvas editor (top bar with name input).
 *   2. Saving a new workflow fires a POST to /api/workflows.
 *   3. After save, Run button becomes enabled.
 *   4. Clicking Run fires POST to /api/workflows/<id>/run.
 *   5. Execution status badge appears after run is triggered.
 *   6. Loading a saved workflow from the WorkflowList populates the canvas.
 *
 * The workflow editor is a full-screen ReactFlow canvas.  We don't attempt to
 * drag nodes in E2E (that's fragile); instead we assert the toolbar, save, and
 * run lifecycle which covers the critical path.
 *
 * Uses Playwright route intercepts — runnable without a live database.
 */

import { test, expect } from "playwright/test";
import { loginViaLocalStorage, goToTab } from "./helpers/auth";
import {
  mockGlobalApi,
  mockWorkflowsApi,
  FIXTURE_WORKFLOW_DETAIL,
  FIXTURE_WORKFLOWS,
} from "./helpers/mock-api";

// ── Setup ─────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await mockGlobalApi(page);
  await mockWorkflowsApi(page);
  await loginViaLocalStorage(page);
  await goToTab(page, "workflows");
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test("workflows tab renders the canvas top bar", async ({ page }) => {
  // The top bar contains a name input
  await expect(page.getByLabel(/Workflow name/i)).toBeVisible();
  // Save button exists in the toolbar
  await expect(page.getByRole("button", { name: /Save/i })).toBeVisible();
});

test("Run button is disabled when workflow is unsaved (dirty)", async ({ page }) => {
  // New workflow starts as unsaved/dirty — Run button should be disabled
  const runBtn = page.getByRole("button", { name: /^Run$/i });
  await expect(runBtn).toBeDisabled();
});

test("saving a workflow fires POST to /api/workflows", async ({ page }) => {
  // Set a workflow name (makes it dirty)
  const nameInput = page.getByLabel(/Workflow name/i);
  await nameInput.clear();
  await nameInput.fill("My E2E Workflow");

  // Track the POST
  const saveRequest = page.waitForRequest(
    (req) => req.url().includes("/api/workflows") && req.method() === "POST",
  );

  await page.getByRole("button", { name: /Save/i }).click();

  const req = await saveRequest;
  const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
  expect(body["name"]).toBe("My E2E Workflow");
});

test("after save, Run button is enabled", async ({ page }) => {
  const nameInput = page.getByLabel(/Workflow name/i);
  await nameInput.clear();
  await nameInput.fill("My E2E Workflow");

  await page.getByRole("button", { name: /Save/i }).click();

  // After a successful save the component dispatches MARK_SAVED which clears
  // isDirty, enabling the Run button.
  const runBtn = page.getByRole("button", { name: /^Run$/i });
  await expect(runBtn).toBeEnabled({ timeout: 8_000 });
});

test("clicking Run fires POST to /api/workflows/<id>/run", async ({ page }) => {
  // First save to get an id and clear dirty state
  const nameInput = page.getByLabel(/Workflow name/i);
  await nameInput.clear();
  await nameInput.fill("My E2E Workflow");
  await page.getByRole("button", { name: /Save/i }).click();

  // Wait for run button to be enabled
  const runBtn = page.getByRole("button", { name: /^Run$/i });
  await expect(runBtn).toBeEnabled({ timeout: 8_000 });

  // Track the run POST
  const runRequest = page.waitForRequest(
    (req) =>
      req.url().includes("/api/workflows/") &&
      req.url().includes("/run") &&
      req.method() === "POST",
  );

  await runBtn.click();

  const req = await runRequest;
  expect(req.url()).toMatch(/\/api\/workflows\/.*\/run/);
});

test("execution status badge appears after run is triggered", async ({ page }) => {
  // Save first
  const nameInput = page.getByLabel(/Workflow name/i);
  await nameInput.clear();
  await nameInput.fill("My E2E Workflow");
  await page.getByRole("button", { name: /Save/i }).click();

  const runBtn = page.getByRole("button", { name: /^Run$/i });
  await expect(runBtn).toBeEnabled({ timeout: 8_000 });

  await runBtn.click();

  // The RunControls component renders an execution status badge pill after
  // onExecutionStart is called. The badge text is one of: pending / running /
  // completed / failed / cancelled. Our mock returns {executionId: "exec-new-001"}.
  await expect(
    page.getByText(/pending|running|completed/i).first(),
  ).toBeVisible({ timeout: 8_000 });
});

test("Load button opens the workflow list", async ({ page }) => {
  await page.getByRole("button", { name: /Load/i }).click();

  // The WorkflowList component renders a list of saved workflows.
  // The fixture has one workflow: "Morning Brief"
  await expect(page.getByText(FIXTURE_WORKFLOWS.data[0]!.name)).toBeVisible({ timeout: 8_000 });
});

test("selecting a workflow from the list loads it onto the canvas", async ({ page }) => {
  // Open the load dialog
  await page.getByRole("button", { name: /Load/i }).click();
  await expect(page.getByText(FIXTURE_WORKFLOWS.data[0]!.name)).toBeVisible({ timeout: 8_000 });

  // Click on the workflow entry to load it
  await page.getByText(FIXTURE_WORKFLOWS.data[0]!.name).click();

  // The canvas name input should update to match the loaded workflow name
  const nameInput = page.getByLabel(/Workflow name/i);
  await expect(nameInput).toHaveValue(FIXTURE_WORKFLOW_DETAIL.data.name, { timeout: 8_000 });
});

test("Undo and Redo buttons exist in the toolbar", async ({ page }) => {
  // The toolbar contains undo/redo icon-buttons (titled Undo/Redo)
  await expect(page.getByTitle(/Undo/i)).toBeVisible();
  await expect(page.getByTitle(/Redo/i)).toBeVisible();
});

test("New button resets the canvas to a blank workflow", async ({ page }) => {
  // Load a workflow first
  await page.getByRole("button", { name: /Load/i }).click();
  await expect(page.getByText("Morning Brief")).toBeVisible({ timeout: 8_000 });
  await page.getByText("Morning Brief").click();

  // Now click New
  await page.getByRole("button", { name: /New/i }).click();

  // The name input should reset to the default placeholder / empty state
  // The component uses a default name like "Untitled Workflow"
  const nameInput = page.getByLabel(/Workflow name/i);
  await expect(nameInput).not.toHaveValue("Morning Brief");
});
