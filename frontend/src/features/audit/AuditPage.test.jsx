import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AuditPage from "./AuditPage";
import { useAuth } from "../auth/AuthContext";
import { listAuditEvents } from "../../api/audit";

vi.mock("../auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../api/audit", () => ({ listAuditEvents: vi.fn() }));
const event = {
  _id: "audit-1", action: "EMPLOYEE_UPDATED", occurredAt: "2026-10-09T12:00:00.000Z",
  actor: { firstName: "Alex", lastName: "Admin", email: "admin@example.com", role: "ADMIN" },
  resource: { type: "EMPLOYEE", label: "EMP-000001" },
  changes: [{ field: "jobTitle", before: "Engineer", after: "Senior engineer" }],
};
const history = { data: [event], pagination: { page: 1, limit: 20, totalItems: 21, totalPages: 2 } };
beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { role: "HR_MANAGER" } });
  listAuditEvents.mockResolvedValue(history);
});
const show = () => render(<MemoryRouter initialEntries={["/audit"]}><Routes><Route path="/audit" element={<AuditPage />} /><Route path="/dashboard" element={<h1>Overview</h1>} /></Routes></MemoryRouter>);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test("managers see actors, resources, and readable before/after history without write controls", async () => {
  show();
  expect(await screen.findByRole("cell", { name: "Employee updated", exact: true })).toBeInTheDocument();
  expect(screen.getByText("Alex Admin")).toBeInTheDocument();
  expect(screen.getByText("EMP-000001")).toBeInTheDocument();
  fireEvent.click(screen.getByText("View changes (1)"));
  expect(screen.getByText("Job title").closest("li")).toHaveTextContent("Engineer → Senior engineer");
  expect(screen.queryByRole("button", { name: /delete|edit/i })).not.toBeInTheDocument();
});
test("pagination and filters reach the API and changing a filter resets the page", async () => {
  show();
  await screen.findByRole("cell", { name: "Employee updated", exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(listAuditEvents).toHaveBeenLastCalledWith({ page: 2, limit: 20 }));
  fireEvent.change(screen.getByLabelText("Action"), { target: { value: "EMPLOYEE_UPDATED" } });
  fireEvent.change(screen.getByLabelText("Resource"), { target: { value: "EMPLOYEE" } });
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-09" } });
  fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "EMP-000001" } });
  await waitFor(() => expect(listAuditEvents).toHaveBeenLastCalledWith({ page: 1, limit: 20, action: "EMPLOYEE_UPDATED", resourceType: "EMPLOYEE", from: "2026-10-01", to: "2026-10-09", search: "EMP-000001" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(listAuditEvents).toHaveBeenLastCalledWith({ page: 1, limit: 20 }));
});
test("failed history reads show an error and can be retried", async () => {
  listAuditEvents.mockRejectedValueOnce({ response: { data: { error: { message: "History unavailable" } } } });
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("cell", { name: "Employee updated", exact: true })).toBeInTheDocument();
});
test("employees are redirected without requesting audit data", async () => {
  useAuth.mockReturnValue({ user: { role: "EMPLOYEE" } });
  show();
  expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  expect(listAuditEvents).not.toHaveBeenCalled();
});

test("background refresh reveals delayed history and preserves expanded rows", async () => {
  vi.useFakeTimers();
  listAuditEvents.mockResolvedValueOnce({ data: [], pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0 } });
  await act(async () => { show(); });
  expect(screen.getByRole("heading", { name: "No matching activity" })).toBeInTheDocument();
  expect(screen.getByText(/Recent changes may take a few seconds/)).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("cell", { name: "Employee updated", exact: true })).toBeInTheDocument();
  fireEvent.click(screen.getByText("View changes (1)"));
  const details = screen.getByText("View changes (1)").closest("details");
  expect(details.open).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(details.open).toBe(true);
  expect(screen.queryByText("Loading audit history…")).not.toBeInTheDocument();
});

test("background read failures retain history and recover on the next refresh", async () => {
  vi.useFakeTimers();
  await act(async () => { show(); });
  listAuditEvents.mockRejectedValueOnce({ response: { data: { error: { message: "Temporarily unavailable" } } } });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("alert")).toHaveTextContent("Temporarily unavailable");
  expect(screen.getByRole("cell", { name: "Employee updated", exact: true })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a failed new filter does not display results from the preceding query", async () => {
  show();
  await screen.findByRole("cell", { name: "Employee updated", exact: true });
  listAuditEvents.mockRejectedValueOnce({ response: { data: { error: { message: "Filter unavailable" } } } });
  fireEvent.change(screen.getByLabelText("Action"), { target: { value: "EMPLOYEE_DELETED" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Filter unavailable");
  expect(screen.queryByRole("cell", { name: "Employee updated", exact: true })).not.toBeInTheDocument();
});

test("hidden tabs pause refresh and unmount clears polling without overlapping requests", async () => {
  vi.useFakeTimers();
  let finish;
  listAuditEvents.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let view;
  await act(async () => { view = show(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(listAuditEvents).toHaveBeenCalledTimes(1);
  await act(async () => { finish(history); });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(listAuditEvents).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(listAuditEvents).toHaveBeenCalledTimes(1);
});
