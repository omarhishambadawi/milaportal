import { describe, expect, it } from "vitest";
import {
  buildRelationCatalog,
  describeRelation,
  planSave,
  validateRelation,
  type RelationProduct,
} from "../relations";
import {
  groupHistoryByPhone,
  groupRelationsByItem,
  recommendLead,
  type ProductRelation,
  type PurchaseRecord,
  type RecommendableLead,
  type RecommendationContext,
} from "../recommendations";
import { buildProductIdentityIndex } from "../identity";

const TODAY = "2026-09-02";
const PHONE = "0504630565";

const MOUNJARO_5 = "10611028";
const MOUNJARO_15 = "10611032";
const LIBRE = "99001";
const DEXCOM = "99002";
const RETIRED = "88000";

const PRODUCTS: RelationProduct[] = [
  { itemCode: MOUNJARO_5, itemName: "MOUNJARO KWIKPEN 5 MG", active: true },
  { itemCode: MOUNJARO_15, itemName: "MOUNJARO KWIKPEN 15 MG", active: true },
  { itemCode: LIBRE, itemName: "FREESTYLE LIBRE 3 SENSOR", active: true },
  { itemCode: DEXCOM, itemName: "DEXCOM G7 SENSOR", active: true },
  { itemCode: RETIRED, itemName: "DISCONTINUED METER", active: false },
];

const catalog = buildRelationCatalog(PRODUCTS);

/* ===================================================================== */
/* What may be configured                                                */
/* ===================================================================== */

describe("validateRelation", () => {
  it("accepts a pair of real, sellable products", () => {
    const v = validateRelation({ fromItemCode: MOUNJARO_5, toItemCode: LIBRE }, catalog);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // The name comes from the catalogue, never from the request: it is the
    // sentence an agent reads out.
    expect(v.value.toItemName).toBe("FREESTYLE LIBRE 3 SENSOR");
    expect(v.value.note).toBeNull();
  });

  it("refuses a product as its own cross-sell", () => {
    const v = validateRelation({ fromItemCode: LIBRE, toItemCode: LIBRE }, catalog);
    expect(v).toEqual({ ok: false, reason: "same_product" });
  });

  it("refuses either end missing", () => {
    expect(validateRelation({ fromItemCode: "", toItemCode: LIBRE }, catalog)).toEqual({
      ok: false,
      reason: "missing_source",
    });
    expect(validateRelation({ fromItemCode: LIBRE, toItemCode: "  " }, catalog)).toEqual({
      ok: false,
      reason: "missing_target",
    });
  });

  it("refuses a product that is not in the catalogue", () => {
    // A free-typed code would configure a recommendation for something the
    // pharmacy does not sell, which an agent would then offer a customer.
    expect(
      validateRelation({ fromItemCode: "does-not-exist", toItemCode: LIBRE }, catalog),
    ).toEqual({ ok: false, reason: "unknown_source" });
    expect(
      validateRelation({ fromItemCode: LIBRE, toItemCode: "does-not-exist" }, catalog),
    ).toEqual({ ok: false, reason: "unknown_target" });
  });

  it("allows a retired product as the source but never as the recommendation", () => {
    /*
     * Asymmetric on purpose. A customer may have bought something the desk has
     * since stopped selling, and that purchase is still a real fact to
     * recommend *from*; recommending a switched-off product is offering
     * something that cannot be fulfilled.
     */
    expect(validateRelation({ fromItemCode: RETIRED, toItemCode: LIBRE }, catalog).ok).toBe(true);
    expect(validateRelation({ fromItemCode: LIBRE, toItemCode: RETIRED }, catalog)).toEqual({
      ok: false,
      reason: "inactive_target",
    });
  });

  it("trims input and keeps an empty note as null", () => {
    const v = validateRelation(
      { fromItemCode: ` ${MOUNJARO_5} `, toItemCode: ` ${LIBRE} `, note: "   " },
      catalog,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.fromItemCode).toBe(MOUNJARO_5);
    expect(v.value.note).toBeNull();
  });
});

/* ===================================================================== */
/* Saving over an existing pair                                          */
/* ===================================================================== */

