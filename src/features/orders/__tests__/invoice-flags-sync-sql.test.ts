/**
 * The Orders list must describe the invoices the order names *now*.
 *
 * The reproduction this guards, in full:
 *
 *   1. Order carries invoice `A`, a walk-in document. It verifies, so
 *      `invoices_verified = true` and `call_center_verified = false`, and the
 *      list shows the warning triangle. Correct.
 *   2. The agent replaces `A` with `B`, a Call Centre document, and saves.
 *   3. Before this trigger, the save was a plain `UPDATE orders SET invoice_no`
 *      and nothing re-derived the columns — so the list kept warning about a
 *      document the order no longer had, while the order page (which reads the
 *      live Shams answer) showed Call Centre.
 *
 * As with `invoice-verification-sql.test.ts`, the function cannot be executed
 * here — it needs a database — so what is asserted is that the clauses carrying
 * its guarantees are present, and that the rules it applies are the *same* rules
 * the client and `record_invoice_verification` apply. Every assertion below
 * corresponds to something that silently breaks the list if it is removed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invoiceKey, summarizeInvoices, type OrderInvoice } from "../invoice-verification";
import { callCentreState } from "../components/call-centre-cell";

/**
 * The *deployed* definition, not the one this trigger shipped with.
 * `20260815190000` has been retired to a no-op: its backfill caused the
 * verification incident of 2026-08-15, and its copy of this function lacked the
 * current-evidence guard. `20260815230000` is what production runs.
 */
const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260815230000_verification_needs_current_evidence.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The applied migration that owns the trigger itself. */
const triggerSql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260815165443_a379abae-77cb-4ad7-ae18-ede8fed096ab.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The retired migration, asserted to stay harmless. */
const retired = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260815190000_invoice_flags_follow_the_invoice_number.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The migration that owns the derivation this one has to agree with. */
const rpcSql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260815170000_call_centre_flag_follows_current_invoices.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("the flags are re-derived when the invoice number changes", () => {
  it("fires on an invoice_no change and only on one", () => {
    // The trigger is owned by the migration that created it; 20260815230000
    // replaces the function body underneath it and leaves the binding alone.
    expect(triggerSql).toContain("AFTER UPDATE OF invoice_no ON public.orders");
    expect(triggerSql).toContain("WHEN (NEW.invoice_no IS DISTINCT FROM OLD.invoice_no)");
  });

  it("cannot re-enter itself", () => {
    // The correcting UPDATE writes the three derived columns and never
    // `invoice_no`, so the WHEN guard is false for it.
    const update = sql.slice(sql.indexOf("UPDATE public.orders"));
    const body = update.slice(0, update.indexOf("synced := FOUND"));
    expect(body).toContain("call_center_verified = new_flag");
    expect(body).toContain("invoices_verified    = new_verified");
    expect(body).not.toContain("invoice_no =");
  });

  it("derives from the numbers the order names now, not from the caller", () => {
    expect(sql).toContain("regexp_split_to_table(COALESCE(NEW.invoice_no, ''), '[,\\n]+')");
    expect(sql).toContain("FROM public.order_activity a");
    expect(sql).toContain("JOIN current_keys c ON c.key = l.key");
  });

  it("strips leading zeros the same way the client does", () => {
    expect(sql).toContain("ltrim(btrim(part), '0')");
    expect(sql).toContain("WHEN ltrim(btrim(part), '0') = '' THEN '0'");
    expect(invoiceKey("022138")).toBe("22138");
    expect(invoiceKey("000")).toBe("0");
  });

  it("takes the latest statement per document, so a re-priced invoice wins", () => {
    expect(sql).toContain("SELECT DISTINCT ON (a.details->>'invoice_key')");
    expect(sql).toContain("(a.action = 'invoice_value_changed') DESC");
  });
});

