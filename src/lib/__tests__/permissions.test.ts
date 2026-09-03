import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
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
  "view_shams_mis",
];

const TELESALES_DEFAULTS = [
  "view_orders",
  "create_orders",
  "edit_orders",
  "view_dashboard",
  "verify_own_orders",
  "view_branches",
  "view_shams_mis",
  "view_telesales",
  "work_telesales",
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
  "view_shams_mis",
  "view_telesales",
  "work_telesales",
  "manage_telesales",
];

/**
 * The auditor is the one role whose ceiling is wider than its defaults.
 *
 * `view_shams_mis` and `view_telesales` are grantable to an individual auditor
 * but held by none of them automatically — the mechanism behind "this auditor may
 * see Shams MIS, auditors may not".
 */
const AUDITOR_CEILING = [...AUDITOR_SET, "view_shams_mis", "view_telesales"];

const EXPECTED: Record<Exclude<AppRole, "owner" | "admin">, RoleExpectation> = {
  supervisor: { allowed: SUPERVISOR_SET, defaults: SUPERVISOR_SET },
  customer_care: {
    allowed: [
      ...CUSTOMER_CARE_DEFAULTS,
      "view_invoice_analytics",
      "export_reports",
      // Grantable, off by default: the two agent teams cover for one another on
      // the phones, and reading a lead history without being able to act on it
      // is the right shape for that.
      "view_telesales",
    ],
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
  auditor: { allowed: AUDITOR_CEILING, defaults: AUDITOR_SET },
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
    const mutating = ALL_KEYS.filter((k) => !AUDITOR_CEILING.includes(k));
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

  /**
   * The Shams MIS page. Operational roles get it; the auditor does not, but one
   * auditor can be handed it through the same per-user permission array every
   * other grant uses — no list of user ids, no second mechanism.
   */
  it("gives Shams MIS to the operational roles by default", () => {
    for (const role of ["owner", "admin", "supervisor", "customer_care", "telesales"] as const) {
      expect(hasPerm(role, null, "view_shams_mis"), `${role} → shams`).toBe(true);
    }
  });

  it("denies Shams MIS to an auditor by default", () => {
    expect(hasPerm("auditor", null, "view_shams_mis")).toBe(false);
    expect(hasPerm("auditor", [], "view_shams_mis")).toBe(false);
  });

  it("grants Shams MIS to an auditor whose account lists it explicitly", () => {
    expect(hasPerm("auditor", ["view_shams_mis"], "view_shams_mis")).toBe(true);
    expect(hasPerm("auditor", ["view_orders", "view_shams_mis"], "view_shams_mis")).toBe(true);
  });

  it("does not give one granted auditor's access to the next", () => {
    // The grant lives on the account, not on the role.
    expect(hasPerm("auditor", ["view_shams_mis"], "view_shams_mis")).toBe(true);
    expect(hasPerm("auditor", ["view_orders"], "view_shams_mis")).toBe(false);
  });

  it("refuses Shams MIS to a role that has no entry at all", () => {
    expect(hasPerm(null, ["view_shams_mis"], "view_shams_mis")).toBe(false);
    expect(hasPerm("call_center" as never, ["view_shams_mis"], "view_shams_mis")).toBe(false);
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

/* ===================================================================== */
/* CRM visibility                                                        */
/* ===================================================================== */

describe("CRM sidebar visibility", () => {
  /*
   * The sidebar renders the CRM item when `hasPerm(role, perms,
   * "view_telesales")` is true — `src/routes/_app.tsx` computes exactly that
   * and nothing else. So these assertions are the sidebar's rule, not a model
   * of it, and the chain the desk asked for is:
   *
   *     Rules -> view_telesales -> sidebar
   *
   * The permission key stays `view_telesales`; only the label says CRM. The key
   * is the RLS predicate on eleven tables and the argument to
   * `has_permission()` in SQL, so renaming it would be a migration and a
   * re-grant of every user to change a string nobody outside the code reads.
   */
  const crmVisible = (role: AppRole | null, perms: string[] | null) =>
    hasPerm(role, perms, "view_telesales");

  it("is visible by default to Owner, Admin, Supervisor and Telesales", () => {
    for (const role of ["owner", "admin", "supervisor", "telesales"] as AppRole[]) {
      // `null` perms means "follow the role defaults", which is how every
      // account that has never been individually edited is stored.
      expect(crmVisible(role, null), `${role} should see the CRM`).toBe(true);
    }
  });

  it("is hidden by default from Customer Care and Auditor", () => {
    for (const role of ["customer_care", "auditor"] as AppRole[]) {
      expect(crmVisible(role, null), `${role} should not see the CRM`).toBe(false);
    }
  });

  it("appears for a role once an administrator grants the rule", () => {
    /*
     * The requirement that stops the role list being the source of truth: an
     * administrator ticks View CRM in the permission editor and the item
     * appears, with no release. Both roles list `view_telesales` in their
     * *allowed* ceiling, which is what makes the grant stick.
     */
    expect(crmVisible("customer_care", ["view_telesales"])).toBe(true);
    expect(crmVisible("auditor", ["view_telesales"])).toBe(true);
  });

  it("disappears again when the rule is withdrawn", () => {
    // Reversible, and reversible through the same mechanism.
    expect(crmVisible("customer_care", ["view_orders"])).toBe(false);
  });

  it("cannot be granted to a role outside its ceiling", () => {
    /*
     * `manage_telesales` is absent from the telesales role's allowed ceiling as
     * well as its defaults: an agent who could reassign leads to themselves is
     * the ownership problem the module exists to remove. Storing the key on the
     * account must not be enough.
     */
    expect(hasPerm("telesales", ["manage_telesales"], "manage_telesales")).toBe(false);
  });

  it("shows the CRM permissions in the editor, so Rules can actually reach them", () => {
    /*
     * The defect this phase fixed. `PermissionEditor` iterates
     * `PERMISSION_GROUPS` and filters `ALL_PERMISSIONS` by it, so a group
     * missing from that array is a group whose permissions render nowhere — and
     * "CRM" was missing. The grant path existed in the model and was unreachable
     * in the UI, which made the hardcoded defaults the only way any role got
     * CRM access.
     */
    expect(PERMISSION_GROUPS).toContain("CRM");
    const crmPerms = ALL_PERMISSIONS.filter((p) => p.group === "CRM");
    expect(crmPerms.map((p) => p.key).sort()).toEqual([
      "manage_telesales",
      "view_telesales",
      "work_telesales",
    ]);
    // Every group that carries permissions must be renderable, not just this one.
    for (const perm of ALL_PERMISSIONS) {
      expect(PERMISSION_GROUPS, `group "${perm.group}" is not rendered`).toContain(perm.group);
    }
  });

  it("labels the CRM permissions for the desk, not for the schema", () => {
    for (const perm of ALL_PERMISSIONS.filter((p) => p.group === "CRM")) {
      expect(perm.label).toContain("CRM");
      expect(perm.label).not.toMatch(/telesales/i);
    }
  });

  it("hiding the item is not the security boundary", () => {
    /*
     * `/telesales` computes the same `view_telesales` in-page and renders a
     * refusal instead of the queue, every read is additionally gated by RLS on
     * the same key, and every write re-checks server-side through
     * `resolveActor`. Navigating straight to the URL therefore gains nothing —
     * asserted here as the rule the sidebar and the page share.
     */
    expect(crmVisible("customer_care", null)).toBe(false);
    expect(hasPerm("customer_care", null, "view_telesales")).toBe(false);
    expect(hasPerm("customer_care", null, "work_telesales")).toBe(false);
    expect(hasPerm("customer_care", null, "manage_telesales")).toBe(false);
  });

  it("leaves the Calls telesales-team view alone", () => {
    /*
     * `/calls/telesales` is the call-analytics view of the telesales *team* and
     * is a different thing from the CRM at `/telesales`. It is gated by
     * `canViewCallsPage`, not by `view_telesales`, and this phase did not touch
     * it — the two would otherwise be easy to conflate on the next rename.
     */
    expect(canViewCallCenter("telesales", null)).toBe(false);
    expect(crmVisible("telesales", null)).toBe(true);
  });
});