describe("planSave", () => {
  const next = {
    fromItemCode: MOUNJARO_5,
    toItemCode: LIBRE,
    kind: "cross_sell" as const,
    toItemName: "FREESTYLE LIBRE 3 SENSOR",
    note: "desk decision",
  };

  it("creates when the pair is new", () => {
    expect(planSave(null, next)).toBe("created");
  });

  it("reactivates rather than duplicating a pair that was switched off", () => {
    /*
     * The unique key is on the pair alone and ignores `active`, which is what
     * makes this possible: re-configuring a switched-off pair brings the
     * original row back instead of failing on a constraint or creating a
     * second. The configuration's history survives being toggled.
     */
    const existing = {
      active: false,
      kind: "cross_sell" as const,
      note: "desk decision",
      toItemName: next.toItemName,
    };
    expect(planSave(existing, next)).toBe("reactivated");
  });

  it("updates when the note changed", () => {
    const existing = {
      active: true,
      kind: "cross_sell" as const,
      note: "older reason",
      toItemName: next.toItemName,
    };
    expect(planSave(existing, next)).toBe("updated");
  });

  it("does nothing when the pair is already configured identically", () => {
    // Saving an unchanged pair must not bump `updated_at` and claim an edit.
    const existing = {
      active: true,
      kind: "cross_sell" as const,
      note: "desk decision",
      toItemName: next.toItemName,
    };
    expect(planSave(existing, next)).toBe("unchanged");
  });
});

describe("describeRelation", () => {
  it("reads as product names, never as codes", () => {
    const text = describeRelation(
      { fromItemCode: MOUNJARO_5, toItemName: "FREESTYLE LIBRE 3 SENSOR" },
      catalog,
    );
    expect(text).toBe("MOUNJARO KWIKPEN 5 MG → FREESTYLE LIBRE 3 SENSOR");
    expect(text).not.toContain(MOUNJARO_5);
  });
});

/* ===================================================================== */
/* What the engine does with a configured pair                           */
/* ===================================================================== */

function purchase(over: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    phone: PHONE,
    itemCode: MOUNJARO_5,
    itemName: "MOUNJARO KWIKPEN 5 MG",
    // Well past a refill, and no earlier separate purchase, so the refill and
    // repeat rules both decline and cross-sell is what is left.
    sourceDate: "2026-08-28",
    documentNo: "188767",
    branchNo: "P0001",
    ...over,
  };
}

function lead(over: Partial<RecommendableLead> = {}): RecommendableLead {
  return {
    id: "lead-1",
    phone: PHONE,
    itemCode: MOUNJARO_5,
    itemName: "MOUNJARO KWIKPEN 5 MG",
    branchNo: "P0001",
    sourceDate: "2026-08-28",
    nextFollowupOn: null,
    invoiceMatchStatus: null,
    documentNo: "188767",
    ...over,
  };
}

function ctx(over: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    today: TODAY,
    historyByPhone: groupHistoryByPhone([purchase()]),
    identity: buildProductIdentityIndex(
      PRODUCTS.filter((p) => p.active).map((p) => ({
        itemCode: p.itemCode,
        itemName: p.itemName,
        refillDays: 28,
      })),
    ),
    // 28-day cycle from 28 Aug is 25 Sep: not due, not soon, so no refill.
    cycleByItem: new Map([[MOUNJARO_5, { itemCode: MOUNJARO_5, refillDays: 28 }]]),
    relationsByItem: new Map(),
    ...over,
  };
}

const libreRelation: ProductRelation = {
  fromItemCode: MOUNJARO_5,
  toItemCode: LIBRE,
  toItemName: "FREESTYLE LIBRE 3 SENSOR",
  note: "configured by the desk",
};

