import { useCallback, useEffect, useMemo, useState } from "react";
import { createEmployee, deleteEmployee, listEmployees, updateEmployee } from "../../api/employees";
import { errorMessage } from "../../api/client";
import { useAuth } from "../auth/AuthContext";
import EmployeeFilters from "./components/EmployeeFilters";
import EmployeeForm from "./components/EmployeeForm";
import EmployeeTable from "./components/EmployeeTable";
import Pagination from "./components/Pagination";
import { emptyEmployee, employeePayload, employeeToForm } from "./employeeForm";
import useDebouncedValue from "./hooks/useDebouncedValue";

const initialFilters = { search: "", department: "", status: "", sortBy: "createdAt", sortOrder: "desc", page: 1, limit: 20 };

export default function EmployeesPage() {
  const { user } = useAuth();
  const canManage = ["ADMIN", "HR_MANAGER"].includes(user.role);
  const canDelete = user.role === "ADMIN";
  const [employees, setEmployees] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [filters, setFilters] = useState(initialFilters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyEmployee);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const debouncedSearch = useDebouncedValue(filters.search);
  const debouncedDepartment = useDebouncedValue(filters.department);

  const requestParams = useMemo(() => {
    const params = { page: filters.page, limit: filters.limit, sortBy: filters.sortBy, sortOrder: filters.sortOrder };
    if (debouncedSearch.trim()) params.search = debouncedSearch.trim();
    if (debouncedDepartment.trim()) params.department = debouncedDepartment.trim();
    if (filters.status) params.status = filters.status;
    return params;
  }, [debouncedSearch, debouncedDepartment, filters.page, filters.limit, filters.sortBy, filters.sortOrder, filters.status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await listEmployees(requestParams);
      setEmployees(result.data);
      setPagination(result.pagination);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [requestParams]);

  useEffect(() => { load(); }, [load]);

  function beginCreate() { setForm({ ...emptyEmployee }); setEditing("new"); setError(""); }
  function beginEdit(person) { setForm(employeeToForm(person)); setEditing(person._id); setError(""); }
  function cancelEdit() { setEditing(null); setForm({ ...emptyEmployee }); }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = employeePayload(form);
      if (editing === "new") await createEmployee(payload);
      else await updateEmployee(editing, payload);
      cancelEdit();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(person) {
    if (!canDelete || !window.confirm(`Delete the employee record for ${person.firstname} ${person.lastname}? This cannot be undone.`)) return;
    setBusyId(person._id);
    setError("");
    try {
      await deleteEmployee(person._id);
      if (employees.length === 1 && filters.page > 1) setFilters((current) => ({ ...current, page: current.page - 1 }));
      else await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  const hasFilters = Boolean(filters.search || filters.department || filters.status || filters.sortBy !== "createdAt" || filters.sortOrder !== "desc");
  return (
    <main className="page">
      <div className="page-heading">
        <div><span className="section-tag">PEOPLE MAKE THE DIFFERENCE</span><h1>{canManage ? "People directory" : "My employee profile"}</h1><p className="muted">{canManage ? "Search, organize, and maintain your employee directory." : "Your employee record, in one place."}</p></div>
        {canManage && <button className="primary" onClick={beginCreate}>+ Add employee</button>}
      </div>
      {error && <div role="alert" className="notice error"><span>{error}</span><button className="text-link" onClick={load}>Retry</button></div>}
      {editing && <EmployeeForm form={form} setForm={setForm} busy={saving} isNew={editing === "new"} onSubmit={save} onCancel={cancelEdit} />}
      <section className="card directory">
        <div className="directory-heading"><div><h3>{canManage ? "Your people" : "Employee record"} <span className="count">{pagination?.totalItems ?? employees.length}</span></h3><p>{canManage ? "Results come directly from the employee service." : "Only the employee record matching your account email is shown."}</p></div></div>
        {canManage && <EmployeeFilters filters={filters} onChange={setFilters} onClear={() => setFilters(initialFilters)} />}
        {loading ? <p role="status" className="empty-state">Loading employee records…</p> : employees.length === 0 ? <div className="empty-state"><h3>{hasFilters ? "No matching people" : "No employee records yet"}</h3><p>{hasFilters ? "Clear or adjust your filters and try again." : canManage ? "Add your first employee to get started." : "Ask an administrator to add your work email to the directory."}</p></div> : <EmployeeTable employees={employees} canManage={canManage} canDelete={canDelete} busyId={busyId} onEdit={beginEdit} onDelete={remove} />}
        {canManage && <Pagination pagination={pagination} onPage={(page) => setFilters((current) => ({ ...current, page }))} />}
      </section>
    </main>
  );
}
