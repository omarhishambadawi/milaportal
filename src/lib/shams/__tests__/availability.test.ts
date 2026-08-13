/**
 * Invoice items ↔ branch stock.
 *
 * Two things are under test and they are different in kind. `availability.ts` is
 * pure, so its four states are asserted directly. `getStockForItems` talks to
 * the MIS, so `shamsFetch` is stubbed and what is asserted there is the request
 * *behaviour* — how many go out, for what, and what happens when one fails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawStockRow, ShamsBranchStock, ShamsInvoiceItem } from "@/lib/shams/types";
import {
  branchStockState,
  invoiceItemCodes,
  resolveItemAvailability,
} from "@/lib/shams/availability";

const fetchMock = vi.fn();

vi.mock("@/lib/shams/client.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shams/client.server")>(
    "@/lib/shams/client.server",
  );
  return { ...actual, shamsFetch: (...args: unknown[]) => fetchMock(...args) };
});

const { getStockForItems, _clearCaches } = await import("@/lib/shams/catalog.server");

/** A minimal invoice line — only the fields the join actually reads. */
function item(itemCode: string, itemName: string, quantity: number): ShamsInvoiceItem {
  return {
    itemCode,
    itemName,
    quantity,
    lzQuantity: 0,
    freeQuantity: 0,
    freeLzQuantity: 0,
    unitRate: 10,
    grossAmount: 10 * quantity,
    discountAmount: 0,
    amount: 10 * quantity,
    tax: 0,
    netAmount: 10 * quantity,
  };
}

function stock(branchCode: string, quantity: number): ShamsBranchStock {
  return { branchCode, branchName: branchCode, areaName: "RIYADH", quantity, lzQuantity: 0 };
}

function stockRow(branchCode: string, quantity: number): RawStockRow {
  return { branchCode, branchName: branchCode, areaName: "RIYADH", quantity };
}

beforeEach(() => {
  fetchMock.mockReset();
  _clearCaches();
});

/* -------------------------------------------------------------------------- */
/* The four states                                                             */
/* -------------------------------------------------------------------------- */

describe("branchStockState", () => {
  it("reports a quantity above zero as in stock", () => {
    expect(branchStockState([stock("P0221", 14)], "P0221")).toEqual({
      state: "in_stock",
      quantity: 14,
    });
  });

  it("reports a branch the MIS lists with zero as out of stock", () => {
    // A real answer, not an absence: the response covers every branch.
    expect(branchStockState([stock("P0221", 0)], "P0221")).toEqual({
      state: "out_of_stock",
      quantity: 0,
    });
  });

  it("reports an item the MIS does not know as not found", () => {
    // The API answers 200 with nothing for an unknown code rather than a 404.
    expect(branchStockState([], "P0221")).toEqual({ state: "not_found", quantity: null });
  });

  it("reports a lookup that produced nothing as unknown, never as zero", () => {
    expect(branchStockState(undefined, "P0221")).toEqual({ state: "unknown", quantity: null });
  });

  it("reports a branch missing from a non-empty response as unknown", () => {
    // Unaccounted for, not empty-handed. Calling this "out of stock" would send
    // an agent a fact the MIS never stated.
    expect(branchStockState([stock("P0034", 3)], "P0221")).toEqual({
      state: "unknown",
      quantity: null,
    });
  });

  it("matches the branch regardless of case or padding", () => {
    expect(branchStockState([stock("P0221", 2)], " p0221 ").state).toBe("in_stock");
  });
});

/* -------------------------------------------------------------------------- */
/* Item codes                                                                  */
/* -------------------------------------------------------------------------- */

