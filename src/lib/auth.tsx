import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { hasPerm } from "@/lib/permissions";

import type { AppRole } from "@/lib/roles";

// Re-exported so the many existing `import type { AppRole } from "@/lib/auth"`
// call sites keep working. The definition itself now lives in `@/lib/roles`,
// derived from APP_ROLES so the role list cannot drift between modules again.
export type { AppRole };

/** True for the Owner role. Owner is protected: it cannot be deleted,
 *  deactivated, or have its role changed. See 20260721001200_owner_protection.
 *
 *  Accepts a plain string, like `roleLabel`/`roleTone` do, because callers often
 *  hold an unvalidated role straight from a database row; a non-matching value
 *  simply returns false. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return role === "owner";
}

/**
 * Centralized administrator check. Owner and admin have identical
 * top-level privileges across the platform (dashboard, users, Yeastar,
 * diagnostics, orders/complaints admin, system settings).
 */
export function isAdministrator(role: AppRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export interface Profile {
  id: string;
  full_name: string;
  agent_code: string | null;
  active: boolean;
  permissions: string[];
  yeastar_ext?: string | null;
  created_at?: string;
  avatar_url?: string | null;
  /** Set when an administrator issued the current password. The app layout
   *  blocks on it until the holder sets one of their own. Read together with
   *  the deadline below via `temporaryPasswordState()`. */
  must_change_password?: boolean;
  must_change_password_expires_at?: string | null;
}


interface AuthCtx {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  role: AppRole | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = async (uid: string) => {
    const [{ data: p }, { data: r }] = await Promise.all([
      // Uses SECURITY DEFINER RPC so sensitive columns (permissions,
      // yeastar_ext) remain hidden from broad authenticated SELECT while
      // still readable for the caller's own row.
      supabase.rpc("get_my_profile" as any),
      supabase.from("user_roles").select("role").eq("user_id", uid).maybeSingle(),
    ]);
    setProfile((Array.isArray(p) ? p[0] : p) as Profile | null);
    setRole((r?.role as AppRole) ?? null);
  };


  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s?.user) {
        setTimeout(() => loadProfile(s.user.id), 0);
      } else {
        setProfile(null);
        setRole(null);
      }
    });
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session?.user) await loadProfile(data.session.user.id);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthCtx = {
    session,
    user: session?.user ?? null,
    profile,
    role,
    loading,
    signOut: async () => {
      await supabase.auth.signOut();
    },
    refresh: async () => {
      if (session?.user) await loadProfile(session.user.id);
    },
    hasPermission: (permission: string) => hasPerm(role, profile?.permissions, permission),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside provider");
  return v;
}
