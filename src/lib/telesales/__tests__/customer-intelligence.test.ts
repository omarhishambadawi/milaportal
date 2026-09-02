import { describe, expect, it } from "vitest";
import {
  classifyLookup,
  deriveCustomerIntelligence,
  historyWindow,
  purchaseDay,
} from "../customer-intelligence";
import { normalizeCrmMobile } from "@/lib/shams/normalize";
import { toSaudiPhone } from "@/lib/phone";
import type { ShamsCrmHistory, ShamsCrmSale } from "@/lib/shams/types";

/** A `crm/data` row, in the shape `groupCrmHistory` produces. */
function sale(over: Partial<ShamsCrmSale> = {}): ShamsCrmSale {
  return {
    docNo: "188767",
    docDate: "2026-08-28T00:00:00",
    branchCode: "P0003",
    branchCity: "JEDDAH",
    branchLabel: "P0003-JEDDAH",
    itemCode: "10611028",
    itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
    quantity: 1,
    ...over,
  };
}

function history(over: Partial<ShamsCrmHistory> = {}): ShamsCrmHistory {
  return {
    customer: {
      customerId: "C-90210",
      name: "Ahmed Mohamed",
      mobile: "0504630565",
      availablePoints: 2450,
      pointsValue: 24.5,
    },
    sales: [sale()],
    page: 1,
    perPage: 100,
    hasMore: false,
    ...over,
  };
}

describe("the phone the MIS is asked with", () => {
  /*
   * The one integration seam in this phase. The Telesales CRM stores
   * `0504630565`; `crm/data` wants nine digits. `normalizeCrmMobile` is the
   * established conversion and it already accepts the canonical form, so there
   * is no second algorithm — this test exists to keep it that way.
   */
  it("converts the canonical Telesales phone to the MIS's nine digits", () => {
    expect(normalizeCrmMobile("0504630565")).toBe("504630565");
    expect(normalizeCrmMobile(toSaudiPhone("+966 50 463 0565"))).toBe("504630565");
    expect(normalizeCrmMobile(toSaudiPhone("00966504630565"))).toBe("504630565");
    expect(normalizeCrmMobile(toSaudiPhone("504630565"))).toBe("504630565");
  });

  it("refuses what the canonical normalizer already refused", () => {
    // A lead with no usable number must never produce a MIS lookup: the
    // endpoint answers 200 with an empty result for an unusable query, which is
    // indistinguishable from a real empty history.
    expect(toSaudiPhone("0000")).toBeNull();
    expect(normalizeCrmMobile("0000")).toBeNull();
    expect(normalizeCrmMobile("")).toBeNull();
    expect(normalizeCrmMobile(null)).toBeNull();
  });

  it("every canonical Saudi mobile survives the conversion", () => {
    for (const p of ["050", "053", "054", "055", "056", "057", "058", "059"]) {
      const canonical = `${p}4630565`;
      expect(normalizeCrmMobile(canonical), canonical).toBe(canonical.slice(1));
    }
  });
});