describe("the rules it applies are the existing ones", () => {
  it("keeps the ANY rule for the order-level flag", () => {
    // One Call Centre invoice beside a walk-in one is still a call-centre
    // order. ALL governs auto-completion, which this does not touch.
    expect(sql).toContain("THEN (call_centre_cnt > 0) OR manual_tick");
    expect(rpcSql).toContain("call_center_verified = (call_centre_cnt > 0)");
    expect(sql).not.toContain("call_centre_cnt = verified_cnt");
  });

  it("does not discard a tick made by hand in the same save", () => {
    // The form still offers the box to `verify_*` holders for a document raised
    // outside the channel; correcting the invoice number at the same time must
    // not silently undo it.
    expect(sql).toContain("manual_tick     boolean := COALESCE(NEW.call_center_verified, false)");
    expect(sql).toContain("AND NOT COALESCE(OLD.call_center_verified, false)");
  });

  it("does not complete or cancel anything", () => {
    // Auto-completion belongs to `record_invoice_verification`, which sees the
    // live MIS answer. Changing a number is not evidence an order is finished.
    expect(sql).not.toContain("'Completed'");
    expect(sql).not.toContain("status =");
  });

  it("keeps a typed value when nothing is verified", () => {
    // The same rule as `authoritativeValue`: with no verified document there is
    // no authoritative figure to replace what the agent typed.
    expect(sql).toContain(
      "CASE WHEN verified_cnt > 0 THEN verified_sum ELSE NEW.invoice_value END",
    );
  });

  it("writes nothing when nothing changed", () => {
    expect(sql).toContain("call_center_verified IS DISTINCT FROM new_flag");
    expect(sql).toContain("OR invoices_verified IS DISTINCT FROM new_verified");
    expect(sql).toContain("IF synced THEN");
  });
});

describe("the correction is attributed to the portal, not to whoever saved", () => {
  it("suppresses the generic edit log with the existing GUC", () => {
    expect(sql).toContain("set_config('milaserv.invoice_sync', 'on', true)");
    expect(sql).toContain("set_config('milaserv.invoice_sync', 'off', true)");
  });

  it("narrates itself with the events the RPC already uses", () => {
    for (const action of ["value_synced", "call_center_flagged", "call_center_cleared"]) {
      expect(sql).toContain(`'${action}'`);
      expect(rpcSql).toContain(`'${action}'`);
    }
  });

  it("repairs nothing in bulk — the backfill is what caused the incident", () => {
    // `20260815165443` / `20260815190000` applied this derivation to every order
    // at once, against evidence that only started existing on 2026-08-14, and
    // cleared 3,836 hand-set flags. The deployed function touches one row, the
    // one whose invoice_no just changed.
    expect(sql).not.toContain("FROM derived d");
    expect(sql).not.toContain("DISABLE TRIGGER");
    expect(sql).not.toMatch(/UPDATE public\.orders o\b/);
  });

  it("keeps the retired migration harmless", () => {
    // It must never re-run its backfill through a future `supabase db push`.
    expect(retired).not.toMatch(/\bUPDATE\s+public\.orders\b/i);
    expect(retired).not.toMatch(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/i);
    expect(retired).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
  });
});

/* -------------------------------------------------------------------------- */
/* What the list will show, given what the trigger derives                     */
/* -------------------------------------------------------------------------- */

/**
 * The three columns the trigger writes, as the list's cell reads them.
 *
 * `verified_cnt` / `call_centre_cnt` are what the SQL computes from the current
 * invoice set; this mirrors the two assignments so the transition an agent
 * actually sees can be asserted end to end.
 */
function derive(
  counts: { verifiedCnt: number; callCentreCnt: number },
  existing = { call_center_verified: false, invoices_verified: false },
) {
  // The guard: with nothing answered for, every column keeps what it holds.
  if (counts.verifiedCnt === 0) return existing;
  return {
    call_center_verified: counts.callCentreCnt > 0,
    invoices_verified: true,
  };
}

function listState(counts: { verifiedCnt: number; callCentreCnt: number }, status = "Pending") {
  return callCentreState({ status, ...derive(counts) });
}

const invoice = (over: Partial<OrderInvoice> = {}): OrderInvoice => ({
  invoiceNo: "22138",
  key: "22138",
  state: "verified",
  branchCode: "P0221",
  customer: "HOME DELIVERY-Call Centre",
  isCallCentre: true,
  total: 230,
  docDate: "2026-08-13T00:00:00",
  cancelled: false,
  items: [],
  ...over,
});

