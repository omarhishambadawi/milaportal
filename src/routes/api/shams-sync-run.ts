import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

/**
 * The Shams sync worker endpoint.
 *
 * `pg_cron` runs `public.shams_sync_tick()` every minute. That function makes no
 * HTTP request at all unless a run is open or an enabled schedule slot is due
 * and automation is on; when it does, it POSTs here through `net.http_post`
 * carrying the platform's service role key as a Bearer token.
 * This route does the work, because the transport, the session handling, the
 * status normalisation and the timestamp correction are all TypeScript in this
 * Worker; reimplementing any of them in plpgsql would be a second integration to
 * keep in step with the first.
 *
 * The same shape as `api/alshrouq-run-scheduled`, deliberately: a scheduler
 * holds no Supabase session, so it authenticates with a shared credential
 * compared in constant time, and the endpoint is a **no-op when that credential
 * is unset** so an unconfigured deployment cannot be triggered by a guess.
 *
 * `GET` reports state and never triggers anything. A scheduler health check must
 * not be able to start a synchronisation by accident.
 *
 * The service-role client is used because the worker acts as no user: there is
 * no session to carry at one in the morning, and every row it writes is about
 * this deployment's own actions rather than anyone's data.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Length-independent, value-constant comparison.
 *
 * `!==` on a secret leaks its prefix through timing; this compares every byte
 * either way. Duplicated from `api/alshrouq-run-scheduled` rather than shared:
 * six lines, no dependencies, and extracting it would mean editing a live
 * courier-dispatch route for the convenience of a new one.
 */
function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Is this the scheduler?
 *
 * One credential, not two. The AlShrouq route also accepts a hand-maintained
 * `x-alshrouq-scheduler-secret`, and that header is the exact mechanism that
 * failed there: one string held twice, in the vault and in the deployment, kept
 * equal by somebody remembering to. Nobody did, and 5,769 consecutive cron runs
 * reported success while nothing was ever sent.
 *
 * Both halves of the service role key are issued and rotated by the platform, so
 * there is no copy for anyone to forget. Introducing a second secret here would
 * be reintroducing the defect on purpose.
 *
 * It grants no new authority: a caller holding the service role key can already
 * write `shams_sync_runs` directly, and considerably worse.
 */
function isScheduler(request: Request): boolean {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return secretMatches(auth.slice("Bearer ".length).trim(), process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Only the tasks the cron job sends. Anything else is refused.
 *
 * `tick` is the Control Center entry point: evaluate the configured schedule and
 * act on whatever is due. `reconcile` is kept because it is strictly weaker —
 * it cannot start a sync — and remains useful for closing open rows by hand
 * without touching the schedule.
 *
 * `trigger` is deliberately **gone**. It started both kinds unconditionally,
 * ignoring the schedule and the global automation switch, which is no longer a
 * thing this endpoint should be able to do: manual runs now go through the
 * audited, administrator-gated server function instead.
 */
function readTask(body: unknown): "tick" | "reconcile" | null {
  const task = (body as { task?: unknown } | null)?.task;
  return task === "tick" || task === "reconcile" ? task : null;
}

export const Route = createFileRoute("/api/shams-sync-run")({
  server: {
    handlers: {
      /**
       * Health only. Reports whether the endpoint can work and how many runs are
       * currently open — never starts or reconciles one.
       */
      GET: async ({ request }) => {
        if (!isScheduler(request)) {
          console.warn("[shams-sync] health check rejected: bad or missing credential");
          return json({ error: "unauthorized" }, 401);
        }

        const supabase = serviceClient();
        if (!supabase) return json({ configured: false, open: null }, 200);

        const { isSyncConfigured } = await import("@/lib/shams-crm/sync.server");
        const { count } = await (supabase as any)
          .from("shams_sync_runs")
          .select("id", { count: "exact", head: true })
          .in("status", ["triggered", "running"]);

        return json({
          configured: true,
          open: count ?? 0,
          crmConfigured: isSyncConfigured(),
        });
      },

      POST: async ({ request }) => {
        if (!isScheduler(request)) {
          /*
           * A rejected caller is the one event that must never be silent.
           *
           * If the two halves of a credential drift apart, the cron job keeps
           * firing and this endpoint keeps refusing it — and the nightly
           * synchronisation simply stops happening, with nothing anywhere saying
           * why. That is not hypothetical: it is what the AlShrouq scheduler did
           * for days, answering every poll with a 401 nobody was reading.
           *
           * Nothing about the credential is logged, including its length.
           */
          console.warn("[shams-sync] request rejected: bad or missing credential");
          return json({ error: "unauthorized" }, 401);
        }

        const supabase = serviceClient();
        if (!supabase) {
          // Configured to exist but not to work. Distinct from "nothing to do".
          console.error(
            "[shams-sync] not configured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing",
          );
          return json({ error: "not_configured" }, 503);
        }

        const task = readTask(await request.json().catch(() => null));
        if (!task) return json({ error: "bad_task" }, 400);

        try {
          if (task === "tick") {
            const { runShamsSyncTick } = await import("@/lib/shams-crm/sync-scheduler.server");
            const summary = await runShamsSyncTick(supabase as any);
            /*
             * Counts only. Never a run's contents, never a credential — the
             * summary types are integers and one boolean, and a test asserts
             * nothing else reaches them.
             */
            console.info("[shams-sync] tick", summary);
            return json({ ok: true, task, ...summary });
          }

          const { runShamsSyncReconcile } = await import("@/lib/shams-crm/sync-scheduler.server");
          const summary = await runShamsSyncReconcile(supabase as any);
          console.info("[shams-sync] reconcile", summary);
          return json({ ok: true, task, ...summary });
        } catch (err) {
          console.error("[shams-sync] run failed:", (err as Error)?.name ?? "unknown");
          return json({ ok: false, error: "run_failed" }, 500);
        }
      },
    },
  },
});
