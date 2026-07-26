import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  canViewCallCenter,
  defaultPermsForRole,
  hasPerm,
} from "@/lib/permissions";
import { APP_ROLES, type AppRole } from "@/lib/roles";

/**
 * Expected permission sets, restated by hand.
 *
 * Three independent copies of this model now exist: `has_permission()` in SQL
 * (authoritative), `src/lib/permissions.ts` (what the UI renders from), and this
 * table. `scripts/check-permission-parity.mjs` already proves the first two
 * agree — but it proves only that they agree, so a change applied wrongly to
 * BOTH still passes it. This table is the third opinion: it says what the sets
 * are supposed to be, so an intentional grant has to be written down here too.
 *
 * `allowed` is the ceiling: the most a role may ever hold, even when an
 * administrator has stored an explicit permission array on the account.
 * `defaults` is what the role holds when no explicit array is stored (an empty
 * stored array means "follow role defaults").
 */
interface RoleExpectation {
  allowed: string[];
  defaults: string[];
}

const CUSTOMER_CARE_DEFAULTS = [
  "view_orders",
  "create_orders",
  "edit_orders",
  "view_complaints",
  "create_complaints",
  "edit_complaints",
  "resolve_complaints",
  "view_dashboard",
  "view_team_analytics",
  "verify_own_orders",
  "view_branches",
];

const TELESALES_DEFAULTS = [
  "view_orders",
  "create_orders",
  "edit_orders",
  "view_dashboard",
  "verify_own_orders",
  "view_branches",
];

/** Read-only by construction: nothing here creates, edits, resolves or deletes. */
const AUDITOR_SET = [
  "view_orders",
  "view_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_call_center",
  "view_invoice_analytics",
  "view_reports",
  "export_reports",
  "view_branches",
];

/** Everything except the two destructive permissions. Supervisor cannot delete. */
const SUPERVISOR_SET = [
  "view_orders",
  "create_orders",
  "edit_orders",
  "edit_all_orders",
  "view_complaints",
  "create_complaints",
  "edit_complaints",
  "edit_all_complaints",
  "resolve_complaints",
  "resolve_all_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_call_center",
  "export_reports",
  "verify_own_orders",
  "verify_all_orders",
  "view_invoice_analytics",
  "view_branches",
  "view_reports",
  "manage_users",
  "admin_access",
];

const EXPECTED: Record<Exclude<AppRole, "owner" | "admin">, RoleExpectation> = {
  supervisor: { allowed: SUPERVISOR_SET, defaults: SUPERVISOR_SET },
  customer_care: {
    allowed: [...CUSTOMER_CARE_DEFAULTS, "view_invoice_analytics", "export_reports"],
    defaults: CUSTOMER_CARE_DEFAULTS,
  },
  telesales: {
    allowed: [
      ...TELESALES_DEFAULTS,
      "view_team_analytics",
      "view_invoice_analytics",
      "export_reports",
    ],
    defaults: TELESALES_DEFAULTS,
  },
  auditor: { allowed: AUDITOR_SET, defaults: AUDITOR_SET },
};

const ADMINISTRATORS: AppRole[] = ["owner", "admin"];
const NON_ADMIN_ROLES = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];
const ALL_KEYS = ALL_PERMISSIONS.map((p) => p.key);

describe("ALL_PERMISSIONS", () => {
  it("has unique keys and a label and group for each", () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    for (const perm of ALL_PERMISSIONS) {
      expect(perm.label, `label for ${perm.key}`).toBeTruthy();
      expect(perm.group, `group for ${perm.key}`).toBeTruthy();
    }
  });

  it("no longer declares the phantom manage_roles permission", () => {
    // It rendered a checkbox but was enforced nowhere: has_permission()
    // short-circuits to true for owner/admin, so unticking it looked like it
    // revoked role management while changing nothing.
    expect(ALL_KEYS).not.toContain("manage_roles");
  });
});

