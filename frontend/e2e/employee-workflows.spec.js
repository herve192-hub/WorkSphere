const { test, expect } = require("@playwright/test");
const {
  fixtures, apiURL, origin, employeeData, login, openDirectory,
  employeeRow, saveEmployee, addEmployee, logout,
} = require("./helpers.cjs");

test("registration → login → own employee profile → logout; employee restrictions", async ({ page, context, request }) => {
  const employee = employeeData("registered");
  // Provision the work record independently: registration creates an EMPLOYEE account.
  const adminLogin = await request.post(`${apiURL}/auth/login`, {
    headers: { Origin: origin }, data: { email: fixtures.accounts.admin.email, password: fixtures.password },
  });
  expect(adminLogin.status()).toBe(200);
  const created = await request.post(`${apiURL}/employees`, { headers: { Origin: origin }, data: employee });
  expect(created.status()).toBe(201);
  const ownRecord = (await created.json()).data;
  const directory = await request.get(`${apiURL}/employees`, { params: { search: fixtures.otherEmployee.email } });
  expect(directory.status()).toBe(200);
  const otherRecord = (await directory.json()).data[0];
  expect(otherRecord.email).toBe(fixtures.otherEmployee.email);

  await page.goto("/register");
  await page.getByLabel("First name", { exact: true }).fill(employee.firstName);
  await page.getByLabel("Last name", { exact: true }).fill(employee.lastName);
  await page.getByLabel("Email address", { exact: true }).fill(employee.email.toUpperCase());
  await page.getByLabel("Password", { exact: true }).fill(fixtures.password);
  await page.getByLabel("Confirm password", { exact: true }).fill(fixtures.password);
  const registered = page.waitForResponse((response) => response.url() === `${apiURL}/auth/register`);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const registrationResponse = await registered;
  expect(registrationResponse.status()).toBe(201);
  expect((await registrationResponse.json()).data.role).toBe("EMPLOYEE");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("status")).toContainText("Account created successfully");
  await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(employee.email);
  expect((await context.request.get(`${apiURL}/employees`)).status()).toBe(401);

  await page.getByLabel("Password", { exact: true }).fill(fixtures.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await openDirectory(page, "EMPLOYEE");
  await expect(employeeRow(page, employee.email)).toContainText(ownRecord.employeeNumber);
  await expect(page.getByRole("row")).toHaveCount(2); // Header and own record only.
  await expect(page.getByText(fixtures.otherEmployee.email, { exact: true })).toHaveCount(0);
  for (const name of [/Add employee/, /^Edit$/, /^Delete$/]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(page.getByLabel("Search", { exact: true })).toHaveCount(0);

  const scoped = await context.request.get(`${apiURL}/employees`);
  expect(scoped.status()).toBe(200);
  expect((await scoped.json()).data.map(({ email }) => email)).toEqual([employee.email]);
  expect((await context.request.get(`${apiURL}/employees/${otherRecord._id}`)).status()).toBe(403);
  expect((await context.request.post(`${apiURL}/employees`, {
    headers: { Origin: origin }, data: employeeData("forbidden"),
  })).status()).toBe(403);
  expect((await context.request.patch(`${apiURL}/employees/${ownRecord._id}`, {
    headers: { Origin: origin }, data: { jobTitle: "Unauthorized change" },
  })).status()).toBe(403);
  expect((await context.request.delete(`${apiURL}/employees/${ownRecord._id}`, {
    headers: { Origin: origin },
  })).status()).toBe(403);
  const unchanged = await context.request.get(`${apiURL}/employees/${ownRecord._id}`);
  expect(unchanged.status()).toBe(200);
  expect((await unchanged.json()).data.jobTitle).toBe(employee.jobTitle);
  await page.reload();
  await expect(employeeRow(page, employee.email)).toBeVisible();
  await logout(page, context);
});

test("administrator creates, searches, updates, and deletes employees, then logs out", async ({ page, context }) => {
  await login(page, fixtures.accounts.admin);
  await openDirectory(page, "ADMIN");
  const employee = employeeData("admin-created");
  const created = await addEmployee(page, employee);
  await page.getByLabel("Search", { exact: true }).fill(employee.email);
  await expect(page.getByRole("row")).toHaveCount(2);
  const row = employeeRow(page, employee.email);
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".employee-editor");
  await expect(editor.getByLabel("Employee number")).toHaveValue(created.employeeNumber);
  await expect(editor.getByLabel("Employee number")).toHaveAttribute("readonly", "");
  await editor.getByLabel("Job title", { exact: true }).fill("Senior software engineer");
  await editor.getByLabel("Department", { exact: true }).fill("Platform");
  await editor.getByLabel("Location", { exact: true }).fill("Austin");
  await editor.getByLabel("Employment status").selectOption("ON_LEAVE");
  const updated = await saveEmployee(page, "PATCH");
  expect(updated.employeeNumber).toBe(created.employeeNumber);
  await expect(row).toContainText("Senior software engineer");
  await expect(row).toContainText("Platform");
  await expect(row).toContainText("on leave");
  await page.reload();
  await expect(row).toContainText("Austin");
  await expect(row).toContainText(created.employeeNumber);

  page.once("dialog", (dialog) => dialog.dismiss());
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toBeVisible();
  const removed = page.waitForResponse((response) => response.url() === `${apiURL}/employees/${created._id}` && response.request().method() === "DELETE");
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await removed).status()).toBe(204);
  await expect(row).toHaveCount(0);
  expect((await context.request.get(`${apiURL}/employees/${created._id}`)).status()).toBe(404);
  await logout(page, context);
});

test("HR manager creates and updates employees but cannot delete them", async ({ page, context }) => {
  await login(page, fixtures.accounts.hr);
  await openDirectory(page, "HR_MANAGER");
  await expect(employeeRow(page, fixtures.otherEmployee.email)).toBeVisible();
  const employee = employeeData("hr-created");
  const created = await addEmployee(page, employee);
  const row = employeeRow(page, employee.email);
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".employee-editor").getByLabel("Job title", { exact: true }).fill("HR business partner");
  await saveEmployee(page, "PATCH");
  await page.reload();
  await expect(row).toContainText("HR business partner");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  expect((await context.request.delete(`${apiURL}/employees/${created._id}`, {
    headers: { Origin: origin },
  })).status()).toBe(403);
  const preserved = await context.request.get(`${apiURL}/employees/${created._id}`);
  expect(preserved.status()).toBe(200);
  expect((await preserved.json()).data.jobTitle).toBe("HR business partner");
  await logout(page, context);
});
