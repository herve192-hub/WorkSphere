import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import EmployeesPage from "./EmployeesPage";
import { useAuth } from "../auth/AuthContext";
import { createEmployee, deleteEmployee, listEmployees, updateEmployee } from "../../api/employees";

jest.mock("../auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../../api/employees", () => ({ listEmployees: jest.fn(), createEmployee: jest.fn(), updateEmployee: jest.fn(), deleteEmployee: jest.fn() }));

const employee = { _id: "e1", firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", employeeNumber: "WS-100", jobTitle: "Engineer", department: "Engineering", employmentStatus: "ACTIVE", location: "Chicago" };

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
  expect(screen.getByLabelText("Employee number")).toHaveValue("Assigned when saved");
  expect(screen.getByLabelText("Employee number")).toHaveAttribute("readonly");
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Taylor" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Reed" } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "taylor@example.com" } });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Designer" } });
  const form = screen.getByLabelText("First name").closest("form");
  fireEvent.change(within(form).getByLabelText("Department"), { target: { value: "Product" } });
  fireEvent.click(screen.getByRole("button", { name: "Save employee" }));
  await waitFor(() => expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({ firstName: "Taylor", lastName: "Reed", email: "taylor@example.com", jobTitle: "Designer", department: "Product", employmentStatus: "ACTIVE" })));
  expect(createEmployee.mock.calls[0][0]).not.toHaveProperty("firstname");
  expect(createEmployee.mock.calls[0][0]).not.toHaveProperty("lastname");
  expect(createEmployee.mock.calls[0][0]).not.toHaveProperty("employeeNumber");
});

test("editing retains canonical names and submits name changes", async () => {
  useAuth.mockReturnValue({ user: { role: "ADMIN", email: "admin@example.com" } });
  render(<EmployeesPage />);
  await screen.findByText("Jamie Morgan");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("First name")).toHaveValue("Jamie");
  expect(screen.getByLabelText("Last name")).toHaveValue("Morgan");
  expect(screen.getByLabelText("Employee number")).toHaveValue("WS-100");
  expect(screen.getByLabelText("Employee number")).toHaveAttribute("readonly");
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: " Updated " } });
  fireEvent.click(screen.getByRole("button", { name: "Save employee" }));
  await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("e1", expect.objectContaining({ firstName: "Updated", lastName: "Morgan" })));
  expect(updateEmployee.mock.calls[0][1]).not.toHaveProperty("firstname");
  expect(updateEmployee.mock.calls[0][1]).not.toHaveProperty("lastname");
  expect(updateEmployee.mock.calls[0][1]).not.toHaveProperty("employeeNumber");
});

test("name sorting sends canonical field names and resets pagination", async () => {
  useAuth.mockReturnValue({ user: { role: "ADMIN", email: "admin@example.com" } });
  render(<EmployeesPage />);
  await screen.findByText("Jamie Morgan");
  for (const field of ["lastName", "firstName"]) {
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: field } });
    await waitFor(() => expect(listEmployees).toHaveBeenCalledWith(expect.objectContaining({ sortBy: field, page: 1 })));
  }
});

test("delete confirmation displays canonical names", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    useAuth.mockReturnValue({ user: { role: "ADMIN", email: "admin@example.com" } });
    render(<EmployeesPage />);
    await screen.findByText("Jamie Morgan");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete the employee record for Jamie Morgan? This cannot be undone.");
    await waitFor(() => expect(deleteEmployee).toHaveBeenCalledWith("e1"));
  } finally {
    confirm.mockRestore();
  }
});
