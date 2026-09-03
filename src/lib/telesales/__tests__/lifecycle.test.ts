import { describe, expect, it } from "vitest";
import { DEFAULT_CYCLE_DAYS, isRefillStale, leadLifecycle, staleAfterDate } from "../lifecycle";
import {
  groupHistoryByPhone,
  recommendLead,
  type PurchaseRecord,
  type RecommendableLead,
  type RecommendationContext,
} from "../recommendations";
import { buildProductIdentityIndex } from "../identity";

const TODAY = "2026-09-02";

/* ===================================================================== */
/* The boundary                                                          */
/* ===================================================================== */

describe("the staleness boundary", () => {
  /*
   * Due 1 August on a 28-day cycle. The boundary is 29 August -- one full cycle
   * later -- and the lead is stale from 30 August. Stated as dates rather than
   * as arithmetic because a day either way changes what an agent is told.
   */
  const dueOn = "2026-08-01";
  const cycleDays = 28;

  it("puts the boundary one full cycle after the due date", () => {
    expect(staleAfterDate(dueOn, cycleDays)).toBe("2026-08-29");
  });

  it("is active on the due date itself", () => {
    expect(leadLifecycle({ dueOn, cycleDays, today: dueOn }).state).toBe("active");
  });

  it("is active while overdue by less than one cycle", () => {
    expect(leadLifecycle({ dueOn, cycleDays, today: "2026-08-10" }).state).toBe("active");
    expect(leadLifecycle({ dueOn, cycleDays, today: "2026-08-28" }).state).toBe("active");
  });

  it("is still active ON the boundary", () => {
    // Exactly one cycle past due. The customer has not yet missed a full fill.
    expect(leadLifecycle({ dueOn, cycleDays, today: "2026-08-29" }).state).toBe("active");
  });

  it("is stale the day after the boundary", () => {
    const l = leadLifecycle({ dueOn, cycleDays, today: "2026-08-30" });
    expect(l.state).toBe("stale");
    expect(l.daysStale).toBe(1);
  });

  it("counts how far past the boundary it has gone", () => {
    expect(leadLifecycle({ dueOn, cycleDays, today: TODAY }).daysStale).toBe(4);
  });
});

describe("each product is judged against its own cycle", () => {
  const dueOn = "2026-08-01";

  it.each([
    [10, "2026-08-11"],
    [14, "2026-08-15"],
    [28, "2026-08-29"],
    [30, "2026-08-31"],
  ])("a %i-day cycle expires on %s", (cycleDays, boundary) => {
    expect(staleAfterDate(dueOn, cycleDays)).toBe(boundary);
    expect(leadLifecycle({ dueOn, cycleDays, today: boundary }).state).toBe("active");
  });

  it("makes a 10-day sensor stale while a 30-day pen is still current", () => {
    const today = "2026-08-20";
    expect(leadLifecycle({ dueOn, cycleDays: 10, today }).state).toBe("stale");
    expect(leadLifecycle({ dueOn, cycleDays: 30, today }).state).toBe("active");
  });
});

describe("products with no configured cycle", () => {
  it("falls back only when there is still a due date", () => {
    // Reachable only via an agreed callback: a projection cannot exist without
    // a cycle to project with.
    expect(staleAfterDate("2026-08-01", null)).toBe("2026-08-31");
    expect(DEFAULT_CYCLE_DAYS).toBe(30);
  });

  it("has no lifecycle at all without a due date", () => {
    const l = leadLifecycle({ dueOn: null, cycleDays: 28, today: TODAY });
    expect(l.state).toBe("none");
    expect(l.staleAfter).toBeNull();
    expect(l.reason).toBeNull();
  });

  it("ignores a zero or negative cycle rather than expiring instantly", () => {
    for (const cycleDays of [0, -5]) {
      expect(staleAfterDate("2026-08-01", cycleDays)).toBe("2026-08-31");
    }
  });

  it("refuses a malformed date instead of guessing", () => {
    expect(staleAfterDate("not-a-date", 28)).toBeNull();
    expect(leadLifecycle({ dueOn: "2026-02-30", cycleDays: 28, today: TODAY }).state).toBe("none");
  });
});

describe("the reason shown to an agent", () => {
  it("says it expired and when it was due, without the arithmetic", () => {
    const l = leadLifecycle({ dueOn: "2026-08-01", cycleDays: 28, today: TODAY });
    expect(l.reason).toContain("expired after one full cycle");
    expect(l.reason).toContain("1 Aug 2026");
    expect(l.reason).toContain("28-day refill cycle");
    expect(l.reason).not.toContain("2026-08-29"); // no boundary maths on screen
  });

  it("gives an active lead no reason to explain", () => {
    expect(leadLifecycle({ dueOn: "2026-09-05", cycleDays: 28, today: TODAY }).reason).toBeNull();
  });
});

/* ===================================================================== */
/* Agreement with the recommendation engine                              */
/* ===================================================================== */

const PHONE = "0504630565";
const ITEM = "10611028";

function purchase(over: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    phone: PHONE,
    itemCode: ITEM,
    itemName: "MOUNJARO KWIKPEN 5 MG",
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
    itemCode: ITEM,
    itemName: "MOUNJARO KWIKPEN 5 MG",
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
    identity: buildProductIdentityIndex([
      { itemCode: ITEM, itemName: "MOUNJARO KWIKPEN 5 MG", refillDays: 28 },
    ]),
    cycleByItem: new Map([[ITEM, { itemCode: ITEM, refillDays: 28 }]]),
    relationsByItem: new Map(),
    ...over,
  };
}

