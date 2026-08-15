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

const sql = readFileSync(
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
    expect(sql).toContain("AFTER UPDATE OF invoice_no ON public.orders");
    expect(sql).toContain("WHEN (NEW.invoice_no IS DISTINCT FROM OLD.invoice_no)");
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
    expect(sql).toContain("new_flag     := (call_centre_cnt > 0) OR manual_tick;");
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

  it("repairs the orders that are already stale, without inventing history", () => {
    expect(sql).toContain("UPDATE public.orders o");
    expect(sql).toContain("FROM derived d");
    // The backfill runs under the same GUC, so it cannot file a
    // `verification_changed` row against nobody for every order it corrects.
    const backfill = sql.slice(sql.indexOf("Repair the orders"));
    expect(backfill).toContain("set_config('milaserv.invoice_sync', 'on', true)");
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
function listState(counts: { verifiedCnt: number; callCentreCnt: number }, status = "Pending") {
  return callCentreState({
    status,
    invoices_verified: counts.verifiedCnt > 0,
    call_center_verified: counts.callCentreCnt > 0,
  });
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
