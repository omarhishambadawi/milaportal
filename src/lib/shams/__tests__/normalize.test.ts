/**
 * Shams normalization tests.
 *
 * Fixtures are copied verbatim from the 2026-08-13 HAR capture — including its
 * awkward numeric spellings (`".000"`, `"806.22000000000003"`), because those
 * are precisely what the parsing exists to survive. The one departure from the
 * capture: the identifiers on the invoice header are replaced with `"REDACTED"`
 * placeholders. Their *presence* is what the privacy assertions test; their
 * values have no business being in a repository.
 *
 * The customer *label* fields are not redacted, because they are not people —
 * they carry the sales-channel account name the Call Centre classification
 * reads, and the point of several tests is which of them wins.
 */

import { describe, expect, it } from "vitest";
import {
  documentKey,
  groupInvoices,
  isHeaderRow,
  normalizeProductDetail,
  normalizeProducts,
  normalizeStock,
  isCallCentreCustomer,
  stripLeadingZeros,
  toIsoDateTime,
  toMoney,
  toNumber,
} from "@/lib/shams/normalize";
import { validateInvoiceQuery, ShamsQueryError } from "@/lib/shams/sales.server";
import { ALL_PERMISSIONS } from "@/lib/permissions";
import type { RawSalesRow } from "@/lib/shams/types";

/** The permission keys `shams.functions.ts` gates its handlers on. */
const SHAMS_GATES = {
  catalog: "view_orders",
  invoices: "view_invoice_analytics",
} as const;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** From `GET /api/v2/product/search?q=mounjaro` (first three of twelve rows). */
const SEARCH_ROWS = [
  { itemCode: "10609670", itemName: "MOUNJARO 2.5 MG 0.5ML PEN, 4'S", retailPrice: 1261.4 },
  { itemCode: "10609671", itemName: "MOUNJARO 5 MG 0.5ML PEN, 4'S", retailPrice: 1261.4 },
  {
    itemCode: "10611031",
    itemName: "MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR",
    retailPrice: 1261.4,
  },
];

/** From `GET /api/v2/product/stock?itemcode=10611031`. */
const STOCK_ROWS = [
  { branchCode: "P0003", branchName: "P0003", areaName: "RIYADH", quantity: 13, lzQuantity: 0 },
  { branchCode: "P0001", branchName: "P0001", areaName: "RIYADH", quantity: 3, lzQuantity: 0 },
  { branchCode: "P0304", branchName: "P0304", areaName: "QASIM", quantity: 0, lzQuantity: 0 },
];

/**
 * From `GET /api/v2/sales/details?...doc_no_start=0075181&wh_cd=P0304`.
 *
 * The whole point of the fixture: two rows, one document. The header carries
 * `GrandAmt "806.220"` and empty item fields; the item carries
 * `Amt "806.22000000000003"` and a zeroed `GrandAmt`.
 */
const HEADER_ROW: RawSalesRow = {
  Usr_ID: "REDACTED",
  Doc_No: "75181",
  Doc_Dt: "2026-08-13 00:00:00",
  Doc_type: "Credit",
  PatCd: "REDACTED",
  CusName: "",
  // The two disagree on the wire, which is the whole bug: `Customer` is the
  // bare account name, `Customer_Name` carries the channel suffix and is what
  // the MIS portal displays.
  Customer: "HOME DELIVERY",
  Customer_Name: "HOME DELIVERY-Call Centre",
  Customer_Code: "REDACTED",
  Whouse: "P0304",
  Division: "##",
  Cus_Cd: "REDACTED",
  Doc_Cancelled: "0",
  Cash_Amt: ".000",
  Cash_Tax: ".000",
  Credit_Amt: "806.22000000000003",
  Credit_Tax: ".000",
  Discount: "0.0",
  TotalCost: "1445.8499999999999",
  Profit: "-639.63",
  TotalTax: ".000",
  GrandAmt: "806.220",
  Prior: "0",
  ItmCd: "",
  ItmName: "",
  Qty: "0.0",
  LzQty: "0.0",
  FocQty: "0.0",
  FocLzQty: "0.0",
  Rate: "0.0",
  ItmGrossAmt: ".0000000",
  ItmDiscAmt: ".000",
  Amt: "0.0",
  ItemTax: ".000",
  Item_NetAmt: ".000",
};

