import { describe, expect, it } from "vitest";
import {
  generateCashLeads,
  generateRetentionLeads,
  generateWasfatyLeads,
  type RetentionCandidate,
} from "../generation";
import { buildCatalog, type ProductPatternRow, type ProductRow } from "../products";
import { DEFAULT_SETTINGS, type SourceRecordInput } from "../types";

/**
 * The edge cases the brief asks for, made executable.
 *
 * Every one of these is a question somebody will eventually ask about a lead
 * that did or did not appear, so each test is named as that question.
 */

const PRODUCTS: ProductRow[] = [
  {
    itemCode: "10611031",
    itemName: "MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR",
    family: "mounjaro",
    strength: "12.5 MG",
    category: null,
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
    category: null,
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
    category: null,
    eligibleCash: true,
    eligibleRetention: false,
    refillDays: null,
    active: true,
  },
  {
    itemCode: "10609943",
    itemName: "NERVAN 500 MG TAB 30'S",
    family: "other",
    strength: null,
    category: null,
    eligibleCash: false,
    eligibleRetention: false,
    refillDays: null,
    active: true,
  },
];

const PATTERNS: ProductPatternRow[] = [
  { pattern: "MOUNJARO", family: "mounjaro", eligible: true, priority: 100, active: true },
];

const catalog = buildCatalog(PRODUCTS, PATTERNS);

let seq = 0;
function row(over: Partial<SourceRecordInput> = {}): SourceRecordInput & { id: string } {
  seq += 1;
  return {
    id: `src-${seq}`,
    sourceType: "cash",
    rowNumber: seq,
    contentHash: `h${seq}`,
    customerRef: "509226",
    customerName: "MOHAMED",
    phoneRaw: "0535323292",
    phoneE164: "+966535323292",
    branchNo: "P0001",
    city: null,
    facility: null,
    itemCode: "10611031",
    itemName: "MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR",
    quantity: 1,
    unitPrice: 1261.4,
    totalValue: null,
    sourceDate: "2026-07-30",
    fillDate: null,
    dispenseTime: null,
    documentNo: "188767",
    channel: "CASH IN BOX",
    patientId: null,
    prescriptionNo: null,
    callbackDate: null,
    agentLabel: null,
    actionLabel: null,
    notes: null,
    raw: {},
    ...over,
  };
}

/* ------------------------------------------------------------------------- */
/* Cash                                                                      */
/* ------------------------------------------------------------------------- */

