import type { AppRole } from "@/lib/supabase/database.types";

export type { AppRole };

/** Highest privilege first. Used to pick where a multi-role user lands after login. */
export const ROLE_PRIORITY: readonly AppRole[] = ["admin", "officer", "clinician", "citizen"];

export const ROLE_BASE_PATH: Record<AppRole, string> = {
  citizen: "/dashboard",
  clinician: "/clinician",
  officer: "/officer",
  admin: "/admin",
};

export const ROLE_LABEL: Record<AppRole, string> = {
  citizen: "Citizen",
  clinician: "Clinician",
  officer: "Public-health officer",
  admin: "Administrator",
};

export function primaryRole(roles: readonly AppRole[]): AppRole | null {
  return ROLE_PRIORITY.find((r) => roles.includes(r)) ?? null;
}

export function homePathFor(roles: readonly AppRole[]): string {
  const role = primaryRole(roles);
  return role ? ROLE_BASE_PATH[role] : "/forbidden";
}
