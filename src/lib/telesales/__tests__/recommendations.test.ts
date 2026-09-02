import { describe, expect, it } from "vitest";
import {
  BAND_PRIORITY,
  compareRecommendations,
  groupHistoryByPhone,
  groupRelationsByItem,
  recommendLead,
  recommendLeads,
  type ProductRelation,
  type PurchaseRecord,
  type RecommendableLead,
  type RecommendationContext,
} from "../recommendations";

const TODAY = "2026-09-02";
const PHONE = "0504630565";
const MOUNJARO = "10611028";
const OZEMPIC = "10104198";

function purchase(over: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    phone: PHONE,
    itemCode: MOUNJARO,
    itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
    sourceDate: "2026-08-05",
    documentNo: "188767",
    branchNo: "P0001",
    ...over,
  };
}

function lead(over: Partial<RecommendableLead> = {}): RecommendableLead {
  return {
    id: "lead-1",
    phone: PHONE,
    itemCode: MOUNJARO,
    itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
    branchNo: "P0001",
    sourceDate: "2026-08-05",
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
    // 28-day cycle: bought 5 Aug, due 2 Sep, which is TODAY.
    cycleByItem: new Map([[MOUNJARO, { itemCode: MOUNJARO, refillDays: 28 }]]),
    relationsByItem: new Map(),
    ...over,
  };
}

/* ===================================================================== */
/* A. Refill                                                             */
/* ===================================================================== */

describe("refill opportunity", () => {
  it("recommends a refill that falls due today", () => {
    const v = recommendLead(lead(), ctx());
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("refill_due_today");
    expect(v.recommendation.kind).toBe("refill");
    expect(v.recommendation.dueOn).toBe("2026-09-02");
    expect(v.recommendation.dueBasis).toBe("refill_cycle");
    expect(v.recommendation.reason).toContain("due for refill today");
    expect(v.recommendation.reason).toContain("5 Aug 2026");
  });

  it("recommends an overdue refill and says how overdue", () => {
    // Bought 16 Jul, 28-day cycle -> due 13 Aug, 20 days ago. Inside one cycle,
    // so still a refill the customer is plausibly waiting for.
    const v = recommendLead(
      lead(),
      ctx({ historyByPhone: groupHistoryByPhone([purchase({ sourceDate: "2026-07-16" })]) }),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("refill_overdue");
    expect(v.recommendation.refill?.days).toBe(-20);
    expect(v.recommendation.reason).toContain("20 days overdue");
  });

  it("recommends a refill due within three days", () => {
    // Bought 8 Aug -> due 5 Sep, three days out.
    const v = recommendLead(
      lead(),
      ctx({ historyByPhone: groupHistoryByPhone([purchase({ sourceDate: "2026-08-08" })]) }),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("refill_soon");
    expect(v.recommendation.reason).toContain("in 3 days");
  });

  it("does NOT recommend a refill that is weeks away", () => {
    // Bought 30 Aug -> due 27 Sep. Real, but not this agent's call today.
    const v = recommendLead(
      lead(),
      ctx({ historyByPhone: groupHistoryByPhone([purchase({ sourceDate: "2026-08-30" })]) }),
    );
    expect(v.recommended).toBe(false);
    if (v.recommended) return;
    expect(v.declined).toBe("not_due_and_no_repeat");
  });

  it("prefers a promised callback over the projected cycle", () => {
    /*
     * A date a human committed to beats an estimate. The cycle here would say
     * "due today"; the promise says tomorrow, and the promise is what the desk
     * is accountable for.
     */
    const v = recommendLead(lead({ nextFollowupOn: "2026-09-03" }), ctx());
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.dueBasis).toBe("promised_callback");
    expect(v.recommendation.dueOn).toBe("2026-09-03");
    expect(v.recommendation.reason).toContain("agreed callback date");
  });

  it("has no refill basis when the product has no configured cycle", () => {
    const v = recommendLead(lead(), ctx({ cycleByItem: new Map() }));
    expect(v.recommended).toBe(false);
    if (v.recommended) return;
    expect(v.declined).toBe("no_refill_basis");
  });
});

/* ===================================================================== */
/* B. Previously purchased                                               */
/* ===================================================================== */

describe("previously purchased", () => {
  it("recommends a repeat buyer whose refill is not yet near", () => {
    // Two separate documents; the later one produced the lead. Not due for
    // weeks, but the customer has demonstrated demand twice.
    const history = groupHistoryByPhone([
      purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
      purchase({ documentNo: "170000", sourceDate: "2026-06-01" }),
    ]);
    const v = recommendLead(lead({ sourceDate: "2026-08-30" }), ctx({ historyByPhone: history }));
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("previously_purchased");
    expect(v.recommendation.priorPurchaseCount).toBe(1);
    expect(v.recommendation.reason).toContain("once before");
    expect(v.recommendation.reason).toContain("1 Jun 2026");
  });

  it("counts several earlier purchases", () => {
    const history = groupHistoryByPhone([
      purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
      purchase({ documentNo: "170000", sourceDate: "2026-06-01" }),
      purchase({ documentNo: "160000", sourceDate: "2026-05-01" }),
    ]);
    const v = recommendLead(lead({ sourceDate: "2026-08-30" }), ctx({ historyByPhone: history }));
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.priorPurchaseCount).toBe(2);
    expect(v.recommendation.reason).toContain("2 times before");
  });

  it("does NOT treat the lead's own source purchase as a previous purchase", () => {
    /*
     * The trap this rule exists to avoid. A retention lead is generated from a
     * source record, so without excluding it every lead in the system would
     * claim the customer is a repeat buyer and the badge would mean nothing.
     */
    const v = recommendLead(
      lead({ sourceDate: "2026-08-30", documentNo: "188767" }),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
        ]),
      }),
    );
    expect(v.recommended).toBe(false);
  });

  it("does not count a different product as a previous purchase of this one", () => {
    const v = recommendLead(
      lead({ sourceDate: "2026-08-30" }),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
          purchase({ documentNo: "170000", sourceDate: "2026-06-01", itemCode: OZEMPIC }),
        ]),
      }),
    );
    expect(v.recommended).toBe(false);
  });
});

