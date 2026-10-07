import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { AuthContext, type AuthContextValue, type Profile } from "./AuthContext";
import type { AppRole } from "./roles";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [identityLoadedFor, setIdentityLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionResolved(true);
    });
    // Do not call supabase from inside this callback (deadlock risk); only set state.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setSessionResolved(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;

  const loadIdentity = useCallback(async (id: string) => {
    const [rolesRes, profileRes] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", id),
      supabase.from("profiles").select("id, display_name, preferred_language").eq("id", id).maybeSingle(),
    ]);
    setRoles(((rolesRes.data ?? []) as { role: AppRole }[]).map((r) => r.role));
    setProfile((profileRes.data as Profile | null) ?? null);
    setIdentityLoadedFor(id);
  }, []);

  useEffect(() => {
    if (!userId) {
      setRoles([]);
      setProfile(null);
      setIdentityLoadedFor(null);
      return;
    }
    void loadIdentity(userId);
  }, [userId, loadIdentity]);

  const signIn = useCallback<AuthContextValue["signIn"]>(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback<AuthContextValue["signUp"]>(async (email, password, displayName) => {
    // Only display_name is sent. The database assigns the citizen role; clients cannot choose a role.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw error;
    return { needsEmailConfirmation: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const refreshProfile = useCallback(async () => {
    if (userId) await loadIdentity(userId);
  }, [userId, loadIdentity]);

  const isLoading = !sessionResolved || (userId !== null && identityLoadedFor !== userId);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      roles,
      profile,
      isLoading,
      signIn,
      signUp,
      signOut,
      refreshProfile,
    }),
    [session, roles, profile, isLoading, signIn, signUp, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
