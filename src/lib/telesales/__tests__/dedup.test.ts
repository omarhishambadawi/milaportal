import { describe, expect, it } from "vitest";
import {
  contentHash,
  dedupKeyForRetention,
  dedupKeyForSource,
  normalizePhone,
  toE164,
  workbookDigest,
} from "../dedup";
import type { SourceRecordInput } from "../types";

function cashRow(over: Partial<SourceRecordInput> = {}): SourceRecordInput {
  return {
    sourceType: "cash",
    rowNumber: 2,
    contentHash: "h",
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
    sourceDate: "2026-07-21",
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

function wasfatyRow(over: Partial<SourceRecordInput> = {}): SourceRecordInput {
  return {
    ...cashRow(),
    sourceType: "wasfaty",
    customerRef: null,
    itemCode: null,
    itemName: null,
    documentNo: null,
    channel: null,
    patientId: "1001385382",
    prescriptionNo: "j8952992",
    sourceDate: "2026-09-05",
    ...over,
  };
}

describe("phone normalisation", () => {
  it("reduces every spelling the extracts contain to one comparable form", () => {
    expect(normalizePhone("0535323292")).toBe("535323292");
    expect(normalizePhone("535323292")).toBe("535323292");
    expect(normalizePhone("+966535323292")).toBe("535323292");
    expect(normalizePhone("966535323292")).toBe("535323292");
    expect(normalizePhone("966 53 532 3292")).toBe("535323292");
  });

  it("refuses the placeholders that stand in for a refusal", () => {
    // All three are real values in the July working sheets, on rows whose name
    // reads REFUSED TO GET MOBILE NUMBER.
    expect(normalizePhone("0")).toBe("");
    expect(normalizePhone("0000")).toBe("");
    expect(normalizePhone("m")).toBe("");
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone("")).toBe("");
  });

  it("accepts the Wasfaty numbers as they are actually stored", () => {
    /*
     * `9.66555E+11` is what the Wasfaty Phone column *displays* in a narrow
     * column. The stored value is the full-precision integer 966555389897, and
     * the importer reads stored values rather than rendered ones — which is why
     * 1,178 real numbers in `Wasfaty Aug` are usable instead of discarded.
     */
    expect(normalizePhone(966555389897)).toBe("555389897");
    expect(normalizePhone("966555389897")).toBe("555389897");
  });

  it("refuses the rendered form, which has no digits left to recover", () => {
    // Should a display string ever reach this — a pasted cell, a CSV export —
    // there is nothing in it to dial, so it is refused rather than guessed at.
    expect(normalizePhone("9.66555E+11")).toBe("");
  });

  it("formats a usable number as E.164 and an unusable one as null", () => {
    expect(toE164("0535323292")).toBe("+966535323292");
    expect(toE164("0")).toBeNull();
  });
});

describe("the Cash key", () => {
  it("separates two products on one invoice", () => {
    const a = dedupKeyForSource("cash", cashRow({ itemCode: "10611031" }));
    const b = dedupKeyForSource("cash", cashRow({ itemCode: "10613360" }));
    expect(a).not.toBe(b);
  });

  it("separates the same product at two branches", () => {
    const a = dedupKeyForSource("cash", cashRow({ branchNo: "P0001" }));
    const b = dedupKeyForSource("cash", cashRow({ branchNo: "P0005" }));
    expect(a).not.toBe(b);
  });

  it("separates a repeat purchase on a later date", () => {
    const july3 = dedupKeyForSource("cash", cashRow({ sourceDate: "2026-07-03" }));
    const july29 = dedupKeyForSource("cash", cashRow({ sourceDate: "2026-07-29" }));
    expect(july3).not.toBe(july29);
  });

  it("collapses the same row arriving from two overlapping imports", () => {
    // Identical opportunity, different row number, different document number
    // after a correction, and a phone written the other way.
    const first = dedupKeyForSource("cash", cashRow());
    const second = dedupKeyForSource(
      "cash",
      cashRow({ rowNumber: 918, documentNo: "188767-A", phoneRaw: "535323292" }),
    );
    expect(first).toBe(second);
  });

  /**
   * The anonymous walk-in, which is half the extract.
   *
   * 83,634 of the 173,008 rows in `July Leads` share the single customer id
   * 437745, named `REFUSED TO GET MOBILE NUMBER` and phoned `0000`. Keying those
   * on the id would merge every anonymous customer who bought the same product
   * at the same branch on the same day into one lead.
   *
   * These two cases are the exact pair the real data produced when the rule was
   * first run over it, and they are the reason the discriminator is the phone
   * number rather than the id.
   */
  it("merges two invoices for one reachable customer", () => {
    // Real: customer 69732 (عبداللطيف, 0508626771) bought Mounjaro 12.5 MG at
    // P0202 on 30 July under invoices 271460 and 271474. One person, one call.
    const first = dedupKeyForSource(
      "cash",
      cashRow({
        customerRef: "69732",
        phoneRaw: "0508626771",
        phoneE164: "+966508626771",
        branchNo: "P0202",
        sourceDate: "2026-07-30",
        documentNo: "271460",
      }),
    );
    const second = dedupKeyForSource(
      "cash",
      cashRow({
        customerRef: "69732",
        phoneRaw: "0508626771",
        phoneE164: "+966508626771",
        branchNo: "P0202",
        sourceDate: "2026-07-30",
        documentNo: "271474",
      }),
    );
    expect(first).toBe(second);
  });

  it("does NOT merge two anonymous walk-ins who share the placeholder id", () => {
    // Real: id 437745 at P0027 on 31 July, invoices 86954 and 86981. Two
    // different people, neither of them callable.
    const anon = {
      customerRef: "437745",
      customerName: "REFUSED TO GET MOBILE NUMBER",
      phoneRaw: "0000",
      phoneE164: null,
      branchNo: "P0027",
      sourceDate: "2026-07-31",
      itemCode: "10611028",
    };
    const first = dedupKeyForSource(
      "cash",
      cashRow({ ...anon, documentNo: "86954", contentHash: "h1" }),
    );
    const second = dedupKeyForSource(
      "cash",
      cashRow({ ...anon, documentNo: "86981", contentHash: "h2" }),
    );
    expect(first).not.toBe(second);
    expect(first).toContain("anon");
  });

  it("still collapses a re-imported anonymous row with the same invoice", () => {
    // Idempotency survives the split: the same transaction re-read from an
    // overlapping file is still one lead.
    const anon = {
      customerRef: "437745",
      phoneRaw: "0000",
      phoneE164: null,
      documentNo: "86954",
    };
    expect(dedupKeyForSource("cash", cashRow({ ...anon, rowNumber: 12, contentHash: "a" }))).toBe(
      dedupKeyForSource("cash", cashRow({ ...anon, rowNumber: 980, contentHash: "b" })),
    );
  });

  it("does not merge two customers who both refused a number", () => {
    const a = dedupKeyForSource(
      "cash",
      cashRow({ customerRef: "437745", phoneRaw: "0", phoneE164: null, customerName: "REFUSED" }),
    );
    const b = dedupKeyForSource(
      "cash",
      cashRow({
        customerRef: "509226",
        phoneRaw: "0000",
        phoneE164: null,
        customerName: "REFUSED",
      }),
    );
    expect(a).not.toBe(b);
  });

  it("falls back through customer ref, then phone, then name", () => {
    const byPhone = dedupKeyForSource(
      "cash",
      cashRow({ customerRef: null, phoneRaw: "0535323292" }),
    );
    expect(byPhone).toContain("535323292");

    const byName = dedupKeyForSource(
      "cash",
      cashRow({ customerRef: null, phoneRaw: "0", phoneE164: null, customerName: "OM HOUR" }),
    );
    expect(byName).toContain("om hour");
  });
});

describe("the Wasfaty key", () => {
  it("is the patient and prescription pair", () => {
    expect(dedupKeyForSource("wasfaty", wasfatyRow())).toBe("wasfaty|1001385382|j8952992");
  });

  it("is case-insensitive, because the sheets are not consistent", () => {
    const lower = dedupKeyForSource("wasfaty", wasfatyRow({ prescriptionNo: "j8952992" }));
    const upper = dedupKeyForSource("wasfaty", wasfatyRow({ prescriptionNo: "J8952992" }));
    expect(lower).toBe(upper);
  });

  it("keeps one patient's several prescriptions apart", () => {
    // 333 patients in the Riyadh sheet hold more than one prescription.
    const a = dedupKeyForSource("wasfaty", wasfatyRow({ prescriptionNo: "f5567839" }));
    const b = dedupKeyForSource("wasfaty", wasfatyRow({ prescriptionNo: "r8298417" }));
    expect(a).not.toBe(b);
  });

  it("does not change when the next dispense date moves", () => {
    // The deliberate difference from Cash: a re-imported file whose dispense
    // date has shifted is the same lead, not a new one.
    const sept = dedupKeyForSource("wasfaty", wasfatyRow({ sourceDate: "2026-09-05" }));
    const oct = dedupKeyForSource("wasfaty", wasfatyRow({ sourceDate: "2026-10-05" }));
    expect(sept).toBe(oct);
  });

  it("gives a row missing half the pair its own key rather than merging it", () => {
    const a = dedupKeyForSource(
      "wasfaty",
      wasfatyRow({ prescriptionNo: null, contentHash: "aaa" }),
    );
    const b = dedupKeyForSource(
      "wasfaty",
      wasfatyRow({ prescriptionNo: null, contentHash: "bbb" }),
    );
    expect(a).not.toBe(b);
    expect(a).toContain("partial");
  });
});

describe("the Retention key", () => {
  const base = {
    customerRef: "509226",
    phone: "+966535323292",
    customerName: "MOHAMED",
    itemCode: "10611031",
    itemName: "MOUNJARO",
  };

  it("distinguishes one cycle from the next", () => {
    const c2 = dedupKeyForRetention({ ...base, cycleNumber: 2 });
    const c3 = dedupKeyForRetention({ ...base, cycleNumber: 3 });
    expect(c2).not.toBe(c3);
  });

  it("ignores the branch, because the customer may collect elsewhere", () => {
    // There is no branch in the input at all — this asserts the shape. The
    // identity is the phone rather than the customer ref, for the reason
    // `cashKey` documents: `Id` is not a person in this data.
    expect(dedupKeyForRetention({ ...base, cycleNumber: 2 })).toBe(
      "retention|535323292|10611031|c2",
    );
  });

  it("keeps two anonymous backlog rows apart", () => {
    const anon = {
      customerRef: null,
      phone: "0",
      customerName: "REFUSED TO GET MOBILE NUMBER",
      itemCode: "10611031",
      itemName: "MOUNJARO",
      cycleNumber: 1,
    };
    expect(dedupKeyForRetention({ ...anon, documentNo: "211946" })).not.toBe(
      dedupKeyForRetention({ ...anon, documentNo: "211999" }),
    );
  });

  it("keeps two products for one customer on separate cycles", () => {
    const mounjaro = dedupKeyForRetention({ ...base, cycleNumber: 2 });
    const libre = dedupKeyForRetention({ ...base, itemCode: "10613360", cycleNumber: 2 });
    expect(mounjaro).not.toBe(libre);
  });
});

describe("content hashing", () => {
  it("is stable, and different for different content", () => {
    expect(contentHash(["a", "b", 1])).toBe(contentHash(["a", "b", 1]));
    expect(contentHash(["a", "b", 1])).not.toBe(contentHash(["a", "b", 2]));
  });

  it("normalises the way the keys do", () => {
    expect(contentHash([" A ", "b"])).toBe(contentHash(["a", "B"]));
    expect(contentHash([null, undefined])).toBe(contentHash(["", ""]));
  });

  it("digests a workbook independently of row order", () => {
    // Two uploads of the same file that Excel happened to sort differently are
    // the same workbook.
    expect(workbookDigest(["a", "b", "c"])).toBe(workbookDigest(["c", "a", "b"]));
    expect(workbookDigest(["a", "b"])).not.toBe(workbookDigest(["a", "b", "c"]));
  });
});
