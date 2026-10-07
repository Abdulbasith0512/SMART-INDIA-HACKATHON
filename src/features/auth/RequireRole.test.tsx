import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireRole } from "./RequireRole";
import { HomeRedirect } from "./HomeRedirect";
import type { AppRole } from "./roles";

const mockAuth = vi.hoisted(() => ({
  value: { isLoading: false, user: null, roles: [] } as {
    isLoading: boolean;
    user: { id: string } | null;
    roles: AppRole[];
  },
}));

vi.mock("./useAuth", () => ({ useAuth: () => mockAuth.value }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/forbidden" element={<div>forbidden page</div>} />
        <Route path="/app" element={<HomeRedirect />} />
        <Route path="/dashboard" element={<div>citizen home</div>} />
        <Route path="/officer" element={<div>officer home</div>} />
        <Route path="/admin" element={<div>admin home</div>} />
        <Route
          path="/secret"
          element={
            <RequireRole roles={["officer"]}>
              <div>officer secret</div>
            </RequireRole>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireRole", () => {
  beforeEach(() => {
    mockAuth.value = { isLoading: false, user: null, roles: [] };
  });

  it("shows a loader while auth is resolving and never flashes content", () => {
    mockAuth.value = { isLoading: true, user: null, roles: [] };
    renderAt("/secret");
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("officer secret")).not.toBeInTheDocument();
  });

  it("redirects unauthenticated users to /login", () => {
    renderAt("/secret");
    expect(screen.getByText("login page")).toBeInTheDocument();
    expect(screen.queryByText("officer secret")).not.toBeInTheDocument();
  });

  it("redirects wrong-role users to /forbidden", () => {
    mockAuth.value = { isLoading: false, user: { id: "u1" }, roles: ["citizen"] };
    renderAt("/secret");
    expect(screen.getByText("forbidden page")).toBeInTheDocument();
    expect(screen.queryByText("officer secret")).not.toBeInTheDocument();
  });

  it("renders for an allowed role", () => {
    mockAuth.value = { isLoading: false, user: { id: "u1" }, roles: ["citizen", "officer"] };
    renderAt("/secret");
    expect(screen.getByText("officer secret")).toBeInTheDocument();
  });
});

describe("HomeRedirect", () => {
  it("sends a citizen to /dashboard", () => {
    mockAuth.value = { isLoading: false, user: { id: "u1" }, roles: ["citizen"] };
    renderAt("/app");
    expect(screen.getByText("citizen home")).toBeInTheDocument();
  });

  it("sends a multi-role user to their highest-priority home", () => {
    mockAuth.value = { isLoading: false, user: { id: "u1" }, roles: ["citizen", "officer", "admin"] };
    renderAt("/app");
    expect(screen.getByText("admin home")).toBeInTheDocument();
  });

  it("sends unauthenticated users to /login", () => {
    mockAuth.value = { isLoading: false, user: null, roles: [] };
    renderAt("/app");
    expect(screen.getByText("login page")).toBeInTheDocument();
  });
});
