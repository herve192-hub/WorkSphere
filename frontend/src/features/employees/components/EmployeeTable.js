function initials(person) {
  return `${person.firstname?.[0] || ""}${person.lastname?.[0] || ""}`.toUpperCase();
}
function statusLabel(value) { return (value || "ACTIVE").replaceAll("_", " ").toLowerCase(); }
export default function EmployeeTable({ employees, canManage, canDelete, busyId, onEdit, onDelete }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Name</th><th>Role / department</th><th>Status</th><th>Location</th>{canManage && <th>Actions</th>}</tr></thead>
        <tbody>{employees.map((person) => (
          <tr key={person._id}>
            <td><span className="table-person"><span className="avatar">{initials(person)}</span><span><strong>{person.firstname} {person.lastname}</strong><small>{person.email}</small></span></span></td>
            <td><strong className="cell-primary">{person.jobTitle || "—"}</strong><small>{person.department || "No department"}{person.employeeNumber ? ` · ${person.employeeNumber}` : ""}</small></td>
            <td><span className={`status-badge status-${(person.employmentStatus || "ACTIVE").toLowerCase()}`}>{statusLabel(person.employmentStatus)}</span></td>
            <td>{person.location || "—"}</td>
            {canManage && <td><div className="actions"><button className="text-link" disabled={busyId === person._id} onClick={() => onEdit(person)}>Edit</button>{canDelete && <button className="text-link danger" disabled={busyId === person._id} onClick={() => onDelete(person)}>{busyId === person._id ? "Deleting…" : "Delete"}</button>}</div></td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
