/**
 * An order's invoice position: states, totals, and what gets recorded.
 *
 * The rule every case here defends is that **an invoice arriving late is normal**.
 * A document can appear in the MIS an hour or two after the order is taken, so
 * "not found" is `pending` and never a failure, never a reason to call the order
 * invalid, and never something that checks the Call Center box.
 */

import { describe, expect, it } from "vitest";
import {
  authoritativeValue,
  dedupeInvoices,
  invoiceKey,
  invoicesToRecord,
  needsValueSync,
  summarizeInvoices,
  verificationEntries,
  type OrderInvoice,
} from "../invoice-verification";

function invoice(invoiceNo: string, overrides: Partial<OrderInvoice> = {}): OrderInvoice {
  return {
    invoiceNo,
    key: invoiceKey(invoiceNo),
    state: "pending",
    branchCode: null,
    customer: null,
    isCallCentre: false,
    total: null,
    docDate: null,
    cancelled: false,
    items: [],
    ...overrides,
  };
}

function verified(invoiceNo: string, total: number, overrides: Partial<OrderInvoice> = {}) {
  return invoice(invoiceNo, {
    state: "verified",
    total,
    branchCode: "P0221",
    customer: "HOME DELIVERY-Call Centre",
    isCallCentre: true,
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

describe("invoiceKey", () => {
  it("treats a padded and an unpadded number as one document", () => {
    expect(invoiceKey("022138")).toBe(invoiceKey("22138"));
    expect(invoiceKey(" 22138 ")).toBe("22138");
  });

  it("keeps a genuine zero", () => {
    expect(invoiceKey("000")).toBe("0");
  });
});

describe("dedupeInvoices", () => {
  it("collapses two spellings of the same number", () => {
    const rows = dedupeInvoices([invoice("22138"), invoice("022138")]);
    expect(rows).toHaveLength(1);
  });

  it("lets a verified entry displace an unverified one for the same document", () => {
    // The order lists the number twice; one lookup found it. It is found.
    const rows = dedupeInvoices([invoice("22138"), verified("022138", 230)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("verified");
  });

  it("keeps genuinely different numbers apart", () => {
    expect(dedupeInvoices([invoice("22138"), invoice("22139")])).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Delayed invoices                                                            */
/* -------------------------------------------------------------------------- */

describe("an order whose invoice has not appeared yet", () => {
  it("is pending, not failed", () => {
    const s = summarizeInvoices([invoice("22138")]);
    expect(s.pending).toHaveLength(1);
    expect(s.verified).toEqual([]);
    expect(s.allVerified).toBe(false);
  });

  it("contributes nothing to the total rather than a guess", () => {
    expect(summarizeInvoices([invoice("22138")]).verifiedTotal).toBe(0);
  });

  it("records nothing, so the Call Center box is not touched", () => {
    expect(invoicesToRecord(summarizeInvoices([invoice("22138")]), new Set())).toEqual([]);
  });

  it("becomes verified when the document lands, with no other change needed", () => {
    // The same order, two hours later. Nothing was recreated.
    const later = summarizeInvoices([verified("22138", 230)]);
    expect(later.verified).toHaveLength(1);
    expect(later.verifiedTotal).toBe(230);
    expect(later.allVerified).toBe(true);
    expect(invoicesToRecord(later, new Set()).map((i) => i.key)).toEqual(["22138"]);
  });

  it("keeps a temporary MIS outage distinct from a missing document", () => {
    const s = summarizeInvoices([invoice("22138", { state: "unavailable" })]);
    expect(s.unavailable).toHaveLength(1);
    expect(s.pending).toEqual([]);
    // Neither state records anything: one is "not yet", the other "cannot say".
    expect(invoicesToRecord(s, new Set())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Multiple invoices                                                           */
/* -------------------------------------------------------------------------- */

describe("an order with several invoices", () => {
  it("sums the verified totals rather than taking the first", () => {
    const s = summarizeInvoices([verified("22138", 230), verified("22139", 150)]);
    expect(s.verifiedTotal).toBe(380);
    expect(s.isMulti).toBe(true);
    expect(s.allVerified).toBe(true);
  });

  it("keeps invoices from different branches separate", () => {
    const s = summarizeInvoices([
      verified("22138", 230, { branchCode: "P0221" }),
      verified("22139", 150, { branchCode: "P0034", isCallCentre: false }),
    ]);
    expect(s.verified.map((i) => i.branchCode)).toEqual(["P0221", "P0034"]);
    expect(s.verifiedTotal).toBe(380);
  });

  it("never counts one document twice, however it is spelled", () => {
    const s = summarizeInvoices([verified("22138", 230), verified("022138", 230)]);
    expect(s.invoices).toHaveLength(1);
    expect(s.verifiedTotal).toBe(230);
  });

  it("totals only what is verified while others are still pending", () => {
    const s = summarizeInvoices([verified("22138", 230), invoice("22139")]);
    expect(s.verifiedTotal).toBe(230);
    expect(s.verified).toHaveLength(1);
    expect(s.pending).toHaveLength(1);
    // The distinction the UI needs to label the figure "so far".
    expect(s.allVerified).toBe(false);
  });

  it("adds the second invoice's total once it arrives", () => {
    const before = summarizeInvoices([verified("22138", 230), invoice("22139")]);
    const after = summarizeInvoices([verified("22138", 230), verified("22139", 150)]);
    expect(before.verifiedTotal).toBe(230);
    expect(after.verifiedTotal).toBe(380);
    expect(after.allVerified).toBe(true);
  });

  it("keeps the currency's own precision when summing figures off the wire", () => {
    expect(summarizeInvoices([verified("1", 0.1), verified("2", 0.2)]).verifiedTotal).toBe(0.3);
  });

  it("does not treat an order with one invoice as multi", () => {
    expect(summarizeInvoices([verified("22138", 230)]).isMulti).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Customer information                                                        */
/* -------------------------------------------------------------------------- */

describe("customer information", () => {
  it("belongs to the invoice it came from", () => {
    const s = summarizeInvoices([
      verified("22138", 230, { customer: "HOME DELIVERY-Call Centre" }),
      verified("22139", 150, { customer: "CASH SALES", isCallCentre: false }),
    ]);
    expect(s.verified.map((i) => i.customer)).toEqual(["HOME DELIVERY-Call Centre", "CASH SALES"]);
    expect(s.verified.map((i) => i.isCallCentre)).toEqual([true, false]);
  });

  it("survives a document the MIS gave no customer for", () => {
    const s = summarizeInvoices([verified("22138", 230, { customer: null })]);
    expect(s.verified[0].customer).toBeNull();
    // Absent customer is not absent verification — the total still counts.
    expect(s.verifiedTotal).toBe(230);
  });
});

/* -------------------------------------------------------------------------- */
/* What gets recorded                                                          */
/* -------------------------------------------------------------------------- */

describe("invoicesToRecord", () => {
  it("offers a newly verified invoice", () => {
    const s = summarizeInvoices([verified("22138", 230)]);
    expect(invoicesToRecord(s, new Set()).map((i) => i.key)).toEqual(["22138"]);
  });

  it("offers nothing for an invoice the timeline already holds", () => {
    // Idempotence: a re-render, a refetch, or a second agent opening the order.
    const s = summarizeInvoices([verified("22138", 230)]);
    expect(invoicesToRecord(s, new Set(["22138"]))).toEqual([]);
  });

  it("matches a recorded invoice regardless of padding", () => {
    const s = summarizeInvoices([verified("022138", 230)]);
    expect(invoicesToRecord(s, new Set(["22138"]))).toEqual([]);
  });

  it("offers only the invoice that is new", () => {
    const s = summarizeInvoices([verified("22138", 230), verified("22139", 150)]);
    expect(invoicesToRecord(s, new Set(["22138"])).map((i) => i.key)).toEqual(["22139"]);
  });

  it("never offers a pending or unavailable invoice", () => {
    // The rule that keeps the Call Center checkbox honest: neither a typed
    // number, nor an attempted lookup, nor a failed one is a verification.
    const s = summarizeInvoices([invoice("22138"), invoice("22139", { state: "unavailable" })]);
    expect(invoicesToRecord(s, new Set())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Keeping the order's value in step — the self-healing half                   */
/* -------------------------------------------------------------------------- */

/**
 * The bug this suite exists for.
 *
 * Recording used to be driven *only* by an invoice the timeline did not yet
 * hold, which made the whole sync a one-shot: if that single write did not land,
 * the order kept a verified invoice of SAR 212.60 beside an order value of 0.00
 * for ever, because every later visit correctly found nothing **new** to record
 * and therefore asked for nothing at all. `needsValueSync` is the second reason
 * to call the server, and it is what repairs that.
 */
describe("needsValueSync", () => {
  it("asks for a sync when the stored value is still zero", () => {
    // The reported case, exactly: verified 212.60, order value 0.00.
    const s = summarizeInvoices([verified("0169580", 212.6)]);
    expect(needsValueSync(s, 0, false)).toBe(true);
  });

  it("asks for a sync when the invoice is recorded but the value never landed", () => {
    // Nothing new to record — `invoicesToRecord` is empty — and yet the order
    // disagrees with its own log. This is the state that used to be terminal.
    const s = summarizeInvoices([verified("0169580", 212.6)]);
    expect(invoicesToRecord(s, new Set(["169580"]))).toEqual([]);
    expect(needsValueSync(s, 0, false)).toBe(true);
  });

  it("asks for a sync when the value agrees but the flag was never set", () => {
    const s = summarizeInvoices([verified("0169580", 212.6)]);
    expect(needsValueSync(s, 212.6, false)).toBe(true);
  });

  it("asks for nothing once the order agrees with what was verified", () => {
    // The steady state: opening the order again must cost no write at all.
    const s = summarizeInvoices([verified("0169580", 212.6)]);
    expect(needsValueSync(s, 212.6, true)).toBe(false);
  });

  it("tolerates the stored column's two-decimal rounding", () => {
    const s = summarizeInvoices([verified("1", 212.599999)]);
    expect(needsValueSync(s, 212.6, true)).toBe(false);
  });

  it("asks for a sync when a second invoice lands", () => {
    const s = summarizeInvoices([verified("1", 212.6), verified("2", 100)]);
    expect(needsValueSync(s, 212.6, true)).toBe(true);
    expect(s.verifiedTotal).toBe(312.6);
  });

  it("never asks while nothing is verified, so a typed value survives", () => {
    // An order with a pending invoice keeps whatever the agent entered.
    expect(needsValueSync(summarizeInvoices([invoice("22138")]), 500, false)).toBe(false);
    expect(needsValueSync(summarizeInvoices([]), 500, false)).toBe(false);
    expect(
      needsValueSync(summarizeInvoices([invoice("1", { state: "unavailable" })]), 500, false),
    ).toBe(false);
  });

  it("does not re-add a duplicate invoice's total on a repeat check", () => {
    // The explicit scenario: checking 0169580 again must leave the order at
    // 212.60, not 425.20.
    const first = summarizeInvoices([verified("0169580", 212.6)]);
    const again = summarizeInvoices([verified("0169580", 212.6), verified("169580", 212.6)]);
    expect(again.verifiedTotal).toBe(212.6);
    expect(needsValueSync(again, first.verifiedTotal, true)).toBe(false);
  });

  it("treats an invoice the MIS priced at nothing as verified, not pending", () => {
    // A zero-total document is still a document; it just adds nothing.
    const s = summarizeInvoices([verified("1", 0)]);
    expect(s.verified).toHaveLength(1);
    expect(s.verifiedTotal).toBe(0);
    expect(needsValueSync(s, 0, true)).toBe(false);
    // But the flag still has to be set, so it is not silently skipped.
    expect(needsValueSync(s, 0, false)).toBe(true);
  });

  it("counts a verified invoice with no total as contributing nothing", () => {
    const s = summarizeInvoices([verified("1", 212.6), verified("2", 0, { total: null })]);
    expect(s.verifiedTotal).toBe(212.6);
  });

  it("stops asking once a non-call-centre invoice is reconciled", () => {
    // The loop this rule closes. `needsValueSync` used to read "verified and the
    // flag unset means sync", so a walk-in invoice — which must never tick the
    // box — was a permanent disagreement: the client asked on every render and
    // the server, correctly, changed nothing.
    const s = summarizeInvoices([verified("1", 212.6, { isCallCentre: false })]);
    expect(s.callCentreVerified).toBe(false);
    expect(needsValueSync(s, 212.6, false)).toBe(false);
    // The value is still reconciled — only the flag is none of its business.
    expect(needsValueSync(s, 100, false)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The Call Center flag                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The distinction the whole checkbox rests on: it says *the call centre raised
 * this invoice*, established from the document's own channel, and nothing else
 * may set it — not a typed number, not an attempted lookup, not a failed one.
 */
describe("callCentreVerified", () => {
  it("is true when a verified document carries the Call Centre channel", () => {
    const s = summarizeInvoices([verified("0169580", 212.6)]);
    expect(s.callCentreVerified).toBe(true);
  });

  it("is false for a verified walk-in invoice", () => {
    const s = summarizeInvoices([
      verified("22138", 230, { customer: "CASH SALES", isCallCentre: false }),
    ]);
    expect(s.verified).toHaveLength(1);
    expect(s.callCentreVerified).toBe(false);
  });

  it("is false while the invoice is only pending", () => {
    // Even though this number will turn out to be a call-centre document.
    expect(summarizeInvoices([invoice("0169580")]).callCentreVerified).toBe(false);
  });

  it("is false when the lookup could not be made at all", () => {
    expect(
      summarizeInvoices([invoice("0169580", { state: "unavailable" })]).callCentreVerified,
    ).toBe(false);
  });

  it("is true when any one of several invoices is a Call Centre document", () => {
    const s = summarizeInvoices([
      verified("22138", 230, { isCallCentre: false }),
      verified("22139", 150, { isCallCentre: true }),
    ]);
    expect(s.callCentreVerified).toBe(true);
  });

  it("asks for a sync when a call-centre invoice is verified and the flag is unset", () => {
    const s = summarizeInvoices([verified("0169580", 212.6)]);
    expect(needsValueSync(s, 212.6, false)).toBe(true);
    expect(needsValueSync(s, 212.6, true)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* What actually gets written to the order                                     */
/* -------------------------------------------------------------------------- */

/**
 * The business rule the form kept showing but not saving: **a verified total
 * overwrites a manually entered value.** Stated once, here, so the field, the
 * insert and the update cannot each answer it differently.
 */
describe("authoritativeValue", () => {
  it("overwrites a manually entered value with the verified total", () => {
    const s = summarizeInvoices([verified("0169580", 212.6)]);
    expect(authoritativeValue(s, 100)).toBe(212.6);
  });

  it("sums several verified invoices rather than taking the first", () => {
    const s = summarizeInvoices([verified("0169580", 212.6), verified("0169581", 150)]);
    expect(authoritativeValue(s, 100)).toBe(362.6);
  });

  it("counts one document once, however many times the order names it", () => {
    const s = summarizeInvoices([verified("0169580", 212.6), verified("169580", 212.6)]);
    expect(authoritativeValue(s, 100)).toBe(212.6);
  });

  it("overwrites even a value that was typed to match nothing in particular", () => {
    const s = summarizeInvoices([verified("1", 0)]);
    expect(authoritativeValue(s, 500)).toBe(0);
  });

  it("keeps the typed value while nothing has been verified", () => {
    // A pending invoice may still be an hour away; the order is valid meanwhile.
    expect(authoritativeValue(summarizeInvoices([invoice("22138")]), 100)).toBe(100);
    expect(authoritativeValue(summarizeInvoices([]), 100)).toBe(100);
    expect(
      authoritativeValue(summarizeInvoices([invoice("1", { state: "unavailable" })]), 100),
    ).toBe(100);
  });

  it("leaves an empty field empty rather than inventing a zero", () => {
    expect(authoritativeValue(summarizeInvoices([invoice("22138")]), null)).toBeNull();
  });
});

describe("verificationEntries", () => {
  it("sends only verified documents", () => {
    const entries = verificationEntries([
      verified("0169580", 212.6),
      invoice("0169581"),
      invoice("0169582", { state: "unavailable" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].invoice_no).toBe("0169580");
  });

  it("carries the channel classification the server decides the flag from", () => {
    const [callCentre] = verificationEntries([verified("0169580", 212.6)]);
    expect(callCentre.is_call_centre).toBe(true);
    const [walkIn] = verificationEntries([
      verified("22138", 230, { customer: "CASH SALES", isCallCentre: false }),
    ]);
    expect(walkIn.is_call_centre).toBe(false);
  });

  it("sends the number as typed, so the server strips zeros the same way", () => {
    const [entry] = verificationEntries([verified("0169580", 212.6)]);
    expect(entry.invoice_no).toBe("0169580");
    expect(invoiceKey(entry.invoice_no)).toBe("169580");
  });

  it("sends nothing at all for an order whose invoice has not appeared", () => {
    expect(verificationEntries([invoice("0169580")])).toEqual([]);
  });
});
