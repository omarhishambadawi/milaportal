import { createFileRoute } from "@tanstack/react-router";

/**
 * The endpoint `pg_cron` calls to send AlShrouq orders whose held time has come.
 *
 * Shaped after `/lovable/email/queue/process`, which is the pattern this project
 * already uses for durable background work: a database job wakes on a schedule
 * and POSTs here with the service_role key as a bearer token. The job itself is
 * registered out of band — see the post-migration note in
 * `20260820220000_alshrouq_scheduling_and_historical.sql` — because it needs the
 * project URL and the key, neither of which belongs in a migration.
 *
 * Until that job exists this route is never called, and a scheduled order simply
 * stays held. Nothing dispatches early either way.
 */
export const Route = createFileRoute("/api/alshrouq/run-scheduled")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
        if (!serviceKey) {
          console.error("[alshrouq] scheduled sweep: no service role key configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        /**
         * The same bearer check the email queue uses.
         *
         * This endpoint can create real courier deliveries, so it is not open:
         * only something holding the service_role key — which is the cron job —
         * may ask for a sweep.
         */
        const authHeader = request.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (authHeader.slice("Bearer ".length).trim() !== serviceKey) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const { runScheduledAlShrouqDispatch } = await import("@/lib/alshrouq/scheduler.server");
          const result = await runScheduledAlShrouqDispatch();
          // Counts and reasons only — never a payload, a token, or a customer.
          return Response.json(result, { status: 200 });
        } catch (e: any) {
          console.error("[alshrouq] scheduled sweep failed", { error: e?.message ?? String(e) });
          return Response.json({ error: "Sweep failed" }, { status: 500 });
        }
      },
    },
  },
});
