import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useAuth, isAdministrator } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  ListOrdered,
  PlusCircle,
  Users,
  MapPin,
  ShieldAlert,
  MessageSquareWarning,
  PhoneCall,
  Headphones,
  PhoneOutgoing,
} from "lucide-react";

import { hasPerm, canViewCallCenter } from "@/lib/permissions";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { ForcePasswordChange } from "@/features/profile/components/force-password-change";
import { TemporaryPasswordExpired } from "@/features/profile/components/temporary-password-expired";
import { temporaryPasswordState } from "@/lib/password-policy";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

const SIDEBAR_PREF_KEY = "milaserv.sidebar.expanded";

function AppLayout() {
  const { session, profile, role, loading, signOut, refresh } = useAuth();
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
    try {
      localStorage.setItem(SIDEBAR_PREF_KEY, expanded ? "1" : "0");
    } catch {}
  }, [expanded]);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", replace: true });
  }, [loading, session, navigate]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Stable references: the sidebar's inner tree is memoized, and an inline
  // arrow here would hand it a fresh callback on every layout render, turning
  // every unrelated update (avatar load, notifications) into a sidebar
  // reconcile.
  const toggleSidebar = useCallback(() => setExpanded((v) => !v), []);
  const closeMobileSidebar = useCallback(() => setMobileOpen(false), []);

  const canDashboard = hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canOrders = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canComplaints = hasPerm(role, profile?.permissions as any, "view_complaints");
  const canUsers = hasPerm(role, profile?.permissions as any, "manage_users");
  const canBranches =
    hasPerm(role, profile?.permissions as any, "view_branches") ||
    hasPerm(role, profile?.permissions as any, "admin_access");
  const canCallCenter = canViewCallCenter(role, profile?.permissions as any);

  const nav = useMemo(
    () => [
      ...(canDashboard ? [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] : []),
      ...(canOrders ? [{ to: "/orders", label: "Orders", icon: ListOrdered }] : []),
      ...(canCreate ? [{ to: "/orders/new", label: "New Order", icon: PlusCircle }] : []),
      ...(canComplaints
        ? [{ to: "/complaints", label: "Complaints", icon: MessageSquareWarning }]
        : []),
      // Calls is split by workflow: Customer Care is queue-driven, Telesales is
      // extension-driven, and their KPIs are computed differently. The sidebar
      // groups both under a "Calls" heading (see SECTIONS in app-sidebar).
      ...(canCallCenter
        ? [
            { to: "/calls/customer-care", label: "Customer Care", icon: Headphones },
            { to: "/calls/telesales", label: "Telesales", icon: PhoneOutgoing },
          ]
        : []),

      ...(canUsers ? [{ to: "/admin/users", label: "Users", icon: Users }] : []),
      ...(canBranches ? [{ to: "/branches", label: "Branches", icon: MapPin }] : []),
      ...(isAdministrator(role)
        ? [{ to: "/admin/yeastar", label: "Yeastar PBX", icon: PhoneCall }]
        : []),

    ],
    [canDashboard, canOrders, canCreate, canComplaints, canCallCenter, canUsers, canBranches, role],
  );

  if (loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (profile && !profile.active) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md text-center space-y-4">
          <ShieldAlert className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="text-xl font-semibold">Account deactivated</h1>
          <p className="text-sm text-muted-foreground">
            Your account is currently inactive. Please contact an administrator.
          </p>
          <Button variant="outline" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  // An administrator-issued password is a credential two people know. Until the
  // holder replaces it, the entire authenticated surface is withheld — same
  // treatment as a deactivated account, and for the same reason: this is a
  // property of the account, not of the page being visited, so it cannot be
  // sidestepped by navigating elsewhere. Sits after the `active` check because
  // a deactivated account has nothing to gain from setting a password.
  //
  // Past its deadline the password is not merely unwelcome but retired: the
  // expired screen rotates it away and hands the user the recovery path.
  const tempPasswordState = temporaryPasswordState(profile);
  if (tempPasswordState === "expired") {
    return (
      <TemporaryPasswordExpired
        email={session.user.email}
        onSignOut={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
      />
    );
  }
  if (tempPasswordState === "active") {
    return (
      <ForcePasswordChange
        name={profile?.full_name}
        deadline={profile?.must_change_password_expires_at ?? null}
        onDone={refresh}
        onSignOut={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
      />
    );
  }

  const activePath = (() => {
    const path = location.pathname;
    const cands = nav.filter((m) => path === m.to || path.startsWith(m.to + "/"));
    return cands.sort((a, b) => b.to.length - a.to.length)[0]?.to ?? "";
  })();

  const activeItem = nav.find((n) => n.to === activePath);

  return (
    <div
      className="min-h-screen flex bg-muted/30"
      // Published so fixed-position overlays inside routes (e.g. the Branch
      // Locator's sticky bar) can sit beside the sidebar instead of over it.
      style={{ "--app-sidebar-w": expanded ? "16rem" : "76px" } as CSSProperties}
    >
      <AppSidebar
        nav={nav}
        activePath={activePath}
        expanded={expanded}
        onToggle={toggleSidebar}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobileSidebar}
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

        {/* Route content — quick fade-in. Horizontal containment lives here (a
            sibling of the header, not its ancestor) so wide content is still
            contained without breaking the sticky header.

            `overflow-x-clip`, not `overflow-x-hidden`, and the difference is
            load-bearing. CSS does not allow one axis to be `hidden` while the
            other is `visible`: the spec computes the `visible` side to `auto`, so
            `overflow-x: hidden` silently made this a *vertical scroll container*.
            It never actually scrolled — its height is its content — but that is
            enough to break `position: sticky` for everything inside it, because
            sticky offsets are measured against the nearest scrolling ancestor and
            an ancestor that cannot scroll never produces one. That is why the
            Branch Directory's sticky map sat still instead of following the page.

            `clip` contains the same overflow without establishing a scroll box,
            so the document stays the scrollport and sticky descendants work. */}
        <div
          key={location.pathname}
          className="p-3 sm:p-4 lg:p-6 xl:px-8 w-full overflow-x-clip animate-in fade-in duration-150"
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}