describe("deriving what the agent sees", () => {
  it("reads the MIS identity and loyalty", () => {
    const i = deriveCustomerIntelligence(history());
    expect(i.misCustomerId).toBe("C-90210");
    expect(i.misName).toBe("Ahmed Mohamed");
    expect(i.loyaltyPoints).toBe(2450);
    expect(i.loyaltyValue).toBe(24.5);
  });

  it("reports loyalty as unknown rather than zero when there is no customer", () => {
    // A number the MIS has never heard of has no balance to read. Rendering
    // "0 points" would be an invented fact about a real person.
    const i = deriveCustomerIntelligence(history({ customer: null, sales: [] }));
    expect(i.loyaltyPoints).toBeNull();
    expect(i.loyaltyValue).toBeNull();
  });

  it("keeps a genuine zero balance as zero", () => {
    const i = deriveCustomerIntelligence(
      history({
        customer: {
          customerId: "C-1",
          name: "N",
          mobile: "0500000000",
          availablePoints: 0,
          pointsValue: 0,
        },
      }),
    );
    expect(i.loyaltyPoints).toBe(0);
    expect(i.loyaltyValue).toBe(0);
  });

  it("preserves the newest-first order the integration already applied", () => {
    const i = deriveCustomerIntelligence(
      history({
        sales: [
          sale({ docDate: "2026-08-28T00:00:00", docNo: "3" }),
          sale({ docDate: "2026-07-01T00:00:00", docNo: "2" }),
          sale({ docDate: "2026-02-14T00:00:00", docNo: "1" }),
        ],
      }),
    );
    expect(i.purchases.map((p) => p.documentNo)).toEqual(["3", "2", "1"]);
  });

  it("identifies the last purchase as the newest dated line", () => {
    const i = deriveCustomerIntelligence(
      history({
        sales: [
          sale({ docDate: "2026-08-28T00:00:00", itemName: "MOUNJARO KWIKPEN 5 MG" }),
          sale({ docDate: "2026-07-01T00:00:00", itemName: "OZEMPIC 1 MG" }),
        ],
      }),
    );
    expect(i.lastPurchase?.itemName).toBe("MOUNJARO KWIKPEN 5 MG");
    expect(i.lastPurchase?.purchasedOn).toBe("2026-08-28");
    expect(i.lastPurchase?.branchCode).toBe("P0003");
    expect(i.lastPurchase?.documentNo).toBe("188767");
  });

  it("skips a dateless row when choosing the last purchase", () => {
    // A row whose date could not be parsed says nothing about when it happened,
    // so it cannot be "the most recent purchase".
    const i = deriveCustomerIntelligence(
      history({
        sales: [
          sale({ docDate: null, docNo: "undated" }),
          sale({ docDate: "2026-08-28T00:00:00", docNo: "dated" }),
        ],
      }),
    );
    expect(i.lastPurchase?.documentNo).toBe("dated");
    // …but it is still shown in the history, in the position it arrived in.
    expect(i.purchases).toHaveLength(2);
    expect(i.purchases[0].documentNo).toBe("undated");
  });

  it("has no last purchase when there are none", () => {
    expect(deriveCustomerIntelligence(history({ sales: [] })).lastPurchase).toBeNull();
    expect(deriveCustomerIntelligence(null).lastPurchase).toBeNull();
  });
});

describe("previously purchased products", () => {
  it("folds repeat purchases of one product into one entry", () => {
    const i = deriveCustomerIntelligence(
      history({
        sales: [
          sale({ docDate: "2026-08-28T00:00:00", itemCode: "10611028", quantity: 1 }),
          sale({ docDate: "2026-07-28T00:00:00", itemCode: "10611028", quantity: 2 }),
          sale({ docDate: "2026-06-28T00:00:00", itemCode: "10611028", quantity: 1 }),
        ],
      }),
    );
    expect(i.products).toHaveLength(1);
    expect(i.products[0].timesPurchased).toBe(3);
    expect(i.products[0].totalQuantity).toBe(4);
    expect(i.products[0].lastPurchasedOn).toBe("2026-08-28");
  });

  it("lists distinct products, most recently purchased first", () => {
    const i = deriveCustomerIntelligence(
      history({
        sales: [
          sale({ docDate: "2026-08-28T00:00:00", itemCode: "A", itemName: "MOUNJARO 5 MG" }),
          sale({ docDate: "2026-07-01T00:00:00", itemCode: "B", itemName: "OZEMPIC 1 MG" }),
          sale({ docDate: "2026-05-01T00:00:00", itemCode: "C", itemName: "FREESTYLE LIBRE" }),
        ],
      }),
    );
    expect(i.products.map((p) => p.itemName)).toEqual([
      "MOUNJARO 5 MG",
      "OZEMPIC 1 MG",
      "FREESTYLE LIBRE",
    ]);
  });

  it("does not split one product because a row lost its code", () => {
    const i = deriveCustomerIntelligence(
      history({
        sales: [
          sale({ itemCode: null, itemName: "MOUNJARO 5 MG" }),
          sale({ itemCode: null, itemName: "mounjaro 5 mg" }),
        ],
      }),
    );
    expect(i.products).toHaveLength(1);
    expect(i.products[0].timesPurchased).toBe(2);
  });

  it("skips a row that names nothing", () => {
    const i = deriveCustomerIntelligence(
      history({ sales: [sale({ itemCode: null, itemName: null })] }),
    );
    expect(i.products).toHaveLength(0);
  });
});

