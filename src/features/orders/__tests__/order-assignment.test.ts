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
import { assignableAgents, isAssignableAgent, teamForAgent } from "../components/order-assignment";

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

/* -------------------------------------------------------------------------- */
/* Creator is not the assignee                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The rule: entering an order and owning it are different acts.
 *
 * The form used to collapse them — a new order was always filed under whoever
 * typed it — which put owners, admins and supervisors into `agent_id`, and from
 * there into agent workload, the team split and the "My orders" filter. Only
 * someone who can actually hold a caseload may be the assignee, and that is
 * exactly the set with a team.
 */
describe("who may be assigned an order", () => {
  it("accepts the two operational roles", () => {
    expect(isAssignableAgent({ role: "customer_care" })).toBe(true);
    expect(isAssignableAgent({ role: "telesales" })).toBe(true);
  });

  it("refuses an owner, an admin and a supervisor", () => {
    // A supervisor is not a caseload. They create orders; they do not hold them.
    expect(isAssignableAgent({ role: "owner" })).toBe(false);
    expect(isAssignableAgent({ role: "admin" })).toBe(false);
    expect(isAssignableAgent({ role: "supervisor" })).toBe(false);
    expect(isAssignableAgent({ role: "auditor" })).toBe(false);
  });

  it("refuses a directory entry whose role RLS hid", () => {
    expect(isAssignableAgent({ role: null })).toBe(false);
    expect(isAssignableAgent(undefined)).toBe(false);
  });
});

describe("the agent picker's list", () => {
  const directory = [
    { id: "owner-1", full_name: "Omar", agent_code: null, role: "owner" },
    { id: "sup-1", full_name: "Sara Supervisor", agent_code: null, role: "supervisor" },
    { id: "cc-1", full_name: "Ahmed Mohamed", agent_code: "CC-01", role: "customer_care" },
    { id: "ts-1", full_name: "Sara Ali", agent_code: "TS-04", role: "telesales" },
    { id: "aud-1", full_name: "Auditor", agent_code: null, role: "auditor" },
  ];

  it("offers agents only — no owner, supervisor or auditor", () => {
    expect(assignableAgents(directory).map((a) => a.id)).toEqual(["cc-1", "ts-1"]);
  });

  it("is empty rather than wrong when the directory has not loaded", () => {
    expect(assignableAgents(undefined)).toEqual([]);
  });

  it("derives the team from whichever agent is picked", () => {
    const ahmed = directory.find((a) => a.id === "cc-1");
    const sara = directory.find((a) => a.id === "ts-1");
    expect(teamForAgent(ahmed)).toBe("customer_care");
    expect(teamForAgent(sara)).toBe("telesales");
  });
});

/**
 * Seeding a new order's assignee.
 *
 * Mirrors `creatorIsAgent` in `use-order-form`: an agent's own new order is
 * theirs, and anyone else starts with the field empty and has to choose.
 */
describe("a newly created order's assignee", () => {
  const seed = (creatorRole: string | null) =>
    isAssignableAgent({ role: creatorRole }) ? "creator" : "";

  it("is the creator when an agent takes the order down", () => {
    expect(seed("customer_care")).toBe("creator");
    expect(seed("telesales")).toBe("creator");
  });

  it("is empty when an owner creates it", () => {
    expect(seed("owner")).toBe("");
  });

  it("is empty when a supervisor creates it", () => {
    expect(seed("supervisor")).toBe("");
  });

  it("is empty when an admin creates it", () => {
    expect(seed("admin")).toBe("");
  });
});