const ITEM_ROW: RawSalesRow = {
  Usr_ID: "REDACTED",
  Doc_No: "75181",
  Doc_Dt: "2026-08-13 00:00:00",
  Doc_type: "Credit",
  PatCd: "",
  CusName: "",
  Customer: "",
  Customer_Name: "",
  Customer_Code: "",
  Whouse: "P0304",
  Division: "##",
  Cus_Cd: "",
  Doc_Cancelled: "0",
  Cash_Amt: ".000",
  Cash_Tax: ".000",
  Credit_Amt: "0.0",
  Credit_Tax: ".000",
  Discount: "0.0",
  TotalCost: "0.0",
  Profit: "0.0",
  TotalTax: ".000",
  GrandAmt: ".000",
  Prior: "1",
  ItmCd: "10612388",
  ItmName: "DEXCOM ONE PLUS SENSOR 1 S",
  Qty: "9.0",
  LzQty: "0.0",
  FocQty: "0.0",
  FocLzQty: "0.0",
  Rate: "89.579999999999998",
  ItmGrossAmt: "806.2200000",
  ItmDiscAmt: ".000",
  Amt: "806.22000000000003",
  ItemTax: ".000",
  Item_NetAmt: "806.220",
};

/* -------------------------------------------------------------------------- */
/* Scalars                                                                     */
/* -------------------------------------------------------------------------- */

describe("numeric parsing", () => {
  it("parses the API's leading-dot notation", () => {
    expect(toNumber(".000")).toBe(0);
    expect(toNumber(".0000000")).toBe(0);
    expect(toMoney(".000")).toBe(0);
  });

  it("distinguishes absent from zero", () => {
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("0.0")).toBe(0);
  });

  it("rounds away the API's float noise", () => {
    expect(toMoney("806.22000000000003")).toBe(806.22);
    expect(toMoney("1445.8499999999999")).toBe(1445.85);
    expect(toMoney("89.579999999999998")).toBe(89.58);
  });

  it("keeps negatives, which Profit genuinely uses", () => {
    expect(toMoney("-639.63")).toBe(-639.63);
  });

  it("rejects non-numeric text rather than yielding NaN", () => {
    expect(toNumber("abc")).toBeNull();
    expect(toMoney("abc")).toBe(0);
  });
});

describe("toIsoDateTime", () => {
  it("normalizes the separator without inventing a timezone", () => {
    expect(toIsoDateTime("2026-08-13 00:00:00")).toBe("2026-08-13T00:00:00");
  });

  it("passes unexpected formats through instead of nulling them", () => {
    expect(toIsoDateTime("13/08/2026")).toBe("13/08/2026");
    expect(toIsoDateTime("")).toBeNull();
  });
});

