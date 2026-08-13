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

const { findInvoiceBranches, getInvoices, partitionBranches, _clearDiscoveryCache } =
  await import("@/lib/shams/sales.server");

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
  _clearDiscoveryCache();
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
    // Call Centre first (P0221, P0505 — both suffixed), then the walk-in
    // account; branch code orders within each group.
    expect(matches.map((m) => m.branchCode)).toEqual(["P0221", "P0505", "P0034"]);
  });

  it("keeps the same number in different branches separate", async () => {
    respondWith({
      P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")],
      P0034: [header("22138", "P0034", "CASH SALES", "99.00")],
    });

    const { matches } = await findInvoiceBranches("22138", CHAIN);

    // Different documents that happen to share a number: different totals,
    // different customers, different Call Centre status. The call-centre one
    // leads, which is the row an agent is nearly always after.
    expect(matches).toHaveLength(2);
    const [jeddah, riyadh] = matches;
    expect(jeddah).toMatchObject({
      branchCode: "P0221",
      grandTotal: 230,
      isCallCentre: true,
      customer: "HOME DELIVERY-Call Centre",
    });
    expect(riyadh).toMatchObject({
      branchCode: "P0034",
      grandTotal: 99,
      isCallCentre: false,
      customer: "CASH SALES",
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

  it("returns Call Centre branches first", async () => {
    respondWith({
      P0100: [header("22138", "P0100", "CASH SALES", "10.00")],
      P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")],
      P0505: [header("22138", "P0505", "NUPCO / …", "50.00")],
    });

    const { matches } = await findInvoiceBranches("22138", ["P0100", "P0221", "P0505"]);

    expect(matches.map((m) => m.branchCode)).toEqual(["P0221", "P0100", "P0505"]);
    expect(matches[0].isCallCentre).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Partitioning and caching — what makes the sweep fast                        */
/* -------------------------------------------------------------------------- */

describe("partitionBranches", () => {
  const CODES = ["P0001", "P0002", "P0003", "P0004", "P0005"];

  it("interleaves rather than slicing contiguously", () => {
    // Contiguous slices would put a whole region — and its latency — in one
    // part; interleaving gives every part the same mix.
    expect(partitionBranches(CODES, 0, 2)).toEqual(["P0001", "P0003", "P0005"]);
    expect(partitionBranches(CODES, 1, 2)).toEqual(["P0002", "P0004"]);
  });

  it("covers every branch exactly once across the parts", () => {
    const parts = 4;
    const seen = Array.from({ length: parts }, (_, p) => partitionBranches(CODES, p, parts)).flat();
    expect(seen.sort()).toEqual([...CODES].sort());
  });

  it("returns everything when the sweep is not split", () => {
    expect(partitionBranches(CODES, 0, 1)).toEqual(CODES);
  });
});

describe("findInvoiceBranches — parts", () => {
  it("asks only its own share of the chain", async () => {
    respondWith({});

    const { probed } = await findInvoiceBranches("22138", CHAIN, { part: 0, parts: 4 });

    expect(probed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("finds a branch wherever in the chain it falls", async () => {
    respondWith({ P0505: [header("22138", "P0505", "HOME DELIVERY-Call Centre", "230.00")] });

    const sweeps = await Promise.all(
      [0, 1, 2, 3].map((part) => findInvoiceBranches("22138", CHAIN, { part, parts: 4 })),
    );

    const found = sweeps.flatMap((s) => s.matches).map((m) => m.branchCode);
    expect(found).toEqual(["P0505"]);
    // Every branch was asked exactly once, across the four parts.
    expect(fetchMock).toHaveBeenCalledTimes(CHAIN.length);
  });

  it("clamps an out-of-range part rather than sweeping nothing", async () => {
    respondWith({});
    const { probed } = await findInvoiceBranches("22138", CHAIN, { part: 99, parts: 4 });
    expect(probed).toBeGreaterThan(0);
  });
});

describe("findInvoiceBranches — cache", () => {
  it("answers a repeated sweep without asking the MIS again", async () => {
    respondWith({ P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")] });

    const first = await findInvoiceBranches("22138", CHAIN);
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await findInvoiceBranches("22138", CHAIN);

    expect(second.matches).toEqual(first.matches);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("does not answer one document from another document's sweep", async () => {
    respondWith({ P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")] });

    await findInvoiceBranches("22138", CHAIN);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await findInvoiceBranches("87578", CHAIN);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("does not cache a total failure, so a retry can succeed", async () => {
    fetchMock.mockRejectedValue(new Error("MIS unreachable"));
    await expect(findInvoiceBranches("22138", CHAIN)).rejects.toThrow();

    respondWith({ P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")] });
    const { matches } = await findInvoiceBranches("22138", CHAIN);

    expect(matches.map((m) => m.branchCode)).toEqual(["P0221"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reading the document the sweep already downloaded                           */
/* -------------------------------------------------------------------------- */

/**
 * The step the agent actually waits on.
 *
 * Discovery fetches the *whole* document from every branch that holds it and
 * used to keep only the chooser summary, so opening the document — which, for a
 * single match, happens automatically the moment the sweep settles — repeated
 * the identical upstream request. These pin the reuse and its limits.
 */
describe("the document a sweep found", () => {
  /**
   * An item line belonging to a document, so a full payload has lines to lose.
   * `Prior` is the row discriminator — anything but `"0"` is an item line.
   */
  function line(docNo: string, whouse: string, itemCode: string): RawSalesRow {
    return {
      Doc_No: docNo,
      Doc_Dt: "2026-08-13 00:00:00",
      Whouse: whouse,
      Prior: "1",
      ItmCd: itemCode,
      ItmName: `Item ${itemCode}`,
      Qty: "2",
      Rate: "50.00",
      Item_NetAmt: "100.00",
    };
  }

  it("is read back without asking the MIS a second time", async () => {
    respondWith({
      P0221: [
        header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00"),
        line("22138", "P0221", "SKU-1"),
      ],
    });

    await findInvoiceBranches("22138", CHAIN);
    const afterSweep = fetchMock.mock.calls.length;

    const invoices = await getInvoices({ branchCode: "P0221", docNoStart: "22138" });

    expect(fetchMock).toHaveBeenCalledTimes(afterSweep);
    expect(invoices).toHaveLength(1);
    // The lines too, not just the summary the chooser showed.
    expect(invoices[0].items).toHaveLength(1);
    expect(invoices[0].grandTotal).toBe(230);
  });

  it("is keyed on the number, not on how it was padded", async () => {
    respondWith({ P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")] });

    await findInvoiceBranches("22138", CHAIN);
    const afterSweep = fetchMock.mock.calls.length;

    // `022138` is the same document; the API accepts either on input.
    await getInvoices({ branchCode: "P0221", docNoStart: "022138" });

    expect(fetchMock).toHaveBeenCalledTimes(afterSweep);
  });

  it("is not confused with a branch that had no such document", async () => {
    respondWith({ P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")] });

    await findInvoiceBranches("22138", CHAIN);
    const afterSweep = fetchMock.mock.calls.length;

    // P0034 answered the sweep with nothing, so there is nothing to reuse and
    // an explicit lookup must still go and ask.
    await getInvoices({ branchCode: "P0034", docNoStart: "22138" });

    expect(fetchMock.mock.calls.length).toBe(afterSweep + 1);
  });

  it("is not reused for a query the sweep never made", async () => {
    respondWith({ P0221: [header("22138", "P0221", "HOME DELIVERY-Call Centre", "230.00")] });

    await findInvoiceBranches("22138", CHAIN);
    const afterSweep = fetchMock.mock.calls.length;

    // A range and a date window are different questions; only the bare
    // single-document request is the one discovery already answered.
    await getInvoices({ branchCode: "P0221", docNoStart: "22138", docNoEnd: "22140" });
    await getInvoices({ branchCode: "P0221", docNoStart: "22138", startDate: "20260813" });

    expect(fetchMock.mock.calls.length).toBe(afterSweep + 2);
  });

  it("probes without the transport's transient retry", async () => {
    respondWith({});
    await findInvoiceBranches("22138", CHAIN);

    for (const call of fetchMock.mock.calls) {
      expect(call[2]).toMatchObject({ retry: false });
    }
  });
});
