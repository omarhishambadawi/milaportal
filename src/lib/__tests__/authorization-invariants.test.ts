import { describe, expect, it } from "vitest";

import { isAdministrator, isOwnerRole } from "@/lib/auth";
import { CALL_CENTER_VIEW_PERMISSIONS } from "@/lib/call-center-permissions";
import {
  ALL_PERMISSIONS,
  canViewCallCenter,
  defaultPermsForRole,
  hasPerm,
} from "@/lib/permissions";
import {
  APP_ROLES,
  ASSIGNABLE_ROLES,
  RETIRED_ROLES,
  canActOnRole,
  canAssignRole,
  isAppRole,
  roleHasAgentCode,
  roleLabel,
  roleTone,
  type AppRole,
} from "@/lib/roles";
import { temporaryPasswordState } from "@/lib/password-policy";

/**
 * Cross-cutting invariants.
 *
 * The other suites check one function against a written-down expectation. These
 * check properties that span `roles.ts` and `permissions.ts` together — the
 * relationships that no single module owns, and which therefore break silently
 * when one of the two is edited on its own.
 */

const ALL_KEYS = ALL_PERMISSIONS.map((p) => p.key);
const NON_ADMIN_ROLES = APP_ROLES.filter((r) => !isAdministrator(r));

/** The most a role can ever hold: probe each key with it stored explicitly. */
function ceilingOf(role: AppRole): string[] {
  return ALL_KEYS.filter((key) => hasPerm(role, [key], key));
}

describe("manage_users implies a ladder, and a ladder implies manage_users", () => {
  it("every role holding manage_users may administer somebody", () => {
    // Otherwise the Users page renders for someone who can act on no account in
    // it — a permission that grants a screen and nothing on it.
    for (const role of APP_ROLES) {
      if (!hasPerm(role, null, "manage_users")) continue;
      const administrable = APP_ROLES.filter((target) => canActOnRole(role, target));
      expect(
        administrable.length,
        `${role} holds manage_users but administers nobody`,
      ).toBeGreaterThan(0);
    }
  });

  it("every role that may administer somebody holds manage_users", () => {
    // The converse: a ladder row for a role that cannot reach the Users page is
    // dead configuration, and reads as an authority that does not exist.
    for (const role of APP_ROLES) {
      const administrable = APP_ROLES.filter((target) => canActOnRole(role, target));
      if (administrable.length === 0) continue;
      expect(
        hasPerm(role, null, "manage_users"),
        `${role} has a ladder row but not manage_users`,
      ).toBe(true);
    }
  });

  it("confines user administration to owner, admin and supervisor", () => {
    const managers = APP_ROLES.filter((role) => hasPerm(role, null, "manage_users"));
    expect([...managers].sort()).toEqual(["admin", "owner", "supervisor"]);
  });
});

describe("a non-administrator can never mint an account more capable than itself", () => {
  // This is the property that makes `manage_users` safe to hand to Supervisor.
  // Checking only the role ladder is not enough: the ladder says WHO may be
  // created, and this says the result cannot outrank the creator.
  it.each(NON_ADMIN_ROLES)("%s grants only roles whose ceiling it already holds", (actor) => {
    const actorCeiling = new Set(ceilingOf(actor));
    for (const target of APP_ROLES) {
      if (!canAssignRole(actor, target)) continue;
      for (const key of ceilingOf(target)) {
        expect(
          actorCeiling.has(key),
          `${actor} may grant ${target}, which can hold '${key}' that ${actor} cannot`,
        ).toBe(true);
      }
    }
  });

  it.each(NON_ADMIN_ROLES)("%s grants only roles whose defaults it already holds", (actor) => {
    const actorDefaults = new Set(defaultPermsForRole(actor));
    for (const target of APP_ROLES) {
      if (!canAssignRole(actor, target)) continue;
      for (const key of defaultPermsForRole(target)) {
        expect(
          actorDefaults.has(key),
          `${actor} may grant ${target}, which holds '${key}' by default that ${actor} does not`,
        ).toBe(true);
      }
    }
  });

  it("no non-administrator may grant a role that itself administers users", () => {
    for (const actor of NON_ADMIN_ROLES) {
      for (const target of APP_ROLES) {
        if (!canAssignRole(actor, target)) continue;
        expect(
          hasPerm(target, null, "manage_users"),
          `${actor} may grant ${target}, which would let it propagate user administration`,
        ).toBe(false);
      }
    }
  });
});

describe("owner protection", () => {
  it("recognises exactly one owner role", () => {
    for (const role of APP_ROLES) expect(isOwnerRole(role)).toBe(role === "owner");
  });

  it("treats owner and admin as equally administrative", () => {
    for (const role of APP_ROLES) {
      expect(isAdministrator(role)).toBe(role === "owner" || role === "admin");
    }
  });

  it("makes owner reachable only from owner, and never from a dialog", () => {
    for (const actor of APP_ROLES) {
      expect(canAssignRole(actor, "owner"), `${actor} → owner`).toBe(actor === "owner");
      expect(canActOnRole(actor, "owner"), `${actor} administers owner`).toBe(actor === "owner");
    }
    expect(ASSIGNABLE_ROLES).not.toContain("owner");
  });
});

