/**
 * The Phase 4 search diagnostic.
 *
 * `searchProducts` is mocked, so nothing here touches the CRM or the MIS. What
 * is checked is only what the diagnostic is responsible for: that it runs the
 * four fixed queries through the *production* search function, and that what
 * comes back is safe to put on a page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShamsProduct } from "@/lib/shams/types";

const searchMock = vi.fn();

vi.mock("@/lib/shams/catalog.server", () => ({
  searchProducts: (q: string) => searchMock(q),
}));

const { runCrmSearchDiagnostic } = await import("@/lib/shams-crm/diagnostics.server");

const product = (itemCode: string, itemName: string): ShamsProduct => ({
  itemCode,
  itemName,
  retailPrice: 1261.4,
});

const FOUND = [
  product("10609670", "MOUNJARO 2.5 MG 0.5ML PEN, 4'S"),
  product("10400746", "NAN 2 OPTIPRO 1800 GM"),
  product("10400741", "NAN OPTIPRO KIDS MILK, 400 G"),
  product("10400395", "NAN OPTIPRO NO 1 400GM"),
];

const QUERIES = ["Mounjaro", "nan", "nan*op", "104*746"];

beforeEach(() => {
  searchMock.mockReset();
  process.env.SHAMS_CRM_USERNAME = "stub-user";
  process.env.SHAMS_CRM_PASSWORD = "stub-pass";
});

afterEach(() => {
  delete process.env.SHAMS_CRM_USERNAME;
  delete process.env.SHAMS_CRM_PASSWORD;
});

describe("runCrmSearchDiagnostic", () => {
  it("runs the four fixed queries through the production search function", async () => {
    searchMock.mockResolvedValue(FOUND);

    const report = await runCrmSearchDiagnostic();

    expect(searchMock.mock.calls.map((c) => c[0])).toEqual(QUERIES);
    expect(report.queries.map((q) => q.query)).toEqual(QUERIES);
    expect(report.catalogAvailable).toBe(true);
    expect(report.allPassed).toBe(true);
  });

  it("reduces results to item code and name, capped at three", async () => {
    searchMock.mockResolvedValue(FOUND);

    const [first] = (await runCrmSearchDiagnostic()).queries;

    expect(first.count).toBe(4);
    expect(first.sample).toHaveLength(3);
    // No price, no extra fields — exactly two keys per row.
    for (const row of first.sample ?? []) {
      expect(Object.keys(row).sort()).toEqual(["itemCode", "itemName"]);
    }
  });

  it("never leaks a credential, token or price into the report", async () => {
    searchMock.mockResolvedValue(FOUND);

    const serialized = JSON.stringify(await runCrmSearchDiagnostic());

    expect(serialized).not.toContain("stub-user");
    expect(serialized).not.toContain("stub-pass");
    expect(serialized).not.toMatch(/session|token|Authorization/i);
    expect(serialized).not.toContain("1261.4");
  });

  it("converts a failure into a safe error kind, and keeps going", async () => {
    const { ShamsCrmError } = await import("@/lib/shams-crm/client.server");
    searchMock
      .mockRejectedValueOnce(new ShamsCrmError("unavailable", "boom"))
      .mockResolvedValue(FOUND);

    const report = await runCrmSearchDiagnostic();

    expect(report.queries[0]).toMatchObject({
      status: "failed",
      count: null,
      sample: null,
      errorKind: "unavailable",
    });
    // The remaining three still ran.
    expect(searchMock).toHaveBeenCalledTimes(4);
    expect(report.allPassed).toBe(false);
  });

  it("an unrecognised throw becomes `unknown`, not a raw message", async () => {
    searchMock.mockRejectedValue(new Error("upstream said something revealing"));

    const report = await runCrmSearchDiagnostic();

    expect(report.queries.every((q) => q.errorKind === "unknown")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("revealing");
  });

  it("a query that succeeds but finds nothing is not a pass", async () => {
    // `104*746` returning zero in production is the finding, not a rounding
    // error — allPassed must not paper over it.
    searchMock.mockResolvedValue([]);

    const report = await runCrmSearchDiagnostic();

    expect(report.queries.every((q) => q.status === "success")).toBe(true);
    expect(report.queries.every((q) => q.count === 0)).toBe(true);
    expect(report.allPassed).toBe(false);
  });

  it("reports not-configured without running any search", async () => {
    delete process.env.SHAMS_CRM_PASSWORD;

    const report = await runCrmSearchDiagnostic();

    expect(report.catalogAvailable).toBe(false);
    expect(report.allPassed).toBe(false);
    expect(report.queries.map((q) => q.errorKind)).toEqual(Array(4).fill("not_configured"));
    expect(searchMock).not.toHaveBeenCalled();
  });
});