describe("invoiceItemCodes", () => {
  it("asks once per product, not once per line", () => {
    const codes = invoiceItemCodes([
      item("SKU-1", "Mounjaro 2.5", 2),
      item("SKU-2", "Ozempic 1", 1),
      item("SKU-1", "Mounjaro 2.5", 1), // a split line for the same product
    ]);
    expect(codes).toEqual(["SKU-1", "SKU-2"]);
  });

  it("drops blanks, which product/stock cannot be asked about", () => {
    expect(invoiceItemCodes([item("", "Mystery", 1), item("SKU-9", "Real", 1)])).toEqual(["SKU-9"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The join                                                                    */
/* -------------------------------------------------------------------------- */

describe("resolveItemAvailability", () => {
  const items = [
    item("SKU-1", "Mounjaro 2.5", 2),
    item("SKU-2", "Ozempic 1", 1),
    item("SKU-3", "Trulicity", 4),
  ];

  it("pairs each line with what the issuing branch holds", () => {
    const rows = resolveItemAvailability(
      items,
      new Map([
        ["SKU-1", [stock("P0221", 14), stock("P0034", 0)]],
        ["SKU-2", [stock("P0221", 0)]],
        // SKU-3 absent: its lookup failed.
      ]),
      "P0221",
    );

    expect(rows).toEqual([
      {
        itemCode: "SKU-1",
        itemName: "Mounjaro 2.5",
        invoiced: 2,
        state: "in_stock",
        quantity: 14,
      },
      { itemCode: "SKU-2", itemName: "Ozempic 1", invoiced: 1, state: "out_of_stock", quantity: 0 },
      { itemCode: "SKU-3", itemName: "Trulicity", invoiced: 4, state: "unknown", quantity: null },
    ]);
  });

  it("answers for the branch asked about, not the one with the most stock", () => {
    const rows = resolveItemAvailability(
      [item("SKU-1", "Mounjaro 2.5", 2)],
      new Map([["SKU-1", [stock("P0221", 14), stock("P0034", 0)]]]),
      "P0034",
    );
    expect(rows[0]).toMatchObject({ state: "out_of_stock", quantity: 0 });
  });

  it("keeps repeated lines separate while sharing one stock answer", () => {
    // The document is the record being reconciled; merging lines the MIS printed
    // separately would misreport it.
    const rows = resolveItemAvailability(
      [item("SKU-1", "Mounjaro 2.5", 2), item("SKU-1", "Mounjaro 2.5", 1)],
      new Map([["SKU-1", [stock("P0221", 14)]]]),
      "P0221",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.invoiced)).toEqual([2, 1]);
    expect(rows.every((r) => r.state === "in_stock" && r.quantity === 14)).toBe(true);
  });

  it("survives an empty stock map rather than failing the document", () => {
    const rows = resolveItemAvailability(items, new Map(), "P0221");
    expect(rows.every((r) => r.state === "unknown" && r.quantity === null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The requests it takes                                                       */
/* -------------------------------------------------------------------------- */

describe("getStockForItems", () => {
  /** Answer `itemcode=<code>` with rows, or with nothing. */
  function respondWith(rowsByCode: Record<string, RawStockRow[]>) {
    fetchMock.mockImplementation(async (_path: string, query: Record<string, string>) => ({
      success: true,
      data: rowsByCode[query.itemcode] ?? [],
    }));
  }

  it("asks once per item and keys the answers by code", async () => {
    respondWith({
      "SKU-1": [stockRow("P0221", 14)],
      "SKU-2": [stockRow("P0221", 0)],
    });

    const out = await getStockForItems(["SKU-1", "SKU-2"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.get("SKU-1")?.[0]).toMatchObject({ branchCode: "P0221", quantity: 14 });
    expect(out.get("SKU-2")?.[0]).toMatchObject({ branchCode: "P0221", quantity: 0 });
  });

  it("does not ask twice for a repeated code", async () => {
    respondWith({ "SKU-1": [stockRow("P0221", 14)] });

    await getStockForItems(["SKU-1", "SKU-1", " SKU-1 "]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the stock cache the Branch Stock tab fills", async () => {
    respondWith({ "SKU-1": [stockRow("P0221", 14)], "SKU-2": [stockRow("P0221", 1)] });

    await getStockForItems(["SKU-1"]);
    const afterFirst = fetchMock.mock.calls.length;
    // A second document sharing a product costs only the product it adds.
    await getStockForItems(["SKU-1", "SKU-2"]);

    expect(fetchMock.mock.calls.length).toBe(afterFirst + 1);
  });

  it("omits an item whose lookup failed instead of losing the rest", async () => {
    fetchMock.mockImplementation(async (_path: string, query: Record<string, string>) => {
      if (query.itemcode === "SKU-2") throw new Error("upstream blew up");
      return { success: true, data: [stockRow("P0221", 5)] };
    });

    const out = await getStockForItems(["SKU-1", "SKU-2", "SKU-3"]);

    expect(out.has("SKU-1")).toBe(true);
    expect(out.has("SKU-3")).toBe(true);
    // Absent, not zero — which `branchStockState` reads as `unknown`.
    expect(out.has("SKU-2")).toBe(false);
    expect(branchStockState(out.get("SKU-2"), "P0221").state).toBe("unknown");
  });

  it("issues nothing at all for an empty or blank item list", async () => {
    expect((await getStockForItems([])).size).toBe(0);
    expect((await getStockForItems(["", "   "])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds a pathological document rather than opening a request per line", async () => {
    respondWith({});
    const many = Array.from({ length: 80 }, (_, i) => `SKU-${i}`);

    await getStockForItems(many);

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(40);
  });
});
