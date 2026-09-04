/**
 * The administration shell: one frame every admin page sits inside.
 *
 * ## It used to carry the navigation, and no longer does
 *
 * Administration had a rail inside the content area — a grouped vertical list
 * on wide screens, a horizontal scroller below `xl` — because a second
 * full-height sidebar would have competed with the app's own. That reasoning
 * was sound and the conclusion has been overtaken: the sidebar's Admin entry is
 * now a flyout listing the same destinations, so the rail was a second menu
 * open at the same time as the first, disagreeing about nothing but costing the
 * reader a decision about which one to use.
 *
 * The pages were always independent routes, so nothing had to move for that.
 * What is left here is what this component always really was: a permission gate
 * and a header. `ADMIN_NAV` is still the one list, now read by the sidebar and
 * by the overview cards.
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
import { Link } from "@tanstack/react-router";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { isAdministrator, useAuth } from "@/lib/auth";
import { resolveAdminItem } from "@/features/admin/nav";
import { AdminCard } from "./primitives";

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

  /*
   * No rail.
   *
   * Administration used to carry its own vertical navigation inside the content
   * area, which meant two menus were open at once and the sidebar's Admin entry
   * was a door into a second, differently-shaped menu. The pages are already
   * independent routes, so the sidebar's own flyout can list them directly and
   * this is left as what it always really was: a permission gate and a header.
   */
  return <div className="space-y-6">{children}</div>;
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
