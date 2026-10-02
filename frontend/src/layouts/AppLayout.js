import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import { errorMessage } from "../api/client";

/**
 * Main application shell for authenticated users.
 *
 * Renders the workspace sidebar navigation, the current user's identity,
 * and an outlet for page-specific content. It also handles sign-out state
 * and surfaces any auth-related errors to the user.
 */
export default function AppLayout() {
  const { user, signOut } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await signOut();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <NavLink to="/dashboard" className="brand">
          <span className="brand-mark">w.</span> WorkSphere
        </NavLink>
        <span className="nav-caption">WORKSPACE</span>
        <nav>
          <NavLink to="/dashboard">
            ◫ <span>Overview</span>
          </NavLink>
          <NavLink to="/employees">
            ♧{" "}
            <span>
              {user.role === "EMPLOYEE"
                ? "My employee profile"
                : "People directory"}
            </span>
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="user-summary">
            <span className="avatar">
              {user.firstName[0]}
              {user.lastName[0]}
            </span>
            <div>
              <strong>
                {user.firstName} {user.lastName}
              </strong>
              <small>{user.role.replace("_", " ").toLowerCase()}</small>
            </div>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="secondary" onClick={logout} disabled={busy}>
            {busy ? "Signing out…" : "Sign out ↗"}
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <span>
            Your workspace / <strong>WorkSphere</strong>
          </span>
          <span className="status-dot">Connected</span>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
