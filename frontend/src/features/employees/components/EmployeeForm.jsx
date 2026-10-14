import { EMPLOYMENT_STATUSES } from "../employeeForm";

const textFields = [
  ["phone", "Phone", 40],
  ["jobTitle", "Job title", 120],
  ["department", "Department", 120],
  ["location", "Location", 160],
];

export default function EmployeeForm({ form, setForm, busy, isNew, onSubmit, onCancel }) {
  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  return (
    <section className="card employee-editor">
      <div className="editor-heading">
        <div>
          <span className="section-tag">EMPLOYEE DETAILS</span>
          <h2>{isNew ? "Add employee" : "Edit employee"}</h2>
        </div>
        <button className="text-link" type="button" onClick={onCancel}>Close</button>
      </div>
      <form onSubmit={onSubmit}>
        <fieldset disabled={busy}>
          <div className="employee-form-grid">
            <label>First name<input required name="firstName" maxLength="80" value={form.firstName} onChange={update} /></label>
            <label>Last name<input required name="lastName" maxLength="80" value={form.lastName} onChange={update} /></label>
            <label>Email address<input required type="email" name="email" maxLength="254" value={form.email} onChange={update} /></label>
            <label>Employee number<input readOnly value={isNew ? "Assigned when saved" : form.employeeNumber || "Pending assignment"} /></label>
            {textFields.map(([name, label, maxLength]) => (
              <label key={name}>{label}<input name={name} maxLength={maxLength} value={form[name]} onChange={update} /></label>
            ))}
            <label>Employment status
              <select name="employmentStatus" value={form.employmentStatus} onChange={update}>
                {EMPLOYMENT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
              </select>
            </label>
            <label>Hire date<input type="date" name="hireDate" value={form.hireDate} onChange={update} /></label>
          </div>
          <div className="actions">
            <button className="primary" type="submit">{busy ? "Saving…" : "Save employee"}</button>
            <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
