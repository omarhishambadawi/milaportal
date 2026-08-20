/**
 * The sweep that sends orders whose held time has come.
 *
 * Runs from `pg_cron` against `/api/alshrouq/run-scheduled`, not from a browser:
 * a held order must go out whether or not the agent who raised it is still
 * logged in, still on the page, or still at work. See the post-migration note in
 * `20260820220000_alshrouq_scheduling_and_historical.sql` for the job itself.
 *
 * ## What it does not do
 *
 * It does not re-implement dispatch. Every order it picks goes through the same
 * `attemptDispatch` the Send button uses, so the live-dispatch read, the
 * historical gate, the schedule gate and the `client_order_id` lookup after an
 * ambiguous POST all apply unchanged. The sweep's only job is choosing *which*
 * orders to hand over.
 *
 * ## Why it reads with the privileged client
 *
 * There is no caller to authorise. The decision to dispatch was made and
 * authorised when an agent saved the order with a schedule; this is the Portal
 * keeping that appointment. `attemptDispatch` is given the same privileged
 * client, and the dispatch is attributed to the order's own agent rather than to
 * a service account, because that is who raised it.
 */

import { attemptDispatch } from "@/lib/alshrouq/dispatch.server";

export interface SweepResult {
  /** Orders whose time had come when the sweep ran. */
  due: number;
  dispatched: number;
  failed: number;
  /** Order ids that failed, with the reason, for the response body. */
  failures: { orderId: string; reason: string }[];
}

/** How many to take in one pass, so a backlog cannot make one run unbounded. */
const BATCH = 25;

/**
 * Send every order that is due.
 *
 * Ordered oldest-first so a backlog drains in the order it was promised. Each
 * order is independent: one that fails is recorded and the rest still go.
 */
export async function runScheduledAlShrouqDispatch(): Promise<SweepResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nowIso = new Date().toISOString();

  /**
   * Due, and not already handled.
   *
   * `alshrouq_scheduled_at <= now()` is the appointment. The other three
   * conditions are the cheap exclusions — a method changed away from AlShrouq, a
   * cancelled order, and one marked historical by hand — so the sweep does not
   * hand over work `attemptDispatch` would only refuse. It refuses anyway; this
   * just keeps the batch honest.
   */
  const { data, error } = await supabaseAdmin
    .from("orders" as any)
    .select("id, agent_id")
    .eq("delivery_type", "AlShrouq")
    .eq("alshrouq_historical", false)
    .neq("status", "Cancelled")
    .not("alshrouq_scheduled_at", "is", null)
    .lte("alshrouq_scheduled_at", nowIso)
    .order("alshrouq_scheduled_at", { ascending: true })
    .limit(BATCH);

  if (error) throw new Error("Unable to read the scheduled AlShrouq orders.");

  const rows = (data as unknown as { id: string; agent_id: string }[] | null) ?? [];
  const result: SweepResult = { due: rows.length, dispatched: 0, failed: 0, failures: [] };

  for (const row of rows) {
    try {
      // The same call the Send button makes. An order already dispatched comes
      // back as the existing record rather than a second delivery, which is what
      // makes a re-run of the sweep safe.
      await attemptDispatch(supabaseAdmin as never, row.agent_id, row.id);
      result.dispatched++;
    } catch (e: any) {
      result.failed++;
      // The message only. `attemptDispatch` has already written the failure to
      // the order's timeline; this is for the sweep's own response.
      result.failures.push({ orderId: row.id, reason: e?.message ?? "unknown error" });
    }
  }

  return result;
}
