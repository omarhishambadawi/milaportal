/**
 * Order → Invoice → Branch → Stock, end to end at the server modules.
 *
 * The server function above these is a permission gate and a `try`; the chain it
 * runs is `parseInvoiceNumbers` → `getInvoices` / `findInvoiceBranches` →
 * `invoiceItemCodes` → `getStockForItems` → `resolveItemAvailability`, and that
 * is what is exercised here with `shamsFetch` stubbed.
 *
 * What these assert above all is the **request budget**. The order's branch is a
 * lead worth one request; the sweep is 137. Getting that ordering wrong, or
 * re-asking for a document the sweep already downloaded, is the difference
 * between a panel that opens and one an agent waits on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawSalesRow, RawStockRow } from "@/lib/shams/types";
import { invoiceItemCodes, resolveItemAvailability } from "@/lib/shams/availability";
import { parseInvoiceNumbers } from "@/features/orders/utils";

const fetchMock = vi.fn();

vi.mock("@/lib/shams/client.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shams/client.server")>(
    "@/lib/shams/client.server",
  );
  return { ...actual, shamsFetch: (...args: unknown[]) => fetchMock(...args) };
});

const { findInvoiceBranches, getInvoices, _clearDiscoveryCache } =
  await import("@/lib/shams/sales.server");
const { getStockForItems, _clearCaches } = await import("@/lib/shams/catalog.server");

/** MilaServ's chain, standing in for the 137 real branches. */
const CHAIN = ["P0001", "P0034", "P0221", "P0505"];

function header(docNo: string, whouse: string, customer: string, total: string): RawSalesRow {
  return {
    Doc_No: docNo,
    Doc_Dt: "2026-08-13 00:00:00",
    Doc_type: "Credit",
    Whouse: whouse,
    Customer_Name: customer,
    Doc_Cancelled: "0",
    GrandAmt: total,
    Prior: "0",
  };
}

function line(docNo: string, whouse: string, itmCd: string, qty: number): RawSalesRow {
  return {
    Doc_No: docNo,
    Whouse: whouse,
    Prior: "1",
    ItmCd: itmCd,
    ItmName: `Item ${itmCd}`,
    Qty: String(qty),
    Rate: "50.00",
    Item_NetAmt: String(50 * qty),
  };
}

/** A document with two lines, as one branch's `sales/details` answer. */
function document(docNo: string, whouse: string, customer = "HOME DELIVERY-Call Centre") {
  return [
    header(docNo, whouse, customer, "230.00"),
    line(docNo, whouse, "SKU-1", 2),
    line(docNo, whouse, "SKU-2", 1),
  ];
}

function stockRow(branchCode: string, quantity: number): RawStockRow {
  return { branchCode, branchName: branchCode, areaName: "RIYADH", quantity };
}

/** Route `sales/details` by `wh_cd` and `product/stock` by `itemcode`. */
function respondWith(options: {
  sales?: Record<string, RawSalesRow[]>;
  stock?: Record<string, RawStockRow[]>;
}) {
  fetchMock.mockImplementation(async (path: string, query: Record<string, string>) => {
    if (path.includes("sales/details")) {
      return { success: true, data: options.sales?.[query.wh_cd] ?? [] };
    }
    return { success: true, data: options.stock?.[query.itemcode] ?? [] };
  });
}

/** Upstream calls whose path is `sales/details`. */
function salesCalls() {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes("sales/details"));
}
function stockCalls() {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes("product/stock"));
}

beforeEach(() => {
  fetchMock.mockReset();
  _clearDiscoveryCache();
  _clearCaches();
});

/* -------------------------------------------------------------------------- */
/* Order → invoice numbers                                                     */
/* -------------------------------------------------------------------------- */

