/**
 * Reconciles the two names every Supabase value travels under.
 *
 * Lovable Cloud's Supabase connection injects the `VITE_`-prefixed names, because
 * that is what its generated client reads via `import.meta.env`. This repo's own
 * server code — the auth middleware, the MCP tools, the public CDR route — reads
 * the unprefixed names off `process.env` instead (see .env.example). Locally that
 * works because `.env` defines both sets by hand; in an environment where only one
 * set is present, every server-side reader throws "Missing Supabase environment
 * variable(s)" even though the value is right there under the other name.
 *
 * So: fill each gap from whichever side has the value. `src/lib/security-headers.ts`
 * already reads both names for exactly this reason; this generalizes it rather than
 * repeating the fallback at each call site — which matters because the files that
 * need it most (`client.ts`, `client.server.ts`, `auth-middleware.ts`) are generated
 * and would lose any edit on the next regeneration.
 *
 * Only browser-safe values are bridged. SUPABASE_SERVICE_ROLE_KEY bypasses RLS and
 * is deliberately absent from the list: a `VITE_`-prefixed service role key would be
 * inlined into the public bundle, so if one ever appears it must NOT be honoured.
 */

/** Values safe to carry across the VITE_ boundary in either direction. */
const BRIDGED_KEYS = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PROJECT_ID"] as const;

/**
 * Vite only guarantees static replacement for literal `import.meta.env.VITE_X`
 * member access, so the client-inlined values are spelled out rather than looked
 * up dynamically.
 */
function viteEnv(): Record<string, string | undefined> {
  return {
    SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_PROJECT_ID: import.meta.env.VITE_SUPABASE_PROJECT_ID,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return undefined;
}

let hydrated = false;

/**
 * Populates `process.env` with any bridged Supabase value that is missing under one
 * name but present under the other, or supplied only as a Cloudflare Worker binding.
 *
 * Runs once per isolate, before the request reaches the TanStack server entry, so
 * every downstream `process.env.SUPABASE_*` read sees the reconciled values. An
 * ambient `process.env` entry always wins — this fills gaps, it never overrides.
 */
export function hydrateServerEnv(workerEnv?: unknown): void {
  if (hydrated) return;
  hydrated = true;

  if (typeof process === "undefined" || !process.env) return;

  const binding = asRecord(workerEnv);
  const inlined = viteEnv();

  for (const key of BRIDGED_KEYS) {
    if (process.env[key]) continue;

    const resolved = firstString(
      binding?.[key],
      binding?.[`VITE_${key}`],
      process.env[`VITE_${key}`],
      inlined[key],
    );

    if (resolved) process.env[key] = resolved;
  }
}