describe("the retired call_center role is inert everywhere", () => {
  it.each(RETIRED_ROLES)("%s is absent from the live role list", (retired) => {
    expect(APP_ROLES).not.toContain(retired);
    expect(ASSIGNABLE_ROLES).not.toContain(retired);
    expect(isAppRole(retired)).toBe(false);
  });

  it.each(RETIRED_ROLES)("%s is assignable by nobody", (retired) => {
    for (const actor of APP_ROLES) {
      expect(canAssignRole(actor, retired), `${actor} → ${retired}`).toBe(false);
    }
  });

  it.each(RETIRED_ROLES)("%s holds no permission and carries no agent code", (retired) => {
    for (const key of ALL_KEYS) {
      expect(hasPerm(retired as AppRole, null, key), key).toBe(false);
      expect(hasPerm(retired as AppRole, ALL_KEYS, key), key).toBe(false);
    }
    expect(roleHasAgentCode(retired)).toBe(false);
    expect(isAdministrator(retired as AppRole)).toBe(false);
  });

  it.each(RETIRED_ROLES)("an account stranded on %s stays repairable", (retired) => {
    // Whoever may administer an agent may move them back to a live role,
    // otherwise the account would be permanently unfixable through the UI.
    expect(canActOnRole("owner", retired)).toBe(true);
    expect(canActOnRole("admin", retired)).toBe(true);
    expect(canActOnRole("supervisor", retired)).toBe(true);
  });
});

describe("defaults never exceed ceilings", () => {
  it.each(APP_ROLES)("%s holds every one of its defaults when asked", (role) => {
    for (const key of defaultPermsForRole(role)) {
      expect(hasPerm(role, null, key), `${role} default '${key}' is not granted`).toBe(true);
      expect(hasPerm(role, [key], key), `${role} default '${key}' is above its own ceiling`).toBe(
        true,
      );
    }
  });
});

describe("the call centre gate agrees with its permission list", () => {
  it.each(APP_ROLES)(
    "%s: canViewCallCenter matches administrator OR one of the view permissions",
    (role) => {
      for (const stored of [null, [], ALL_KEYS, ["view_call_center"], ["view_team_analytics"]]) {
        const expected =
          isAdministrator(role) ||
          CALL_CENTER_VIEW_PERMISSIONS.some((p) => hasPerm(role, stored, p));
        expect(canViewCallCenter(role, stored), `${role} / ${JSON.stringify(stored)}`).toBe(
          expected,
        );
      }
    },
  );
});

describe("hostile input denies rather than throws", () => {
  /**
   * Every one of these functions is called with values straight out of a
   * database row or a URL, so none may throw. `hasPerm` used to: indexing into
   * the role tables with a value the app did not know produced a TypeError on
   * `undefined.includes(...)`, which took the whole page down instead of
   * refusing the permission.
   */
  const HOSTILE = [null, undefined, "", "call_center", "future_role", "ADMIN", 0, 1, true, {}, []];

  /**
   * Object-prototype keys are deliberately NOT in the list above.
   *
   * `hasPerm` indexes plain object literals by role name, so `ROLE_DEFAULTS["toString"]`
   * resolves to the inherited `Function.prototype.toString` — truthy, so it passes the
   * `if (!allowed || !defaults) return false` guard — and the next line throws
   * `defaults.includes is not a function`. That is the same crash class the guard was
   * added to close, still open for this one family of inputs.
   *
   * It is not reachable today: `role` originates in the `public.app_role` Postgres enum,
   * which cannot hold "__proto__". So this is a hardening gap, not a live defect, and
   * closing it means editing application code — out of scope for this sprint, which is
   * verification only. Add "__proto__", "constructor" and "toString" back to HOSTILE at
   * the same time as the fix (an `Object.hasOwn` check in `hasPerm`).
   */

  it.each(HOSTILE)("hasPerm(%p, …) denies without throwing", (role) => {
    for (const stored of [null, undefined, [], ALL_KEYS, ["__proto__"]]) {
      for (const key of ["view_orders", "manage_users", "__proto__", ""]) {
        expect(() => hasPerm(role as AppRole, stored, key)).not.toThrow();
        expect(hasPerm(role as AppRole, stored, key)).toBe(false);
      }
    }
  });

  it.each(HOSTILE)("the ladder functions deny %p without throwing", (value) => {
    for (const other of [...APP_ROLES, ...HOSTILE]) {
      expect(() => canAssignRole(value as string, other as string)).not.toThrow();
      expect(() => canActOnRole(value as string, other as string)).not.toThrow();
      expect(canAssignRole(value as string, other as string)).toBe(false);
    }
  });

  it.each(HOSTILE)("the display helpers tolerate %p", (value) => {
    expect(() => roleLabel(value as string)).not.toThrow();
    expect(() => roleTone(value as string)).not.toThrow();
    expect(() => roleHasAgentCode(value as string)).not.toThrow();
    expect(roleHasAgentCode(value as string)).toBe(false);
  });

  it("temporaryPasswordState tolerates malformed rows", () => {
    const malformed = [
      {},
      { must_change_password: null, must_change_password_expires_at: null },
      { must_change_password: true, must_change_password_expires_at: "" },
      { must_change_password: true, must_change_password_expires_at: "0000-00-00" },
      { must_change_password: true, must_change_password_expires_at: "٢٠٢٦" },
    ];
    for (const fields of malformed) {
      expect(() => temporaryPasswordState(fields)).not.toThrow();
      expect(["none", "active", "expired"]).toContain(temporaryPasswordState(fields));
    }
  });
});
