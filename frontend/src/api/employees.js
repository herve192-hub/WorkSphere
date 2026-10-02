import api from "./client";
import { normalizeNames } from "./names";

export async function listEmployees(params = {}) {
  const response = await api.get("/employees", { params });
  return { ...response.data, data: response.data.data.map(normalizeNames) };
}

export async function createEmployee(payload) {
  const response = await api.post("/employees", payload);
  return normalizeNames(response.data.data);
}

export async function updateEmployee(id, payload) {
  const response = await api.patch(`/employees/${id}`, payload);
  return normalizeNames(response.data.data);
}

export async function deleteEmployee(id) {
  await api.delete(`/employees/${id}`);
}
