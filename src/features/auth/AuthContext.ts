import { createContext } from "react";
import type { Session, User } from "@supabase/supabase-js";
import type { AppRole } from "./roles";

export interface Profile {
  id: string;
  display_name: string | null;
  preferred_language: string;
}

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  roles: AppRole[];
  profile: Profile | null;
  /** True until the session AND (if signed in) the roles have been resolved. */
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<{ needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