describe("a configured pair reaching an agent", () => {
  it("produces a cross-sell when the customer bought the source", () => {
    const v = recommendLead(
      lead(),
      ctx({ relationsByItem: groupRelationsByItem([libreRelation]) }),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.kind).toBe("cross_sell");
    expect(v.recommendation.crossSell?.toItemName).toBe("FREESTYLE LIBRE 3 SENSOR");
  });

  it("explains itself in product names and the desk's own words", () => {
    const v = recommendLead(
      lead(),
      ctx({ relationsByItem: groupRelationsByItem([libreRelation]) }),
    );
    if (!v.recommended) throw new Error("expected a recommendation");
    const { reason } = v.recommendation;
    expect(reason).toContain("previously purchased");
    expect(reason).toContain("configured as a related product");
    expect(reason).toContain("configured by the desk");
    // No identifiers leak into the sentence an agent reads.
    expect(reason).not.toContain(MOUNJARO_5);
    expect(reason).not.toContain(LIBRE);
  });

  it("produces nothing when no pair is configured", () => {
    // The live state: the table is empty, so this branch is silent.
    expect(recommendLead(lead(), ctx()).recommended).toBe(false);
  });

  it("produces nothing once the pair is switched off", () => {
    /*
     * Deactivation is enforced at the read — `use-recommended-leads` asks for
     * `active = true` — so an inactive pair never reaches the engine at all.
     * This is that contract from the engine's side: given no relations, no
     * cross-sell.
     */
    const inactiveNeverLoaded = new Map();
    expect(recommendLead(lead(), ctx({ relationsByItem: inactiveNeverLoaded })).recommended).toBe(
      false,
    );
  });

  it("never recommends something the customer already bought", () => {
    const v = recommendLead(
      lead(),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase(),
          purchase({ documentNo: "9", itemCode: LIBRE, itemName: "FREESTYLE LIBRE 3 SENSOR" }),
        ]),
        relationsByItem: groupRelationsByItem([libreRelation]),
      }),
    );
    if (v.recommended) expect(v.recommendation.kind).not.toBe("cross_sell");
  });

  it("gives one recommendation, not several, when a product has many companions", () => {
    const many = groupRelationsByItem([
      libreRelation,
      { ...libreRelation, toItemCode: DEXCOM, toItemName: "DEXCOM G7 SENSOR" },
    ]);
    const v = recommendLead(lead(), ctx({ relationsByItem: many }));
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.crossSell).not.toBeNull();
  });

  it("chooses the same companion every time, whatever order the data arrived in", () => {
    /*
     * A lead carries one recommendation, so with several configured companions
     * one has to be picked. Picking by purchase-row order would mean the same
     * lead showing a different cross-sell on two page loads.
     */
    const relations = [
      { ...libreRelation, toItemCode: DEXCOM, toItemName: "DEXCOM G7 SENSOR" },
      libreRelation,
    ];
    const forward = recommendLead(
      lead(),
      ctx({ relationsByItem: groupRelationsByItem(relations) }),
    );
    const reversed = recommendLead(
      lead(),
      ctx({ relationsByItem: groupRelationsByItem([...relations].reverse()) }),
    );
    if (!forward.recommended || !reversed.recommended) throw new Error("expected recommendations");
    expect(forward.recommendation.crossSell?.toItemCode).toBe(
      reversed.recommendation.crossSell?.toItemCode,
    );
  });

  it("does not treat a dose change as a cross-sell on its own", () => {
    /*
     * The safety boundary. Two strengths of the same medicine are a prescribing
     * decision, and nothing in this module may propose one. Configuring the
     * pair is the *only* way it could ever appear, and here it is not
     * configured — the customer owning 5mg produces nothing about 15mg.
     */
    const v = recommendLead(lead(), ctx({ relationsByItem: new Map() }));
    expect(v.recommended).toBe(false);
    // And nothing about a shared family creates one either: the engine has no
    // notion of product families at all.
    const familyOnly = recommendLead(lead(), ctx({ relationsByItem: groupRelationsByItem([]) }));
    expect(familyOnly.recommended).toBe(false);
  });
});

describe("cross-sell never outranks a refill", () => {
  it("loses to a refill that is due", () => {
    // Bought 5 Aug on a 28-day cycle: due today. A configured companion exists,
    // and the refill still wins.
    const v = recommendLead(
      lead({ sourceDate: "2026-08-05" }),
      ctx({
        historyByPhone: groupHistoryByPhone([purchase({ sourceDate: "2026-08-05" })]),
        relationsByItem: groupRelationsByItem([libreRelation]),
      }),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("refill_due_today");
    expect(v.recommendation.kind).not.toBe("cross_sell");
  });

  it("loses to a repeat purchase", () => {
    const v = recommendLead(
      lead(),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase(),
          purchase({ documentNo: "170000", sourceDate: "2026-05-01" }),
        ]),
        relationsByItem: groupRelationsByItem([libreRelation]),
      }),
    );
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.band).toBe("previously_purchased");
  });
});

describe("stock on a cross-sell", () => {
  const relations = groupRelationsByItem([libreRelation]);

  it("reports stock for the recommended product, not the lead's own", () => {
    // The agent is being asked to offer the Libre, so the Libre's shelf is the
    // one that matters.
    const v = recommendLead(
      lead(),
      ctx({
        relationsByItem: relations,
        stockByItem: new Map([
          [MOUNJARO_5, { state: "out_of_stock", quantity: 0 }],
          [LIBRE, { state: "in_stock", quantity: 6 }],
        ]),
      }),
    );
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.stock).toEqual({ state: "in_stock", quantity: 6 });
    expect(v.recommendation.supporting).toContain("in_stock");
  });

  it("still recommends when the companion is out of stock", () => {
    const v = recommendLead(
      lead(),
      ctx({
        relationsByItem: relations,
        stockByItem: new Map([[LIBRE, { state: "out_of_stock", quantity: 0 }]]),
      }),
    );
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.kind).toBe("cross_sell");
    expect(v.recommendation.stock.state).toBe("out_of_stock");
    expect(v.recommendation.supporting).not.toContain("in_stock");
  });

  it("treats an unanswered stock lookup as unknown, never as out of stock", () => {
    const v = recommendLead(lead(), ctx({ relationsByItem: relations }));
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.stock).toEqual({ state: "unknown", quantity: null });
  });
});
