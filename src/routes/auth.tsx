import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import { ThemeToggle } from "@/components/theme-toggle";
import { hasPerm } from "@/lib/permissions";
import { BrandLogo } from "@/components/brand-logo";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Sign in — MilaServ Portal" }] }),
  validateSearch: (s: Record<string, unknown>): { next?: string } => {
    // Only accept a same-origin relative path for the post-login redirect.
    // Parse against a fixed sentinel origin (no `window` — this runs during SSR
    // too). Off-origin forms — "//evil.com", "/\evil.com" (backslashes
    // normalize to slashes), "https://evil.com", "javascript:…" — fail the
    // origin check and are dropped, closing the open-redirect vector.
    let next: string | undefined;
    if (typeof s.next === "string") {
      try {
        const u = new URL(s.next, "http://localhost");
        if (u.origin === "http://localhost") next = u.pathname + u.search + u.hash;
      } catch {
        // malformed → leave next undefined
      }
    }
    return { next };
  },
  component: AuthPage,
});

function AuthPage() {
  const { session, loading, role, profile } = useAuth();
  const { next } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // Where an already-authenticated visitor belongs. A pure derivation: reading
  // it has no effect on anything, so it is safe to compute during render and
  // safe for React to discard and recompute. Same precedence as before —
  // dashboard, then orders, then "/" (which re-resolves against permissions).
  const authed = !loading && !!session;
  const redirectTo = !authed
    ? null
    : hasPerm(role, profile?.permissions, "view_dashboard")
      ? "/dashboard"
      : hasPerm(role, profile?.permissions, "view_orders")
        ? "/orders"
        : "/";

  // `next` survives validateSearch as an app-relative path, but it is an
  // arbitrary string rather than a typed route, so it still goes through a full
  // document load instead of <Navigate>. That is a genuine side effect, so it
  // belongs in an effect — never in render, where React may call the component
  // more than once and fire the assignment repeatedly. The ref makes it
  // at-most-once even under StrictMode's double invocation in development.
  const assigned = useRef(false);
  useEffect(() => {
    if (!authed || !next || assigned.current) return;
    assigned.current = true;
    window.location.assign(next);
  }, [authed, next]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Signed in");
    // No navigation here on purpose. A successful sign-in fires SIGNED_IN on
    // supabase.auth.onAuthStateChange, AuthProvider sets `session`, and the
    // redirect above takes over. Navigating here as well is what produced two
    // competing redirects for a single sign-in.
  };

  const onForgot = async () => {
    if (!email) { toast.error("Enter your email first"); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) toast.error(error.message);
    else toast.success("Password reset email sent");
  };

  // Declarative redirect for in-app targets: React performs the navigation as
  // part of committing this render instead of the component mutating router
  // state while rendering. Matches the pattern already used in routes/index.tsx.
  // Placed below every hook so the hook order never changes between renders.
  // The `next` case is excluded — the effect above owns that one.
  if (redirectTo && !next) return <Navigate to={redirectTo} replace />;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-gradient-to-br from-accent to-background px-4">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <Card className="w-full max-w-md shadow-xl border-border/60">
        <CardHeader className="text-center space-y-1 pb-4">
          <BrandLogo size="auth" className="mx-auto -mb-1" />
          <CardTitle className="text-2xl leading-tight">MilaServ Portal</CardTitle>
          <CardDescription className="pt-1">Sign in to access orders, complaints & call center analytics</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@milaserv.com" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <button type="button" onClick={onForgot} className="text-xs text-primary hover:underline">Forgot?</button>
              </div>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
          </form>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Need an account? Ask an administrator to create one.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
