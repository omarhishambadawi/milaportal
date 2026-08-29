/**
 * The administration shell: one frame every admin page sits inside.
 *
 * ## Why a rail and not a second sidebar
 *
 * MilaPortal already has a global sidebar, and the brief asked both for an admin
 * sidebar *and* that the normal portal navigation not be disturbed. A second
 * full-height sidebar would compete with the first — two active states, two
 * collapse behaviours, and a permanent argument about which one owns the left
 * edge.
 *
 * So the admin navigation is a **rail inside the content area**: a grouped
 * vertical list on wide screens, and a horizontal scroller below `xl`. It gives
 * administration its own information architecture without taking the app's
 * navigation away from it, and it disappears entirely for non-admin users
 * because they never reach these routes.
 *
 * ## The gate here is presentational
 *
 * `AdminShell` renders a refusal for non-administrators so they see a sentence
 * rather than a thrown error. It is **not** the access control: every server
 * function behind these pages calls `assertAdmin`, and the tables enforce it
 * again in RLS. Removing this component would change what a non-admin sees, not
 * what they can do.
 */

import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { isAdministrator, useAuth } from "@/lib/auth";
import { ADMIN_NAV, resolveAdminItem } from "@/features/admin/nav";
import { AdminCard } from "./primitives";

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The rail a given viewer should see.
 *
 * A supervisor holds `manage_users` and reaches `/admin/users` legitimately, but
 * cannot open the Shams consoles. Showing them anyway would be a menu of
 * refusals, so administrator-only entries are filtered out and any group left
 * empty disappears with them.
 */
function visibleGroups(isAdmin: boolean) {
  return ADMIN_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => isAdmin || !i.adminOnly),
  })).filter((g) => g.items.length > 0);
}

function RailLink({
  to,
  label,
  description,
  icon: Icon,
  active,
  compact,
}: {
  to: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  compact?: boolean;
}) {
  return (
    <Link
      to={to}
      title={description}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        compact ? "whitespace-nowrap" : "w-full",
        active
          ? "border-primary/30 bg-primary/10 font-medium text-primary-ink"
          : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function AdminRailDesktop({ pathname, isAdmin }: { pathname: string; isAdmin: boolean }) {
  return (
    <>
      {/* Wide screens: a grouped vertical rail. */}
      <nav aria-label="Administration" className="hidden w-56 shrink-0 xl:block">
        <div className="sticky top-4 space-y-5">
          {visibleGroups(isAdmin).map((group) => (
            <div key={group.id} className="space-y-1.5">
              <div className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <RailLink
                    key={item.to}
                    {...item}
                    active={
                      pathname === item.to ||
                      (item.to !== "/admin" && pathname.startsWith(`${item.to}/`))
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}

/**
 * Below `xl` the rail becomes one horizontal strip above the page.
 *
 * Group labels are dropped rather than repeated inline: with four destinations
 * the headings cost more room than the structure they convey. It scrolls rather
 * than wrapping, so the header below it never shifts down a line as the set of
 * admin pages grows.
 */
function AdminRailMobile({ pathname, isAdmin }: { pathname: string; isAdmin: boolean }) {
  return (
    <nav
      aria-label="Administration"
      className="-mx-1 mb-5 flex gap-1.5 overflow-x-auto px-1 pb-1 xl:hidden"
    >
      {visibleGroups(isAdmin)
        .flatMap((g) => g.items)
        .map((item) => (
          <RailLink
            key={item.to}
            {...item}
            compact
            active={
              pathname === item.to || (item.to !== "/admin" && pathname.startsWith(`${item.to}/`))
            }
          />
        ))}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Page header                                                                 */
/* -------------------------------------------------------------------------- */

export function AdminPageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  /** Refresh and primary controls. */
  actions?: ReactNode;
  /** "Last updated" and similar context, shown under the actions. */
  meta?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b pb-4">
      <div className="min-w-0 space-y-1.5">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1 text-xs text-muted-foreground">
            <li>
              <Link
                to="/admin"
                className="rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Administration
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="h-3 w-3" />
            </li>
            <li className="font-medium text-foreground">{title}</li>
          </ol>
        </nav>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>

      {(actions || meta) && (
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
        </div>
      )}
    </header>
  );
}

/** "Last updated 2 minutes ago" — the line every monitoring page needs. */
export function LastUpdated({
  at,
  refreshing,
}: {
  at?: string | Date | null;
  refreshing?: boolean;
}) {
  if (refreshing) return <span>Refreshing…</span>;
  if (!at) return null;
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return (
    <span>
      Last updated{" "}
      <time dateTime={new Date(ms).toISOString()} className="tabular-nums">
        {new Intl.DateTimeFormat("en-GB", {
          timeStyle: "medium",
          timeZone: "Asia/Riyadh",
        }).format(ms)}
      </time>{" "}
      (Riyadh)
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

export function AdminShell({
  children,
  requireAdministrator = true,
}: {
  children: ReactNode;
  /**
   * Set false when the page enforces its own, broader permission. The shell then
   * supplies chrome only and the page's own check remains the gate — which is
   * what keeps `/admin/users` open to supervisors.
   */
  requireAdministrator?: boolean;
}) {
  const { role } = useAuth();
  const isAdmin = isAdministrator(role);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (requireAdministrator && !isAdmin) {
    return (
      <AdminCard className="mx-auto max-w-lg p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="space-y-1">
            <h1 className="text-sm font-semibold">Administrator access required</h1>
            <p className="text-sm text-muted-foreground">
              This area manages system configuration and integrations. Ask an administrator if you
              need access.
            </p>
          </div>
        </div>
      </AdminCard>
    );
  }

  return (
    <div>
      {/* Above the content on narrow screens, beside it on wide ones. */}
      <AdminRailMobile pathname={pathname} isAdmin={isAdmin} />
      <div className="flex gap-6">
        <AdminRailDesktop pathname={pathname} isAdmin={isAdmin} />
        <div className="min-w-0 flex-1 space-y-6">{children}</div>
      </div>
    </div>
  );
}

/** Header plus shell, which is how every admin page is composed. */
export function AdminPage({
  title,
  description,
  actions,
  meta,
  children,
  requireAdministrator,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  requireAdministrator?: boolean;
}) {
  return (
    <AdminShell requireAdministrator={requireAdministrator}>
      <AdminPageHeader title={title} description={description} actions={actions} meta={meta} />
      {children}
    </AdminShell>
  );
}

export { resolveAdminItem };