describe("hasPerm — administrators short-circuit", () => {
  for (const role of ADMINISTRATORS) {
    it(`${role} holds every declared permission`, () => {
      for (const key of ALL_KEYS) {
        expect(hasPerm(role, null, key), `${role} → ${key}`).toBe(true);
      }
    });

    it(`${role} short-circuits even for an undeclared permission key`, () => {
      expect(hasPerm(role, [], "some_permission_added_later")).toBe(true);
    });

    it(`${role} is unaffected by a restrictive stored permission array`, () => {
      // The short-circuit runs before the stored array is consulted, so an empty
      // or narrow array cannot lock an administrator out of the platform.
      expect(hasPerm(role, [], "manage_users")).toBe(true);
      expect(hasPerm(role, ["view_orders"], "delete_orders")).toBe(true);
    });
  }
});

describe("hasPerm — role defaults, every role × every permission", () => {
  for (const role of NON_ADMIN_ROLES) {
    const { defaults } = EXPECTED[role];
    for (const key of ALL_KEYS) {
      const expected = defaults.includes(key);
      it(`${role} ${expected ? "holds" : "does not hold"} ${key} by default`, () => {
        // null and [] both mean "no explicit array stored" -> follow defaults.
        expect(hasPerm(role, null, key)).toBe(expected);
        expect(hasPerm(role, [], key)).toBe(expected);
        expect(hasPerm(role, undefined, key)).toBe(expected);
      });
    }
  }
});

describe("hasPerm — the allowed ceiling, every role × every permission", () => {
  for (const role of NON_ADMIN_ROLES) {
    const { allowed } = EXPECTED[role];
    for (const key of ALL_KEYS) {
      const expected = allowed.includes(key);
      it(`${role} ${expected ? "may" : "may NEVER"} be granted ${key} explicitly`, () => {
        // Store the permission on the account and ask again. Above the ceiling
        // the answer must still be false — this is the second line of defence
        // behind the per-role `_allowed` array in has_permission().
        expect(hasPerm(role, [key], key)).toBe(expected);
      });
    }
  }
});

describe("hasPerm — escalation regressions", () => {
  it("cannot be escalated past the ceiling by storing an administrative permission", () => {
    // The concrete attack: an admin (or a bug) writes `permissions` containing
    // manage_users onto an agent account. The stored array must not be able to
    // grant what the role may not hold.
    for (const role of ["customer_care", "telesales", "auditor"] as const) {
      expect(hasPerm(role, ["manage_users"], "manage_users"), role).toBe(false);
      expect(hasPerm(role, ["admin_access"], "admin_access"), role).toBe(false);
    }
    // `view_reports` is administrative for the two agent roles but is inside the
    // auditor ceiling on purpose — the auditor exists to read everything.
    expect(hasPerm("customer_care", ["view_reports"], "view_reports")).toBe(false);
    expect(hasPerm("telesales", ["view_reports"], "view_reports")).toBe(false);
    expect(hasPerm("auditor", ["view_reports"], "view_reports")).toBe(true);
  });

  it("never lets a non-administrator delete", () => {
    // delete_orders / delete_complaints are absent from every non-admin ceiling,
    // which is what confines destructive actions to owner/admin.
    for (const role of NON_ADMIN_ROLES) {
      for (const key of ["delete_orders", "delete_complaints"]) {
        expect(hasPerm(role, null, key), `${role} default → ${key}`).toBe(false);
        expect(hasPerm(role, [key], key), `${role} explicit → ${key}`).toBe(false);
      }
    }
  });

  it("keeps the auditor read-only whatever is stored on the account", () => {
    const mutating = ALL_KEYS.filter((k) => !AUDITOR_SET.includes(k));
    expect(mutating.length).toBeGreaterThan(0);
    for (const key of mutating) {
      expect(hasPerm("auditor", [key], key), `auditor → ${key}`).toBe(false);
    }
    // Even handed the whole permission list at once.
    for (const key of mutating) {
      expect(hasPerm("auditor", ALL_KEYS, key), `auditor (all) → ${key}`).toBe(false);
    }
  });

  it("intersects the stored array with the ceiling rather than replacing it", () => {
    // A stored array narrows as well as selects: a permission inside the ceiling
    // but absent from the array is not held.
    expect(hasPerm("customer_care", ["view_orders"], "view_orders")).toBe(true);
    expect(hasPerm("customer_care", ["view_orders"], "create_orders")).toBe(false);
  });

  it("grants an in-ceiling permission that is not a default when stored explicitly", () => {
    // export_reports is allowed for telesales but not granted by default; this
    // is the case that proves `allowed` and `defaults` are distinct.
    expect(hasPerm("telesales", null, "export_reports")).toBe(false);
    expect(hasPerm("telesales", ["export_reports"], "export_reports")).toBe(true);
  });
});

