const { test, expect } = require("@playwright/test");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { fixtures, apiURL, login, openDirectory, employeeData, addEmployee, employeeRow, saveEmployee } = require("./helpers.cjs");
const docker = promisify(execFile);
const worker = process.env.WORKSPHERE_E2E_AUDIT_WORKER;

test("@regression audit history catches up after a real worker outage while employee writes remain available", async ({ page, context }) => {
  test.setTimeout(90000);
  // Only the isolated verification harness supplies a container ID. Application
  // HTTP endpoints never expose process control; direct existing-stack runs skip it.
  test.skip(!worker && !process.env.CI, "Run npm run test:e2e to provision an isolated worker.");
  expect(worker).toMatch(/^[a-f\d]{64}$/);
  await login(page, fixtures.accounts.admin);
  try {
    await docker("docker", ["stop", "--time", "20", worker], { timeout: 30000 });
    await openDirectory(page, "ADMIN");
    const person = employeeData("worker-outage");
    const created = await addEmployee(page, person);
    await employeeRow(page, person.email).getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".employee-editor").getByLabel("Job title", { exact: true }).fill("Recovery engineer");
    await saveEmployee(page, "PATCH");
    expect((await context.request.get(`${apiURL}/employees/${created._id}`)).status()).toBe(200);
    expect((await context.request.get(`${new URL(apiURL).origin}/health/ready`)).status()).toBe(200);
    const health = await context.request.get(`${apiURL}/operations/audit`);
    expect(health.status()).toBe(503);
    expect((await health.json()).producers.employees.pending).toBeGreaterThanOrEqual(2);
    await page.getByRole("link", { name: /Audit history/ }).click();
    await page.getByLabel("Search history", { exact: true }).fill(created.employeeNumber);
    await expect(page.getByRole("heading", { name: "No matching activity" })).toBeVisible();
    await expect(page.getByText(/Recent changes may take a few seconds/)).toBeVisible();
    await docker("docker", ["start", worker], { timeout: 30000 });
    // Observe the browser's real polling path; no manual page refresh, fake audit
    // responses, or direct database mutation can make this assertion succeed.
    await expect(page.getByRole("cell", { name: "Employee created", exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("cell", { name: "Employee updated", exact: true })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(3);
    await page.getByRole("row").filter({ hasText: "Employee updated" }).locator("summary").click();
    await expect(page.getByText(/Software engineer → Recovery engineer/)).toBeVisible();
    await expect.poll(async () => (await context.request.get(`${apiURL}/operations/audit`)).status()).toBe(200);
    await expect.poll(async () => (await (await context.request.get(`${apiURL}/audit`, { params: { resourceId: created._id } })).json()).pagination.totalItems).toBe(2);
  } finally {
    await docker("docker", ["start", worker], { timeout: 30000 });
  }
});