describe("stripLeadingZeros", () => {
  it("reconciles the padded request form with the unpadded response form", () => {
    expect(stripLeadingZeros("0075181")).toBe("75181");
    expect(stripLeadingZeros("75181")).toBe("75181");
  });

  it("does not annihilate a genuine zero", () => {
    expect(stripLeadingZeros("000")).toBe("0");
    expect(stripLeadingZeros("")).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* Products                                                                    */
/* -------------------------------------------------------------------------- */

describe("normalizeProducts", () => {
  it("maps the three fields the catalog actually returns", () => {
    const [first] = normalizeProducts(SEARCH_ROWS);
    expect(first).toEqual({
      itemCode: "10609670",
      itemName: "MOUNJARO 2.5 MG 0.5ML PEN, 4'S",
      retailPrice: 1261.4,
    });
  });

  it("exposes no invented pharmaceutical fields", () => {
    const [first] = normalizeProducts(SEARCH_ROWS);
    expect(Object.keys(first).sort()).toEqual(["itemCode", "itemName", "retailPrice"]);
  });

  it("drops rows with no item code", () => {
    expect(normalizeProducts([{ itemName: "orphan", retailPrice: 1 }])).toEqual([]);
  });

  it("survives a missing or malformed payload", () => {
    expect(normalizeProducts(undefined)).toEqual([]);
    expect(normalizeProducts(null)).toEqual([]);
    expect(normalizeProducts([] as never)).toEqual([]);
  });
});

describe("normalizeProductDetail", () => {
  it("carries the tax-inclusive price through", () => {
    expect(
      normalizeProductDetail({
        itemCode: "10609670",
        itemName: "MOUNJARO 2.5 MG 0.5ML PEN, 4'S",
        retailPrice: 1261.4,
        retailPriceWithTax: 1261.4,
      }),
    ).toEqual({
      itemCode: "10609670",
      itemName: "MOUNJARO 2.5 MG 0.5ML PEN, 4'S",
      retailPrice: 1261.4,
      retailPriceWithTax: 1261.4,
    });
  });

  it("falls back to the ex-tax price rather than reporting a free product", () => {
    const detail = normalizeProductDetail({ itemCode: "X", itemName: "Y", retailPrice: 10 });
    expect(detail?.retailPriceWithTax).toBe(10);
  });

  it("returns null for an unknown item code", () => {
    expect(normalizeProductDetail(null)).toBeNull();
    expect(normalizeProductDetail({})).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Stock                                                                       */
/* -------------------------------------------------------------------------- */

describe("normalizeStock", () => {
  it("orders by branch code", () => {
    expect(normalizeStock(STOCK_ROWS).map((r) => r.branchCode)).toEqual([
      "P0001",
      "P0003",
      "P0304",
    ]);
  });

  it("keeps zero-quantity branches, so 'stocked nowhere' stays distinguishable", () => {
    const rows = normalizeStock(STOCK_ROWS);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.branchCode === "P0304")?.quantity).toBe(0);
  });

  it("emits branch codes in the same space as branches.branch_no", () => {
    for (const row of normalizeStock(STOCK_ROWS)) {
      expect(row.branchCode).toMatch(/^P\d{4}$/);
    }
  });

  it("survives a malformed payload", () => {
    expect(normalizeStock(undefined)).toEqual([]);
    expect(normalizeStock([{ areaName: "RIYADH" }])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Invoices — the header/item fold                                             */
/* -------------------------------------------------------------------------- */

describe("invoice row classification", () => {
  it("reads Prior as the discriminator", () => {
    expect(isHeaderRow(HEADER_ROW)).toBe(true);
    expect(isHeaderRow(ITEM_ROW)).toBe(false);
  });

  it("keys a document by warehouse and unpadded number", () => {
    expect(documentKey(HEADER_ROW)).toBe("P0304::75181");
    expect(documentKey({ ...ITEM_ROW, Doc_No: "0075181" })).toBe("P0304::75181");
  });
});

describe("groupInvoices", () => {
  it("folds two rows into one document, not two invoices", () => {
    const invoices = groupInvoices([HEADER_ROW, ITEM_ROW]);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].items).toHaveLength(1);
  });

  it("takes totals from the header and lines from the item row", () => {
    const [invoice] = groupInvoices([HEADER_ROW, ITEM_ROW]);
    expect(invoice.docNo).toBe("75181");
    expect(invoice.branchCode).toBe("P0304");
    expect(invoice.docType).toBe("Credit");
    expect(invoice.docDate).toBe("2026-08-13T00:00:00");
    expect(invoice.cancelled).toBe(false);
    expect(invoice.grandTotal).toBe(806.22);
    expect(invoice.creditAmount).toBe(806.22);
    expect(invoice.totalCost).toBe(1445.85);
    expect(invoice.profit).toBe(-639.63);
    expect(invoice.items[0]).toEqual({
      itemCode: "10612388",
      itemName: "DEXCOM ONE PLUS SENSOR 1 S",
      quantity: 9,
      lzQuantity: 0,
      freeQuantity: 0,
      freeLzQuantity: 0,
      unitRate: 89.58,
      grossAmount: 806.22,
      discountAmount: 0,
      amount: 806.22,
      tax: 0,
      netAmount: 806.22,
    });
  });

  it("does not double-count: the grand total is the header's, not a row sum", () => {
    const [invoice] = groupInvoices([HEADER_ROW, ITEM_ROW]);
    const naiveSum = invoice.grandTotal + invoice.items[0].amount;
    expect(invoice.grandTotal).toBe(806.22);
    expect(naiveSum).toBe(1612.44); // what treating every row as an invoice would report
  });

  it("separates documents that share a response", () => {
    const other = { ...HEADER_ROW, Doc_No: "75182" };
    const otherItem = { ...ITEM_ROW, Doc_No: "75182", ItmCd: "999" };
    const invoices = groupInvoices([HEADER_ROW, ITEM_ROW, other, otherItem]);
    expect(invoices.map((i) => i.docNo)).toEqual(["75181", "75182"]);
    expect(invoices.every((i) => i.items.length === 1)).toBe(true);
  });

  it("separates identical document numbers in different warehouses", () => {
    const elsewhere = { ...HEADER_ROW, Whouse: "P0027" };
    expect(groupInvoices([HEADER_ROW, elsewhere])).toHaveLength(2);
  });

  it("keeps items when the header row is absent rather than dropping the document", () => {
    const [invoice] = groupInvoices([ITEM_ROW]);
    expect(invoice.docNo).toBe("75181");
    expect(invoice.items).toHaveLength(1);
    expect(invoice.grandTotal).toBe(0);
  });

  it("reads the cancellation flag", () => {
    const [invoice] = groupInvoices([{ ...HEADER_ROW, Doc_Cancelled: "1" }, ITEM_ROW]);
    expect(invoice.cancelled).toBe(true);
  });

  it("returns [] for the empty result the API gives an unknown document", () => {
    expect(groupInvoices([])).toEqual([]);
    expect(groupInvoices(undefined)).toEqual([]);
    expect(groupInvoices(null)).toEqual([]);
  });

  it("survives malformed rows", () => {
    expect(groupInvoices([null as never, undefined as never])).toEqual([]);
  });

  it("carries no identifier into the normalized model", () => {
    const [invoice] = groupInvoices([HEADER_ROW, ITEM_ROW]);
    const serialized = JSON.stringify(invoice);
    // Every redacted field is an identifier; the customer *label* is the one
    // header field deliberately kept, and it is not redacted in the fixture.
    expect(serialized).not.toContain("REDACTED");
    for (const leaked of ["PatCd", "Customer_Code", "Cus_Cd", "Usr_ID"]) {
      expect(serialized).not.toContain(leaked);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Invoices — Call Centre classification                                       */
/* -------------------------------------------------------------------------- */

describe("isCallCentreCustomer", () => {
  it("classifies a customer that ends with the -Call Centre suffix", () => {
    expect(isCallCentreCustomer("NUPCO / الشركة الوطنية للشراء الموحد (نوبكو)-Call Centre")).toBe(
      true,
    );
    expect(isCallCentreCustomer("HOME DELIVERY-Call Centre")).toBe(true);
    expect(isCallCentreCustomer("CALL CENTER SALES-Call Centre")).toBe(true);
  });

  it("tolerates case and whitespace around the suffix", () => {
    expect(isCallCentreCustomer("home delivery-call centre")).toBe(true);
    expect(isCallCentreCustomer("HOME DELIVERY - Call Centre")).toBe(true);
    expect(isCallCentreCustomer("HOME DELIVERY-CALL CENTRE")).toBe(true);
    expect(isCallCentreCustomer("  HOME DELIVERY-Call Centre  ")).toBe(true);
  });

  it("does not classify the same accounts without the suffix", () => {
    expect(isCallCentreCustomer("NUPCO / الشركة الوطنية للشراء الموحد (نوبكو)")).toBe(false);
    expect(isCallCentreCustomer("HOME DELIVERY")).toBe(false);
    expect(isCallCentreCustomer("CALL CENTER")).toBe(false);
  });

  /**
   * The distinction the whole rule exists for. `CALL CENTER SALES` is a walk-in
   * account whose *name* mentions a call center; matching on the words rather
   * than the suffix would silently reclassify every one of its invoices.
   */
  it("does not classify CALL CENTER SALES, which merely contains the words", () => {
    expect(isCallCentreCustomer("CALL CENTER SALES")).toBe(false);
    expect(isCallCentreCustomer("call center sales")).toBe(false);
  });

  it("requires the suffix to terminate the value", () => {
    expect(isCallCentreCustomer("HOME DELIVERY-Call Centre Riyadh")).toBe(false);
    expect(isCallCentreCustomer("Call Centre-HOME DELIVERY")).toBe(false);
  });

  it("requires the hyphen, not just the words at the end", () => {
    expect(isCallCentreCustomer("HOME DELIVERY CALL CENTRE")).toBe(false);
  });

  it("treats an absent or blank customer as not Call Centre", () => {
    expect(isCallCentreCustomer(null)).toBe(false);
    expect(isCallCentreCustomer(undefined)).toBe(false);
    expect(isCallCentreCustomer("")).toBe(false);
    expect(isCallCentreCustomer("   ")).toBe(false);
    expect(isCallCentreCustomer(42)).toBe(false);
  });
});

describe("groupInvoices — customer and Call Centre status", () => {
  /**
   * The regression. Document P0221/22138 is a real call-centre invoice whose
   * `Customer` and `Customer_Name` disagree: reading `Customer` drops the
   * `-Call Centre` suffix and reports a call-centre document as a walk-in one.
   * The MIS portal's own Sales Register renders `Customer_Name ?? CusName`.
   */
  it("reads the label the MIS portal displays, not the bare Customer field", () => {
    const header: RawSalesRow = {
      ...HEADER_ROW,
      Doc_No: "22138",
      Whouse: "P0221",
      Customer: "NUPCO / الشركة الوطنية للشراء الموحد (نوبكو)",
      Customer_Name: "NUPCO / الشركة الوطنية للشراء الموحد (نوبكو)-Call Centre",
      CusName: "",
    };
    const [invoice] = groupInvoices([header, { ...ITEM_ROW, Doc_No: "22138", Whouse: "P0221" }]);
    expect(invoice.customer).toBe("NUPCO / الشركة الوطنية للشراء الموحد (نوبكو)-Call Centre");
    expect(invoice.isCallCentre).toBe(true);
  });

  it("still reports no Call Centre status when that label has no suffix", () => {
    const [invoice] = groupInvoices([
      {
        ...HEADER_ROW,
        Customer_Name: "NUPCO / الشركة الوطنية للشراء الموحد (نوبكو)",
      },
      ITEM_ROW,
    ]);
    expect(invoice.customer).toBe("NUPCO / الشركة الوطنية للشراء الموحد (نوبكو)");
    expect(invoice.isCallCentre).toBe(false);
  });

  it("falls back to CusName when Customer_Name is blank", () => {
    // `??` alone would settle on the empty string and never reach the fallback,
    // because the API spells a missing field "" rather than null.
    const [invoice] = groupInvoices([
      { ...HEADER_ROW, Customer_Name: "", CusName: "HOME DELIVERY-Call Centre" },
      ITEM_ROW,
    ]);
    expect(invoice.customer).toBe("HOME DELIVERY-Call Centre");
    expect(invoice.isCallCentre).toBe(true);
  });

  it("does not fall back to the Customer field, which disagrees with the portal", () => {
    const [invoice] = groupInvoices([
      { ...HEADER_ROW, Customer_Name: "", CusName: "", Customer: "HOME DELIVERY-Call Centre" },
      ITEM_ROW,
    ]);
    expect(invoice.customer).toBeNull();
    expect(invoice.isCallCentre).toBe(false);
  });

  it("takes the customer from the header row, trimmed but otherwise verbatim", () => {
    const [invoice] = groupInvoices([
      { ...HEADER_ROW, Customer_Name: "  HOME DELIVERY-Call Centre  " },
      ITEM_ROW,
    ]);
    expect(invoice.customer).toBe("HOME DELIVERY-Call Centre");
    expect(invoice.isCallCentre).toBe(true);
  });

  it("derives the status from the customer, not from branch, type or items", () => {
    const [nonCallCentre] = groupInvoices([
      { ...HEADER_ROW, Customer_Name: "CALL CENTER SALES" },
      ITEM_ROW,
    ]);
    expect(nonCallCentre.customer).toBe("CALL CENTER SALES");
    expect(nonCallCentre.isCallCentre).toBe(false);

    const [callCentre] = groupInvoices([
      { ...HEADER_ROW, Customer_Name: "CALL CENTER SALES-Call Centre" },
      ITEM_ROW,
    ]);
    expect(callCentre.isCallCentre).toBe(true);
  });

  it("reports no customer, and no Call Centre status, when the header is absent", () => {
    // Item rows blank the customer fields, so there is nothing to read.
    const [invoice] = groupInvoices([ITEM_ROW]);
    expect(invoice.customer).toBeNull();
    expect(invoice.isCallCentre).toBe(false);
  });

  it("reports a blank customer as null rather than an empty string", () => {
    const [invoice] = groupInvoices([{ ...HEADER_ROW, Customer_Name: "", CusName: "" }, ITEM_ROW]);
    expect(invoice.customer).toBeNull();
    expect(invoice.isCallCentre).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Query validation                                                            */
/* -------------------------------------------------------------------------- */

describe("validateInvoiceQuery", () => {
  it("accepts the capture's own query shape", () => {
    expect(validateInvoiceQuery({ branchCode: "P0304", docNoStart: "0075181" })).toEqual({
      branchCode: "P0304",
      docNoStart: "0075181",
      docNoEnd: "0075181",
      startDate: "",
      endDate: "",
    });
  });

  it("defaults the range end to a single document", () => {
    expect(validateInvoiceQuery({ branchCode: "P0027", docNoStart: "87578" }).docNoEnd).toBe(
      "87578",
    );
  });

  it("rejects a branch code that is not a warehouse code", () => {
    expect(() => validateInvoiceQuery({ branchCode: "RIYADH", docNoStart: "1" })).toThrow(
      ShamsQueryError,
    );
  });

  it("rejects a non-numeric document number", () => {
    expect(() => validateInvoiceQuery({ branchCode: "P0304", docNoStart: "75181; DROP" })).toThrow(
      ShamsQueryError,
    );
  });

  it("rejects an inverted range", () => {
    expect(() =>
      validateInvoiceQuery({ branchCode: "P0304", docNoStart: "200", docNoEnd: "100" }),
    ).toThrow(ShamsQueryError);
  });

  it("rejects a date that is not YYYYMMDD", () => {
    expect(() =>
      validateInvoiceQuery({ branchCode: "P0304", docNoStart: "1", startDate: "2026-08-13" }),
    ).toThrow(ShamsQueryError);
  });
});

/* -------------------------------------------------------------------------- */
/* Authorization gates                                                         */
/* -------------------------------------------------------------------------- */

describe("Shams server-function gates", () => {
  /**
   * A gate naming a permission that does not exist denies everyone except
   * owner/admin — `has_permission` short-circuits for those two and returns
   * false for the rest — so a renamed or mistyped key fails quietly, as a
   * feature that "only works for admins". This pins the names instead.
   */
  it("gates on permission keys that actually exist", () => {
    const keys = new Set(ALL_PERMISSIONS.map((p) => p.key));
    for (const gate of Object.values(SHAMS_GATES)) {
      expect(keys.has(gate)).toBe(true);
    }
  });

  it("gates invoices more narrowly than the catalog, because invoices carry margin", () => {
    // Not the same key: ShamsInvoice exposes totalCost and profit, which is a
    // smaller audience than product availability.
    expect(SHAMS_GATES.invoices).not.toBe(SHAMS_GATES.catalog);
    expect(ALL_PERMISSIONS.find((p) => p.key === SHAMS_GATES.invoices)?.group).toBe(
      "Invoice Verification",
    );
  });
});
