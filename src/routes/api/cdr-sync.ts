import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

/**
 * Background CDR synchronization trigger.
 *
 * This is the "background" in the synchronization layer: a scheduler (a
 * Cloudflare cron trigger or any external timer) POSTs
 * here on an interval and the layer advances one bounded run. The work itself
 * lives in `cdr-sync.server`; this route is only authorization plus a result.
 *
 * TWO ways in, because they answer different needs:
 *
 *   - `x-cdr-sync-secret`, matching `CDR_SYNC_SECRET`. A scheduler has no
 *     Supabase session, so it cannot use the portal's normal bearer token. The
 *     secret is compared in constant time and the endpoint is a no-op when it is
 *     unset, so an unconfigured deployment cannot be triggered by a guess.
 *   - A Supabase bearer token belonging to an administrator, so the sync can be
 *     kicked and inspected from the diagnostics surface without a shared secret
 *     ever reaching a browser.
 *
 * GET reports state and never triggers anything — a scheduler health check must
 * not be able to start a PBX sweep by accident.
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

/** True when the request carries an administrator's Supabase access token. */
async function isAdminRequest(request: Request): Promise<boolean> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return false;

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return false;

  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) return false;
  // `is_administrator` is the same SECURITY DEFINER oracle every other admin
  // path uses, so this cannot drift from the rest of the authorization model.
  const { data: isAdmin } = await supabase.rpc("is_administrator", {
    _user_id: String(data.claims.sub),
  });
  return !!isAdmin;
}

async function authorize(request: Request): Promise<boolean> {
  if (secretMatches(request.headers.get("x-cdr-sync-secret"), process.env.CDR_SYNC_SECRET)) {
    return true;
  }
  return isAdminRequest(request);
}

export const Route = createFileRoute("/api/cdr-sync")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await authorize(request))) return json({ error: "Unauthorized" }, 401);
        const { readSyncState } = await import("@/lib/yeastar/cdr-store.server");
        const state = await readSyncState();
        // `lastError` can carry PBX or infrastructure detail; this endpoint is
        // administrator-only, which is the same bar the diagnostics page sets.
        return json({ ok: true, state });
      },
      POST: async ({ request }) => {
        if (!(await authorize(request))) return json({ error: "Unauthorized" }, 401);
        const { runCdrSync } = await import("@/lib/yeastar/cdr-sync.server");
        const result = await runCdrSync();
        // 200 even on a failed run: the scheduler's job is to call this on an
        // interval, and a non-2xx would make an unconfigured PBX look like a
        // broken endpoint and trigger retry storms. The outcome is in the body
        // and on `cdr_sync_state`.
        return json(result);
      },
    },
  },
});