/* ===================================================================== */
/* C. Cross-sell                                                         */
/* ===================================================================== */

describe("cross-sell", () => {
  const relation: ProductRelation = {
    fromItemCode: MOUNJARO,
    toItemCode: "99001",
    toItemName: "FREESTYLE LIBRE 3 SENSOR",
    note: "configured by the desk",
  };

  it("recommends only from a configured relation", () => {
    const v = recommendLead(
      lead({ sourceDate: "2026-08-30" }),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
        ]),
        relationsByItem: groupRelationsByItem([relation]),
      }),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.kind).toBe("cross_sell");
    expect(v.recommendation.crossSell?.toItemCode).toBe("99001");
    expect(v.recommendation.reason).toContain("configured as a related product");
    expect(v.recommendation.reason).toContain("configured by the desk");
  });

  it("recommends nothing when no relationship is configured", () => {
    // The live state: the relations table is empty, so this branch is silent
    // rather than guessing a companion product.
    const v = recommendLead(
      lead({ sourceDate: "2026-08-30" }),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
        ]),
        relationsByItem: new Map(),
      }),
    );
    expect(v.recommended).toBe(false);
  });

  it("does not offer a related product the customer already owns", () => {
    const v = recommendLead(
      lead({ sourceDate: "2026-08-30" }),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
          purchase({ documentNo: "170001", sourceDate: "2026-07-01", itemCode: "99001" }),
        ]),
        relationsByItem: groupRelationsByItem([relation]),
      }),
    );
    // Owning both means there is nothing to cross-sell. The earlier purchase of
    // a *different* product is also not a repeat of the lead's product, so the
    // lead does not qualify at all.
    if (v.recommended) expect(v.recommendation.kind).not.toBe("cross_sell");
    else expect(v.declined).toBe("not_due_and_no_repeat");
  });
});

/* ===================================================================== */
/* D. Stock                                                              */
/* ===================================================================== */

