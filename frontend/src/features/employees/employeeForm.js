export const EMPLOYMENT_STATUSES = [
  { value: "ACTIVE", label: "Active" },
  { value: "ON_LEAVE", label: "On leave" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "TERMINATED", label: "Terminated" },
];

export const emptyEmployee = {
  firstName: "",
  lastName: "",
  email: "",
  employeeNumber: "",
  phone: "",
  jobTitle: "",
  department: "",
  employmentStatus: "ACTIVE",
  hireDate: "",
  location: "",
};

export function employeeToForm(employee) {
  return {
    ...emptyEmployee,
    ...Object.fromEntries(
      Object.keys(emptyEmployee).map((key) => [key, employee?.[key] ?? emptyEmployee[key]]),
    ),
    hireDate: employee?.hireDate ? String(employee.hireDate).slice(0, 10) : "",
  };
}

export function employeePayload(form) {
  const payload = {};
  for (const [key, value] of Object.entries(form)) {
    if (key === "employeeNumber") continue;
    if (["firstName", "lastName", "email", "employmentStatus"].includes(key) || value !== "") {
      payload[key] = typeof value === "string" ? value.trim() : value;
    }
  }
  return payload;
}
