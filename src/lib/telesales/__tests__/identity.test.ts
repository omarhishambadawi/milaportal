import { describe, expect, it } from "vitest";
import {
  EMPTY_IDENTITY_INDEX,
  buildProductIdentityIndex,
  codesForCanonical,
  productMatchKey,
  refillDaysFor,
  resolveTelesalesProductIdentity,
  sameProductIdentity,
  type IdentityAlias,
} from "../identity";
import {
  ALIAS_REJECTION_LABELS,
  buildAliasCatalog,
  describeAliasEffect,
  findAliasCandidates,
  planAliasSave,
  validateAlias,
  type AliasProduct,
} from "../aliases";
import {
  buildCycleIndex,
  groupHistoryByPhone,
  recommendLead,
  type PurchaseRecord,
  type RecommendableLead,
  type RecommendationContext,
} from "../recommendations";

/**
 * Product identity: the same medicine under two item codes.
 *
 * The numbers in these tests are the live ones. The retention source carries 112
 * distinct item codes for 23 product names; 22 are catalogue products, 88 name a
 * catalogue product under a different code, and two are products the desk does
 * not carry. `519914` really is what the workbook says for MOUNJARO KWIKPEN
 * 5 MG, and `10611028` is the catalogue's code for it.
 */

/* ===================================================================== */
/* Fixtures                                                              */
/* ===================================================================== */

const MOUNJARO_5 = "10611028";
const MOUNJARO_15 = "10611032";
const OZEMPIC_1 = "10104198";

const MOUNJARO_5_NAME = "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA";
const MOUNJARO_15_NAME = "MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR";

/** One alias code for the 5 MG pen, straight out of the live workbook. */
const ALIAS_5 = "519914";
/** One of the twenty codes naming the 12.5 MG pen. */
const ALIAS_125 = "50488";
const MOUNJARO_125 = "10611031";

const CATALOGUE = [
  { itemCode: MOUNJARO_5, itemName: MOUNJARO_5_NAME, refillDays: 28 },
  { itemCode: MOUNJARO_15, itemName: MOUNJARO_15_NAME, refillDays: 28 },
  { itemCode: MOUNJARO_125, itemName: "MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR", refillDays: 28 },
  { itemCode: OZEMPIC_1, itemName: "OZEMPIC 1 MG 1.5ML PEN, 1'S", refillDays: 30 },
  { itemCode: "88000", itemName: "NO CYCLE CONFIGURED", refillDays: null },
];

const ALIASES: IdentityAlias[] = [
  { aliasItemCode: ALIAS_5, canonicalItemCode: MOUNJARO_5, active: true },
  { aliasItemCode: "506434", canonicalItemCode: MOUNJARO_5, active: true },
  { aliasItemCode: ALIAS_125, canonicalItemCode: MOUNJARO_125, active: true },
  // Switched off: a decision somebody reversed, kept for the audit trail.
  { aliasItemCode: "999999", canonicalItemCode: OZEMPIC_1, active: false },
];

const index = buildProductIdentityIndex(CATALOGUE, ALIASES);

/* ===================================================================== */
/* A. Resolution                                                         */
/* ===================================================================== */

