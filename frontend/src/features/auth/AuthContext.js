import { createContext, useContext, useEffect, useState } from "react";
import { authApi, restoreSession } from "../../api/client";

/**
 * Shared authentication state for the app.
 *
 * Provides the current user, a loading flag while the session is restored,
 * and an unavailable flag when the auth service cannot be reached.
 */
const AuthContext = createContext(null);

/**
 * Initializes and exposes auth state to the application.
 *
 * It restores any saved session on mount, listens for explicit session-expired
 * events, and exposes helper methods for registration, sign-in, and sign-out.
 *
 * @param {{ children: React.ReactNode }} props
 * @returns {JSX.Element}
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    restoreSession()
      .then((user) => {
        if (active) setUser(user);
      })
      .catch((error) => {
        if (active && error.response?.status !== 401) setUnavailable(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const expired = () => setUser(null);
    window.addEventListener("session-expired", expired);

    return () => {
      active = false;
      window.removeEventListener("session-expired", expired);
    };
  }, []);

  /**
   * Creates a new account for a user.
   *
   * @param {Object} values - Registration payload.
   */
  async function registerAccount(values) {
    await authApi.post("/auth/register", values);
  }

  /**
   * Signs in a user and stores the returned account data in context.
   *
   * @param {Object} values - Login payload.
   */
  async function signIn(values) {
    const { data } = await authApi.post("/auth/login", values);
    setUser(data.data);
  }

  /**
   * Ends the current session and clears the active user from context.
   */
  async function signOut() {
    await authApi.post("/auth/logout");
    setUser(null);
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, unavailable, registerAccount, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Access the authentication context from any component.
 *
 * @returns {{
 *   user: Object | null,
 *   loading: boolean,
 *   unavailable: boolean,
 *   registerAccount: (values: Object) => Promise<void>,
 *   signIn: (values: Object) => Promise<void>,
 *   signOut: () => Promise<void>
 * } | null}
 */
export const useAuth = () => useContext(AuthContext);
