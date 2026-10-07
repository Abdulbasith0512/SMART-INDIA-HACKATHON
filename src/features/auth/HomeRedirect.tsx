import { Navigate } from "react-router-dom";
import { useAuth } from "./useAuth";
import { FullPageLoader } from "./FullPageLoader";
import { homePathFor } from "./roles";

/** `/app`: send the signed-in user to the home of their highest-priority role. */
export function HomeRedirect() {
  const { isLoading, user, roles } = useAuth();
  if (isLoading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={homePathFor(roles)} replace />;
}