describe("an order's invoice numbers", () => {
  it("reads the one column that holds one or many", () => {
    expect(parseInvoiceNumbers("22138")).toEqual(["22138"]);
    expect(parseInvoiceNumbers("22138, 22139")).toEqual(["22138", "22139"]);
    // Older rows separate with newlines.
    expect(parseInvoiceNumbers("22138\n22139")).toEqual(["22138", "22139"]);
  });

  it("yields nothing for an order without one, so nothing is ever looked up", () => {
    expect(parseInvoiceNumbers(null)).toEqual([]);
    expect(parseInvoiceNumbers("")).toEqual([]);
    expect(parseInvoiceNumbers("  ,  ")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The order's branch: one request, and only a lead                            */
/* -------------------------------------------------------------------------- */

describe("checking the branch on the order", () => {
  it("costs one request when the branch does hold the document", async () => {
    respondWith({ sales: { P0221: document("22138", "P0221") } });

    const invoices = await getInvoices({ branchCode: "P0221", docNoStart: "22138" });

    expect(salesCalls()).toHaveLength(1);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].branchCode).toBe("P0221");
    expect(invoices[0].items).toHaveLength(2);
  });

  it("answers 'not here' as data rather than as a failure", async () => {
    // The order names P0034; Shams raised the document at P0221. The branch on
    // the order is a lead, and this is the lead not paying off.
    respondWith({ sales: { P0221: document("22138", "P0221") } });

    const invoices = await getInvoices({ branchCode: "P0034", docNoStart: "22138" });

    expect(invoices).toEqual([]);
    expect(salesCalls()).toHaveLength(1);
  });

  it("finds a zero-padded number the order recorded", async () => {
    // The form stores what the agent typed; the MIS returns it unpadded. The
    // API accepts either on input, and the document that comes back is the one.
    respondWith({ sales: { P0221: document("22138", "P0221") } });

    const invoices = await getInvoices({ branchCode: "P0221", docNoStart: "022138" });

    expect(invoices).toHaveLength(1);
    expect(invoices[0].docNo).toBe("22138");
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep: authoritative, and never re-asked                                */
/* -------------------------------------------------------------------------- */

describe("searching every branch", () => {
  it("returns the one branch that holds it", async () => {
    respondWith({ sales: { P0221: document("22138", "P0221") } });

    const { matches } = await findInvoiceBranches("22138", CHAIN);

    expect(matches.map((m) => m.branchCode)).toEqual(["P0221"]);
  });

  it("keeps every branch when the number exists in several", async () => {
    // The same number in two warehouses is two different sales. Collapsing them
    // to "the" branch would report one order against the wrong document.
    respondWith({
      sales: {
        P0221: document("22138", "P0221", "HOME DELIVERY-Call Centre"),
        P0034: document("22138", "P0034", "CASH SALES"),
      },
    });

    const { matches } = await findInvoiceBranches("22138", CHAIN);

    expect(matches.map((m) => m.branchCode)).toEqual(["P0221", "P0034"]);
    expect(matches[0].isCallCentre).toBe(true);
    expect(matches[1].isCallCentre).toBe(false);
  });

  it("reports a number Shams has never seen as no matches, not an error", async () => {
    respondWith({ sales: {} });

    const { matches, probed } = await findInvoiceBranches("87578", CHAIN);

    expect(matches).toEqual([]);
    expect(probed).toBe(CHAIN.length);
  });

  it("hands the document to the branch step without asking again", async () => {
    respondWith({ sales: { P0221: document("22138", "P0221") } });

    await findInvoiceBranches("22138", CHAIN);
    const afterSweep = salesCalls().length;

    // What the panel does when the agent picks a branch from the sweep.
    const invoices = await getInvoices({ branchCode: "P0221", docNoStart: "22138" });

    expect(salesCalls()).toHaveLength(afterSweep);
    expect(invoices[0].items).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Invoice → stock                                                             */
/* -------------------------------------------------------------------------- */

describe("the whole chain, and what it costs", () => {
  async function chain(branchCode: string, docNo: string) {
    const invoice = (await getInvoices({ branchCode, docNoStart: docNo }))[0] ?? null;
    if (!invoice) return { invoice: null, items: [] };
    const stockByCode = await getStockForItems(invoiceItemCodes(invoice.items));
    return {
      invoice,
      items: resolveItemAvailability(invoice.items, stockByCode, branchCode),
    };
  }

  it("resolves order → invoice → branch → stock in one request per item", async () => {
    respondWith({
      sales: { P0221: document("22138", "P0221") },
      stock: {
        "SKU-1": [stockRow("P0221", 14), stockRow("P0034", 3)],
        "SKU-2": [stockRow("P0221", 0)],
      },
    });

    const { invoice, items } = await chain("P0221", "22138");

    expect(invoice?.branchCode).toBe("P0221");
    // One document read, one stock read per distinct product. No N+1 on lines.
    expect(salesCalls()).toHaveLength(1);
    expect(stockCalls()).toHaveLength(2);
    expect(items).toEqual([
      {
        itemCode: "SKU-1",
        itemName: "Item SKU-1",
        invoiced: 2,
        state: "in_stock",
        quantity: 14,
        // Straight off the document's `Rate` and `Item_NetAmt`, through the
        // whole chain — the panel's price columns read these.
        unitRate: 50,
        lineTotal: 100,
      },
      {
        itemCode: "SKU-2",
        itemName: "Item SKU-2",
        invoiced: 1,
        state: "out_of_stock",
        quantity: 0,
        unitRate: 50,
        lineTotal: 50,
      },
    ]);
  });

  it("reports stock for the branch that raised the invoice, not the order's", async () => {
    // P0221 has 14; P0034 has 3. Reading the wrong branch is the failure mode
    // that "order branch = invoice branch" would cause.
    respondWith({
      sales: { P0034: document("22138", "P0034", "CASH SALES") },
      stock: { "SKU-1": [stockRow("P0221", 14), stockRow("P0034", 3)], "SKU-2": [] },
    });

    const { items } = await chain("P0034", "22138");

    expect(items[0]).toMatchObject({ state: "in_stock", quantity: 3 });
    // SKU-2 is not in the catalogue at all — distinct from "out of stock".
    expect(items[1]).toMatchObject({ state: "not_found", quantity: null });
  });

  it("still returns the invoice when every stock lookup fails", async () => {
    fetchMock.mockImplementation(async (path: string, query: Record<string, string>) => {
      if (path.includes("sales/details")) {
        return { success: true, data: query.wh_cd === "P0221" ? document("22138", "P0221") : [] };
      }
      throw new Error("stock endpoint down");
    });

    const { invoice, items } = await chain("P0221", "22138");

    // One failed external request must not cost the agent the document.
    expect(invoice?.grandTotal).toBe(230);
    expect(items.map((i) => i.state)).toEqual(["unknown", "unknown"]);
  });

  it("costs nothing extra for a second order sharing a product", async () => {
    respondWith({
      sales: { P0221: document("22138", "P0221"), P0505: document("22139", "P0505") },
      stock: { "SKU-1": [stockRow("P0221", 14)], "SKU-2": [stockRow("P0221", 1)] },
    });

    await chain("P0221", "22138");
    const afterFirst = stockCalls().length;
    // A different document at a different branch, same two products.
    await chain("P0505", "22139");

    expect(afterFirst).toBe(2);
    expect(stockCalls()).toHaveLength(2);
  });
});