describe("resolveTelesalesProductIdentity", () => {
  it("resolves a catalogue code to itself", () => {
    const r = resolveTelesalesProductIdentity(index, {
      itemCode: MOUNJARO_5,
      itemName: "whatever the row happens to say",
    });
    expect(r.canonicalItemCode).toBe(MOUNJARO_5);
    expect(r.via).toBe("item_code");
    // The name comes from the catalogue, never from the row.
    expect(r.canonicalItemName).toBe(MOUNJARO_5_NAME);
  });

  it("resolves an aliased code to its canonical product", () => {
    const r = resolveTelesalesProductIdentity(index, {
      itemCode: ALIAS_5,
      itemName: MOUNJARO_5_NAME,
    });
    expect(r.canonicalItemCode).toBe(MOUNJARO_5);
    expect(r.via).toBe("alias");
  });

  it("resolves an unmapped code by an exact, unique product name", () => {
    // The safety net that kept 88 leads working between Phase 7 and Phase 8.
    const r = resolveTelesalesProductIdentity(index, {
      itemCode: "777001",
      itemName: MOUNJARO_5_NAME,
    });
    expect(r.canonicalItemCode).toBe(MOUNJARO_5);
    expect(r.via).toBe("product_name");
  });

  it("prefers the code over the alias, and the alias over the name", () => {
    /*
     * Order matters twice. A catalogue code is the product's own identity and
     * nothing may override it; an alias is a recorded human decision and
     * outranks an inference from a name.
     */
    const misleading = buildProductIdentityIndex(CATALOGUE, [
      { aliasItemCode: "777002", canonicalItemCode: OZEMPIC_1, active: true },
    ]);
    // Code wins: the row's name says Mounjaro, the code says the 15 MG pen.
    expect(
      resolveTelesalesProductIdentity(misleading, {
        itemCode: MOUNJARO_15,
        itemName: MOUNJARO_5_NAME,
      }),
    ).toMatchObject({ canonicalItemCode: MOUNJARO_15, via: "item_code" });
    // Alias wins over the name.
    expect(
      resolveTelesalesProductIdentity(misleading, {
        itemCode: "777002",
        itemName: MOUNJARO_5_NAME,
      }),
    ).toMatchObject({ canonicalItemCode: OZEMPIC_1, via: "alias" });
  });

  it("ignores an inactive mapping", () => {
    const r = resolveTelesalesProductIdentity(index, { itemCode: "999999", itemName: null });
    expect(r.canonicalItemCode).toBeNull();
    expect(r.unresolved).toBe("not_in_catalogue");
    // Still comparable to itself by its raw code.
    expect(r.matchKey).toBe("999999");
  });

  it("drops a mapping whose canonical product is not live", () => {
    const stale = buildProductIdentityIndex(CATALOGUE, [
      { aliasItemCode: "777003", canonicalItemCode: "NOT-A-PRODUCT", active: true },
    ]);
    expect(
      resolveTelesalesProductIdentity(stale, { itemCode: "777003", itemName: null })
        .canonicalItemCode,
    ).toBeNull();
  });

  it("refuses a name carried by more than one product", () => {
    const dupes = buildProductIdentityIndex([
      { itemCode: "A1", itemName: "SHARED NAME", refillDays: 10 },
      { itemCode: "A2", itemName: "SHARED NAME", refillDays: 20 },
    ]);
    const r = resolveTelesalesProductIdentity(dupes, { itemCode: "Z9", itemName: "SHARED NAME" });
    expect(r.canonicalItemCode).toBeNull();
    expect(r.unresolved).toBe("ambiguous_name");
  });

  it("is order-independent about ambiguity", () => {
    const rows = [
      { itemCode: "A1", itemName: "SHARED NAME", refillDays: 10 },
      { itemCode: "A2", itemName: "SHARED NAME", refillDays: 20 },
    ];
    const forward = buildProductIdentityIndex(rows);
    const reversed = buildProductIdentityIndex([...rows].reverse());
    const input = { itemCode: "Z9", itemName: "SHARED NAME" };
    expect(resolveTelesalesProductIdentity(forward, input).unresolved).toBe("ambiguous_name");
    expect(resolveTelesalesProductIdentity(reversed, input).unresolved).toBe("ambiguous_name");
  });

  it("reports a row with neither a code nor a name", () => {
    expect(
      resolveTelesalesProductIdentity(index, { itemCode: null, itemName: null }),
    ).toMatchObject({ unresolved: "no_product", matchKey: null });
    expect(
      resolveTelesalesProductIdentity(index, { itemCode: "  ", itemName: "   " }).unresolved,
    ).toBe("no_product");
  });

  it("leaves a code with no code match and no name match unresolved", () => {
    // The two real ones: LIMITLESS CHROMAX and SAXENDA are simply not products
    // the Telesales catalogue carries, and they stay that way.
    const r = resolveTelesalesProductIdentity(index, {
      itemCode: "10606737",
      itemName: "SAXENDA 6MG/ML,5 PRE-FILLED PEN",
    });
    expect(r.canonicalItemCode).toBeNull();
    expect(r.unresolved).toBe("not_in_catalogue");
  });

  it("normalises only whitespace and case", () => {
    const r = resolveTelesalesProductIdentity(index, {
      itemCode: "777004",
      itemName: "  mounjaro   kwikpen 5 mg/0.6ml   2.4ml*1 aa ",
    });
    expect(r.canonicalItemCode).toBe(MOUNJARO_5);
    // A trailing space on a code must not make it a different code.
    expect(
      resolveTelesalesProductIdentity(index, { itemCode: ` ${MOUNJARO_5} `, itemName: null }).via,
    ).toBe("item_code");
  });
});

