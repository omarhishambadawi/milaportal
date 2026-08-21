/**
 * Branch resolution.
 *
 * Pure — no CRM, no network, no fixtures beyond the shape the live config
 * publishes. The ids below are real values from that config, used because the
 * resolver must return the CRM's id verbatim; nothing here is a stored mapping.
 */

import { describe, expect, it } from "vitest";
import {
  resolveAlShrouqBranch,
  type AlShrouqBranchOption,
} from "@/lib/shams-crm/alshrouq-branches";

function option(over: Partial<AlShrouqBranchOption> = {}): AlShrouqBranchOption {
  return {
    id: "9999927657121",
    internal_code: "P0001",
    branch_name: "Hazm RDHS",
    label: "P0001 | Hazm RDHS",
    covered: true,
    note: null,
    ...over,
  };
}

const OPTIONS: AlShrouqBranchOption[] = [
  option(),
  option({ id: "9999927657247", internal_code: "P0127", branch_name: "Al Yasmin" }),
  option({
    id: "9999927657127",
    internal_code: "P0007",
    branch_name: "Not Covered",
    covered: false,
    note: "Not Covered",
  }),
];

describe("resolveAlShrouqBranch", () => {
  it("resolves a covered branch to the CRM's id", () => {
    expect(resolveAlShrouqBranch(OPTIONS, "P0127")).toEqual({
      kind: "resolved",
      branchId: "9999927657247",
      branchName: "Al Yasmin",
    });
  });

  it("matches trimmed and case-insensitively", () => {
    for (const code of [" P0001 ", "p0001", "P0001"]) {
      const r = resolveAlShrouqBranch(OPTIONS, code);
      expect(r.kind).toBe("resolved");
      if (r.kind !== "resolved") throw new Error("unreachable");
      expect(r.branchId).toBe("9999927657121");
    }
  });

  /**
   * The distinction the whole module exists for. An uncovered branch is a real
   * answer an agent can act on — send it another way — not a lookup failure.
   */
  it("reports an uncovered branch as its own outcome, never as resolved", () => {
    expect(resolveAlShrouqBranch(OPTIONS, "P0007")).toEqual({
      kind: "not_covered",
      branchName: "Not Covered",
      note: "Not Covered",
    });
  });

  it("keeps the three failure modes apart", () => {
    expect(resolveAlShrouqBranch(OPTIONS, null)).toEqual({
      kind: "unknown",
      reason: "no_branch_on_order",
    });
    expect(resolveAlShrouqBranch(OPTIONS, "   ")).toEqual({
      kind: "unknown",
      reason: "no_branch_on_order",
    });
    expect(resolveAlShrouqBranch(OPTIONS, "P9999")).toEqual({
      kind: "unknown",
      reason: "not_in_crm",
    });
    expect(resolveAlShrouqBranch([option({ internal_code: "P0500", id: "  " })], "P0500")).toEqual({
      kind: "unknown",
      reason: "no_id_published",
    });
  });

  it("checks coverage before the id, so an uncovered branch never reads as a data fault", () => {
    const r = resolveAlShrouqBranch(
      [option({ internal_code: "P0007", id: null, covered: false, note: "Not Covered" })],
      "P0007",
    );
    expect(r.kind).toBe("not_covered");
  });

  it("holds no mapping of its own — an empty list resolves nothing", () => {
    expect(resolveAlShrouqBranch([], "P0001")).toEqual({ kind: "unknown", reason: "not_in_crm" });
  });

  it("does not mutate the options it is given", () => {
    const options = [option()];
    const before = structuredClone(options);
    resolveAlShrouqBranch(options, "P0001");
    expect(options).toEqual(before);
  });
});
