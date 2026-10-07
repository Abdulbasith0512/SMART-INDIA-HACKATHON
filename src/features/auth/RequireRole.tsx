import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";
import { FullPageLoader } from "./FullPageLoader";
import type { AppRole } from "./roles";

export function RequireRole({ roles, children }: { roles: readonly AppRole[]; children: ReactNode }) {
  const { isLoading, user, roles: userRoles } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!roles.some((r) => userRoles.includes(r))) return <Navigate to="/forbidden" replace />;
  return <>{children}</>;
}
