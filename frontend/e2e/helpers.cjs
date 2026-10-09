const { randomUUID } = require("node:crypto");
const { expect } = require("@playwright/test");
const fixtures = require("./fixtures.json");

const apiURL = process.env.WORKSPHERE_E2E_API_URL || "http://localhost:5100/api/v1";
const origin = process.env.WORKSPHERE_E2E_BASE_URL || "http://localhost:3100";

function employeeData(prefix) {
  return {
    firstName: "Jamie",
    lastName: "Browser",
    email: `${prefix}-${randomUUID()}@worksphere.test`,
    jobTitle: "Software engineer",
    department: "Engineering",
    location: "Chicago",
    phone: "+1 312 555 0100",
    hireDate: "2026-01-15",
  };
}

async function login(page, account) {
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(fixtures.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function openDirectory(page, role) {
  await page.getByRole("link", { name: role === "EMPLOYEE" ? /My employee profile/ : /People directory/ }).click();
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByRole("heading", { name: role === "EMPLOYEE" ? "My employee profile" : "People directory", exact: true })).toBeVisible();
  await expect(page.getByText("Loading employee records…", { exact: true })).toHaveCount(0);
}

function employeeRow(page, email) {
  return page.getByRole("row").filter({ hasText: email });
}

async function saveEmployee(page, method) {
  const responsePromise = page.waitForResponse((response) =>
    response.url().startsWith(`${apiURL}/employees`) && response.request().method() === method);
  await page.getByRole("button", { name: "Save employee", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(method === "POST" ? 201 : 200);
  await expect(page.getByRole("heading", { name: /^(Add|Edit) employee$/ })).toHaveCount(0);
  return (await response.json()).data;
}

async function addEmployee(page, employee) {
  await page.getByRole("button", { name: /Add employee/ }).click();
  const editor = page.locator(".employee-editor");
  for (const [field, label] of [
    ["firstName", "First name"], ["lastName", "Last name"], ["email", "Email address"],
    ["phone", "Phone"], ["jobTitle", "Job title"], ["department", "Department"],
    ["location", "Location"], ["hireDate", "Hire date"],
  ]) {
    await editor.getByLabel(label, { exact: true }).fill(employee[field]);
  }
  await expect(editor.getByLabel("Employee number")).toHaveAttribute("readonly", "");
  const created = await saveEmployee(page, "POST");
  expect(created.employeeNumber).toMatch(/^EMP-\d{6,}$/);
  await expect(employeeRow(page, employee.email)).toContainText(created.employeeNumber);
  return created;
}

async function logout(page, context) {
  const oldCookies = (await context.cookies(apiURL)).filter(({ name }) => ["ws_access", "ws_refresh"].includes(name));
  expect(oldCookies).toHaveLength(2);
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies(apiURL)).filter(({ name }) => name.startsWith("ws_"))).toHaveLength(0);
  const cookie = oldCookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  // Replay the former session to check server-side revocation as well as UI state.
  expect((await context.request.get(`${apiURL}/employees`, { headers: { Cookie: cookie } })).status()).toBe(401);
  expect((await context.request.post(`${apiURL}/auth/refresh`, { headers: { Origin: origin, Cookie: cookie } })).status()).toBe(401);
  await page.goto("/employees");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
}

module.exports = { fixtures, apiURL, origin, employeeData, login, openDirectory, employeeRow, saveEmployee, addEmployee, logout };
