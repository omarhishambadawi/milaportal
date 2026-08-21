import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

/**
 * The scheduled-dispatch worker endpoint.
 *
 * `pg_cron` runs `public.alshrouq_dispatch_due()` every minute; when something
 * is due that function POSTs here through `net.http_post`, carrying a shared
 * secret it reads from Supabase Vault. This route does the work, because the
 * transport, the payload builder, the reconciliation and the safety gate are all
 * TypeScript in this Worker — reimplementing any of them in plpgsql would be a
 * second integration to keep in step with the first.
 *
 * The same shape as `api/cdr-sync`, deliberately: a scheduler holds no Supabase
 * session, so it authenticates with `x-alshrouq-scheduler-secret` compared in
 * constant time, and the endpoint is a **no-op when the secret is unset** so an
 * unconfigured deployment cannot be triggered by a guess.
 *
 * `GET` reports state and never dispatches. A scheduler health check must not be
 * able to send a courier by accident.
 *
 * The service-role client is used because the worker acts as no user: the rows
 * it touches were authorised by an agent at scheduling time, and there is no
 * session to carry at 2am.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Length-independent, value-constant comparison. `!==` on a secret leaks its
 *  prefix through timing; this compares every byte either way. */
function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export const Route = createFileRoute("/api/alshrouq-run-scheduled")({
  server: {
    handlers: {
      /**
       * Health only. Reports whether the endpoint is configured and how many
       * dispatches are waiting — never starts one.
       */
      GET: async ({ request }) => {
        if (
          !secretMatches(
            request.headers.get("x-alshrouq-scheduler-secret"),
            process.env.ALSHROUQ_SCHEDULER_SECRET,
          )
        ) {
          console.warn("[alshrouq] scheduler health check rejected: bad or missing secret");
          return json({ error: "unauthorized" }, 401);
        }

        const supabase = serviceClient();
        if (!supabase) return json({ configured: false, due: null }, 200);

        const { isAlShrouqLiveDispatchEnabled } =
          await import("@/lib/shams-crm/alshrouq-dispatch.server");
        const { count } = await (supabase as any)
          .from("alshrouq_dispatches")
          .select("id", { count: "exact", head: true })
          .eq("dispatch_status", "scheduled")
          .is("cancelled_at", null)
          .lte("scheduled_for", new Date().toISOString());

        return json({
          configured: true,
          due: count ?? 0,
          liveDispatchEnabled: isAlShrouqLiveDispatchEnabled(),
        });
      },

      POST: async ({ request }) => {
        if (
          !secretMatches(
            request.headers.get("x-alshrouq-scheduler-secret"),
            process.env.ALSHROUQ_SCHEDULER_SECRET,
          )
        ) {
          /*
           * A rejected caller is the one event that must never be silent.
           *
           * If the vault secret and `ALSHROUQ_SCHEDULER_SECRET` drift apart, the
           * cron job keeps firing and this endpoint keeps refusing it — and
           * scheduled deliveries simply stop happening, with nothing anywhere
           * saying why. That is the same failure mode as the email job that ran
           * 54 times and then stopped unnoticed.
           *
           * Nothing about the credential is logged, including its length.
           */
          console.warn("[alshrouq] scheduler request rejected: bad or missing secret");
          return json({ error: "unauthorized" }, 401);
        }

        const supabase = serviceClient();
        if (!supabase) {
          // Configured to exist but not to work. Distinct from "nothing due".
          console.error(
            "[alshrouq] scheduler not configured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing",
          );
          return json({ error: "not_configured" }, 503);
        }

        const { runDueAlShrouqDispatches } =
          await import("@/lib/shams-crm/alshrouq-scheduler.server");

        try {
          const { isAlShrouqLiveDispatchEnabled } =
            await import("@/lib/shams-crm/alshrouq-dispatch.server");
          const summary = await runDueAlShrouqDispatches(supabase as any);

          /*
           * Counts only. Never a customer, never a credential, never a payload —
           * `RunDueSummary` is six integers and a test asserts nothing else
           * reaches it.
           *
           * The gate is stated rather than inferred: `skippedDisabled` already
           * carries it, but "0 accepted" reads identically whether the gate was
           * shut or there was simply nothing to do, and those are opposite
           * operational facts.
           */
          console.info("[alshrouq] scheduled run", {
            ...summary,
            liveDispatchEnabled: isAlShrouqLiveDispatchEnabled(),
          });
          return json({ ok: true, ...summary });
        } catch (err) {
          console.error("[alshrouq] scheduled run failed:", (err as Error)?.name ?? "unknown");
          return json({ ok: false, error: "run_failed" }, 500);
        }
      },
    },
  },
});
