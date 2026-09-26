import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { AuthProvider, useAuth } from "./features/auth/AuthContext";
import AuthPage from "./features/auth/AuthPage";
import DashboardPage from "./features/dashboard/DashboardPage";
import EmployeesPage from "./features/employees/EmployeesPage";
import AppLayout from "./layouts/AppLayout";
import "./styles/global.css";

// App entrypoint that configures routing and auth state for the workspace.

/**
 * Protects routes by redirecting unauthenticated users to the login page.
 * The original location is stored so the user can be sent back after login.
 */
function ProtectedRoute() {
  const { user } = useAuth();
  const location = useLocation();
  return user ? (
    <Outlet />
  ) : (
    <Navigate to="/login" state={{ from: location.pathname }} replace />
  );
}

/**
 * Resolves the auth state and renders the application routes.
 * It shows a loading state while the auth context is initializing, and
 * a recovery message when the workspace cannot be reached.
 */
function AppRoutes() {
  const { loading, unavailable } = useAuth();
  if (loading)
    return (
      <main className="loading-screen" role="status">
        <span className="brand-mark">w.</span>Opening your workspace…
      </main>
    );
  if (unavailable)
    return (
      <main className="loading-screen">
        <h1>We couldn’t reach your workspace.</h1>
        <p>Please check your connection and try again.</p>
        <button className="primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  return (
    <Routes>
      <Route path="/login" element={<AuthPage key="login" mode="login" />} />
      <Route
        path="/register"
        element={<AuthPage key="register" mode="register" />}
      />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/employees" element={<EmployeesPage />} />
        </Route>
      </Route>
      <Route path="/inventory" element={<Navigate to="/employees" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

/**
 * Root app component that mounts the router and authentication context.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
