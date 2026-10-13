import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { listAuditEvents } from "../../api/audit";
import { errorMessage } from "../../api/client";
import Pagination from "../employees/components/Pagination";
import useDebouncedValue from "../employees/hooks/useDebouncedValue";

const initialFilters = { search: "", action: "", resourceType: "", from: "", to: "", page: 1 };
const actionLabels = {
  EMPLOYEE_CREATED: "Employee created", EMPLOYEE_UPDATED: "Employee updated", EMPLOYEE_DELETED: "Employee deleted",
  AUTH_REGISTERED: "Account registered", AUTH_LOGIN: "Signed in", AUTH_LOGIN_FAILED: "Sign-in failed",
  AUTH_REFRESHED: "Session renewed", AUTH_LOGOUT: "Signed out",
};
const fieldLabels = {
  firstName: "First name", lastName: "Last name", email: "Email", employeeNumber: "Employee number",
  phone: "Phone", jobTitle: "Job title", department: "Department", employmentStatus: "Employment status",
  hireDate: "Hire date", managerId: "Manager", location: "Location", avatarUrl: "Avatar URL",
};
const displayValue = (value) => value == null || value === "" ? "—" : String(value);

function AuditHistory() {
  const [filters, setFilters] = useState(initialFilters);
  const [result, setResult] = useState({ data: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const search = useDebouncedValue(filters.search);
  const params = useMemo(() => {
    const query = { page: filters.page, limit: 20 };
    if (search.trim()) query.search = search.trim();
    for (const key of ["action", "resourceType", "from", "to"]) if (filters[key]) query[key] = filters[key];
    return query;
  }, [search, filters.action, filters.resourceType, filters.from, filters.to, filters.page]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listAuditEvents(params)
      .then((history) => { if (active) setResult(history); })
      .catch((failure) => { if (active) setError(errorMessage(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [params, revision]);
  const change = (event) => setFilters((current) => ({ ...current, [event.target.name]: event.target.value, page: 1 }));
  return (
    <main className="page">
      <div className="page-heading">
        <div><span className="section-tag">WORKSPACE ACTIVITY</span><h1>Audit history</h1><p className="muted">Employee changes and account activity, with who acted and what changed.</p></div>
        <button className="secondary" onClick={() => setRevision((value) => value + 1)} disabled={loading}>Refresh history</button>
      </div>
      <section className="card directory">
        <div className="directory-heading"><div><h3>Recorded activity <span className="count">{result.pagination?.totalItems ?? 0}</span></h3><p>History is read-only. Times and date filters use UTC.</p></div></div>
        <div className="employee-filters">
          <label className="search-label">Search history<input type="search" name="search" placeholder="Name, email, or employee number" maxLength={254} value={filters.search} onChange={change} /></label>
          <label>Action<select name="action" value={filters.action} onChange={change}><option value="">All actions</option>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Resource<select name="resourceType" value={filters.resourceType} onChange={change}><option value="">All resources</option><option value="EMPLOYEE">Employees</option><option value="ACCOUNT">Accounts</option></select></label>
          <label>From<input type="date" name="from" value={filters.from} onChange={change} /></label>
          <label>Through<input type="date" name="to" min={filters.from || undefined} value={filters.to} onChange={change} /></label>
          <button className="text-link" onClick={() => setFilters(initialFilters)}>Clear filters</button>
        </div>
        {error ? <div className="notice error" role="alert"><span>{error}</span> <button className="text-link" onClick={() => setRevision((value) => value + 1)}>Retry</button></div>
          : loading ? <p role="status" className="empty-state">Loading audit history…</p>
            : result.data.length === 0 ? <div className="empty-state"><h3>No matching activity</h3><p>Adjust your filters or refresh after an employee or account change.</p></div>
              : <div className="table-scroll"><table>
                <thead><tr><th>When (UTC)</th><th>Action</th><th>Actor</th><th>Resource</th><th>Changes</th></tr></thead>
                <tbody>{result.data.map((event) => <tr key={event._id}>
                  <td><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString(undefined, { timeZone: "UTC" })}</time></td>
                  <td>{actionLabels[event.action] || event.action}</td>
                  <td>{event.actor ? <><strong>{event.actor.firstName} {event.actor.lastName}</strong><small>{event.actor.email}</small></> : "Unverified sign-in"}</td>
                  <td><strong>{event.resource.label || "Unknown account"}</strong><small>{event.resource.type === "EMPLOYEE" ? "Employee" : "Account"}</small></td>
                  <td>{event.changes.length ? <details className="audit-details"><summary>View changes ({event.changes.length})</summary><ul>{event.changes.map((entry) => <li key={entry.field}><strong>{fieldLabels[entry.field] || entry.field}</strong>: {displayValue(entry.before)} → {displayValue(entry.after)}</li>)}</ul></details> : "No field changes"}</td>
                </tr>)}</tbody>
              </table></div>}
        {!error && !loading && <Pagination pagination={result.pagination} itemLabel="events" onPage={(page) => setFilters((current) => ({ ...current, page }))} />}
      </section>
    </main>
  );
}

export default function AuditPage() {
  const { user } = useAuth();
  return ["ADMIN", "HR_MANAGER"].includes(user.role) ? <AuditHistory /> : <Navigate to="/dashboard" replace />;
}
