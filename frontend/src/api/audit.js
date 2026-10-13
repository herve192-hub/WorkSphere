import api from "./client";

export async function listAuditEvents(params = {}) {
  const response = await api.get("/audit", { params });
  return response.data;
}
