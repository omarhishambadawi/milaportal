/**
 * A document's channel can be restated, and the log has to record it.
 *
 * The bug these guard, in the order it was found:
 *
 *   1. CC-8744 shows the red warning in the Orders list. Its order page shows
 *      the invoice as Verified *and* Call Centre, and ticks the box.
 *   2. `20260815190000` made the flag follow the order's current invoices, and
 *      its backfill reported `still_stale = 0` — the row and the derivation
 *      already agreed. They were wrong together.
 *   3. Both read `order_activity.details->>'is_call_centre'`, and nothing could
 *      ever update it: the only write for an invoice already in the log was
 *      gated on its **total** changing. A document first recorded as a walk-in
 *      stayed one for ever, however many times Shams answered "Call Centre".
 *
 * Two ordinary things put an order there: it was verified before `be824e2`,
 * when the portal read `Customer` instead of `Customer_Name`; or the MIS
 * corrected the customer on a number already recorded.
 *
 * The function cannot be executed here — it needs a database — so what is
 * asserted is that the clauses carrying the fix are present, and that every
 * reader of the log was taught about the new statement. A reader left behind is
 * the whole failure mode being fixed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../supabase/migrations/${name}`, import.meta.url)),
    "utf8",
  );

const sql = read("20260815210000_record_a_channel_correction.sql");
/** The definition this one supersedes, kept for before/after comparisons. */
const previous = read("20260815170000_call_centre_flag_follows_current_invoices.sql");

const ACTIONS = "'invoice_verified', 'invoice_value_changed', 'invoice_channel_changed'";

describe("the channel a document was recorded with can be corrected", () => {
  it("reads the previously recorded channel, not only the total", () => {
    // The root cause in one line: the lookup used to select `prev_total` alone,
    // so a changed channel had nothing to be compared against.
    expect(previous).toContain("SELECT (a.details->>'total')::numeric INTO prev_total");
    expect(sql).toContain("(a.details->>'is_call_centre')::boolean");
    expect(sql).toContain("INTO prev_total, prev_is_cc");
  });

  it("writes an event when the channel changed and the money did not", () => {
    expect(sql).toContain("ELSIF prev_is_cc IS DISTINCT FROM new_is_cc THEN");
    expect(sql).toContain("'invoice_channel_changed'");
    // Carries the total as well, so it can be the latest statement about the
    // document without losing what it is worth.
    expect(sql).toMatch(/'invoice_channel_changed',[\s\S]*?'total',\s+new_total/);
    expect(sql).toMatch(/'invoice_channel_changed',[\s\S]*?'is_call_centre',new_is_cc/);
  });

  it("still writes nothing when neither the total nor the channel moved", () => {
    // Idempotence: re-checking an unchanged document must record nothing, or
    // every page open would add a row.
    const loop = sql.slice(sql.indexOf("FOR entry IN"), sql.indexOf("END LOOP;"));
    expect(loop).toContain("IF NOT had_row THEN");
    expect(loop).toContain("ELSIF prev_total IS DISTINCT FROM new_total THEN");
    expect(loop).toContain("ELSIF prev_is_cc IS DISTINCT FROM new_is_cc THEN");
    expect(loop).not.toContain("ELSE\n");
  });

  it("keeps the re-pricing event distinct from the channel one", () => {
    // The money moving and the channel being restated are different facts, and
    // the timeline should not report one as the other.
    expect(sql).toContain("'invoice_value_changed'");
    expect(sql).toContain("'invoice_channel_changed'");
  });
});

describe("every reader of the log sees the new statement", () => {
  it("the per-invoice lookup does", () => {
    expect(sql).toContain(
      `AND a.action IN (${ACTIONS})\n      AND a.details->>'invoice_key' = key`,
    );
  });

  it("both derivations do — the RPC's and the invoice-number trigger's", () => {
    // Two functions read this log. A correction invisible to either one leaves
    // exactly the stale flag this migration exists to fix.
    const occurrences = sql.split(`a.action IN (${ACTIONS})`).length - 1;
    expect(occurrences).toBe(3);
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.record_invoice_verification");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.sync_order_invoice_flags");
  });

  it("prefers a correction over the first sighting when they tie", () => {
    // `created_at` is transaction time, so two rows written in one transaction
    // tie and the tie-break used to fall to a random uuid. The old rule named
    // one action; the new one covers any correction.
    expect(previous).toContain("(a.action = 'invoice_value_changed') DESC");
    expect(sql).toContain("(a.action <> 'invoice_verified') DESC");
    expect(sql).not.toContain("(a.action = 'invoice_value_changed') DESC");
  });
});

describe("what the fix deliberately does not do", () => {
  it("invents no channel for the orders already stale", () => {
    // What a document's channel is today is a question only Shams can answer.
    // These orders repair themselves on the next page open, because
    // `needsValueSync` has been asking for a reconciliation all along.
    expect(sql).not.toContain("UPDATE public.orders o");
    expect(sql).not.toMatch(/FROM\s+derived/);
  });

  it("changes no business rule", () => {
    // Same flag rule, same completion rule, same permission check.
    expect(sql).toContain("call_center_verified = (call_centre_cnt > 0)");
    expect(sql).toContain("AND call_centre_cnt = verified_cnt");
    expect(sql).toContain("public.has_permission(uid, 'view_shams_mis')");
    expect(sql).toContain("IF verified_cnt > 0 THEN");
  });

  it("keeps the flag out of the ordinary edit log", () => {
    expect(sql).toContain("set_config('milaserv.invoice_sync', 'on', true)");
    expect(sql).toContain("set_config('milaserv.invoice_sync', 'off', true)");
  });

  it("reports what it corrected, so a caller can tell repair from no-op", () => {
    expect(sql).toContain("'rechannelled', rechannelled");
  });
});