describe("stock is a supporting signal, never a reason", () => {
  const inStock = new Map([[MOUNJARO, { state: "in_stock" as const, quantity: 7 }]]);
  const outOfStock = new Map([[MOUNJARO, { state: "out_of_stock" as const, quantity: 0 }]]);

  it("adds an IN STOCK badge to a refill", () => {
    const v = recommendLead(lead(), ctx({ stockByItem: inStock }));
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.supporting).toContain("in_stock");
    expect(v.recommendation.stock).toEqual({ state: "in_stock", quantity: 7 });
  });

  it("still recommends an out-of-stock refill, without the badge", () => {
    const v = recommendLead(lead(), ctx({ stockByItem: outOfStock }));
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.band).toBe("refill_due_today");
    expect(v.recommendation.supporting).not.toContain("in_stock");
    expect(v.recommendation.stock.state).toBe("out_of_stock");
  });

  it("treats absent stock as unknown, not out of stock", () => {
    const v = recommendLead(lead(), ctx());
    if (!v.recommended) throw new Error("expected a recommendation");
    expect(v.recommendation.stock).toEqual({ state: "unknown", quantity: null });
    expect(v.recommendation.supporting).not.toContain("in_stock");
  });

  it("never recommends a lead on stock alone", () => {
    // In stock, but the customer has no purchase relationship with the product.
    const v = recommendLead(
      lead({ sourceDate: "2026-08-30" }),
      ctx({
        historyByPhone: groupHistoryByPhone([
          purchase({ documentNo: "188767", sourceDate: "2026-08-30" }),
        ]),
        stockByItem: inStock,
      }),
    );
    expect(v.recommended).toBe(false);
  });
});

/* ===================================================================== */
/* Combined signals                                                      */
/* ===================================================================== */

describe("combined signals produce ONE recommendation", () => {
  it("folds repeat purchase, stock and a verified invoice into a single row", () => {
    const history = groupHistoryByPhone([
      purchase({ documentNo: "188767", sourceDate: "2026-08-05" }),
      purchase({ documentNo: "170000", sourceDate: "2026-06-01" }),
    ]);
    const result = recommendLeads([lead({ invoiceMatchStatus: "matched" })], {
      ...ctx({ historyByPhone: history }),
      stockByItem: new Map([[MOUNJARO, { state: "in_stock", quantity: 4 }]]),
    });

    expect(result.recommended).toHaveLength(1);
    const rec = result.recommended[0];
    expect(rec.band).toBe("refill_due_today");
    expect(rec.supporting).toEqual(
      expect.arrayContaining(["in_stock", "invoice_verified", "repeat_customer"]),
    );
    expect(rec.priorPurchaseCount).toBe(1);
    expect(rec.reason).toContain("Bought it once before");
  });

  it("does not mark an unverified invoice as verified", () => {
    for (const status of ["not_matched", "ambiguous", "not_checked", null] as const) {
      const v = recommendLead(lead({ invoiceMatchStatus: status }), ctx());
      if (!v.recommended) throw new Error("expected a recommendation");
      expect(v.recommendation.supporting).not.toContain("invoice_verified");
    }
  });
});

/* ===================================================================== */
/* Negative cases                                                        */
/* ===================================================================== */

describe("what is not recommended", () => {
  it("declines a lead with no phone", () => {
    const v = recommendLead(lead({ phone: null }), ctx());
    expect(v).toEqual({ recommended: false, declined: "no_phone" });
  });

  it("declines a lead with no product", () => {
    const v = recommendLead(lead({ itemCode: null, itemName: null }), ctx());
    expect(v).toEqual({ recommended: false, declined: "no_product" });
  });

  it("declines a customer with no local purchase history", () => {
    const v = recommendLead(lead({ phone: "0555555555" }), ctx());
    expect(v).toEqual({ recommended: false, declined: "no_purchase_history" });
  });

  it("does not invent a refill from a purchase with no date", () => {
    const v = recommendLead(
      lead(),
      ctx({ historyByPhone: groupHistoryByPhone([purchase({ sourceDate: null })]) }),
    );
    expect(v.recommended).toBe(false);
  });

  it("does not project a refill from a zero or negative cycle", () => {
    for (const refillDays of [0, -1, null]) {
      const v = recommendLead(
        lead(),
        ctx({ cycleByItem: new Map([[MOUNJARO, { itemCode: MOUNJARO, refillDays }]]) }),
      );
      expect(v.recommended).toBe(false);
    }
  });
});

/* ===================================================================== */
/* Priority and ordering                                                 */
/* ===================================================================== */

