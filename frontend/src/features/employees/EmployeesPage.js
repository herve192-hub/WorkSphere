import { useCallback, useEffect, useState } from "react";
import api, { errorMessage } from "../../api/client";
import { useAuth } from "../auth/AuthContext";

/**
 * Displays the employee directory and supports CRUD actions for admins and HR managers.
 * Non-manager users see only their own profile and cannot edit the directory.
 */
const empty = { firstname: "", lastname: "", email: "" };

/**
 * Renders the employee directory, search, and inline add/edit forms.
 *
 * @returns {JSX.Element} The page for managing employees or viewing a personal profile.
 */
export default function EmployeesPage() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const manage = ["ADMIN", "HR_MANAGER"].includes(user.role);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/employees");
      setEmployees(response.data.data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (editing === "new") await api.post("/employees", form);
      else await api.patch(`/employees/${editing}`, form);
      setEditing(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(person) {
    if (
      !window.confirm(
        `Delete the employee record for ${person.firstname} ${person.lastname}?`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.delete(`/employees/${person._id}`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const shown = employees.filter((p) =>
    `${p.firstname} ${p.lastname} ${p.email}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="section-tag">PEOPLE MAKE THE DIFFERENCE</span>
          <h1>{manage ? "People directory" : "My employee profile"}</h1>
          <p className="muted">
            {manage
              ? "A connected team starts here."
              : "Your details, in one place."}
          </p>
        </div>
        {manage && (
          <button
            className="primary"
            onClick={() => {
              setForm(empty);
              setEditing("new");
            }}
          >
            + Add employee
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="notice error">
          {error}{" "}
          <button className="text-link" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {editing && (
        <section className="card employee-editor">
          <h2>{editing === "new" ? "Add employee" : "Edit employee"}</h2>
          <form onSubmit={save}>
            <fieldset disabled={busy}>
              <div className="form-row">
                {["firstname", "lastname", "email"].map((name) => (
                  <label key={name}>
                    {name === "firstname"
                      ? "First name"
                      : name === "lastname"
                        ? "Last name"
                        : "Email address"}
                    <input
                      required
                      name={name}
                      type={name === "email" ? "email" : "text"}
                      maxLength={name === "email" ? 254 : 80}
                      value={form[name]}
                      onChange={(e) =>
                        setForm({ ...form, [name]: e.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="actions">
                <button className="primary" type="submit">
                  {busy ? "Saving…" : "Save employee"}
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="card directory">
        <div className="directory-toolbar">
          <h3>
            {manage ? "Your people" : "Employee record"}{" "}
            <span className="count">{employees.length}</span>
          </h3>
          <label className="search-label">
            <span className="sr-only">Search employees</span>
            <input
              type="search"
              placeholder="Search by name or email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {loading ? (
          <p role="status" className="empty-state">
            Loading your people…
          </p>
        ) : !shown.length ? (
          <div className="empty-state">
            <h3>{query ? "No matching people" : "No employee records yet"}</h3>
            <p>
              {query
                ? "Try another name or email address."
                : manage
                  ? "Add your first employee to get started."
                  : "Ask your administrator to add your work email to the directory."}
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email address</th>
                  {manage && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((person) => (
                  <tr key={person._id}>
                    <td>
                      <span className="table-person">
                        <span className="avatar">
                          {person.firstname[0]}
                          {person.lastname[0]}
                        </span>
                        {person.firstname} {person.lastname}
                      </span>
                    </td>
                    <td>{person.email}</td>
                    {manage && (
                      <td>
                        <div className="actions">
                          <button
                            className="text-link"
                            disabled={busy}
                            onClick={() => {
                              setEditing(person._id);
                              setForm({
                                firstname: person.firstname,
                                lastname: person.lastname,
                                email: person.email,
                              });
                            }}
                          >
                            Edit
                          </button>
                          {user.role === "ADMIN" && (
                            <button
                              className="text-link danger"
                              disabled={busy}
                              onClick={() => remove(person)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
