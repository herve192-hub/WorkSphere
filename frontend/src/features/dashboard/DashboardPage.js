import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

/**
 * Displays a personalized overview for the authenticated user.
 *
 * The page introduces the workspace, surfaces the current date, and
 * summarizes the signed-in account details and navigation options.
 */
export default function DashboardPage() {
  const { user } = useAuth();
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="section-tag">YOUR WORKSPACE AT A GLANCE</span>
          <h1>
            Hello, {user.firstname} <span className="greeting">✦</span>
          </h1>
          <p className="muted">A fresh perspective on your working day.</p>
        </div>
        <span className="date-label">
          {new Date().toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      </div>
      <section className="welcome-banner">
        <div>
          <span className="eyebrow">ROOM TO DO YOUR BEST WORK</span>
          <h2>
            People first.
            <br />
            Possibilities everywhere.
          </h2>
          <p>You’re in. Your team’s next chapter starts with you.</p>
          <Link className="light-button" to="/employees">
            {user.role === "EMPLOYEE"
              ? "View my employee profile"
              : "Explore your people directory"}{" "}
            <span>→</span>
          </Link>
        </div>
        <div className="banner-art" aria-hidden="true">
          ✳
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="card">
          <span className="section-tag">MY ACCOUNT</span>
          <div className="profile-heading">
            <span className="avatar large">
              {user.firstname[0]}
              {user.lastname[0]}
            </span>
            <div>
              <h3>
                {user.firstname} {user.lastname}
              </h3>
              <p className="muted">{user.email}</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Workspace role</dt>
              <dd>{user.role.replace("_", " ")}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>
                <span className="pill">Signed in securely</span>
              </dd>
            </div>
          </dl>
        </section>
        <section className="card">
          <span className="section-tag">GET STARTED</span>
          <h3>A space for your team.</h3>
          <p className="muted">
            {user.role === "EMPLOYEE"
              ? "Your employee profile appears once an administrator adds your work email to the directory."
              : "Keep your employee directory up to date. Add people, review profiles, and manage contact information."}
          </p>
          <Link className="text-link" to="/employees">
            Open {user.role === "EMPLOYEE" ? "my profile" : "directory"} →
          </Link>
        </section>
      </div>
    </main>
  );
}
