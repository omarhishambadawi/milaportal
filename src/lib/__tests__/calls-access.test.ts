import { describe, it, expect } from "vitest";
import { callsTeamForRole, callsPageAllowedForRole, type CallsPage } from "@/lib/calls-access";
import { canViewCallsPage } from "@/lib/permissions";
import { APP_ROLES } from "@/lib/roles";

const ALL_PAGES: CallsPage[] = [
  "overview",
  "customer_care",
  "telesales",
  "lookup",
  "analytics",
  "diagnostics",
  "configuration",
];

const TEAM_ROLES = ["customer_care", "telesales"] as const;
/** Everyone who is not confined to a single team's dashboard. */
const NON_AGENT_ROLES = APP_ROLES.filter((r) => !(TEAM_ROLES as readonly string[]).includes(r));

describe("callsTeamForRole", () => {
  it("confines exactly the two team-agent roles", () => {
    expect(callsTeamForRole("customer_care")).toBe("customer_care");
    expect(callsTeamForRole("telesales")).toBe("telesales");
    for (const role of NON_AGENT_ROLES) expect(callsTeamForRole(role)).toBeNull();
  });

  it("treats an absent or unknown role as unconfined", () => {
    // The permission gate is what refuses these; this function only answers
    // "which single team is this role locked to", and the answer is none.
    expect(callsTeamForRole(null)).toBeNull();
    expect(callsTeamForRole(undefined)).toBeNull();
    expect(callsTeamForRole("call_center")).toBeNull();
  });
});

describe("callsPageAllowedForRole", () => {
  it("lets every non-agent role reach every page in the module", () => {
    // Owner, admin, supervisor and auditor are unrestricted here; their actual
    // access is decided by the permission gate, not by this rule.
    for (const role of NON_AGENT_ROLES) {
      for (const page of ALL_PAGES) {
        expect(callsPageAllowedForRole(role, page), `${role} → ${page}`).toBe(true);
      }
    }
  });

  it("confines a team agent to their own dashboard", () => {
    expect(callsPageAllowedForRole("customer_care", "customer_care")).toBe(true);
    expect(callsPageAllowedForRole("customer_care", "telesales")).toBe(false);
    expect(callsPageAllowedForRole("telesales", "telesales")).toBe(true);
    expect(callsPageAllowedForRole("telesales", "customer_care")).toBe(false);
  });

  it("keeps the combined overview away from team agents", () => {
    // The overview reports one team's performance beside the other's, which is
    // the thing the confinement rule exists to prevent.
    for (const role of TEAM_ROLES) {
      expect(callsPageAllowedForRole(role, "overview")).toBe(false);
    }
  });

  it("keeps analytics, diagnostics and configuration away from team agents", () => {
    for (const role of TEAM_ROLES) {
      expect(callsPageAllowedForRole(role, "analytics")).toBe(false);
      expect(callsPageAllowedForRole(role, "diagnostics")).toBe(false);
      expect(callsPageAllowedForRole(role, "configuration")).toBe(false);
    }
  });

  it("opens Call Lookup to team agents as well", () => {
    // Deliberate and the ONLY exception. Lookup is a per-number contact
    // history — it aggregates nothing, ranks nobody and exposes no team's
    // performance — and it is most useful to the agent with that customer
    // already on the line. If this ever starts reporting a KPI, it must come
    // off the unconfined list.
    for (const role of TEAM_ROLES) {
      expect(callsPageAllowedForRole(role, "lookup")).toBe(true);
    }
  });
});

describe("canViewCallsPage", () => {
  it("refuses a role holding no call-centre permission, whatever the page", () => {
    // Telesales' own allow-list carries neither `view_call_center` nor
    // `view_team_analytics`, so an explicitly-permissioned telesales user is
    // refused everywhere — including the page they would otherwise be confined
    // to. The confinement rule narrows access; it never grants it.
    const perms = ["view_orders", "create_orders"];
    for (const page of ALL_PAGES) {
      expect(canViewCallsPage("telesales", perms, page), page).toBe(false);
    }
  });

  it("refuses an absent role outright", () => {
    for (const page of ALL_PAGES) {
      expect(canViewCallsPage(null, null, page), page).toBe(false);
    }
  });

  it("admits owner and admin to every page", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const page of ALL_PAGES) {
        expect(canViewCallsPage(role, null, page), `${role} → ${page}`).toBe(true);
      }
    }
  });

  it("admits supervisor and auditor to the combined overview", () => {
    // The two privileged non-admin roles the Overview was specified for. Both
    // reach it on their default permission sets, with no explicit grant.
    expect(canViewCallsPage("supervisor", null, "overview")).toBe(true);
    expect(canViewCallsPage("auditor", null, "overview")).toBe(true);
  });

  it("layers the confinement rule on top of the permission gate", () => {
    // Holding a call-centre permission is necessary but not sufficient for a
    // team agent: both checks have to pass. `view_team_analytics` is the one
    // Customer Care's allow-list actually carries.
    const perms = ["view_team_analytics"];
    expect(canViewCallsPage("customer_care", perms, "customer_care")).toBe(true);
    expect(canViewCallsPage("customer_care", perms, "telesales")).toBe(false);
    expect(canViewCallsPage("customer_care", perms, "overview")).toBe(false);
    expect(canViewCallsPage("customer_care", perms, "lookup")).toBe(true);
  });
});
