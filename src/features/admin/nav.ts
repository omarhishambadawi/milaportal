/**
 * The administration map.
 *
 * One list, grouped, and it contains **only destinations that exist**. Three of
 * the six `/admin/*` routes in this project are legacy redirects
 * (`branches` → `/branches`, `yeastar` and `yeastar-diagnostics` →
 * `/calls/diagnostics`), so they are deliberately absent: a nav entry that
 * bounces the reader somewhere else is worse than no entry.
 *
 * Sections a larger admin console would carry — Permissions, Alerts, System
 * Settings — are likewise absent, because this deployment has no such pages.
 * The group headings appear only when they have something in them, so the rail
 * grows with the product rather than advertising rooms that were never built.
 */

import type { LucideIcon } from "lucide-react";
import { Activity, LayoutDashboard, RefreshCw, Stethoscope, Users } from "lucide-react";

export interface AdminNavItem {
  to: string;
  label: string;
  /** One line, shown as the rail tooltip and on the overview cards. */
  description: string;
  icon: LucideIcon;
  /** Rendered as the page's own `<h1>` and in the breadcrumb. */
  title: string;
  /**
   * Whether this destination requires the administrator role.
   *
   * Not every page under `/admin` does. User management is gated on the
   * `manage_users` permission, which supervisors hold by default — so a
   * supervisor reaches `/admin/users` legitimately and must not be shown a rail
   * full of pages that would refuse them.
   */
  adminOnly: boolean;
}

export interface AdminNavGroup {
  id: string;
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    id: "overview",
    label: "Administration",
    items: [
      {
        to: "/admin",
        label: "Overview",
        title: "Admin overview",
        description: "Operational status across the systems this portal administers.",
        icon: LayoutDashboard,
        adminOnly: true,
      },
      {
        to: "/admin/users",
        label: "Users & roles",
        title: "Users and roles",
        description: "Accounts, roles, permissions and the administrative activity log.",
        icon: Users,
        // Gated on `manage_users`, not on the administrator role.
        adminOnly: false,
      },
    ],
  },
  {
    id: "integrations",
    label: "Shams CRM",
    items: [
      {
        to: "/admin/shams-sync",
        label: "Sync control",
        title: "Shams Sync Control Center",
        description:
          "Automated stock and promotions synchronisation with Shams CRM: schedules, manual runs and history.",
        icon: RefreshCw,
        adminOnly: true,
      },
      {
        to: "/admin/shams-diagnostics",
        label: "Diagnostics",
        title: "Shams diagnostics",
        description: "Connectivity, catalogue and credential checks against the Shams systems.",
        icon: Stethoscope,
        adminOnly: true,
      },
    ],
  },
];

/** Flat list, for lookups. */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap((g) => g.items);

/**
 * Which admin entry the current URL belongs to.
 *
 * Longest match wins, so `/admin/shams-sync` resolves to itself rather than
 * collapsing onto `/admin`.
 */
export function resolveAdminItem(pathname: string): AdminNavItem | null {
  const matches = ADMIN_NAV_ITEMS.filter(
    (i) => pathname === i.to || pathname.startsWith(`${i.to}/`),
  );
  return matches.sort((a, b) => b.to.length - a.to.length)[0] ?? null;
}

export { Activity as AdminActivityIcon };