describe("hasPerm — unknown and retired inputs deny rather than throw", () => {
  it("returns false for a null role", () => {
    for (const key of ALL_KEYS) expect(hasPerm(null, ["manage_users"], key)).toBe(false);
  });

  it("denies every permission to the retired call_center role", () => {
    // Regression: indexing straight into the role tables threw a TypeError on
    // `undefined.includes(...)`, which took the whole page down instead of
    // simply refusing the permission. `supervisor` hit exactly that before it
    // was wired in, and any role the database carries but the app does not know
    // can hit it again.
    for (const key of ALL_KEYS) {
      expect(() => hasPerm("call_center" as AppRole, null, key)).not.toThrow();
      expect(hasPerm("call_center" as AppRole, null, key), key).toBe(false);
      expect(hasPerm("call_center" as AppRole, ALL_KEYS, key), key).toBe(false);
    }
  });

  it("denies every permission to a role the app layer does not know", () => {
    for (const key of ALL_KEYS) {
      expect(() => hasPerm("future_role" as AppRole, ALL_KEYS, key)).not.toThrow();
      expect(hasPerm("future_role" as AppRole, ALL_KEYS, key), key).toBe(false);
    }
  });

  it("denies an unknown permission key for every non-administrator role", () => {
    for (const role of NON_ADMIN_ROLES) {
      expect(hasPerm(role, null, "not_a_permission"), role).toBe(false);
      expect(hasPerm(role, ["not_a_permission"], "not_a_permission"), role).toBe(false);
    }
  });
});

describe("defaultPermsForRole", () => {
  it("returns the full permission list for administrators", () => {
    for (const role of ADMINISTRATORS) {
      expect([...defaultPermsForRole(role)].sort()).toEqual([...ALL_KEYS].sort());
    }
  });

  it.each(NON_ADMIN_ROLES)("returns exactly the expected default set for %s", (role) => {
    expect([...defaultPermsForRole(role)].sort()).toEqual([...EXPECTED[role].defaults].sort());
  });

  it("never returns a default outside the role's own ceiling", () => {
    for (const role of NON_ADMIN_ROLES) {
      for (const key of defaultPermsForRole(role)) {
        expect(EXPECTED[role].allowed, `${role} default ${key} is above its ceiling`).toContain(
          key,
        );
      }
    }
  });

  it("agrees with hasPerm for every role and permission", () => {
    // The dialog seeds its switches from defaultPermsForRole; the gate is
    // hasPerm. If they disagree, the UI shows a permission the app then refuses.
    for (const role of APP_ROLES) {
      const defaults = defaultPermsForRole(role);
      for (const key of ALL_KEYS) {
        expect(hasPerm(role, null, key), `${role} → ${key}`).toBe(defaults.includes(key));
      }
    }
  });
});

describe("canViewCallCenter", () => {
  it("admits administrators through the hasPerm short-circuit", () => {
    for (const role of ADMINISTRATORS) {
      expect(canViewCallCenter(role, [])).toBe(true);
    }
  });

  it("admits any role holding view_call_center or view_team_analytics", () => {
    // Supervisor, customer_care and auditor all hold one of the two by default.
    expect(canViewCallCenter("supervisor", null)).toBe(true);
    expect(canViewCallCenter("customer_care", null)).toBe(true);
    expect(canViewCallCenter("auditor", null)).toBe(true);
  });

  it("refuses telesales by default and admits it once view_team_analytics is granted", () => {
    // view_team_analytics is inside the telesales ceiling but not a default.
    expect(canViewCallCenter("telesales", null)).toBe(false);
    expect(canViewCallCenter("telesales", ["view_team_analytics"])).toBe(true);
  });

  it("refuses a null role and a retired role", () => {
    expect(canViewCallCenter(null, ["view_call_center"])).toBe(false);
    expect(canViewCallCenter("call_center" as AppRole, ["view_call_center"])).toBe(false);
  });
});