describe("dates", () => {
  it("reads the day off the string rather than through Date", () => {
    // No timezone in the payload; constructing an instant would move a midnight
    // purchase into the previous day west of Riyadh.
    expect(purchaseDay({ docDate: "2026-08-28T00:00:00" })).toBe("2026-08-28");
    expect(purchaseDay({ docDate: "2026-08-28" })).toBe("2026-08-28");
    expect(purchaseDay({ docDate: "not a date" })).toBeNull();
    expect(purchaseDay({ docDate: null })).toBeNull();
  });

  it("asks the MIS for a two-year window in its own format", () => {
    const w = historyWindow(new Date(Date.UTC(2026, 8, 3)));
    expect(w.toDate).toBe("20260903");
    expect(w.fromDate).toBe("20240903");
    expect(w.fromDate).toMatch(/^\d{8}$/);
    expect(w.toDate).toMatch(/^\d{8}$/);
  });

  it("crosses a year boundary", () => {
    expect(historyWindow(new Date(Date.UTC(2026, 0, 15)), 24).fromDate).toBe("20240115");
    expect(historyWindow(new Date(Date.UTC(2026, 0, 15)), 1).fromDate).toBe("20251215");
  });
});

describe("telling the four kinds of nothing apart", () => {
  /*
   * The distinction this whole phase turns on. An unreachable MIS and a
   * customer who has never bought anything both produce an empty list, and
   * telling an agent "no purchase history" when the lookup actually failed
   * invites them to say something false to a customer of ten years.
   */
  it("reports an unconfigured deployment as unconfigured", () => {
    expect(classifyLookup({ configured: false, ok: false, errorKind: null, history: null })).toBe(
      "not_configured",
    );
  });

  it("reports a failure as an error, never as an empty history", () => {
    expect(
      classifyLookup({ configured: true, ok: false, errorKind: "timeout", history: null }),
    ).toBe("error");
    expect(
      classifyLookup({ configured: true, ok: false, errorKind: "auth_failed", history: null }),
    ).toBe("error");
    expect(
      classifyLookup({ configured: true, ok: false, errorKind: "unavailable", history: null }),
    ).toBe("error");
    expect(
      classifyLookup({ configured: true, ok: false, errorKind: "http_error", history: null }),
    ).toBe("error");
  });

  it("reports a number the MIS does not know as no customer", () => {
    expect(
      classifyLookup({
        configured: true,
        ok: true,
        errorKind: null,
        history: history({ customer: null, sales: [] }),
      }),
    ).toBe("no_customer");
  });

  it("reports a known customer with nothing bought as no purchases", () => {
    expect(
      classifyLookup({
        configured: true,
        ok: true,
        errorKind: null,
        history: history({ sales: [] }),
      }),
    ).toBe("no_purchases");
  });

  it("reports a real history as ready", () => {
    expect(
      classifyLookup({ configured: true, ok: true, errorKind: null, history: history() }),
    ).toBe("ready");
  });

  it("puts configuration before failure and failure before absence", () => {
    // An unconfigured deployment is not an outage…
    expect(
      classifyLookup({ configured: false, ok: false, errorKind: "timeout", history: null }),
    ).toBe("not_configured");
    // …and an outage is not an empty history.
    expect(
      classifyLookup({
        configured: true,
        ok: false,
        errorKind: "timeout",
        history: history({ sales: [] }),
      }),
    ).toBe("error");
  });
});
