import axios from "axios";

/**
 * Shared API client for authenticated requests.
 * Uses the configured backend base URL and sends cookies with every request.
 */
const baseURL = process.env.REACT_APP_API_URL || "http://localhost:5000/api/v1";
const api = axios.create({ baseURL, withCredentials: true });
let refreshPromise;

/**
 * Separate client used for refresh-token requests so we can isolate session renewal.
 */
export const authApi = axios.create({ baseURL, withCredentials: true });

/**
 * Attempts to restore a valid session by refreshing the access token.
 * Reuses a single in-flight refresh request across concurrent callers.
 *
 * @returns {Promise<any>} Resolves with the refresh response payload.
 */
export function restoreSession() {
  if (!refreshPromise)
    refreshPromise = authApi
      .post("/auth/refresh")
      .then((r) => r.data.data)
      .finally(() => {
        refreshPromise = null;
      });
  return refreshPromise;
}

/**
 * Retry a request once after a 401 response by refreshing the session.
 * If the refresh fails with another 401, the app dispatches a session-expired event.
 */
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (error.response?.status === 401 && !config._retry) {
      config._retry = true;
      try {
        await restoreSession();
      } catch (refreshError) {
        if (refreshError.response?.status === 401)
          window.dispatchEvent(new Event("session-expired"));
        return Promise.reject(refreshError);
      }
      return api(config);
    }
    return Promise.reject(error);
  },
);

/**
 * Extracts a user-friendly API error message from a backend error response.
 *
 * @param {Error} error Axios or backend error.
 * @returns {string} Human-readable error message.
 */
export const errorMessage = (error) =>
  error.response?.data?.error?.message ||
  "Unable to reach WorkSphere. Please try again.";

export default api;