describe("priority", () => {
  it("orders the bands the way the desk works them", () => {
    expect(BAND_PRIORITY.refill_due_today).toBeLessThan(BAND_PRIORITY.refill_overdue);
    expect(BAND_PRIORITY.refill_overdue).toBeLessThan(BAND_PRIORITY.refill_soon);
    expect(BAND_PRIORITY.refill_soon).toBeLessThan(BAND_PRIORITY.previously_purchased);
    expect(BAND_PRIORITY.previously_purchased).toBeLessThan(BAND_PRIORITY.cross_sell);
  });

  it("sorts a mixed set by band, then in-stock, then urgency", () => {
    const base = {
      kind: "refill" as const,
      reason: "",
      supporting: [],
      refill: null,
      dueOn: null,
      dueBasis: null,
      lastPurchasedOn: null,
      priorPurchaseCount: 0,
      crossSell: null,
    };
    const mk = (
      leadId: string,
      band: keyof typeof BAND_PRIORITY,
      stockState: "in_stock" | "unknown",
      days: number | null,
    ) => ({
      ...base,
      leadId,
      band,
      priority: BAND_PRIORITY[band],
      stock: { state: stockState, quantity: null },
      refill: days == null ? null : { label: "", severity: "due" as const, days },
    });

    const sorted = [
      mk("e", "cross_sell", "in_stock", null),
      mk("d", "previously_purchased", "in_stock", null),
      mk("c", "refill_overdue", "unknown", -2),
      mk("b", "refill_overdue", "in_stock", -9),
      mk("a", "refill_due_today", "unknown", 0),
    ].sort(compareRecommendations);

    expect(sorted.map((r) => r.leadId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not bury a lead whose stock is unknown beneath one that is out of stock", () => {
    // Both are "not in stock" for ordering purposes, so the tie breaks on
    // urgency rather than on which unanswered question was asked.
    const base = {
      kind: "refill" as const,
      band: "refill_overdue" as const,
      priority: BAND_PRIORITY.refill_overdue,
      reason: "",
      supporting: [],
      dueOn: null,
      dueBasis: null,
      lastPurchasedOn: null,
      priorPurchaseCount: 0,
      crossSell: null,
    };
    const unknown = {
      ...base,
      leadId: "z",
      stock: { state: "unknown" as const, quantity: null },
      refill: { label: "", severity: "overdue" as const, days: -10 },
    };
    const out = {
      ...base,
      leadId: "a",
      stock: { state: "out_of_stock" as const, quantity: 0 },
      refill: { label: "", severity: "overdue" as const, days: -1 },
    };
    expect([out, unknown].sort(compareRecommendations)[0].leadId).toBe("z");
  });
});

/* ===================================================================== */
/* Batch behaviour and performance shape                                 */
/* ===================================================================== */

describe("recommendLeads", () => {
  it("counts why leads were declined", () => {
    const result = recommendLeads(
      [
        lead({ id: "a" }),
        lead({ id: "b", phone: null }),
        lead({ id: "c", itemCode: null, itemName: null }),
        lead({ id: "d", phone: "0555555555" }),
      ],
      ctx(),
    );
    expect(result.considered).toBe(4);
    expect(result.recommended.map((r) => r.leadId)).toEqual(["a"]);
    expect(result.declined.no_phone).toBe(1);
    expect(result.declined.no_product).toBe(1);
    expect(result.declined.no_purchase_history).toBe(1);
  });

  it("produces exactly one recommendation per recommended lead", () => {
    // Three separate opportunities for one customer stay three leads, and each
    // yields one recommendation -- signals combine, leads do not merge.
    const history = groupHistoryByPhone([
      purchase({ itemCode: MOUNJARO, documentNo: "1" }),
      purchase({ itemCode: OZEMPIC, documentNo: "2", itemName: "OZEMPIC 1 MG" }),
    ]);
    const result = recommendLeads(
      [
        lead({ id: "m", itemCode: MOUNJARO, documentNo: "1" }),
        lead({ id: "o", itemCode: OZEMPIC, itemName: "OZEMPIC 1 MG", documentNo: "2" }),
      ],
      {
        ...ctx({ historyByPhone: history }),
        cycleByItem: new Map([
          [MOUNJARO, { itemCode: MOUNJARO, refillDays: 28 }],
          [OZEMPIC, { itemCode: OZEMPIC, refillDays: 28 }],
        ]),
      },
    );
    expect(result.recommended).toHaveLength(2);
    expect(new Set(result.recommended.map((r) => r.leadId)).size).toBe(2);
  });

  it("is a pure function of its inputs — no I/O, so no per-lead request", () => {
    /*
     * The performance guarantee, asserted rather than asserted-about: the engine
     * is handed three maps and returns an answer. There is nowhere for a
     * per-lead MIS call to hide, which is what keeps a 700-lead page to three
     * bounded queries. `use-recommended-leads` is the only place that fetches,
     * and `queue-isolation.test.ts` guards what it may import.
     */
    const leads = Array.from({ length: 500 }, (_, i) => lead({ id: `lead-${i}` }));
    const before = Date.now();
    const result = recommendLeads(leads, ctx());
    expect(result.recommended).toHaveLength(500);
    expect(Date.now() - before).toBeLessThan(1000);
  });
});

/* ===================================================================== */
/* Staleness: how long an overdue refill stays an opportunity            */
/* ===================================================================== */

describe("an overdue refill goes stale after one cycle", () => {
  /*
   * The rule that keeps this list selective. Against the live backlog, 561 open
   * leads are past due and 430 of them by more than sixty days -- the retention
   * workbook had been accumulating since March. Without a bound the Recommended
   * page would be 83% of the queue, and "REFILL OVERDUE - 214 DAYS" would be
   * telling an agent something that is no longer true of the customer.
   */

  it("still recommends a refill overdue by less than one cycle", () => {
    // 28-day cycle, 27 days overdue: bought 2026-07-09 -> due 2026-08-06.
    const v = recommendLead(
      lead(),
      ctx({ historyByPhone: groupHistoryByPhone([purchase({ sourceDate: "2026-07-09" })]) }),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("refill_overdue");
  });

  it("declines a refill overdue by more than one cycle", () => {
    // Bought 2026-01-01 -> due 2026-01-29, 216 days ago.
    const v = recommendLead(
      lead(),
      ctx({ historyByPhone: groupHistoryByPhone([purchase({ sourceDate: "2026-01-01" })]) }),
    );
    expect(v).toEqual({ recommended: false, declined: "refill_too_stale" });
  });

  it("judges each product against its own cycle, not one global number", () => {
    // A 10-day sensor is stale 11 days after it was due; a 30-day pen is not.
    const boughtOn = "2026-07-14";
    const sensor = recommendLead(
      lead(),
      ctx({
        historyByPhone: groupHistoryByPhone([purchase({ sourceDate: boughtOn })]),
        // due 2026-07-24 -> 40 days overdue, far beyond a 10-day cycle
        cycleByItem: new Map([[MOUNJARO, { itemCode: MOUNJARO, refillDays: 10 }]]),
      }),
    );
    expect(sensor.recommended).toBe(false);

    const pen = recommendLead(
      lead(),
      ctx({
        historyByPhone: groupHistoryByPhone([purchase({ sourceDate: boughtOn })]),
        // due 2026-08-13 -> 20 days overdue, inside a 30-day cycle
        cycleByItem: new Map([[MOUNJARO, { itemCode: MOUNJARO, refillDays: 30 }]]),
      }),
    );
    expect(pen.recommended).toBe(true);
  });

  it("falls through to previously-purchased rather than dropping a repeat customer", () => {
    /*
     * The important half of the rule. A long-overdue customer who has bought
     * this product before is still worth a call -- but as demonstrated demand,
     * ranked beneath today's refills, and described honestly. What they must
     * not be is a "refill" the agent is told is 216 days late.
     */
    const history = groupHistoryByPhone([
      purchase({ documentNo: "188767", sourceDate: "2026-01-01" }),
      purchase({ documentNo: "150000", sourceDate: "2025-11-01" }),
    ]);
    const v = recommendLead(lead({ sourceDate: "2026-01-01" }), ctx({ historyByPhone: history }));
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("previously_purchased");
    expect(v.recommendation.reason).not.toContain("overdue");
  });

  it("uses the fallback bound only when the product has no configured cycle", () => {
    // No cycle, so no projection at all -- there is nothing to be stale about.
    const v = recommendLead(lead(), ctx({ cycleByItem: new Map() }));
    expect(v).toEqual({ recommended: false, declined: "no_refill_basis" });

    // A promised callback needs no cycle, and the fallback bounds it.
    const promised = recommendLead(
      lead({ nextFollowupOn: "2026-01-05" }),
      ctx({ cycleByItem: new Map(), defaultStaleDays: 30 }),
    );
    expect(promised).toEqual({ recommended: false, declined: "refill_too_stale" });
  });
});
