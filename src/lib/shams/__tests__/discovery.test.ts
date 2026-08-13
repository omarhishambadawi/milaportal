/**
 * Invoice branch discovery tests.
 *
 * `findInvoiceBranches` is the only part of the Shams client that talks to more
 * than one branch, so what is tested here is the fan-out itself: that a number
 * living in several branches yields several matches, that one branch is still
 * one match, that a number nowhere in the chain is an empty result rather than a
 * failure, and that two branches holding the *same* number stay separate.
 *
 * The upstream call is stubbed at `shamsFetch`, so no credentials, no network
 * and no MIS are involved — the routing logic is what is under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawSalesRow } from "@/lib/shams/types";

const fetchMock = vi.fn();

vi.mock("@/lib/shams/client.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shams/client.server")>(
    "@/lib/shams/client.server",
  );
  return { ...actual, shamsFetch: (...args: unknown[]) => fetchMock(...args) };
});

const { findInvoiceBranches } = await import("@/lib/shams/sales.server");

/** A header row for one document in one warehouse. */
function header(docNo: string, whouse: string, customer: string, total: string): RawSalesRow {
  return {
    Doc_No: docNo,
    Doc_Dt: "2026-08-13 00:00:00",
    Doc_type: "Credit",
    Whouse: whouse,
    Division: "##",
    Customer_Name: customer,
    CusName: "",
    Doc_Cancelled: "0",
    GrandAmt: total,
    Prior: "0",
  };
}

/** Answer `wh_cd=<code>` with rows, or with nothing. */
function respondWith(rowsByBranch: Record<string, RawSalesRow[]>) {
  fetchMock.mockImplementation(async (_path: string, query: Record<string, string>) => ({
    success: true,
    data: rowsByBranch[query.wh_cd] ?? [],
  }));
}

const CHAIN = ["P0001", "P0034", "P0221", "P0505"];

beforeEach(() => {
  fetchMock.mockReset();
});

describe("findInvoiceBranches", () => {
  it("reports every branch that holds the number", async () => {
    respondWith({
      P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")],
      P0034: [header("22138", "P0034", "CASH SALES", "99.00")],
      P0505: [header("22138", "P0505", "NUPCO / …-Call Centre", "410.50")],
    });

    const { matches, probed } = await findInvoiceBranches("22138", CHAIN);

    expect(probed).toBe(4);
    expect(matches.map((m) => m.branchCode)).toEqual(["P0034", "P0221", "P0505"]);
  });

  it("keeps the same number in different branches separate", async () => {
    respondWith({
      P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")],
      P0034: [header("22138", "P0034", "CASH SALES", "99.00")],
    });

    const { matches } = await findInvoiceBranches("22138", CHAIN);

    // Different documents that happen to share a number: different totals,
    // different customers, different Call Centre status.
    expect(matches).toHaveLength(2);
    const [riyadh, jeddah] = matches;
    expect(riyadh).toMatchObject({
      branchCode: "P0034",
      grandTotal: 99,
      isCallCentre: false,
      customer: "CASH SALES",
    });
    expect(jeddah).toMatchObject({
      branchCode: "P0221",
      grandTotal: 230,
      isCallCentre: true,
      customer: "HOME DELIVERY-Call Centre",
    });
  });

  it("returns a single match when only one branch holds it", async () => {
    respondWith({ P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")] });

    const { matches } = await findInvoiceBranches("22138", CHAIN);

    expect(matches).toHaveLength(1);
    expect(matches[0].branchCode).toBe("P0221");
  });

  it("returns no matches — not an error — when the number exists nowhere", async () => {
    // The API answers 200 with an empty payload for a missing document, so
    // absence is data.
    respondWith({});

    const { matches, probed } = await findInvoiceBranches("87578", CHAIN);

    expect(matches).toEqual([]);
    expect(probed).toBe(4);
  });

  it("asks each branch exactly once, and only for valid branch codes", async () => {
    respondWith({});

    const { probed } = await findInvoiceBranches("22138", [
      "P0221",
      "p0221", // same branch, differently cased
      "RIYADH", // not a warehouse code
      "",
      "P0034",
    ]);

    expect(probed).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const asked = fetchMock.mock.calls.map((c) => (c[1] as Record<string, string>).wh_cd).sort();
    expect(asked).toEqual(["P0034", "P0221"]);
  });

  it("keeps the branches that answered when one branch fails", async () => {
    fetchMock.mockImplementation(async (_path: string, query: Record<string, string>) => {
      if (query.wh_cd === "P0001") throw new Error("upstream blew up");
      if (query.wh_cd === "P0221") {
        return { success: true, data: [header("22138", "P0221", "HOME DELIVERY", "230.00")] };
      }
      return { success: true, data: [] };
    });

    const { matches, failed } = await findInvoiceBranches("22138", CHAIN);

    expect(failed).toBe(1);
    expect(matches.map((m) => m.branchCode)).toEqual(["P0221"]);
  });

  it("raises when nothing answered at all, rather than reporting 'not found'", async () => {
    fetchMock.mockRejectedValue(new Error("MIS unreachable"));

    await expect(findInvoiceBranches("22138", CHAIN)).rejects.toThrow();
  });

  it("rejects a document number that is not numeric before any request", async () => {
    await expect(findInvoiceBranches("22138; DROP", CHAIN)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
