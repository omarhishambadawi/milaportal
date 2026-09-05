import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useAuth, isAdministrator, isOwnerRole } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Banknote,
  Building2,
  ChartColumn,
  ClipboardList,
  ClipboardPlus,
  FileText,
  Headphones,
  LayoutDashboard,
  LayoutList,
  MessageSquareWarning,
  PackageSearch,
  Phone,
  PhoneOutgoing,
  Search,
  PhoneCall,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { hasPerm, canViewCallCenter } from "@/lib/permissions";
import { callsTeamForRole } from "@/lib/calls-access";
import { visibleAdminItems } from "@/features/admin/nav";
import { AppHeader } from "@/components/app-header";
import { AppSidebar, navKey, resolveActivePath } from "@/components/app-sidebar";
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

  /**
   * The admin destinations this viewer can actually open.
   *
   * From `ADMIN_NAV`, the same list the admin overview renders, filtered by the
   * same rule — so the flyout cannot offer a page the overview does not, and
   * neither can offer one the route would refuse. A supervisor holding
   * `manage_users` sees only Users; an owner additionally sees call
   * Configuration.
   */
  const adminItems = useMemo(
    () =>
      visibleAdminItems({ isAdmin: isAdministrator(role), isOwner: isOwnerRole(role) }).filter(
        // `/admin/users` is gated on `manage_users` rather than on the role, so
        // it is the one entry whose visibility is a permission question.
        (i) => i.to !== "/admin/users" || canUsers,
      ),
    [role, canUsers],
  );

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
                /*
                 * Diagnostics and Configuration used to sit here, below a
                 * separator. They are administration rather than call handling —
                 * one diagnoses the PBX connection, the other edits it — and
                 * they now live in the Admin flyout. Their routes and their
                 * permissions are unchanged; only the menu that lists them
                 * moved, so every existing link still works.
                 */
              ],
            },
          ]
        : []),
      /*
       * The CRM. Named for what the desk calls it, not for the client: Shams
       * Pharmacies is the account whose desk it runs, and a second account
       * would add rows here rather than a second menu entry.
       *
       * The routes say `/crm/cash` and `/crm/wasfaty`; the tables and the
       * permission keys stay `telesales`, because those are storage and
       * renaming them would be a migration and a re-grant of every user to
       * change a string nobody outside the code reads. `/telesales` still
       * answers, as a redirect, so no existing bookmark breaks.
       *
       * Visibility is `view_telesales` through `hasPerm`, exactly like every
       * other item here, so Rules decide it: Owner, Admin, Supervisor and
       * Telesales hold it by default, and an administrator can grant it to
       * Customer Care or Auditor from the permission editor without a release.
       * Hiding the item is a courtesy, never the boundary — `/telesales` gates
       * on the same permission in-page and every write re-checks it server-side.
       */
      ...(canTelesales
        ? [
            {
              to: "/crm/cash",
              label: "CRM",
              icon: PhoneCall,
              /*
               * Two destinations, because there are two desks.
               *
               * Retention used to be a third entry here, pinned to
               * `/telesales?type=retention`. It is not a third desk: a
               * Retention lead is literally the next cycle of a Cash
               * conversion this system recorded, worked by the same people
               * from the same catalogue, and the Cash page carries it as a
               * chip. A top-level destination that lands on the same queue
               * with one filter applied is a menu entry pretending to be a
               * place.
               *
               * So the sidebar states the domains and nothing else, and the
               * pinned-query machinery (`search`, `navKey`) is no longer
               * needed to tell two children on one route apart — there are no
               * longer two children on one route.
               */
              children: [
                { to: "/crm/cash", label: "Cash", icon: Banknote },
                { to: "/crm/wasfaty", label: "Wasfaty", icon: FileText },
              ],
            },
          ]
        : []),
      // Shams MIS reads the pharmacy's own system, behind its own page-level
      // permission so it can be granted or withdrawn on its own.
      ...(canShams ? [{ to: "/shams", label: "Shams MIS", icon: PackageSearch }] : []),
      /*
       * Administration, as a flyout over the pages inside it.
       *
       * It used to be a single entry into a page carrying its own rail, with
       * Users hoisted out beside it as a second top-level item. That put two
       * menus on screen at once and gave one admin page a shortcut the others
       * did not have. The children come from `ADMIN_NAV` — the same list the
       * overview cards render — so the sidebar and the page cannot disagree
       * about what exists.
       *
       * Shown to anyone who can open at least one of them, which keeps
       * `/admin/users` reachable for a supervisor holding `manage_users`
       * without giving them a menu of refusals: `visibleAdminItems` drops the
       * administrator- and owner-only entries. Every one of these routes still
       * enforces its own permission in-page.
       */
      ...(adminItems.length > 0
        ? [
            {
              // Supervisors cannot open `/admin` itself, so the parent points at
              // the first page they can actually read.
              to: isAdministrator(role) ? "/admin" : adminItems[0].to,
              label: "Administration",
              shortLabel: "Admin",
              icon: ShieldCheck,
              children: adminItems.map((i) => ({
                to: i.to,
                label: i.label === "Diagnostics" ? i.title : i.label,
                icon: i.icon,
              })),
            },
          ]
        : []),
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
      adminItems,
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
  // The search goes in too: two CRM children share `/telesales` and are told
  // apart only by the pipeline they pin.
  const activePath = resolveActivePath(
    nav,
    location.pathname,
    location.search as Record<string, unknown>,
  );

  // Still the top-level item, so the header keeps naming the section ("Calls")
  // rather than switching to the child's label.
  const activeItem = nav.find(
    (n) => navKey(n) === activePath || (n.children ?? []).some((c) => navKey(c) === activePath),
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
