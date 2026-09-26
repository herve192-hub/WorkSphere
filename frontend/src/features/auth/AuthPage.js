import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { errorMessage } from "../../api/client";

/**
 * Renders the authentication page for signing in or registering.
 *
 * @param {Object} props - The component props.
 * @param {string} props.mode - The authentication mode ("login" or "register").
 * @returns {JSX.Element} The authentication page.
 */

export default function AuthPage({ mode }) {
  const register = mode === "register";
  const { user, signIn, registerAccount } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [values, setValues] = useState({
    firstname: "",
    lastname: "",
    email: location.state?.email || "",
    password: "",
    confirm: "",
  });
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(
    !register && location.state?.registered
      ? "Account created successfully. Please sign in to continue."
      : "",
  );
  useEffect(() => {
    if (!success) return;
    // Consume the one-time message so reload/back does not replay it.
    navigate(location.pathname, {
      replace: true,
      state: { from: location.state?.from },
    });
    const timer = setTimeout(() => setSuccess(""), 8000);
    return () => clearTimeout(timer);
  }, [success, navigate, location.pathname, location.state?.from]);
  const destination =
    location.state?.from?.startsWith("/") &&
    !location.state.from.startsWith("//")
      ? location.state.from
      : "/dashboard";
  if (user) return <Navigate to={destination} replace />;

  /**
   * Updates the current form field value as the user types.
   *
   * @param {React.ChangeEvent<HTMLInputElement>} e - The input change event.
   */
  const change = (e) =>
    setValues({ ...values, [e.target.name]: e.target.value });

  /**
   * Validates and submits the sign-in or registration form.
   *
   * @param {React.FormEvent<HTMLFormElement>} e - The form submission event.
   */
  async function submit(e) {
    e.preventDefault();
    setError("");
    if (register && values.password !== values.confirm) {
      setError("Your passwords do not match.");
      return;
    }
    if (register && new TextEncoder().encode(values.password).length > 72) {
      setError("Please keep your password within 72 UTF-8 bytes.");
      return;
    }
    setBusy(true);
    try {
      const { confirm, ...payload } = values;
      if (register) {
        await registerAccount(payload);
        navigate("/login", {
          replace: true,
          state: {
            registered: true,
            email: values.email.trim().toLowerCase(),
            from: destination,
          },
        });
      } else {
        await signIn({ email: values.email, password: values.password });
        navigate(destination, { replace: true });
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      {success && (
        <div className="success-toast" role="status" aria-live="polite">
          <span>{success}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setSuccess("")}
          >
            ×
          </button>
        </div>
      )}
      <section className="auth-story" aria-label="Welcome to WorkSphere">
        <Link className="brand" to="/login">
          <span className="brand-mark">w.</span> WorkSphere
        </Link>
        <div className="story-content">
          <span className="eyebrow">YOUR PEOPLE. ONE CONNECTED SPACE.</span>
          <h1>
            Great work
            <br />
            starts with
            <br />
            <em>great people.</em>
          </h1>
          <p>
            A little less admin. A lot more connection. Give your team a place
            to grow, together.
          </p>
          <div className="people-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <span className="person person-one">JD</span>
            <span className="person person-two">AK</span>
            <span className="person person-three">ML</span>
            <span className="art-center">w.</span>
            <span className="art-label">
              Better, together <b>✦</b>
            </span>
          </div>
        </div>
        <div className="story-footer">
          A workspace built around people.<span>✦</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-top">
          {register ? "Already part of the team?" : "New to WorkSphere?"}{" "}
          <Link to={register ? "/login" : "/register"} state={location.state}>
            {register ? "Sign in" : "Create an account"}{" "}
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="auth-form-wrap">
          <span className="section-tag">LET’S GET YOU SETTLED IN</span>
          <h2>
            {register ? "Your next chapter starts here." : "Welcome back."}
          </h2>
          <p className="muted">
            {register
              ? "Create your account and make yourself at home."
              : "Sign in to stay connected with your workspace."}
          </p>
          <form onSubmit={submit} className="auth-form">
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <fieldset disabled={busy}>
              {register && (
                <div className="form-row">
                  <label>
                    First name
                    <input
                      name="firstname"
                      autoComplete="given-name"
                      placeholder="Jamie"
                      required
                      maxLength={80}
                      value={values.firstname}
                      onChange={change}
                    />
                  </label>
                  <label>
                    Last name
                    <input
                      name="lastname"
                      autoComplete="family-name"
                      placeholder="Morgan"
                      required
                      maxLength={80}
                      value={values.lastname}
                      onChange={change}
                    />
                  </label>
                </div>
              )}
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  required
                  maxLength={254}
                  value={values.email}
                  onChange={change}
                />
              </label>
              <label>
                Password
                <div className="password-field">
                  <input
                    name="password"
                    aria-label="Password"
                    type={visible ? "text" : "password"}
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                    placeholder={
                      register
                        ? "Create a strong password"
                        : "Enter your password"
                    }
                    required
                    minLength={register ? 12 : undefined}
                    value={values.password}
                    onChange={change}
                    aria-describedby={register ? "password-help" : undefined}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setVisible(!visible)}
                    aria-label={visible ? "Hide password" : "Show password"}
                  >
                    {visible ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
              {register && (
                <>
                  <p id="password-help" className="field-help">
                    Use at least 12 characters. A memorable passphrase works
                    well.
                  </p>
                  <label>
                    Confirm password
                    <input
                      name="confirm"
                      type={visible ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="Enter your password again"
                      required
                      value={values.confirm}
                      onChange={change}
                    />
                  </label>
                </>
              )}
              <button type="submit" className="primary submit">
                {busy
                  ? register
                    ? "Creating your account…"
                    : "Signing you in…"
                  : register
                    ? "Create account"
                    : "Sign in"}{" "}
                {!busy && <span aria-hidden="true">→</span>}
              </button>
            </fieldset>
          </form>
          <div className="security-note">
            <span aria-hidden="true">◇</span> Your workspace, securely
            connected.
          </div>
        </div>
        <footer className="auth-bottom">
          © {new Date().getFullYear()} WorkSphere
          <span>Made for the way people work.</span>
        </footer>
      </section>
    </main>
  );
}
