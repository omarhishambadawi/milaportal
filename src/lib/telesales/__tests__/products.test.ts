import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  familiesInCatalog,
  familyLabel,
  matchProduct,
  normalizeItemName,
  type ProductPatternRow,
  type ProductRow,
} from "../products";

/**
 * The catalogue in these tests mirrors the seed migration, trimmed to the rows
 * that carry an argument.
 */
const PRODUCTS: ProductRow[] = [
  {
    itemCode: "10611031",
    itemName: "MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR",
    family: "mounjaro",
    strength: "12.5 MG",
    category: "ANTI-DIABETIC",
    eligibleCash: true,
    eligibleRetention: true,
    refillDays: 28,
    active: true,
  },
  {
    itemCode: "10613360",
    itemName: "FREESTYLE LIBRE 3 PLUS SENSOR",
    family: "freestyle_libre",
    strength: "3 PLUS SENSOR",
    category: "DIAGNOSTICS & MACHINES",
    eligibleCash: true,
    eligibleRetention: true,
    refillDays: 14,
    active: true,
  },
  {
    itemCode: "10613411",
    itemName: "FREESTYLE LIBRE 3 PLUS READER",
    family: "freestyle_libre",
    strength: "3 PLUS READER",
    category: "DIAGNOSTICS & MACHINES",
    eligibleCash: true,
    // Hardware: a Cash lead, never a refill cycle.
    eligibleRetention: false,
    refillDays: null,
    active: true,
  },
  {
    itemCode: "10300322",
    itemName: "FREESTYLE OPTIUM STRIPS 50's",
    family: "other",
    strength: "STRIPS 50",
    category: "DIAGNOSTICS & MACHINES",
    eligibleCash: false,
    eligibleRetention: false,
    refillDays: null,
    active: true,
  },
  {
    itemCode: "10102123",
    itemName: "NOVORAPID FLEXPEN 100 IU / ML, 5X3 ML, 5 'S",
    family: "insulin",
    strength: "100 IU/ML",
    category: "ANTI-DIABETIC",
    eligibleCash: false,
    eligibleRetention: false,
    refillDays: null,
    active: true,
  },
];

const PATTERNS: ProductPatternRow[] = [
  { pattern: "FREESTYLE\\s+OPTIUM", family: "other", eligible: false, priority: 10, active: true },
  { pattern: "MOUNJARO", family: "mounjaro", eligible: true, priority: 100, active: true },
  { pattern: "OZEMPIC", family: "ozempic", eligible: true, priority: 100, active: true },
  {
    pattern: "FREESTYLE\\s+LIBRE",
    family: "freestyle_libre",
    eligible: true,
    priority: 100,
    active: true,
  },
  { pattern: "DEXCOM", family: "dexcom", eligible: true, priority: 100, active: true },
];

const catalog = buildCatalog(PRODUCTS, PATTERNS);

describe("the FreeStyle name trap", () => {
  it("keeps Optium out even though its name contains FREESTYLE", () => {
    // By code — the catalogue says no, and that is final.
    const byCode = matchProduct(
      catalog,
      { itemCode: "10300322", itemName: "FREESTYLE OPTIUM STRIPS 50's" },
      "cash",
    );
    expect(byCode.eligible).toBe(false);
    expect(byCode.reason).toBe("catalog_disabled");

    // By name — an unknown code whose name is Optium hits the exclusion rule
    // before the FREESTYLE LIBRE rule, because it has a lower priority number.
    const byName = matchProduct(
      catalog,
      { itemCode: "99999999", itemName: "FREESTYLE OPTIUM GLUCOSE METER" },
      "cash",
    );
    expect(byName.eligible).toBe(false);
    expect(byName.reason).toBe("pattern_excluded");
    expect(byName.matchedPattern).toBe("FREESTYLE\\s+OPTIUM");
  });

  it("still admits FreeStyle Libre", () => {
    const known = matchProduct(
      catalog,
      { itemCode: "10613360", itemName: "FREESTYLE LIBRE 3 PLUS SENSOR" },
      "cash",
    );
    expect(known.eligible).toBe(true);
    expect(known.family).toBe("freestyle_libre");
    expect(known.refillDays).toBe(14);
  });
});