describe("the transition the agent sees", () => {
  it("non-Call-Centre invoice warns", () => {
    expect(listState({ verifiedCnt: 1, callCentreCnt: 0 })).toBe("walk_in");
  });

  it("replacing it with a verified Call Centre invoice clears the warning", () => {
    // Step 2 of the reproduction: one verified invoice, and it is a call-centre
    // document, so the list shows the tick rather than the triangle.
    expect(listState({ verifiedCnt: 1, callCentreCnt: 1 })).toBe("verified");
  });

  it("and the reverse transition brings the warning back", () => {
    expect(listState({ verifiedCnt: 1, callCentreCnt: 1 })).toBe("verified");
    expect(listState({ verifiedCnt: 1, callCentreCnt: 0 })).toBe("walk_in");
  });

  it("a replacement nobody has verified yet is pending, not a warning", () => {
    // The old evidence describes a document the order no longer names, so it is
    // withdrawn; the list says "not verified yet" until Shams answers for the
    // new number. This is the case the RPC's `IF verified_cnt > 0` guard would
    // have left showing the stale warning.
    expect(listState({ verifiedCnt: 0, callCentreCnt: 0 })).toBe("pending");
  });

  it("removing every invoice returns the order to pending", () => {
    expect(listState({ verifiedCnt: 0, callCentreCnt: 0 })).toBe("pending");
  });

  it("one Call Centre invoice among several still clears the warning", () => {
    // ANY, matching `summarizeInvoices`, which the order page reads.
    const summary = summarizeInvoices([
      invoice({ invoiceNo: "22138", key: "22138", isCallCentre: true }),
      invoice({ invoiceNo: "22139", key: "22139", isCallCentre: false }),
    ]);
    expect(summary.callCentreVerified).toBe(true);
    expect(listState({ verifiedCnt: 2, callCentreCnt: 1 })).toBe("verified");
    // …but it is not finished: a walk-in beside it is the thing to look at.
    expect(summary.allCallCentre).toBe(false);
  });

  it("a cancelled order still outranks whatever its invoices say", () => {
    expect(listState({ verifiedCnt: 1, callCentreCnt: 1 }, "Cancelled")).toBe("cancelled");
  });
});

/* -------------------------------------------------------------------------- */
/* Regression: the 2026-08-15 incident                                        */
/* -------------------------------------------------------------------------- */

/**
 * 3,836 orders lost a hand-set `call_center_verified` because a derivation read
 * `verified_cnt = 0` — no matching `invoice_verified` row — as proof the order
 * was a walk-in. For any order raised before 2026-08-14 that evidence could not
 * exist, so the conclusion was drawn from silence.
 *
 * The rule these guard: **absence of current evidence is not evidence of
 * non-verification.**
 */
describe("absence of evidence never clears a verification", () => {
  it("keeps both flags when nothing is verified (the incident)", () => {
    const existing = { call_center_verified: true, invoices_verified: true };
    expect(derive({ verifiedCnt: 0, callCentreCnt: 0 }, existing)).toEqual(existing);
    // And the list still shows the tick rather than a dash.
    expect(
      callCentreState({
        status: "Pending",
        ...derive({ verifiedCnt: 0, callCentreCnt: 0 }, existing),
      }),
    ).toBe("verified");
  });

  it("invents no verification when there was none", () => {
    // The guard preserves; it must never promote false to true.
    const existing = { call_center_verified: false, invoices_verified: false };
    expect(derive({ verifiedCnt: 0, callCentreCnt: 0 }, existing)).toEqual(existing);
    expect(
      callCentreState({
        status: "Pending",
        ...derive({ verifiedCnt: 0, callCentreCnt: 0 }, existing),
      }),
    ).toBe("pending");
  });

  it("still reconciles normally once the MIS has answered", () => {
    // Positive current evidence: the derivation runs exactly as before, and may
    // clear a flag — because now there is something that justifies clearing it.
    const existing = { call_center_verified: true, invoices_verified: true };
    expect(derive({ verifiedCnt: 1, callCentreCnt: 1 }, existing)).toEqual({
      call_center_verified: true,
      invoices_verified: true,
    });
    expect(derive({ verifiedCnt: 1, callCentreCnt: 0 }, existing)).toEqual({
      call_center_verified: false,
      invoices_verified: true,
    });
  });

  it("states the guard in the deployed SQL", () => {
    expect(sql).toContain("ELSE COALESCE(NEW.call_center_verified, false) END");
    expect(sql).toContain("ELSE NEW.invoices_verified END");
    expect(sql).not.toContain("new_verified := (verified_cnt > 0);");
  });

  it("holds in the migrations that also define this function", () => {
    // 20260815210000 is unapplied and older than the fix; its copy must not be
    // able to revert the guard if it is ever pushed.
    const channel = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../supabase/migrations/20260815210000_record_a_channel_correction.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(channel).not.toContain("new_verified := (verified_cnt > 0);");
    expect(channel).toContain("ELSE NEW.invoices_verified END");
  });
});
