import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth, isAdministrator } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, ListOrdered, Plus, Users, MapPin,
  ShieldAlert, MessageSquareWarning, PhoneCall, Headphones,
} from "lucide-react";
import { hasPerm, canViewCallCenter } from "@/lib/permissions";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

const SIDEBAR_PREF_KEY = "milaserv.sidebar.expanded";

function AppLayout() {
  const { session, profile, role, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { location } = useRouterState();

  // Compact-by-default: sidebar starts collapsed (icons + label under icon).
  // Preference persisted to localStorage and hydrated after mount to avoid SSR mismatch.
  // Compact-by-default: sidebar starts collapsed (icons + label under icon).
  const [expanded, setExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_PREF_KEY);
      if (v === "1") setExpanded(true);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_PREF_KEY, expanded ? "1" : "0"); } catch {}
  }, [expanded]);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", replace: true });
  }, [loading, session, navigate]);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const canDashboard = hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canOrders = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canComplaints = hasPerm(role, profile?.permissions as any, "view_complaints");
  const canUsers = hasPerm(role, profile?.permissions as any, "manage_users");
  const canBranches = hasPerm(role, profile?.permissions as any, "view_branches") || hasPerm(role, profile?.permissions as any, "admin_access");
  const canCallCenter = canViewCallCenter(role, profile?.permissions as any);

  const nav = useMemo(() => ([
    ...(canDashboard ? [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] : []),
    ...(canOrders ? [{ to: "/orders", label: "Orders", icon: ListOrdered }] : []),
    ...(canCreate ? [{ to: "/orders/new", label: "New", icon: Plus }] : []),
    ...(canComplaints ? [{ to: "/complaints", label: "Complaints", icon: MessageSquareWarning }] : []),
    ...(canCallCenter ? [{ to: "/call-center", label: "Calls", icon: Headphones }] : []),
    ...(canUsers ? [{ to: "/admin/users", label: "Users", icon: Users }] : []),
    ...(canBranches ? [{ to: "/admin/branches", label: "Branches", icon: MapPin }] : []),
    ...(isAdministrator(role) ? [{ to: "/admin/yeastar", label: "Yeastar", icon: PhoneCall }] : []),
  ]), [canDashboard, canOrders, canCreate, canComplaints, canCallCenter, canUsers, canBranches, role]);

  if (loading || !session) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }

  if (profile && !profile.active) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md text-center space-y-4">
          <ShieldAlert className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="text-xl font-semibold">Account deactivated</h1>
          <p className="text-sm text-muted-foreground">Your account is currently inactive. Please contact an administrator.</p>
          <Button variant="outline" onClick={() => signOut()}>Sign out</Button>
        </div>
      </div>
    );
  }

  const activePath = (() => {
    const path = location.pathname;
    const cands = nav.filter((m) => path === m.to || path.startsWith(m.to + "/"));
    return cands.sort((a, b) => b.to.length - a.to.length)[0]?.to ?? "";
  })();

  const activeItem = nav.find((n) => n.to === activePath);

  return (
    <div className="min-h-screen flex bg-muted/30">
      <AppSidebar
        nav={nav}
        activePath={activePath}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        name={profile?.full_name ?? session.user.email ?? "Account"}
        role={role}
        avatarUrl={profile?.avatar_url}
        onSignOut={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
      />

      {/* `main` must NOT establish a scroll container: an `overflow-x-hidden`
          here makes it the sticky header's scroll root, and since the document
          (not `main`) is what scrolls, the header would scroll away. Keep
          overflow visible on `main` so the header sticks to the viewport, and
          move horizontal containment down onto the content wrapper. */}
      <main className="flex-1 min-w-0 flex flex-col">
        <AppHeader
          title={activeItem?.label ?? "MilaServ Portal"}
          icon={activeItem?.icon}
          onOpenMobile={() => setMobileOpen(true)}
          name={profile?.full_name ?? session.user.email ?? "Account"}
          role={role}
          avatarUrl={profile?.avatar_url}
          onSignOut={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
        />

        {/* Route content — quick fade-in. `overflow-x-hidden` lives here (a
            sibling of the header, not its ancestor) so wide content is still
            contained without breaking the sticky header. */}
        <div
          key={location.pathname}
          className="p-3 sm:p-4 lg:p-6 xl:px-8 w-full overflow-x-hidden animate-in fade-in duration-150"
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}