describe("code beats name", () => {
  it("a code listed as ineligible stays ineligible despite a positive rule", () => {
    // NOVORAPID is in the catalogue and switched off. No pattern matches it
    // either, but the point is that the catalogue is consulted first and stops.
    const m = matchProduct(
      catalog,
      { itemCode: "10102123", itemName: "MOUNJARO KWIKPEN 5 MG" },
      "cash",
    );
    expect(m.eligible).toBe(false);
    expect(m.family).toBe("insulin");
    expect(m.reason).toBe("catalog_disabled");
  });

  it("an unknown code falls through to its name", () => {
    // The case this exists for: the pharmacy adds a strength.
    const m = matchProduct(
      catalog,
      { itemCode: "10611099", itemName: "MOUNJARO KWIKPEN 17.5 MG/0.6ML" },
      "cash",
    );
    expect(m.eligible).toBe(true);
    expect(m.family).toBe("mounjaro");
    expect(m.reason).toBe("pattern");
    // No strength or refill interval is invented for it.
    expect(m.strength).toBeNull();
    expect(m.refillDays).toBeNull();
  });

  it("an unrecognised product is refused and said to be unrecognised", () => {
    const m = matchProduct(
      catalog,
      { itemCode: "10609943", itemName: "NERVAN 500 MG TAB 30'S" },
      "cash",
    );
    expect(m.eligible).toBe(false);
    expect(m.reason).toBe("unknown");
    expect(m.family).toBeNull();
  });
});

describe("eligibility is per lead type", () => {
  it("a reader is a Cash lead but not a refill cycle", () => {
    const cash = matchProduct(catalog, { itemCode: "10613411", itemName: "" }, "cash");
    expect(cash.eligible).toBe(true);

    const retention = matchProduct(catalog, { itemCode: "10613411", itemName: "" }, "retention");
    expect(retention.eligible).toBe(false);
    // And it says why, rather than looking like a disabled product.
    expect(retention.reason).toBe("catalog_wrong_type");
  });

  it("a sensor is both", () => {
    expect(matchProduct(catalog, { itemCode: "10613360", itemName: "" }, "cash").eligible).toBe(
      true,
    );
    expect(
      matchProduct(catalog, { itemCode: "10613360", itemName: "" }, "retention").eligible,
    ).toBe(true);
  });
});

describe("normalisation", () => {
  it("collapses the whitespace the extracts carry, and nothing else", () => {
    expect(normalizeItemName("VOLTIC-D 50MG 20 DISP. TAB ")).toBe("VOLTIC-D 50MG 20 DISP. TAB");
    expect(normalizeItemName("MOUNJARO  KWIKPEN   15MG")).toBe("MOUNJARO KWIKPEN 15MG");
    // Punctuation is meaning here: these are two different SKUs.
    expect(normalizeItemName("MOUNJARO 15 MG 0.5ML PEN 4'S")).not.toBe(
      normalizeItemName("MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR"),
    );
    expect(normalizeItemName(null)).toBe("");
  });

  it("tolerates a code that arrived with a trailing space or as a number", () => {
    expect(matchProduct(catalog, { itemCode: " 10611031 ", itemName: "" }, "cash").eligible).toBe(
      true,
    );
    expect(matchProduct(catalog, { itemCode: 10611031, itemName: "" }, "cash").eligible).toBe(true);
  });
});

describe("resilience", () => {
  it("skips a pattern that will not compile rather than failing the run", () => {
    const broken = buildCatalog(PRODUCTS, [
      { pattern: "MOUNJARO(", family: "mounjaro", eligible: true, priority: 50, active: true },
      ...PATTERNS,
    ]);
    // The bad rule is dropped; the good ones still work.
    expect(
      matchProduct(broken, { itemCode: "unknown", itemName: "MOUNJARO KWIKPEN 20 MG" }, "cash")
        .eligible,
    ).toBe(true);
  });

  it("ignores inactive rows on both sides", () => {
    const c = buildCatalog(
      PRODUCTS.map((p) => ({ ...p, active: false })),
      PATTERNS.map((p) => ({ ...p, active: false })),
    );
    expect(matchProduct(c, { itemCode: "10611031", itemName: "MOUNJARO" }, "cash").reason).toBe(
      "unknown",
    );
  });
});

describe("presentation", () => {
  it("lists the families that can actually produce a lead", () => {
    expect(familiesInCatalog(catalog)).toEqual([
      "dexcom",
      "freestyle_libre",
      "mounjaro",
      "ozempic",
    ]);
  });

  it("titles an unmapped family instead of showing its slug", () => {
    expect(familyLabel("freestyle_libre")).toBe("FreeStyle Libre");
    expect(familyLabel("some_new_family")).toBe("Some New Family");
    expect(familyLabel(null)).toBe("—");
  });
});
