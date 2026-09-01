import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useAuth, isAdministrator, isOwnerRole } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Activity,
  Building2,
  ChartColumn,
  ClipboardList,
  ClipboardPlus,
  Headphones,
  LayoutDashboard,
  LayoutList,
  MessageSquareWarning,
  PackageSearch,
  Phone,
  PhoneOutgoing,
  Search,
  PhoneCall,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import { hasPerm, canViewCallCenter } from "@/lib/permissions";
import { callsTeamForRole } from "@/lib/calls-access";
import { AppHeader } from "@/components/app-header";
import { AppSidebar, resolveActivePath } from "@/components/app-sidebar";
import { ForcePasswordChange } from "@/features/profile/components/force-password-change";
import { TemporaryPasswordExpired } from "@/features/profile/components/temporary-password-expired";
import { temporaryPasswordState } from "@/lib/password-policy";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

/**
 * The rail is a fixed 92px and no longer has an expanded state, so the width it
 * publishes is a constant. Kept as a custom property because fixed-position
 * overlays inside routes (the Branch Locator's sticky bar) position against it.
 */
const SIDEBAR_WIDTH = "92px";

function AppLayout() {
  const { session, profile, role, loading, signOut, refresh } = useAuth();
  const navigate = useNavigate();
  const { location } = useRouterState();

  const [mobileOpen, setMobileOpen] = useState(false);

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
  /**
   * Management reporting. `view_reports` already existed and already draws the
   * line the brief asks for — owner, admin, supervisor and auditor hold it, and
   * neither agent role does — so the page needed no new permission.
   */
  const canReports = hasPerm(role, profile?.permissions as any, "view_reports");
  /**
   * Shams MIS. One page-level permission, the same key every Shams server
   * function checks — so the entry appears exactly when the page would work.
   * Auditors do not hold it by default but can be granted it individually.
   */
  const canShams = hasPerm(role, profile?.permissions as any, "view_shams_mis");
  /**
   * The Telesales CRM. `view_telesales` is the same key its RLS policies check,
   * so the entry appears exactly when the queue would have rows to show.
   */
  const canTelesales = hasPerm(role, profile?.permissions as any, "view_telesales");
  // Team agents get one Calls page and no module landing page, so the parent
  // entry points straight at it and the sibling pages are never rendered.
  const callsTeam = callsTeamForRole(role);

  const nav = useMemo(
    () => [
      ...(canDashboard ? [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] : []),
      ...(canReports ? [{ to: "/reports", label: "Reports", icon: ChartColumn }] : []),
      ...(canOrders ? [{ to: "/orders", label: "Orders", icon: ClipboardList }] : []),
      ...(canCreate ? [{ to: "/orders/new", label: "New Order", icon: ClipboardPlus }] : []),
      ...(canComplaints
        ? [{ to: "/complaints", label: "Complaints", icon: MessageSquareWarning }]
        : []),
      // "Calls" is the product feature; the PBX behind it is an implementation
      // detail and is deliberately not named in the navigation, so swapping
      // provider would not change a single menu entry.
      //
      // Access narrows down the list: the two operational dashboards follow the
      // call-centre permission, diagnostics is administrator-only, and
      // configuration is owner-only.
      ...(canCallCenter
        ? [
            {
              to:
                callsTeam === "telesales"
                  ? "/calls/telesales"
                  : callsTeam
                    ? "/calls/customer-care"
                    : "/calls",
              label: "Calls",
              icon: Phone,
              children: [
                // The combined dashboard aggregates a team's performance next
                // to the other's, which is not a team agent's to read — so it
                // is hidden from them here and refused on direct URL access by
                // the same `canViewCallsPage` rule.
                ...(callsTeam
                  ? []
                  : [{ to: "/calls/overview", label: "Calls Overview", icon: LayoutList }]),
                ...(callsTeam && callsTeam !== "customer_care"
                  ? []
                  : [{ to: "/calls/customer-care", label: "Customer Care", icon: Headphones }]),
                ...(callsTeam && callsTeam !== "telesales"
                  ? []
                  : [{ to: "/calls/telesales", label: "Telesales", icon: PhoneOutgoing }]),
                // Deliberately NOT confined to one team: it is a per-number
                // contact history, most useful to the agent with that customer
                // on the line. See UNCONFINED_PAGES in calls-access.ts.
                { to: "/calls/lookup", label: "Call Lookup", icon: Search, separatorBefore: true },
                ...(isAdministrator(role)
                  ? [
                      {
                        to: "/calls/diagnostics",
                        label: "Diagnostics",
                        icon: Activity,
                        separatorBefore: true,
                      },
                    ]
                  : []),
                ...(isOwnerRole(role)
                  ? [{ to: "/calls/configuration", label: "Configuration", icon: Settings2 }]
                  : []),
              ],
            },
          ]
        : []),
      // Shams MIS reads the pharmacy's own system, behind its own page-level
      // permission so it can be granted or withdrawn on its own.
      // The Telesales queue. Named for the work, not for the client: Shams
      // Pharmacies is the account whose desk it runs, and a second account would
      // add rows here rather than a second menu entry.
      ...(canTelesales ? [{ to: "/telesales", label: "Telesales", icon: PhoneCall }] : []),
      ...(canShams ? [{ to: "/shams", label: "Shams MIS", icon: PackageSearch }] : []),
      /*
       * The administration area. Its own rail carries the pages inside it, so
       * the global sidebar needs one entry rather than four — and the entry is
       * administrator-only, while Users stays on `manage_users` so supervisors
       * keep the link they have always had.
       */
      ...(isAdministrator(role)
        ? [{ to: "/admin", label: "Administration", shortLabel: "Admin", icon: ShieldCheck }]
        : []),
      ...(canUsers ? [{ to: "/admin/users", label: "Users", icon: Users }] : []),
      ...(canBranches ? [{ to: "/branches", label: "Branches", icon: Building2 }] : []),
    ],
    [
      canDashboard,
      canReports,
      canOrders,
      canCreate,
      canComplaints,
      canCallCenter,
      callsTeam,
      canTelesales,
      canShams,
      canUsers,
      canBranches,
      role,
    ],
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

  // Resolves against children as well as top-level items — see the note on
  // resolveActivePath for what breaks when it does not.
  const activePath = resolveActivePath(nav, location.pathname);

  // Still the top-level item, so the header keeps naming the section ("Calls")
  // rather than switching to the child's label.
  const activeItem = nav.find(
    (n) => n.to === activePath || (n.children ?? []).some((c) => c.to === activePath),
  );

  return (
    <div
      className="min-h-screen flex bg-muted/30"
      // Published so fixed-position overlays inside routes (e.g. the Branch
      // Locator's sticky bar) can sit beside the sidebar instead of over it.
      style={{ "--app-sidebar-w": SIDEBAR_WIDTH } as CSSProperties}
    >
      <AppSidebar
        nav={nav}
        activePath={activePath}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobileSidebar}
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
