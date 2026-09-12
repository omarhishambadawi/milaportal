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
import {
  Activity,
  ClipboardCheck,
  LayoutDashboard,
  RefreshCw,
  Settings2,
  Stethoscope,
  Users,
} from "lucide-react";

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
  /**
   * Whether this destination requires the owner role specifically.
   *
   * One entry needs it: call Configuration edits the PBX connection, which
   * `/calls/configuration` gates on `isOwnerRole` rather than on
   * `isAdministrator`. Listing it for every administrator would put a menu
   * entry in front of people the page then refuses.
   */
  ownerOnly?: boolean;
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
      {
        /*
         * The worklist `20260823120000` indexed and nothing queried.
         *
         * Filed under Shams CRM because that is the system an AlShrouq dispatch
         * travels through, and because an operator who has just read the sync
         * or diagnostics page is already in the right frame of mind for it.
         */
        to: "/admin/alshrouq-reconciliation",
        label: "Dispatch reconciliation",
        title: "AlShrouq dispatch reconciliation",
        description:
          "Dispatches the automated system could not settle, and what operators decided about them.",
        icon: ClipboardCheck,
        adminOnly: true,
      },
    ],
  },
  {
    /*
     * The telephony consoles, moved here from the Calls menu.
     *
     * They were the last two entries in the Calls flyout, below a separator,
     * and they never belonged there: Calls is where an agent reads their own
     * queue, while these two configure the PBX and diagnose its connection.
     * Neither is a page an agent opens, and both were already gated on
     * administrator or owner.
     *
     * The routes do not move. `/calls/diagnostics` and `/calls/configuration`
     * keep their URLs, their permissions and their pages; only which menu lists
     * them changes. Re-homing the routes as well would break every existing
     * link for a tidier path.
     */
    id: "telephony",
    label: "Telephony",
    items: [
      {
        to: "/calls/diagnostics",
        label: "Diagnostics",
        title: "Call diagnostics",
        description:
          "Connectivity, CDR retrieval and agent-mapping checks against the Yeastar PBX.",
        icon: Activity,
        adminOnly: true,
      },
      {
        to: "/calls/configuration",
        label: "Configuration",
        title: "Call configuration",
        description: "The PBX connection, queues and the call-centre environment.",
        icon: Settings2,
        adminOnly: true,
        ownerOnly: true,
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

/**
 * The admin destinations one viewer may actually open.
 *
 * The single filter, used by the sidebar flyout and by the overview cards, so
 * the menu and the page cannot disagree about what exists. Hiding an entry is a
 * courtesy either way -- every one of these routes enforces its own permission
 * in-page, so a hidden link is not the boundary.
 */
export function visibleAdminNav(access: { isAdmin: boolean; isOwner: boolean }): AdminNavGroup[] {
  return ADMIN_NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) => (access.isAdmin || !i.adminOnly) && (access.isOwner || !i.ownerOnly),
    ),
  })).filter((g) => g.items.length > 0);
}

/** The same list, flattened, for a menu that does not render group headings. */
export function visibleAdminItems(access: { isAdmin: boolean; isOwner: boolean }): AdminNavItem[] {
  return visibleAdminNav(access).flatMap((g) => g.items);
}

export { Activity as AdminActivityIcon };