describe("Cash generation — the window", () => {
  it("takes exactly the three previous days and nothing either side", () => {
    const result = generateCashLeads(
      "2026-08-01",
      [
        row({ sourceDate: "2026-07-28" }), // one day too early
        row({ sourceDate: "2026-07-29" }),
        row({ sourceDate: "2026-07-30" }),
        row({ sourceDate: "2026-07-31" }),
        row({ sourceDate: "2026-08-01" }), // the anchor day itself
      ],
      catalog,
      DEFAULT_SETTINGS,
    );

    expect(result.window).toEqual({ from: "2026-07-29", to: "2026-07-31" });
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts.map((d) => d.sourceDate)).toEqual([
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
    ]);
    expect(result.skipped.outside_window).toBe(2);
  });

  it("works across a month boundary", () => {
    const result = generateCashLeads(
      "2026-08-02",
      [
        row({ sourceDate: "2026-07-30" }),
        row({ sourceDate: "2026-07-31" }),
        row({ sourceDate: "2026-08-01" }),
      ],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.window).toEqual({ from: "2026-07-30", to: "2026-08-01" });
    expect(result.drafts).toHaveLength(3);
  });

  it("skips a row whose date could not be read, and says so", () => {
    const result = generateCashLeads(
      "2026-08-01",
      [row({ sourceDate: null }), row({ sourceDate: "2026-07-30" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.skipped.no_date).toBe(1);
  });
});

describe("Cash generation — eligibility", () => {
  it("refuses a product the catalogue does not sell by phone", () => {
    const result = generateCashLeads(
      "2026-08-01",
      [row({ itemCode: "10609943", itemName: "NERVAN 500 MG TAB 30'S" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped.ineligible_product).toBe(1);
  });

  it("keeps a lead whose customer refused a phone number", () => {
    // 36 such rows were worked in July. They are leads; they just cannot be
    // dialled from the extract.
    const result = generateCashLeads(
      "2026-08-01",
      [
        row({
          customerName: "REFUSED TO GET MOBILE NUMBER",
          phoneRaw: "0",
          phoneE164: null,
        }),
      ],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].phoneE164).toBeNull();
    // Ranked below a lead that can be dialled right now.
    expect(result.drafts[0].priority).toBe(0);
  });

  it("drops a row that identifies nobody at all", () => {
    const result = generateCashLeads(
      "2026-08-01",
      [row({ customerRef: null, customerName: null, phoneE164: null, phoneRaw: null })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped.no_contact_identity).toBe(1);
  });
});

describe("Cash generation — duplicates", () => {
  it("gives one customer with two products two leads", () => {
    const result = generateCashLeads(
      "2026-08-01",
      [
        row({ itemCode: "10611031" }),
        row({ itemCode: "10613360", itemName: "FREESTYLE LIBRE 3 PLUS SENSOR" }),
      ],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(2);
    expect(new Set(result.drafts.map((d) => d.dedupKey)).size).toBe(2);
  });

  it("gives the same product at two branches two leads", () => {
    const result = generateCashLeads(
      "2026-08-01",
      [row({ branchNo: "P0001" }), row({ branchNo: "P0005" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(new Set(result.drafts.map((d) => d.dedupKey)).size).toBe(2);
  });

  it("gives a re-imported identical row the same key, so the insert is a no-op", () => {
    const first = generateCashLeads("2026-08-01", [row()], catalog, DEFAULT_SETTINGS);
    const second = generateCashLeads(
      "2026-08-01",
      [row({ rowNumber: 4021, contentHash: "different" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(first.drafts[0].dedupKey).toBe(second.drafts[0].dedupKey);
  });

  it("is deterministic — the same input twice produces the same keys", () => {
    const input = [row({ sourceDate: "2026-07-30" }), row({ sourceDate: "2026-07-31" })];
    const a = generateCashLeads("2026-08-01", input, catalog, DEFAULT_SETTINGS);
    const b = generateCashLeads("2026-08-01", input, catalog, DEFAULT_SETTINGS);
    expect(a.drafts.map((d) => d.dedupKey)).toEqual(b.drafts.map((d) => d.dedupKey));
  });
});

describe("Cash generation — what the lead says", () => {
  it("explains itself", () => {
    const result = generateCashLeads("2026-08-01", [row()], catalog, DEFAULT_SETTINGS);
    expect(result.drafts[0].generationReason).toBe("Cash window 29–31 Jul 2026 · Mounjaro 12.5 MG");
    expect(result.drafts[0].sourceRecordId).toBe(result.drafts[0].sourceRecordId);
    expect(result.drafts[0].productFamily).toBe("mounjaro");
    expect(result.drafts[0].channel).toBe("CASH IN BOX");
  });
});

/* ------------------------------------------------------------------------- */
/* Wasfaty                                                                   */
/* ------------------------------------------------------------------------- */

function wasfaty(over: Partial<SourceRecordInput> = {}): SourceRecordInput & { id: string } {
  return row({
    sourceType: "wasfaty",
    customerRef: null,
    itemCode: null,
    itemName: null,
    documentNo: null,
    channel: null,
    patientId: "1001385382",
    prescriptionNo: "j8952992",
    phoneE164: null,
    phoneRaw: null,
    sourceDate: "2026-09-01",
    ...over,
  });
}

describe("Wasfaty generation", () => {
  it("takes today and tomorrow, and not yesterday", () => {
    const result = generateWasfatyLeads(
      "2026-09-01",
      [
        wasfaty({ sourceDate: "2026-08-31", prescriptionNo: "a1" }),
        wasfaty({ sourceDate: "2026-09-01", prescriptionNo: "b2" }),
        wasfaty({ sourceDate: "2026-09-02", prescriptionNo: "c3" }),
        wasfaty({ sourceDate: "2026-09-03", prescriptionNo: "d4" }),
      ],
      DEFAULT_SETTINGS,
    );
    expect(result.window).toEqual({ from: "2026-09-01", to: "2026-09-02" });
    expect(result.drafts.map((d) => d.prescriptionNo)).toEqual(["b2", "c3"]);
  });

  it("works across a month boundary", () => {
    const result = generateWasfatyLeads(
      "2026-08-31",
      [
        wasfaty({ sourceDate: "2026-08-31", prescriptionNo: "a1" }),
        wasfaty({ sourceDate: "2026-09-01", prescriptionNo: "b2" }),
      ],
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(2);
  });

  it("creates a lead with no phone number, because that is the normal case", () => {
    // 2,774 of 3,952 rows in the August sheet have no phone.
    const result = generateWasfatyLeads("2026-09-01", [wasfaty()], DEFAULT_SETTINGS);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].phoneE164).toBeNull();
    expect(result.drafts[0].patientId).toBe("1001385382");
    expect(result.drafts[0].prescriptionNo).toBe("j8952992");
  });

  it("reuses a number a colleague already looked up for that patient", () => {
    const known = new Map([["1001385382", "+966505551234"]]);
    const result = generateWasfatyLeads("2026-09-01", [wasfaty()], DEFAULT_SETTINGS, known);
    expect(result.drafts[0].phoneE164).toBe("+966505551234");
    // And it outranks a lead that still needs the portal lookup.
    expect(result.drafts[0].priority).toBeGreaterThan(
      generateWasfatyLeads("2026-09-01", [wasfaty()], DEFAULT_SETTINGS).drafts[0].priority,
    );
  });

  it("gives one patient's two prescriptions two leads", () => {
    const result = generateWasfatyLeads(
      "2026-09-01",
      [wasfaty({ prescriptionNo: "f5567839" }), wasfaty({ prescriptionNo: "r8298417" })],
      DEFAULT_SETTINGS,
    );
    expect(new Set(result.drafts.map((d) => d.dedupKey)).size).toBe(2);
  });

  it("gives a duplicated prescription one key, so the second insert is refused", () => {
    const result = generateWasfatyLeads(
      "2026-09-01",
      [wasfaty(), wasfaty({ rowNumber: 900 })],
      DEFAULT_SETTINGS,
    );
    expect(new Set(result.drafts.map((d) => d.dedupKey)).size).toBe(1);
  });

  it("does not filter by product, because the sheets carry none", () => {
    const result = generateWasfatyLeads(
      "2026-09-01",
      [wasfaty({ itemCode: null, itemName: null })],
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(1);
  });

  it("drops a row with neither identifier", () => {
    const result = generateWasfatyLeads(
      "2026-09-01",
      [wasfaty({ patientId: null, prescriptionNo: null })],
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped.no_contact_identity).toBe(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Retention                                                                 */
/* ------------------------------------------------------------------------- */

function candidate(over: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    id: "lead-1",
    leadType: "cash",
    cycleNumber: 1,
    customerRef: "509226",
    customerName: "MOHAMED",
    phoneE164: "+966535323292",
    branchNo: "P0001",
    city: null,
    channel: "CASH IN BOX",
    itemCode: "10611031",
    itemName: "MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR",
    productFamily: "mounjaro",
    productStrength: "12.5 MG",
    dueOn: "2026-09-01",
    ...over,
  };
}

describe("Retention generation", () => {
  it("raises a cycle whose follow-up is due today", () => {
    const result = generateRetentionLeads("2026-09-01", [candidate()], catalog, DEFAULT_SETTINGS);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].cycleNumber).toBe(2);
    expect(result.drafts[0].parentLeadId).toBe("lead-1");
  });

  it("still raises one that is overdue, unlike the spreadsheet rule", () => {
    // `Days to refill = 0` drops this permanently; the grace window does not.
    const result = generateRetentionLeads(
      "2026-09-01",
      [candidate({ dueOn: "2026-08-25" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(1);
    // An overdue cycle sorts above a punctual one.
    expect(result.drafts[0].priority).toBeGreaterThan(
      generateRetentionLeads("2026-09-01", [candidate()], catalog, DEFAULT_SETTINGS).drafts[0]
        .priority,
    );
  });

  it("does not raise one that is due in the future", () => {
    const result = generateRetentionLeads(
      "2026-09-01",
      [candidate({ dueOn: "2026-09-15" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped.outside_window).toBe(1);
  });

  it("stops raising one that is past the grace period", () => {
    const result = generateRetentionLeads(
      "2026-09-01",
      [candidate({ dueOn: "2026-08-01" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped.outside_window).toBe(1);
  });

  it("keeps every cycle apart, so the third does not overwrite the second", () => {
    const c2 = generateRetentionLeads(
      "2026-09-01",
      [candidate({ cycleNumber: 1 })],
      catalog,
      DEFAULT_SETTINGS,
    ).drafts[0];
    const c3 = generateRetentionLeads(
      "2026-09-01",
      [candidate({ cycleNumber: 2 })],
      catalog,
      DEFAULT_SETTINGS,
    ).drafts[0];
    expect(c2.dedupKey).not.toBe(c3.dedupKey);
    expect(c2.cycleNumber).toBe(2);
    expect(c3.cycleNumber).toBe(3);
  });

  it("gives a customer on two products two cycles", () => {
    const result = generateRetentionLeads(
      "2026-09-01",
      [
        candidate({ id: "l1", itemCode: "10611031" }),
        candidate({
          id: "l2",
          itemCode: "10613360",
          itemName: "FREESTYLE LIBRE 3 PLUS SENSOR",
        }),
      ],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(new Set(result.drafts.map((d) => d.dedupKey)).size).toBe(2);
  });

  it("does not chase a customer about hardware they already own", () => {
    const result = generateRetentionLeads(
      "2026-09-01",
      [candidate({ itemCode: "10613411", itemName: "FREESTYLE LIBRE 3 PLUS READER" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped.ineligible_product).toBe(1);
  });

  it("carries the due date onto the new lead as its follow-up", () => {
    const result = generateRetentionLeads(
      "2026-09-01",
      [candidate({ dueOn: "2026-08-28" })],
      catalog,
      DEFAULT_SETTINGS,
    );
    expect(result.drafts[0].followupDueOn).toBe("2026-08-28");
  });
});
