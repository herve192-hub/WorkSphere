import { EMPLOYMENT_STATUSES } from "../employeeForm";

export default function EmployeeFilters({ filters, onChange, onClear }) {
  const update = (event) => onChange({ ...filters, [event.target.name]: event.target.value, page: 1 });
  return (
    <div className="employee-filters">
      <label className="search-label"><span>Search</span><input name="search" type="search" placeholder="Name, email, title, number…" value={filters.search} onChange={update} /></label>
      <label><span>Department</span><input name="department" placeholder="All departments" maxLength="120" value={filters.department} onChange={update} /></label>
      <label><span>Status</span><select name="status" value={filters.status} onChange={update}><option value="">All statuses</option>{EMPLOYMENT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
      <label><span>Sort by</span><select name="sortBy" value={filters.sortBy} onChange={update}><option value="createdAt">Recently added</option><option value="lastName">Last name</option><option value="firstName">First name</option><option value="department">Department</option><option value="jobTitle">Job title</option><option value="hireDate">Hire date</option></select></label>
      <label><span>Order</span><select name="sortOrder" value={filters.sortOrder} onChange={update}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>
      <button className="secondary filter-clear" type="button" onClick={onClear}>Clear</button>
    </div>
  );
}
