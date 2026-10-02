import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { authApi, restoreSession } from "../../api/client";
import AppLayout from "../../layouts/AppLayout";
import DashboardPage from "../dashboard/DashboardPage";

jest.mock("../../api/client", () => ({
  authApi: { post: jest.fn() }, restoreSession: jest.fn(), errorMessage: jest.fn(),
}));

const account = { id: "a1", email: "jamie@example.com", role: "EMPLOYEE" };
const credentials = { email: account.email, password: "secure passphrase" };

function SignIn() {
  const { user, loading, signIn } = useAuth();
  if (loading) return <p>Restoring</p>;
  if (!user) return <button onClick={() => signIn(credentials)}>Log in</button>;
  return <><AppLayout /><DashboardPage /></>;
}

function renderAccount() {
  render(<MemoryRouter><AuthProvider><SignIn /></AuthProvider></MemoryRouter>);
}

beforeEach(() => { jest.resetAllMocks(); });

test.each([
  { firstName: "Jamie", lastName: "Morgan" },
  { firstname: "Jamie", lastname: "Morgan" },
  { firstName: "Jamie", firstname: "Stale", lastName: "Morgan", lastname: "Stale" },
])("restored accounts display canonical names in dashboard and navigation: %p", async (names) => {
  restoreSession.mockResolvedValue({ ...account, ...names });
  renderAccount();
  expect(await screen.findByRole("heading", { name: /Hello, Jamie/ })).toBeInTheDocument();
  expect(screen.getAllByText("Jamie Morgan")).toHaveLength(2);
  expect(screen.getAllByText("JM")).toHaveLength(2);
});

test.each([
  { firstName: "Jamie", lastName: "Morgan" },
  { firstname: "Jamie", lastname: "Morgan" },
])("sign-in normalizes names before rendering the authenticated app: %p", async (names) => {
  restoreSession.mockRejectedValue({ response: { status: 401 } });
  authApi.post.mockResolvedValue({ data: { data: { ...account, ...names } } });
  renderAccount();
  fireEvent.click(await screen.findByRole("button", { name: "Log in" }));
  expect(await screen.findByRole("heading", { name: /Hello, Jamie/ })).toBeInTheDocument();
  expect(screen.getAllByText("Jamie Morgan")).toHaveLength(2);
  expect(authApi.post).toHaveBeenCalledWith("/auth/login", credentials);
});