/* ===================================================================== */
/* B. The rule that matters most: strengths stay separate                */
/* ===================================================================== */

describe("similar names are never enough", () => {
  it("keeps the Mounjaro strengths apart", () => {
    /*
     * The expensive mistake this module could make. Five strengths share every
     * word but one; nothing here compares parts of a name, so no pair of them
     * can ever resolve to each other.
     */
    const codes = [MOUNJARO_5, MOUNJARO_15, MOUNJARO_125];
    const resolved = codes.map(
      (c) =>
        resolveTelesalesProductIdentity(index, { itemCode: c, itemName: null }).canonicalItemCode,
    );
    expect(new Set(resolved).size).toBe(3);
  });

  it("refuses a name that is a prefix of a catalogue name", () => {
    const r = resolveTelesalesProductIdentity(index, {
      itemCode: "777005",
      itemName: "MOUNJARO KWIKPEN 5 MG",
    });
    expect(r.canonicalItemCode).toBeNull();
  });

  it("refuses a name that contains a catalogue name", () => {
    const r = resolveTelesalesProductIdentity(index, {
      itemCode: "777006",
      itemName: `${MOUNJARO_5_NAME} SPECIAL OFFER`,
    });
    expect(r.canonicalItemCode).toBeNull();
  });

  it("never equates 5 MG with 15MG through an alias either", () => {
    // An alias is a code-to-product statement. It cannot make one catalogue
    // product resolve to another, because a catalogue code always wins.
    const forced = buildProductIdentityIndex(CATALOGUE, [
      { aliasItemCode: MOUNJARO_15, canonicalItemCode: MOUNJARO_5, active: true },
    ]);
    expect(
      resolveTelesalesProductIdentity(forced, { itemCode: MOUNJARO_15, itemName: null })
        .canonicalItemCode,
    ).toBe(MOUNJARO_15);
    // And the index refuses to hold it at all.
    expect(forced.aliasToCanonical.has(MOUNJARO_15)).toBe(false);
  });
});

/* ===================================================================== */
/* C. Comparing two rows                                                 */
/* ===================================================================== */

