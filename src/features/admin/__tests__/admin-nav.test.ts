import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADMIN_NAV, ADMIN_NAV_ITEMS, visibleAdminItems, resolveAdminItem } from "../nav";

/**
 * Administration as a sidebar flyout.
 *
 * The shape being pinned: one list of admin destinations, rendered by the
 * sidebar rather than by a rail inside the page, with the two telephony
 * consoles moved in from the Calls menu and Users no longer hoisted out beside
 * it as a top-level item.
 *
 * Structure is a pure value, so most of this is asserted by calling the list.
 * The two things that are not — which menu a route is listed under, and whether
 * the page still carries its own rail — are read from the source, the technique
 * `queue-isolation` established.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const LAYOUT = "routes/_app.tsx";
const SHELL = "features/admin/components/admin-shell.tsx";
const SIDEBAR = "components/app-sidebar.tsx";

const OWNER = { isAdmin: true, isOwner: true };
const ADMIN = { isAdmin: true, isOwner: false };
const SUPERVISOR = { isAdmin: false, isOwner: false };

const to = (access: { isAdmin: boolean; isOwner: boolean }) =>
  visibleAdminItems(access).map((i) => i.to);

/* ===================================================================== */
/* A. What the Admin flyout lists                                        */
/* ===================================================================== */

describe("the Admin flyout", () => {
  it("carries every admin page plus the two telephony consoles", () => {
    expect(to(OWNER)).toEqual([
      "/admin",
      "/admin/users",
      "/admin/shams-sync",
      "/admin/shams-diagnostics",
      "/admin/alshrouq-reconciliation",
      "/calls/diagnostics",
      "/calls/configuration",
    ]);
  });

  it("keeps the telephony routes where they were", () => {
    /*
     * Only the menu moved. Re-homing `/calls/diagnostics` under `/admin` would
     * have broken every existing link and bookmark for a tidier path.
     */
    const telephony = ADMIN_NAV.find((g) => g.id === "telephony");
    expect(telephony?.items.map((i) => i.to)).toEqual([
      "/calls/diagnostics",
      "/calls/configuration",
    ]);
  });

  it("points at pages that exist", () => {
    // A menu entry that leads nowhere is worse than no entry.
    const fileFor: Record<string, string> = {
      "/admin": "routes/_app.admin.index.tsx",
      "/admin/users": "routes/_app.admin.users.tsx",
      "/admin/shams-sync": "routes/_app.admin.shams-sync.tsx",
      "/admin/shams-diagnostics": "routes/_app.admin.shams-diagnostics.tsx",
      "/admin/alshrouq-reconciliation": "routes/_app.admin.alshrouq-reconciliation.tsx",
      "/calls/diagnostics": "routes/_app.calls.diagnostics.tsx",
      "/calls/configuration": "routes/_app.calls.configuration.tsx",
    };
    for (const item of ADMIN_NAV_ITEMS) {
      expect(fileFor[item.to], `no route file mapped for ${item.to}`).toBeTruthy();
      expect(existsSync(join(ROOT, fileFor[item.to])), item.to).toBe(true);
    }
  });

  it("gives every entry a label and a description", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.label.length, item.to).toBeGreaterThan(0);
      expect(item.title.length, item.to).toBeGreaterThan(0);
      expect(item.description.length, item.to).toBeGreaterThan(15);
    }
  });

  it("resolves the current URL to its entry, longest match first", () => {
    expect(resolveAdminItem("/admin")?.to).toBe("/admin");
    expect(resolveAdminItem("/admin/shams-sync")?.to).toBe("/admin/shams-sync");
    expect(resolveAdminItem("/calls/configuration")?.to).toBe("/calls/configuration");
    expect(resolveAdminItem("/orders")).toBeNull();
  });
});

/* ===================================================================== */
/* B. Who sees what                                                      */
/* ===================================================================== */

describe("admin flyout visibility", () => {
  it("shows an administrator everything except the owner-only console", () => {
    /*
     * `/calls/configuration` edits the PBX connection and gates on
     * `isOwnerRole`, not `isAdministrator`. Listing it for every administrator
     * would be a menu entry the page then refuses.
     */
    expect(to(ADMIN)).not.toContain("/calls/configuration");
    expect(to(ADMIN)).toContain("/calls/diagnostics");
  });

  it("shows an owner the configuration console too", () => {
    expect(to(OWNER)).toContain("/calls/configuration");
  });

  it("shows a supervisor only the page they can open", () => {
    // A supervisor holds `manage_users` and reaches `/admin/users`
    // legitimately, but cannot open the consoles.
    expect(to(SUPERVISOR)).toEqual(["/admin/users"]);
  });

  it("drops a group once nothing in it is visible", () => {
    // Otherwise a supervisor would see "Shams CRM" and "Telephony" headings
    // over nothing at all.
    const groups = ADMIN_NAV.filter((g) => g.items.some((i) => !i.adminOnly && !i.ownerOnly)).map(
      (g) => g.id,
    );
    expect(groups).toEqual(["overview"]);
  });

  it("hiding an entry is never the boundary", () => {
    /*
     * Every one of these routes enforces its own permission in-page, so a
     * hidden link costs an unauthorised viewer nothing to guess.
     */
    for (const rel of [
      "routes/_app.admin.shams-sync.tsx",
      "routes/_app.admin.shams-diagnostics.tsx",
      "routes/_app.calls.diagnostics.tsx",
      "routes/_app.calls.configuration.tsx",
    ]) {
      const text = source(rel);
      expect(
        /isAdministrator|isOwnerRole|AdminPage|canViewCallsPage|requireAdministrator/.test(text),
        rel,
      ).toBe(true);
    }
  });
});

