import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

/**
 * The daily lead-generation worker endpoint.
 *
 * `pg_cron` runs `public.telesales_generation_tick()` every hour. That function
 * makes no HTTP request at all unless automation is on and the configured hour
 * has arrived in Riyadh; when it does, it POSTs here through `net.http_post`
 * carrying the platform's service role key as a Bearer token.
 *
 * The same shape as `api/shams-sync-run` and `api/alshrouq-run-scheduled`,
 * deliberately — a new scheduling architecture for a third scheduled job would
 * be a third thing to keep in step. The work is here rather than in plpgsql
 * because the date arithmetic, the product matching and the deduplication are
 * all TypeScript, and reimplementing any of them in SQL would mean two
 * definitions of the business rules that could disagree.
 *
 * `GET` reports state and never generates anything: a health check must not be
 * able to create a day's leads by accident.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Length-independent, value-constant comparison.
 *
 * `!==` on a secret leaks its prefix through timing. Duplicated from
 * `api/shams-sync-run` rather than shared: six lines with no dependencies, and
 * extracting it would mean editing two live scheduled routes for the
 * convenience of a third.
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
 * The service role key, not a hand-maintained shared secret. That choice is
 * copied from the Shams sync route along with its reasoning: a second string
 * held in two places and kept equal by somebody remembering to is exactly the
 * mechanism that left the AlShrouq scheduler reporting 5,769 consecutive
 * successes while sending nothing. Both halves of this one are issued and
 * rotated by the platform.
 *
 * It grants no new authority — a caller holding the service role key can already
 * write `telesales_leads` directly, and considerably worse.
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

/** Only the task the cron job sends. Anything else is refused. */
function readTask(body: unknown): "generate" | null {
  return (body as { task?: unknown } | null)?.task === "generate" ? "generate" : null;
}

export const Route = createFileRoute("/api/telesales-generate")({
  server: {
    handlers: {
      /** Health only. Reports whether the endpoint can work and whether
       *  automation is switched on. Never generates. */
      GET: async ({ request }) => {
        if (!isScheduler(request)) {
          console.warn("[telesales] health check rejected: bad or missing credential");
          return json({ error: "unauthorized" }, 401);
        }
        const supabase = serviceClient();
        if (!supabase) return json({ configured: false }, 200);

        const { data } = await (supabase as any)
          .from("telesales_settings")
          .select("automation_enabled,generation_hour")
          .eq("id", true)
          .maybeSingle();

        return json({
          configured: true,
          automationEnabled: Boolean(data?.automation_enabled),
          generationHour: data?.generation_hour ?? null,
        });
      },

      POST: async ({ request }) => {
        if (!isScheduler(request)) {
          /*
           * A rejected caller is the one event that must never be silent.
           *
           * If the two halves of a credential drift apart, the cron job keeps
           * firing, this endpoint keeps refusing it, and the desk simply arrives
           * to an empty queue with nothing anywhere saying why. Nothing about the
           * credential is logged, including its length.
           */
          console.warn("[telesales] request rejected: bad or missing credential");
          return json({ error: "unauthorized" }, 401);
        }

        const supabase = serviceClient();
        if (!supabase) {
          console.error(
            "[telesales] not configured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing",
          );
          return json({ error: "not_configured" }, 503);
        }

        if (!readTask(await request.json().catch(() => null))) {
          return json({ error: "bad_task" }, 400);
        }

        try {
          const { loadSettings, runDailyGeneration } =
            await import("@/lib/telesales/generate.server");

          /*
           * The switch is checked here as well as in the cron function.
           *
           * The SQL tick already refuses to call when automation is off, so this
           * is the second of two guards — and it is the one that holds if
           * somebody ever pokes this endpoint by hand with the service key. The
           * cost of the extra read is one row.
           */
          const settings = await loadSettings(supabase as any);
          if (!settings.automationEnabled) {
            console.info("[telesales] skipped: automation is disabled");
            return json({ ok: true, skipped: "automation_disabled" });
          }

          const runs = await runDailyGeneration(supabase as any, {
            executionSource: "scheduled",
          });

          /*
           * Counts only. Never a lead's contents, never a customer.
           *
           * These logs are read by whoever is on call at seven in the morning,
           * and a patient's name in a Worker log is a disclosure with no
           * operational benefit.
           */
          const summary = runs.map((r) => ({
            leadType: r.leadType,
            anchor: r.anchorDate,
            created: r.created,
            duplicates: r.skippedDuplicate,
            ineligible: r.skippedIneligible,
            errors: r.errors,
          }));
          console.info("[telesales] generation", summary);

          return json({ ok: true, runs: summary });
        } catch (err) {
          console.error("[telesales] generation failed:", (err as Error)?.name ?? "unknown");
          return json({ ok: false, error: "run_failed" }, 500);
        }
      },
    },
  },
});