describe("sameProductIdentity", () => {
  const codeRow = { itemCode: MOUNJARO_5, itemName: MOUNJARO_5_NAME };
  const aliasRow = { itemCode: ALIAS_5, itemName: MOUNJARO_5_NAME };

  it("matches the same product under different codes", () => {
    expect(sameProductIdentity(index, codeRow, aliasRow)).toBe(true);
  });

  it("matches the same product under the same code", () => {
    expect(sameProductIdentity(index, codeRow, { ...codeRow })).toBe(true);
  });

  it("does not match different strengths", () => {
    expect(
      sameProductIdentity(index, codeRow, { itemCode: MOUNJARO_15, itemName: MOUNJARO_15_NAME }),
    ).toBe(false);
  });

  it("does not match different products with similar names", () => {
    expect(
      sameProductIdentity(index, codeRow, {
        itemCode: "777007",
        itemName: "MOUNJARO KWIKPEN 5 MG",
      }),
    ).toBe(false);
  });

  it("stops matching once the alias is switched off", () => {
    /*
     * Isolated to the alias on purpose: the row carries no name here, so the
     * name rule cannot stand in for the mapping. With the name present the
     * match survives, which is correct and is asserted separately -- it is why
     * those 88 leads worked before the alias table existed.
     */
    const nameless = { itemCode: ALIAS_5, itemName: null };
    expect(sameProductIdentity(index, codeRow, nameless)).toBe(true);

    const off = buildProductIdentityIndex(
      CATALOGUE,
      ALIASES.map((a) => ({ ...a, active: false })),
    );
    expect(sameProductIdentity(off, codeRow, nameless)).toBe(false);
    // And the name rule alone still carries the named row.
    expect(sameProductIdentity(off, codeRow, aliasRow)).toBe(true);
  });

  it("still matches two uncatalogued rows carrying the same raw code", () => {
    /*
     * The property that makes this a strict superset of code matching: nothing
     * that matched before this module existed can stop matching now.
     */
    const unknown = { itemCode: "10606737", itemName: "SAXENDA 6MG/ML,5 PRE-FILLED PEN" };
    expect(sameProductIdentity(index, unknown, { ...unknown })).toBe(true);
    expect(sameProductIdentity(EMPTY_IDENTITY_INDEX, unknown, { ...unknown })).toBe(true);
  });

  it("never matches two rows that carry no code", () => {
    const blank = { itemCode: null, itemName: "SOMETHING UNCATALOGUED" };
    expect(sameProductIdentity(index, blank, { ...blank })).toBe(false);
  });

  it("does not match on an ambiguous name", () => {
    const dupes = buildProductIdentityIndex([
      { itemCode: "A1", itemName: "SHARED NAME", refillDays: 10 },
      { itemCode: "A2", itemName: "SHARED NAME", refillDays: 20 },
    ]);
    // Different codes, ambiguous name: not the same product.
    expect(
      sameProductIdentity(
        dupes,
        { itemCode: "Z9", itemName: "SHARED NAME" },
        { itemCode: "Z8", itemName: "SHARED NAME" },
      ),
    ).toBe(false);
  });

  it("resolves deterministically across repeated calls", () => {
    const answers = new Set(
      Array.from({ length: 50 }, () => productMatchKey(index, aliasRow) ?? "null"),
    );
    expect(answers.size).toBe(1);
  });
});

/* ===================================================================== */
/* D. Cycles                                                             */
/* ===================================================================== */

describe("refill cycle resolution", () => {
  it("gives an aliased code the canonical product's cycle", () => {
    expect(refillDaysFor(index, { itemCode: ALIAS_5, itemName: null })).toBe(28);
  });

  it("returns null for a catalogued product with no cycle configured", () => {
    expect(refillDaysFor(index, { itemCode: "88000", itemName: null })).toBeNull();
  });

  it("returns null for an unresolved product", () => {
    expect(refillDaysFor(index, { itemCode: "10606737", itemName: "SAXENDA" })).toBeNull();
  });

  it("buildCycleIndex keys every raw code a lead might carry", () => {
    const cycles = buildCycleIndex(index, [
      { itemCode: ALIAS_5, itemName: MOUNJARO_5_NAME },
      { itemCode: "777008", itemName: MOUNJARO_5_NAME },
      { itemCode: "10606737", itemName: "SAXENDA" },
    ]);
    expect(cycles.get(MOUNJARO_5)?.refillDays).toBe(28);
    expect(cycles.get(ALIAS_5)?.refillDays).toBe(28);
    expect(cycles.get("777008")?.refillDays).toBe(28);
    expect(cycles.has("10606737")).toBe(false);
  });

  it("codesForCanonical returns the product and its active aliases, sorted", () => {
    // The list the lifecycle view builds in SQL, so the two agree by
    // construction rather than by coincidence.
    expect(codesForCanonical(index, MOUNJARO_5)).toEqual(["10611028", "506434", "519914"]);
    expect(codesForCanonical(index, "NOT-A-PRODUCT")).toEqual([]);
  });
});

/* ===================================================================== */
/* E. Purchase history, end to end                                       */
/* ===================================================================== */

