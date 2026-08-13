/**
 * Assignment: who may reassign an order, and how the team follows the agent.
 *
 * Two rules, and they are enforced in different places. *Who may* is RBAC —
 * `isAdministrator` in the UI, `prevent_order_reassignment` in the database, and
 * the UI's rule is deliberately the narrower of the two so it can never offer
 * something the database would refuse. *Which team* is a derivation, not a
 * choice, which is the whole point of removing the team selector.
 */

import { describe, expect, it } from "vitest";
import { isAdministrator } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { teamForAgent } from "../components/order-assignment";

/* -------------------------------------------------------------------------- */
/* Who may assign                                                              */
/* -------------------------------------------------------------------------- */

describe("who may assign an order", () => {
  it("allows the owner", () => {
    expect(isAdministrator("owner")).toBe(true);
  });

  it("allows an administrator", () => {
    expect(isAdministrator("admin")).toBe(true);
  });

  it("refuses both agent roles", () => {
    expect(isAdministrator("customer_care")).toBe(false);
    expect(isAdministrator("telesales")).toBe(false);
  });

  it("refuses an auditor and a supervisor", () => {
    // Supervisor holds `edit_all_orders`, so the *database* would let them
    // reassign. The control is narrower on purpose: this phase was asked for
    // Owner and Admin, and narrowing the UI cannot grant anything.
    expect(isAdministrator("auditor")).toBe(false);
    expect(isAdministrator("supervisor")).toBe(false);
    expect(hasPerm("supervisor", null, "edit_all_orders")).toBe(true);
  });

  it("refuses an unauthenticated or unknown role", () => {
    expect(isAdministrator(null)).toBe(false);
    expect(isAdministrator(undefined)).toBe(false);
  });

  it("does not give an agent the underlying reassignment permission either", () => {
    // Belt and braces: even if the control were rendered, the database rule
    // `prevent_order_reassignment` keys on this and would refuse.
    expect(hasPerm("customer_care", null, "edit_all_orders")).toBe(false);
    expect(hasPerm("telesales", null, "edit_all_orders")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The team follows the agent                                                  */
/* -------------------------------------------------------------------------- */

describe("teamForAgent", () => {
  it("reads the team off a Customer Care agent", () => {
    expect(teamForAgent({ role: "customer_care" })).toBe("customer_care");
  });

  it("reads the team off a Telesales agent", () => {
    expect(teamForAgent({ role: "telesales" })).toBe("telesales");
  });

  it("changes the derived team when the agent changes", () => {
    // The behaviour the removed team selector made impossible to guarantee.
    const before = teamForAgent({ role: "customer_care" });
    const after = teamForAgent({ role: "telesales" });
    expect(before).toBe("customer_care");
    expect(after).toBe("telesales");
    expect(before).not.toBe(after);
  });

  it("has no team for a role that does not take orders", () => {
    // The caller keeps whatever the order already had rather than inventing one.
    expect(teamForAgent({ role: "admin" })).toBeNull();
    expect(teamForAgent({ role: "owner" })).toBeNull();
    expect(teamForAgent({ role: "auditor" })).toBeNull();
    expect(teamForAgent({ role: "supervisor" })).toBeNull();
  });

  it("has no team when RLS hid the role, rather than guessing one", () => {
    expect(teamForAgent({ role: null })).toBeNull();
    expect(teamForAgent(undefined)).toBeNull();
  });
});
