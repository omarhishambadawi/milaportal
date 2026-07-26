import { describe, expect, it } from "vitest";

import {
  AGENT_CODE_ROLES,
  APP_ROLES,
  ASSIGNABLE_ROLES,
  RETIRED_ROLES,
  ROLE_LABEL,
  ROLE_TONE,
  canActOnRole,
  canAssignRole,
  isAppRole,
  isRetiredRole,
  roleHasAgentCode,
  roleLabel,
  roleTone,
  type AppRole,
} from "@/lib/roles";

/**
 * The authorization ladder, written out by hand.
 *
 * This is deliberately NOT derived from `ROLE_ASSIGNABLE_BY`. A test that reads
 * its expectations out of the module under test asserts only that the module
 * equals itself, and would pass unchanged if someone added `admin` to the
 * supervisor row. Restating the matrix independently is the whole point: an
 * intentional change has to be made twice, and an accidental one fails here.
 *
 * Read one row as: "an actor holding <key> may administer and grant <values>".
 *
 * Source of truth for these expectations is the product rule, not the code:
 *   - Owner is unrestricted and is the only source of Owner.
 *   - Admin may do everything except mint or touch an Owner.
 *   - Supervisor is confined to the shop floor: agents and auditors. NOT itself.
 *   - Agents and auditors administer nobody.
 */
const EXPECTED_LADDER: Record<AppRole, readonly AppRole[]> = {
  owner: ["owner", "admin", "supervisor", "customer_care", "telesales", "auditor"],
  admin: ["admin", "supervisor", "customer_care", "telesales", "auditor"],
  supervisor: ["customer_care", "telesales", "auditor"],
  customer_care: [],
  telesales: [],
  auditor: [],
};

/** Values that are not live roles, from every direction they can arrive. */
const NON_ROLES = [null, undefined, "", "call_center", "root", "ADMIN", "Owner", 42, {}] as const;

describe("APP_ROLES", () => {
  it("contains exactly the six live roles, most privileged first", () => {
    expect([...APP_ROLES]).toEqual([
      "owner",
      "admin",
      "supervisor",
      "customer_care",
      "telesales",
      "auditor",
    ]);
  });

  it("does not contain the retired call_center role", () => {
    expect(APP_ROLES).not.toContain("call_center");
    expect([...RETIRED_ROLES]).toEqual(["call_center"]);
  });

  it("has an exhaustive label and tone for every role", () => {
    for (const role of APP_ROLES) {
      expect(ROLE_LABEL[role], `label for ${role}`).toBeTruthy();
      expect(ROLE_TONE[role], `tone for ${role}`).toBeTruthy();
    }
  });

  it("excludes owner from the roles a dialog may offer", () => {
    // Ownership transfers through adminSetRole under the Owner-only checks and
    // the protect_last_owner trigger, never through a casual dropdown.
    expect(ASSIGNABLE_ROLES).not.toContain("owner");
    expect([...ASSIGNABLE_ROLES].sort()).toEqual(
      [...APP_ROLES].filter((r) => r !== "owner").sort(),
    );
  });
});

describe("isAppRole / isRetiredRole", () => {
  it("accepts every live role", () => {
    for (const role of APP_ROLES) expect(isAppRole(role)).toBe(true);
  });

  it.each(NON_ROLES)("rejects %p", (value) => {
    expect(isAppRole(value)).toBe(false);
  });

  it("identifies call_center as retired and nothing else", () => {
    expect(isRetiredRole("call_center")).toBe(true);
    for (const role of APP_ROLES) expect(isRetiredRole(role)).toBe(false);
    for (const value of NON_ROLES) {
      if (value === "call_center") continue;
      expect(isRetiredRole(value)).toBe(false);
    }
  });
});

describe("canAssignRole — every actor × target combination", () => {
  // 6 × 6. Every cell is asserted, so a widened row cannot slip through by
  // only being exercised in the cases someone remembered to write.
  for (const actor of APP_ROLES) {
    for (const target of APP_ROLES) {
      const expected = EXPECTED_LADDER[actor].includes(target);
      it(`${actor} ${expected ? "MAY" : "may NOT"} grant ${target}`, () => {
        expect(canAssignRole(actor, target)).toBe(expected);
      });
    }
  }

  it("refuses a retired role for every actor, the Owner included", () => {
    for (const actor of APP_ROLES) {
      expect(canAssignRole(actor, "call_center"), `${actor} → call_center`).toBe(false);
    }
  });

  it.each(NON_ROLES)("refuses unknown target %p for every actor", (target) => {
    for (const actor of APP_ROLES) {
      expect(canAssignRole(actor, target as string)).toBe(false);
    }
  });

  it.each(NON_ROLES)("refuses unknown actor %p for every target", (actor) => {
    for (const target of APP_ROLES) {
      expect(canAssignRole(actor as string, target)).toBe(false);
    }
  });
});

