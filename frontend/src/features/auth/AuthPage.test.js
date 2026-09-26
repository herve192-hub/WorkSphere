import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { useAuth } from "./AuthContext";
import AuthPage from "./AuthPage";
jest.mock("./AuthContext", () => ({ useAuth: jest.fn() }));
const signIn = jest.fn();
const registerAccount = jest.fn();
beforeEach(() => {
  signIn.mockReset();
  registerAccount.mockReset();
  useAuth.mockReturnValue({ user: null, signIn, registerAccount });
});
function renderPage(mode) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<AuthPage key={mode} mode={mode} />} />
        <Route path="/login" element={<AuthPage key="login" mode="login" />} />
        <Route path="/dashboard" element={<h1>Dashboard destination</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}
function fill(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
test("login calls the API and navigates to dashboard", async () => {
  signIn.mockResolvedValue(undefined);
  renderPage("login");
  fill("Email address", "jamie@example.com");
  fill("Password", "a secure passphrase");
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  await screen.findByText("Dashboard destination");
  expect(signIn).toHaveBeenCalledWith(
    expect.objectContaining({
      email: "jamie@example.com",
      password: "a secure passphrase",
    }),
  );
});
test("registration rejects mismatched passwords without submitting", () => {
  renderPage("register");
  fill("First name", "Jamie");
  fill("Last name", "Morgan");
  fill("Email address", "jamie@example.com");
  fill("Password", "a secure passphrase");
  fill("Confirm password", "different passphrase");
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your passwords do not match",
  );
  expect(signIn).not.toHaveBeenCalled();
});
test("shows server errors and lets the user retry", async () => {
  signIn.mockRejectedValue({
    response: {
      data: { error: { message: "Email or password is incorrect." } },
    },
  });
  renderPage("login");
  fill("Email address", "jamie@example.com");
  fill("Password", "bad-password");
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Email or password is incorrect.",
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled(),
  );
});

test("registration redirects to login with a dismissible success toast and no sign-in", async () => {
  registerAccount.mockResolvedValue(undefined);
  renderPage("register");
  fill("First name", "Jamie");
  fill("Last name", "Morgan");
  fill("Email address", "jamie@example.com");
  fill("Password", "a secure passphrase");
  fill("Confirm password", "a secure passphrase");
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Account created successfully. Please sign in",
  );
  expect(
    screen.getByRole("heading", { name: "Welcome back." }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Email address")).toHaveValue(
    "jamie@example.com",
  );
  expect(screen.getByLabelText("Password")).toHaveValue("");
  expect(registerAccount).toHaveBeenCalledWith(
    expect.objectContaining({ email: "jamie@example.com" }),
  );
  expect(signIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
test("failed registration stays on the form without a success toast", async () => {
  registerAccount.mockRejectedValue({
    response: { data: { error: { message: "This email is already in use." } } },
  });
  renderPage("register");
  fill("First name", "Jamie");
  fill("Last name", "Morgan");
  fill("Email address", "jamie@example.com");
  fill("Password", "a secure passphrase");
  fill("Confirm password", "a secure passphrase");
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This email is already in use.",
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(signIn).not.toHaveBeenCalled();
});
