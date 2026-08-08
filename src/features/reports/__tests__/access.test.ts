import { describe, expect, it } from "vitest";
import { defaultPermsForRole, hasPerm } from "@/lib/permissions";
import type { AppRole } from "@/lib/roles";

/**
 * Who may open Reports.
 *
 * The page adds no permission and no role — it reads `view_reports`, which
 * already existed and already drew this line. This suite is what stops that
 * being an accident: if a future edit to the role tables hands an agent
 * `view_reports`, the failure shows up here rather than as a Telesales agent
 * reading the whole network's monthly sales.
 */
const allowed: AppRole[] = ["owner", "admin", "supervisor"];
const refused: AppRole[] = ["customer_care", "telesales"];

/** What the page itself gates on. Mirrors the check in `_app.reports.tsx`. */
const canOpenReports = (role: AppRole) => hasPerm(role, defaultPermsForRole(role), "view_reports");

describe("Reports access", () => {
  it.each(allowed)("allows %s", (role) => {
    expect(canOpenReports(role)).toBe(true);
  });

  it.each(refused)("refuses %s", (role) => {
    expect(canOpenReports(role)).toBe(false);
  });

  it("allows an auditor, whose job is reading other people's work", () => {
    // Not named in the brief's list, but the role exists, holds `view_reports`
    // by default, and is a review role rather than an agent one. Pinned so the
    // inclusion is a decision rather than something nobody noticed.
    expect(canOpenReports("auditor")).toBe(true);
  });

  it("refuses an agent even if every other permission is granted", () => {
    // The gate is this permission, not a role check — so a customer_care user
    // with a hand-edited permission list still cannot walk in through a
    // neighbouring grant.
    const everythingElse = defaultPermsForRole("customer_care").filter(
      (perm) => perm !== "view_reports",
    );
    expect(hasPerm("customer_care", [...everythingElse, "export_reports"], "view_reports")).toBe(
      false,
    );
  });
});