describe("the queue and Recommended Leads apply the same rule", () => {
  /*
   * Both call `leadLifecycle`, so this asserts the wiring rather than the
   * arithmetic: a lead the queue would draw as STALE must not appear in
   * Recommended Leads as a refill, and vice versa.
   */

  it("a lead the queue calls stale is not recommended as a refill", () => {
    const boughtOn = "2026-01-01"; // due 29 Jan, stale from 27 Feb
    const dueOn = "2026-01-29";
    expect(leadLifecycle({ dueOn, cycleDays: 28, today: TODAY }).state).toBe("stale");

    const v = recommendLead(
      lead(),
      ctx({ historyByPhone: groupHistoryByPhone([purchase({ sourceDate: boughtOn })]) }),
    );
    expect(v.recommended).toBe(false);
    if (v.recommended) return;
    expect(v.declined).toBe("refill_too_stale");
  });

  it("a lead the queue calls active is still recommended", () => {
    expect(leadLifecycle({ dueOn: "2026-09-02", cycleDays: 28, today: TODAY }).state).toBe(
      "active",
    );
    const v = recommendLead(lead(), ctx());
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("refill_due_today");
  });

  it("an agreed callback decides the lifecycle, overriding the projection", () => {
    /*
     * The cycle would project 2 Sep from a 5 Aug purchase. A callback agreed
     * for January makes the lead stale despite that -- the date a human
     * committed to is the one the desk is accountable for, in both places.
     */
    const v = recommendLead(lead({ nextFollowupOn: "2026-01-15" }), ctx());
    expect(v.recommended).toBe(false);
    expect(leadLifecycle({ dueOn: "2026-01-15", cycleDays: 28, today: TODAY }).state).toBe("stale");
  });

  it("a stale lead still surfaces as PREVIOUSLY PURCHASED when it earns it", () => {
    const history = groupHistoryByPhone([
      purchase({ documentNo: "188767", sourceDate: "2026-01-01" }),
      purchase({ documentNo: "150000", sourceDate: "2025-11-01" }),
    ]);
    const v = recommendLead(lead({ sourceDate: "2026-01-01" }), ctx({ historyByPhone: history }));
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.band).toBe("previously_purchased");
  });
});

/* ===================================================================== */
/* Reactivation                                                          */
/* ===================================================================== */

describe("reactivation", () => {
  /*
   * Nothing implements this. It falls out of deriving the state instead of
   * storing it: the lifecycle is a function of the due date, so a new business
   * event that moves the due date moves the lead back to active on the next
   * read, and no job has to remember to do it.
   *
   * The converse matters just as much, and is also structural: time only ever
   * increases the gap between today and the due date, so a lead can never
   * un-stale itself by waiting.
   */

  it("a new purchase moves the due date forward and the lead is active again", () => {
    const dueBefore = "2026-01-29"; // projected from a 1 Jan purchase
    expect(leadLifecycle({ dueOn: dueBefore, cycleDays: 28, today: TODAY }).state).toBe("stale");

    // The customer buys again on 20 August; the projection becomes 17 September.
    const dueAfter = "2026-09-17";
    expect(leadLifecycle({ dueOn: dueAfter, cycleDays: 28, today: TODAY }).state).toBe("active");
  });

  it("a newly agreed callback reactivates a stale lead", () => {
    expect(leadLifecycle({ dueOn: "2026-01-15", cycleDays: 28, today: TODAY }).state).toBe("stale");
    expect(leadLifecycle({ dueOn: "2026-09-10", cycleDays: 28, today: TODAY }).state).toBe(
      "active",
    );
  });

  it("the engine follows the new purchase too, not just the queue", () => {
    // Same customer, same product, a second document dated after the first.
    const history = groupHistoryByPhone([
      purchase({ documentNo: "188767", sourceDate: "2026-01-01" }),
      purchase({ documentNo: "199000", sourceDate: "2026-08-05" }),
    ]);
    const v = recommendLead(lead({ documentNo: "188767" }), ctx({ historyByPhone: history }));
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    // Anchored on the newer purchase: 5 Aug + 28 = 2 Sep, due today.
    expect(v.recommendation.band).toBe("refill_due_today");
  });

  it("time alone never makes a stale lead active", () => {
    const dueOn = "2026-01-29";
    for (const today of ["2026-03-01", "2026-06-01", "2026-09-02", "2027-01-01"]) {
      expect(leadLifecycle({ dueOn, cycleDays: 28, today }).state).toBe("stale");
    }
  });

  it("waiting only ever increases how stale a lead is", () => {
    const dueOn = "2026-01-29";
    const a = leadLifecycle({ dueOn, cycleDays: 28, today: "2026-06-01" }).daysStale!;
    const b = leadLifecycle({ dueOn, cycleDays: 28, today: "2026-09-02" }).daysStale!;
    expect(b).toBeGreaterThan(a);
  });
});

describe("isRefillStale", () => {
  it("is the predicate the engine asks for, and agrees with leadLifecycle", () => {
    const cases = [
      { dueOn: "2026-08-01", cycleDays: 28, today: TODAY },
      { dueOn: "2026-09-01", cycleDays: 28, today: TODAY },
      { dueOn: null, cycleDays: 28, today: TODAY },
      { dueOn: "2026-08-01", cycleDays: null, today: TODAY },
    ];
    for (const c of cases) {
      expect(isRefillStale(c)).toBe(leadLifecycle(c).state === "stale");
    }
  });
});
