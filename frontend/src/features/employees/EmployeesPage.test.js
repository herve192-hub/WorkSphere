import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import EmployeesPage from "./EmployeesPage";
import { useAuth } from "../auth/AuthContext";
import { createEmployee, deleteEmployee, listEmployees, updateEmployee } from "../../api/employees";

jest.mock("../auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../../api/employees", () => ({ listEmployees: jest.fn(), createEmployee: jest.fn(), updateEmployee: jest.fn(), deleteEmployee: jest.fn() }));

const employee = { _id: "e1", firstname: "Jamie", lastname: "Morgan", email: "jamie@example.com", employeeNumber: "WS-100", jobTitle: "Engineer", department: "Engineering", employmentStatus: "ACTIVE", location: "Chicago" };

beforeEach(() => {
  jest.clearAllMocks();
  listEmployees.mockResolvedValue({ data: [employee], pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1 } });
  createEmployee.mockResolvedValue(employee);
  updateEmployee.mockResolvedValue(employee);
  deleteEmployee.mockResolvedValue(undefined);
});

test("admin sees the directory and admin-only delete action", async () => {
  useAuth.mockReturnValue({ user: { role: "ADMIN", email: "admin@example.com" } });
  render(<EmployeesPage />);
  expect(await screen.findByText("Jamie Morgan")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  expect(listEmployees).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 20 }));
});

test("HR manager can edit but does not see delete", async () => {
  useAuth.mockReturnValue({ user: { role: "HR_MANAGER", email: "hr@example.com" } });
  render(<EmployeesPage />);
  await screen.findByText("Jamie Morgan");
  expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
});

test("employee sees a read-only profile without directory controls", async () => {
  useAuth.mockReturnValue({ user: { role: "EMPLOYEE", email: "jamie@example.com" } });
  render(<EmployeesPage />);
  expect(await screen.findByRole("heading", { name: "My employee profile" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /add employee/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();
});

test("search is sent to the server after debounce", async () => {
  useAuth.mockReturnValue({ user: { role: "ADMIN", email: "admin@example.com" } });
  render(<EmployeesPage />);
  await screen.findByText("Jamie Morgan");
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Jamie" } });
  await waitFor(() => expect(listEmployees).toHaveBeenCalledWith(expect.objectContaining({ search: "Jamie", page: 1 })), { timeout: 1200 });
});

test("add employee submits the richer employee payload", async () => {
  useAuth.mockReturnValue({ user: { role: "HR_MANAGER", email: "hr@example.com" } });
  render(<EmployeesPage />);
  await screen.findByText("Jamie Morgan");
  fireEvent.click(screen.getByRole("button", { name: /add employee/i }));
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Taylor" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Reed" } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "taylor@example.com" } });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Designer" } });
  fireEvent.change(screen.getByLabelText("Department"), { target: { value: "Product" } });
  fireEvent.click(screen.getByRole("button", { name: "Save employee" }));
  await waitFor(() => expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({ firstname: "Taylor", lastname: "Reed", email: "taylor@example.com", jobTitle: "Designer", department: "Product", employmentStatus: "ACTIVE" })));
});