describe("canActOnRole — every actor × target combination", () => {
  for (const actor of APP_ROLES) {
    for (const target of APP_ROLES) {
      const expected = EXPECTED_LADDER[actor].includes(target);
      it(`${actor} ${expected ? "MAY" : "may NOT"} administer ${target}`, () => {
        expect(canActOnRole(actor, target)).toBe(expected);
      });
    }
  }

  it("lets anyone who may administer agents repair a user stranded on a dead role", () => {
    // A user left on the orphaned `call_center` value (or any role the app layer
    // no longer knows) must stay administrable, or they could never be moved
    // back onto a live role. The rule is "whoever may administer an agent".
    for (const actor of APP_ROLES) {
      const expected = EXPECTED_LADDER[actor].includes("customer_care");
      expect(canActOnRole(actor, "call_center"), `${actor} → call_center`).toBe(expected);
      expect(canActOnRole(actor, "some_future_role"), `${actor} → unknown`).toBe(expected);
      expect(canActOnRole(actor, null), `${actor} → null`).toBe(expected);
    }
  });

  it.each(NON_ROLES)("refuses unknown actor %p against every target", (actor) => {
    for (const target of APP_ROLES) {
      expect(canActOnRole(actor as string, target)).toBe(false);
    }
    expect(canActOnRole(actor as string, "call_center")).toBe(false);
  });
});

describe("escalation ceiling — the reason the ladder exists", () => {
  // Supervisor holds `manage_users`. Without a ceiling, "create and edit users"
  // includes role assignment, so a Supervisor could promote themselves or a
  // confederate to admin, or reset an admin's password and sign in as them.
  const ADMINISTRATIVE_TARGETS: AppRole[] = ["owner", "admin", "supervisor"];

  it.each(ADMINISTRATIVE_TARGETS)("a supervisor may not grant %s", (target) => {
    expect(canAssignRole("supervisor", target)).toBe(false);
  });

  it.each(ADMINISTRATIVE_TARGETS)("a supervisor may not administer %s", (target) => {
    expect(canActOnRole("supervisor", target)).toBe(false);
  });

  it("a supervisor cannot clone itself", () => {
    expect(canAssignRole("supervisor", "supervisor")).toBe(false);
    expect(canActOnRole("supervisor", "supervisor")).toBe(false);
  });

  it("an admin may administer another admin but may never reach an Owner", () => {
    // The rule is deliberately not a uniform ladder; this asymmetry is the
    // reason ROLE_ASSIGNABLE_BY is a table rather than numeric ranks.
    expect(canActOnRole("admin", "admin")).toBe(true);
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canActOnRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "owner")).toBe(false);
  });

  it("only an Owner is a source of Owner", () => {
    for (const actor of APP_ROLES) {
      expect(canAssignRole(actor, "owner"), `${actor} → owner`).toBe(actor === "owner");
    }
  });

  it("agents and auditors administer nobody at all", () => {
    for (const actor of ["customer_care", "telesales", "auditor"] as const) {
      for (const target of APP_ROLES) {
        expect(canAssignRole(actor, target), `${actor} → ${target}`).toBe(false);
        expect(canActOnRole(actor, target), `${actor} → ${target}`).toBe(false);
      }
      expect(canActOnRole(actor, "call_center")).toBe(false);
    }
  });
});

describe("agent codes", () => {
  it("belong to the two agent roles only", () => {
    expect([...AGENT_CODE_ROLES].sort()).toEqual(["customer_care", "telesales"]);
  });

  it.each(APP_ROLES)("roleHasAgentCode(%s) matches the agent roles", (role) => {
    expect(roleHasAgentCode(role)).toBe(role === "customer_care" || role === "telesales");
  });

  it.each(NON_ROLES)("returns false for the non-role %p", (value) => {
    expect(roleHasAgentCode(value as string)).toBe(false);
  });
});

describe("display helpers tolerate stale data", () => {
  it.each(NON_ROLES)("roleLabel(%p) falls back rather than throwing", (value) => {
    expect(roleLabel(value as string)).toBe("—");
  });

  it.each(NON_ROLES)("roleTone(%p) returns an empty class string", (value) => {
    expect(roleTone(value as string)).toBe("");
  });

  it.each(APP_ROLES)("roleLabel(%s) returns the mapped label", (role) => {
    expect(roleLabel(role)).toBe(ROLE_LABEL[role]);
    expect(roleTone(role)).toBe(ROLE_TONE[role]);
  });
});