/* ===================================================================== */
/* C. The sidebar                                                        */
/* ===================================================================== */

describe("the main sidebar", () => {
  const layout = source(LAYOUT);

  it("no longer carries Users as a top-level item", () => {
    // Users belongs to Admin, and having it in both places gave one admin page
    // a shortcut the others did not have.
    expect(layout).not.toMatch(/to: "\/admin\/users", label: "Users"/);
    expect(layout).not.toMatch(/label: "Users"/);
  });

  it("builds the Admin children from the one nav definition", () => {
    // Not a second hand-written list that could drift from the overview cards.
    expect(layout).toContain("visibleAdminItems");
    expect(layout).toMatch(/children: adminItems\.map/);
  });

  it("still keeps Users reachable for a supervisor", () => {
    // They cannot open `/admin` itself, so the parent points at their first
    // available page rather than at a refusal.
    expect(layout).toContain('isAdministrator(role) ? "/admin" : adminItems[0].to');
    expect(layout).toMatch(/i\.to !== "\/admin\/users" \|\| canUsers/);
  });

  it("hides Administration entirely when nothing in it is reachable", () => {
    /*
     * `visibleAdminItems` alone leaves Users for any role, because it is gated
     * on `manage_users` rather than on the role -- so the layout applies that
     * permission on top, and an agent holding neither ends with an empty list
     * and no entry at all.
     */
    expect(to({ isAdmin: false, isOwner: false })).toEqual(["/admin/users"]);
    const withoutManageUsers = to({ isAdmin: false, isOwner: false }).filter(
      (t) => t !== "/admin/users",
    );
    expect(withoutManageUsers).toEqual([]);
    expect(layout).toContain("adminItems.length > 0");
  });
});

describe("the Calls flyout", () => {
  const layout = source(LAYOUT);
  // Everything between the Calls entry and the CRM entry that follows it.
  const calls = layout.slice(layout.indexOf('label: "Calls"'), layout.indexOf('label: "CRM"'));

  it("no longer lists Diagnostics or Configuration", () => {
    expect(calls).not.toContain("/calls/diagnostics");
    expect(calls).not.toContain("/calls/configuration");
  });

  it("keeps the pages an agent actually uses", () => {
    for (const child of [
      "/calls/overview",
      "/calls/customer-care",
      "/calls/telesales",
      "/calls/lookup",
    ]) {
      expect(calls, child).toContain(child);
    }
  });
});

/* ===================================================================== */
/* D. The rail is gone, the flyout is the navigation                     */
/* ===================================================================== */

describe("the admin page shell", () => {
  const shell = source(SHELL);

  it("renders no internal navigation", () => {
    // Two menus open at once, disagreeing about nothing but costing the reader
    // a decision about which one to use.
    expect(shell).not.toContain("AdminRailDesktop");
    expect(shell).not.toContain("AdminRailMobile");
    expect(shell).not.toContain("RailLink");
    expect(shell).not.toContain('aria-label="Administration"');
  });

  it("keeps the permission gate and the header", () => {
    // The shell's remaining job. Removing it would change what a non-admin
    // sees, not what they can do.
    expect(shell).toContain("Administrator access required");
    expect(shell).toContain("requireAdministrator");
    expect(shell).toContain("AdminPageHeader");
    expect(shell).toContain('aria-label="Breadcrumb"');
  });

  it("keeps every page composing through it", () => {
    for (const rel of [
      "routes/_app.admin.index.tsx",
      "routes/_app.admin.users.tsx",
      "routes/_app.admin.shams-sync.tsx",
      "routes/_app.admin.shams-diagnostics.tsx",
    ]) {
      expect(source(rel), rel).toContain("AdminPage");
    }
  });
});

/* ===================================================================== */
/* E. The flyout trigger                                                 */
/* ===================================================================== */

describe("the flyout chevron", () => {
  const sidebar = source(SIDEBAR);

  it("is vertically centred in the rail, not pinned to the top corner", () => {
    /*
     * It sat level with the icon's top edge and read as misaligned against
     * every other control -- and with two flyouts now, the inconsistency was
     * doubled.
     */
    expect(sidebar).toContain("top-1/2 h-4 w-4 -translate-y-1/2");
    expect(sidebar).not.toContain("right-0.5 top-0.5");
  });

  it("is one component, so Calls and Admin cannot drift apart", () => {
    // Both triggers render through the same branch; there is no per-item
    // styling to keep in step.
    const triggers = sidebar.match(/data-flyout-toggle/g) ?? [];
    expect(triggers).toHaveLength(1);
  });
});
