import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AuditPage from "./AuditPage";
import { useAuth } from "../auth/AuthContext";
import { listAuditEvents } from "../../api/audit";

jest.mock("../auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../../api/audit", () => ({ listAuditEvents: jest.fn() }));
const event = {
  _id: "audit-1", action: "EMPLOYEE_UPDATED", occurredAt: "2026-10-09T12:00:00.000Z",
  actor: { firstName: "Alex", lastName: "Admin", email: "admin@example.com", role: "ADMIN" },
  resource: { type: "EMPLOYEE", label: "EMP-000001" },
  changes: [{ field: "jobTitle", before: "Engineer", after: "Senior engineer" }],
};
const history = { data: [event], pagination: { page: 1, limit: 20, totalItems: 21, totalPages: 2 } };
beforeEach(() => {
  jest.clearAllMocks();
  useAuth.mockReturnValue({ user: { role: "HR_MANAGER" } });
  listAuditEvents.mockResolvedValue(history);
});
const show = () => render(<MemoryRouter initialEntries={["/audit"]}><Routes><Route path="/audit" element={<AuditPage />} /><Route path="/dashboard" element={<h1>Overview</h1>} /></Routes></MemoryRouter>);

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
