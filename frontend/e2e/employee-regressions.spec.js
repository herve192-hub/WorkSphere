const { test, expect } = require("@playwright/test");
const { fixtures, apiURL, origin, employeeData, login, openDirectory, addEmployee, employeeRow } = require("./helpers.cjs");

test("@regression employee numbers and manager policies survive rejected writes", async ({ page, context }) => {
  await login(page, fixtures.accounts.admin);
  const create = async (data) => {
    const response = await context.request.post(`${apiURL}/employees`, { headers: { Origin: origin }, data });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const manager = await create(employeeData("regression-manager"));
  const report = await create({ ...employeeData("regression-report"), managerId: manager._id });
  const patch = (id, data) => context.request.patch(`${apiURL}/employees/${id}`, { headers: { Origin: origin }, data });
  const unchanged = await patch(report._id, { employeeNumber: "EMP-999999", jobTitle: "Rejected change" });
  expect(unchanged.status()).toBe(400);
  for (const [id, managerId, code] of [
    [report._id, report._id.toUpperCase(), "SELF_MANAGEMENT"],
    [manager._id, report._id, "REPORTING_CYCLE"],
    [report._id, "000000000000000000000000", "MANAGER_NOT_FOUND"],
  ]) {
    const rejected = await patch(id, { managerId });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error.code).toBe(code);
  }
  for (const response of [
    await patch(manager._id, { employmentStatus: "TERMINATED" }),
    await context.request.delete(`${apiURL}/employees/${manager._id}`, { headers: { Origin: origin } }),
  ]) {
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("MANAGER_HAS_DIRECT_REPORTS");
  }
  const persisted = (await (await context.request.get(`${apiURL}/employees/${report._id}`)).json()).data;
  expect(persisted.employeeNumber).toBe(report.employeeNumber);
  expect(persisted.jobTitle).toBe(report.jobTitle);
  expect(persisted.managerId).toBe(manager._id);
  expect((await patch(report._id, { managerId: null })).status()).toBe(200);
  for (const id of [manager._id, report._id]) {
    expect((await context.request.delete(`${apiURL}/employees/${id}`, { headers: { Origin: origin } })).status()).toBe(204);
  }
  const next = await create(employeeData("regression-next"));
  expect(Number(next.employeeNumber.slice(4))).toBeGreaterThan(Number(report.employeeNumber.slice(4)));
});

test("@regression employee content stays escaped and search stays literal", async ({ page }) => {
  const dialogs = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await login(page, fixtures.accounts.admin);
  await openDirectory(page, "ADMIN");
  const employee = { ...employeeData("regression-escaped"), firstName: '<script>alert("xss")</script>' };
  await addEmployee(page, employee);
  await page.getByLabel("Search", { exact: true }).fill(employee.email);
  await expect(employeeRow(page, employee.email)).toContainText(employee.firstName);
  await expect(page.locator(".directory script")).toHaveCount(0);
  await page.getByLabel("Search", { exact: true }).fill(".*");
  await expect(page.getByRole("heading", { name: "No matching people", exact: true })).toBeVisible();
  expect(dialogs).toEqual([]);
});

test("@regression authenticated writes require a trusted Origin and session cookies stay protected", async ({ page, context }) => {
  await login(page, fixtures.accounts.admin);
  const cookies = (await context.cookies(apiURL)).filter(({ name }) => name.startsWith("ws_"));
  expect(cookies).toHaveLength(2);
  for (const cookie of cookies) {
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    expect(cookie.path).toBe("/api/v1");
  }
  const data = employeeData("regression-csrf");
  for (const headers of [{}, { Origin: "https://attacker.invalid" }]) {
    const rejected = await context.request.post(`${apiURL}/employees`, { headers, data });
    expect(rejected.status()).toBe(403);
    expect((await rejected.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
  }
  const search = await context.request.get(`${apiURL}/employees`, { params: { search: data.email } });
  expect((await search.json()).data).toEqual([]);
  const docs = await context.request.get(`${new URL(apiURL).origin}/docs/`);
  expect(docs.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(docs.headers()["x-content-type-options"]).toBe("nosniff");
});
