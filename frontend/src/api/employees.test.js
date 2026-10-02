import api from "./client";
import { listEmployees, createEmployee, updateEmployee } from "./employees";
import { normalizeNames } from "./names";

jest.mock("./client", () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn() }));

beforeEach(() => { jest.resetAllMocks(); });

test("employee responses normalize legacy, canonical, and mixed records", async () => {
  const pagination = { page: 1, limit: 20, totalItems: 3, totalPages: 1 };
  const records = [
    { _id: "legacy", firstname: "Jamie", lastname: "Morgan" },
    { _id: "modern", firstName: "Taylor", lastName: "Reed" },
    { _id: "mixed", firstName: "Canonical", firstname: "Stale", lastname: "Person" },
  ];
  api.get.mockResolvedValue({ data: { data: records, pagination } });
  await expect(listEmployees({ sortBy: "lastName" })).resolves.toEqual({
    data: [
      { _id: "legacy", firstName: "Jamie", lastName: "Morgan" },
      { _id: "modern", firstName: "Taylor", lastName: "Reed" },
      { _id: "mixed", firstName: "Canonical", lastName: "Person" },
    ], pagination,
  });
  expect(api.get).toHaveBeenCalledWith("/employees", { params: { sortBy: "lastName" } });
});

test("employee mutations send canonical payloads and normalize returned records", async () => {
  const payload = { firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com" };
  const legacy = { _id: "e1", firstname: "Jamie", lastname: "Morgan", email: payload.email };
  api.post.mockResolvedValue({ data: { data: legacy } });
  api.patch.mockResolvedValue({ data: { data: legacy } });
  await expect(createEmployee(payload)).resolves.toEqual({ ...payload, _id: "e1" });
  await expect(updateEmployee("e1", payload)).resolves.toEqual({ ...payload, _id: "e1" });
  expect(api.post).toHaveBeenCalledWith("/employees", payload);
  expect(api.patch).toHaveBeenCalledWith("/employees/e1", payload);
});

test("null responses and nullable canonical names retain the fallback behavior", () => {
  expect(normalizeNames(null)).toBeNull();
  expect(normalizeNames({ firstName: null, firstname: "Jamie", lastName: null, lastname: "Morgan" }))
    .toEqual({ firstName: "Jamie", lastName: "Morgan" });
});