describe("purchase history matching", () => {
  const TODAY = "2026-09-02";
  const PHONE = "0504630565";

  function purchase(over: Partial<PurchaseRecord> = {}): PurchaseRecord {
    return {
      phone: PHONE,
      itemCode: MOUNJARO_5,
      itemName: MOUNJARO_5_NAME,
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
      itemCode: MOUNJARO_5,
      itemName: MOUNJARO_5_NAME,
      branchNo: "P0001",
      sourceDate: "2026-08-05",
      nextFollowupOn: null,
      invoiceMatchStatus: null,
      documentNo: "188767",
      ...over,
    };
  }

  function ctx(
    history: PurchaseRecord[],
    over: Partial<RecommendationContext> = {},
  ): RecommendationContext {
    return {
      today: TODAY,
      historyByPhone: groupHistoryByPhone(history),
      identity: index,
      cycleByItem: buildCycleIndex(index, []),
      relationsByItem: new Map(),
      ...over,
    };
  }

  it("counts an earlier purchase recorded under another code", () => {
    /*
     * The defect. Before this, the June purchase carried `519914` and the lead
     * carries `10611028`, so the customer read as a first-time buyer. It cost
     * the previously-purchased band 26 leads across 13 customers.
     */
    const v = recommendLead(
      lead({ nextFollowupOn: null, sourceDate: "2026-08-05" }),
      ctx([
        purchase(),
        purchase({ itemCode: ALIAS_5, sourceDate: "2026-06-01", documentNo: "111" }),
      ]),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.priorPurchaseCount).toBe(1);
  });

  it("does not count a different strength as the same product", () => {
    const v = recommendLead(
      lead(),
      ctx([
        purchase(),
        purchase({
          itemCode: MOUNJARO_15,
          itemName: MOUNJARO_15_NAME,
          sourceDate: "2026-06-01",
          documentNo: "111",
        }),
      ]),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.priorPurchaseCount).toBe(0);
  });

  it("stops counting it once the mapping is switched off", () => {
    const off = buildProductIdentityIndex(
      CATALOGUE,
      ALIASES.map((a) => ({ ...a, active: false })),
    );
    const history = [
      purchase(),
      purchase({ itemCode: ALIAS_5, sourceDate: "2026-06-01", documentNo: "111" }),
    ];
    const v = recommendLead(
      lead(),
      ctx(history, { identity: off, cycleByItem: buildCycleIndex(off, []) }),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    /*
     * The name rule still resolves it — both rows name the 5 MG pen — which is
     * the correct answer and the reason those 88 leads worked before the alias
     * table existed. What changes is that the *decision* is no longer recorded.
     */
    expect(v.recommendation.priorPurchaseCount).toBe(1);
  });

  it("takes the anchor from the most recent purchase under any of its codes", () => {
    // The lead's own purchase is 5 Aug; a later one under the alias code is
    // 20 Aug, and the refill projects from the later of the two.
    const v = recommendLead(
      lead(),
      ctx([
        purchase(),
        purchase({ itemCode: ALIAS_5, sourceDate: "2026-08-20", documentNo: "222" }),
      ]),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.lastPurchasedOn).toBe("2026-08-20");
  });

  it("leaves an agreed callback in charge of the due date", () => {
    // Identity changes which purchases count; it never overrides a date a human
    // committed to. 7 of the 16 live leads whose last purchase moved are in
    // exactly this position and do not move at all.
    const v = recommendLead(
      lead({ nextFollowupOn: "2026-09-02" }),
      ctx([
        purchase(),
        purchase({ itemCode: ALIAS_5, sourceDate: "2026-08-20", documentNo: "222" }),
      ]),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    expect(v.recommendation.dueBasis).toBe("promised_callback");
    expect(v.recommendation.dueOn).toBe("2026-09-02");
  });

  it("a lead with an unmapped, unnameable product behaves exactly as before", () => {
    const unknown = { itemCode: "10606737", itemName: "SAXENDA 6MG/ML,5 PRE-FILLED PEN" };
    const v = recommendLead(
      lead({ ...unknown, documentNo: "d1", sourceDate: "2026-08-05" }),
      ctx([
        purchase({ ...unknown, documentNo: "d1", sourceDate: "2026-08-05" }),
        purchase({ ...unknown, documentNo: "d0", sourceDate: "2026-05-05" }),
      ]),
    );
    expect(v.recommended).toBe(true);
    if (!v.recommended) return;
    // Matched to itself by raw code, with no cycle, so it lands in the
    // previously-purchased band rather than as a refill.
    expect(v.recommendation.band).toBe("previously_purchased");
    expect(v.recommendation.priorPurchaseCount).toBe(1);
  });
});

/* ===================================================================== */
/* F. What may be configured                                             */
/* ===================================================================== */

describe("validateAlias", () => {
  const PRODUCTS: AliasProduct[] = [
    { itemCode: MOUNJARO_5, itemName: MOUNJARO_5_NAME, active: true },
    { itemCode: MOUNJARO_15, itemName: MOUNJARO_15_NAME, active: true },
    { itemCode: "88000", itemName: "RETIRED PRODUCT", active: false },
  ];
  const catalog = buildAliasCatalog(PRODUCTS);

  it("accepts a source code mapped onto a live catalogue product", () => {
    const v = validateAlias(
      { aliasItemCode: ALIAS_5, canonicalItemCode: MOUNJARO_5, aliasNameSnapshot: MOUNJARO_5_NAME },
      catalog,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // The canonical name comes from the catalogue, never from the request.
    expect(v.value.canonicalItemName).toBe(MOUNJARO_5_NAME);
    expect(v.value.aliasNameSnapshot).toBe(MOUNJARO_5_NAME);
  });

  it("refuses a code mapped to itself", () => {
    expect(
      validateAlias({ aliasItemCode: MOUNJARO_5, canonicalItemCode: MOUNJARO_5 }, catalog),
    ).toEqual({ ok: false, reason: "same_code" });
  });

  it("refuses an alias that is itself a catalogue product", () => {
    /*
     * The rule that makes a chain impossible. If `10611032` could be an alias
     * while also being a product, `A -> B -> C` would exist and every consumer
     * would have to decide how far to follow it.
     */
    expect(
      validateAlias({ aliasItemCode: MOUNJARO_15, canonicalItemCode: MOUNJARO_5 }, catalog),
    ).toEqual({ ok: false, reason: "alias_is_catalogue_product" });
  });

  it("refuses a canonical that is not in the catalogue", () => {
    expect(validateAlias({ aliasItemCode: "1", canonicalItemCode: "999" }, catalog)).toEqual({
      ok: false,
      reason: "unknown_canonical",
    });
  });

  it("refuses a switched-off product as the canonical", () => {
    // Unlike a cross-sell source. A canonical is what live leads resolve to.
    expect(validateAlias({ aliasItemCode: "1", canonicalItemCode: "88000" }, catalog)).toEqual({
      ok: false,
      reason: "inactive_canonical",
    });
  });

  it("refuses either end missing", () => {
    expect(validateAlias({ aliasItemCode: "", canonicalItemCode: MOUNJARO_5 }, catalog)).toEqual({
      ok: false,
      reason: "missing_alias",
    });
    expect(validateAlias({ aliasItemCode: "1", canonicalItemCode: "  " }, catalog)).toEqual({
      ok: false,
      reason: "missing_canonical",
    });
  });

  it("every rejection has copy a supervisor can act on", () => {
    for (const [reason, label] of Object.entries(ALIAS_REJECTION_LABELS)) {
      expect(label, reason).toBeTruthy();
      expect(label.length, reason).toBeGreaterThan(10);
    }
  });

  it("spells out the business effect before saving", () => {
    const v = validateAlias({ aliasItemCode: ALIAS_5, canonicalItemCode: MOUNJARO_5 }, catalog);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const sentence = describeAliasEffect(v.value, MOUNJARO_5_NAME);
    expect(sentence).toContain("same CRM product");
    // And says what it does *not* do, which is the half a supervisor cannot
    // infer from two dropdowns and an arrow.
    expect(sentence).toContain("No source record");
  });
});

describe("planAliasSave", () => {
  const next = {
    aliasItemCode: ALIAS_5,
    canonicalItemCode: MOUNJARO_5,
    canonicalItemName: MOUNJARO_5_NAME,
    aliasNameSnapshot: MOUNJARO_5_NAME,
    note: "audited",
  };

  it("creates when nothing exists", () => {
    expect(planAliasSave(null, next)).toBe("created");
  });

  it("reactivates a switched-off mapping rather than creating a second", () => {
    expect(
      planAliasSave(
        {
          canonicalItemCode: MOUNJARO_5,
          active: false,
          note: "audited",
          aliasNameSnapshot: MOUNJARO_5_NAME,
        },
        next,
      ),
    ).toBe("reactivated");
  });

  it("reports re-pointing separately from an edit", () => {
    // Changing a note changes a sentence; changing the canonical changes which
    // purchases count as the same medicine.
    expect(
      planAliasSave(
        {
          canonicalItemCode: MOUNJARO_15,
          active: true,
          note: "audited",
          aliasNameSnapshot: MOUNJARO_5_NAME,
        },
        next,
      ),
    ).toBe("repointed");
    expect(
      planAliasSave(
        {
          canonicalItemCode: MOUNJARO_5,
          active: true,
          note: "something else",
          aliasNameSnapshot: MOUNJARO_5_NAME,
        },
        next,
      ),
    ).toBe("updated");
  });

  it("does not claim an edit when nothing changed", () => {
    expect(
      planAliasSave(
        {
          canonicalItemCode: MOUNJARO_5,
          active: true,
          note: "audited",
          aliasNameSnapshot: MOUNJARO_5_NAME,
        },
        next,
      ),
    ).toBe("unchanged");
  });
});

/* ===================================================================== */
/* G. Candidates                                                         */
/* ===================================================================== */

describe("findAliasCandidates", () => {
  const tallies = [
    { itemCode: MOUNJARO_5, itemName: MOUNJARO_5_NAME, occurrences: 40 },
    { itemCode: ALIAS_5, itemName: MOUNJARO_5_NAME, occurrences: 1 },
    { itemCode: "777009", itemName: MOUNJARO_15_NAME, occurrences: 5 },
    { itemCode: "10606737", itemName: "SAXENDA 6MG/ML,5 PRE-FILLED PEN", occurrences: 1 },
  ];

  it("classifies each code the way the resolver will act on it", () => {
    const found = findAliasCandidates(tallies, index);
    const byCode = new Map(found.map((c) => [c.sourceItemCode, c]));
    expect(byCode.get(MOUNJARO_5)?.status).toBe("exact_code_match");
    // Already mapped, so not a decision anybody still has to make.
    expect(byCode.get(ALIAS_5)?.alreadyMapped).toBe(true);
    expect(byCode.get("777009")?.status).toBe("exact_unique_name_match");
    expect(byCode.get("777009")?.canonicalItemCode).toBe(MOUNJARO_15);
    expect(byCode.get("10606737")?.status).toBe("no_match");
  });

  it("folds one code seen under several spellings into one decision", () => {
    const found = findAliasCandidates(
      [
        { itemCode: "777010", itemName: MOUNJARO_5_NAME, occurrences: 3 },
        { itemCode: " 777010 ", itemName: `  ${MOUNJARO_5_NAME} `, occurrences: 2 },
      ],
      index,
    );
    expect(found).toHaveLength(1);
    expect(found[0].occurrences).toBe(5);
  });

  it("orders by how often the code is seen, then by the code", () => {
    const found = findAliasCandidates(tallies, index);
    const counts = found.map((c) => c.occurrences);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("reports an ambiguous name rather than choosing", () => {
    const dupes = buildProductIdentityIndex([
      { itemCode: "A1", itemName: "SHARED NAME", refillDays: 10 },
      { itemCode: "A2", itemName: "SHARED NAME", refillDays: 20 },
    ]);
    const found = findAliasCandidates(
      [{ itemCode: "Z9", itemName: "SHARED NAME", occurrences: 1 }],
      dupes,
    );
    expect(found[0].status).toBe("ambiguous");
    expect(found[0].canonicalItemCode).toBeNull();
  });

  it("skips a row with no code at all", () => {
    expect(
      findAliasCandidates([{ itemCode: null, itemName: "SOMETHING", occurrences: 3 }], index),
    ).toHaveLength(0);
  });
});
