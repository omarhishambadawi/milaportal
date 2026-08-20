/**
 * The five AlShrouq calls the CRM makes, and no others.
 *
 * A thin server-only layer over `crmFetch`/`crmSend`: it owns the paths, the
 * timeout and the config cache, and hands the raw bodies to the pure readers in
 * `./alshrouq.ts`. It deliberately holds no policy — who may dispatch, what a
 * duplicate is, what gets written down — because that belongs to
 * `src/lib/alshrouq.functions.ts`, where the caller's identity is known.
 */

import { crmFetch, crmSend } from "./client.server";
import {
  ALSHROUQ_CREATE_TIMEOUT_MS,
  ALSHROUQ_PATHS,
  findByClientOrderId,
  normalizeAlShrouqConfig,
  readAlShrouqState,
  type AlShrouqConfig,
  type AlShrouqCreatePayload,
  type AlShrouqOrderState,
} from "./alshrouq";

/* -------------------------------------------------------------------------- */
/* Config, and why it is cached                                                */
/* -------------------------------------------------------------------------- */

/**
 * The branch mapping and payment list, cached for a few minutes.
 *
 * The mapping is now read live rather than frozen into a migration, so it is on
 * the path of every dispatch and every panel render — without a cache that is
 * one CRM round trip per keystroke-ish interaction. Five minutes is short enough
 * that a branch newly covered by AlShrouq starts working the same shift, and
 * long enough that a busy call centre is not re-fetching 136 branches a minute.
 *
 * Server-side only, and deliberately module-level rather than per-request: it
 * holds no caller identity, so there is nothing in it to leak between users.
 * `webhook_auth_value` never enters it — `normalizeAlShrouqConfig` keeps only
 * the payment and branch lists, so the secret in the CRM's response is dropped
 * where it is read rather than carried around and filtered later.
 */
const CONFIG_TTL_MS = 5 * 60_000;
let configCache: { at: number; value: AlShrouqConfig } | null = null;
/** In-flight de-duplication, so a burst of panels makes one request. */
let configInFlight: Promise<AlShrouqConfig> | null = null;

/** `GET /integrations/alshrouq/config` — the branch mapping and payment methods. */
export async function fetchAlShrouqConfig(): Promise<AlShrouqConfig> {
  const fresh = configCache && Date.now() - configCache.at < CONFIG_TTL_MS;
  if (fresh) return configCache!.value;
  configInFlight ??= (async () => {
    try {
      const value = normalizeAlShrouqConfig(await crmFetch<unknown>(ALSHROUQ_PATHS.config));
      configCache = { at: Date.now(), value };
      return value;
    } finally {
      configInFlight = null;
    }
  })();
  return configInFlight;
}

/** Drop the cache — for tests, and for an explicit re-read after a CRM change. */
export function clearAlShrouqConfigCache(): void {
  configCache = null;
  configInFlight = null;
}

/* -------------------------------------------------------------------------- */
/* The four order calls                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `POST /integrations/alshrouq/orders` — create the delivery.
 *
 * Returns both the parsed state and the raw body: the raw body is persisted so a
 * response we could not fully read is still recoverable later, without a second
 * call to a courier system.
 */
export async function createAlShrouqOrder(
  payload: AlShrouqCreatePayload,
): Promise<{ state: AlShrouqOrderState; raw: unknown }> {
  const raw = await crmSend<unknown>(ALSHROUQ_PATHS.create, {
    body: payload,
    timeoutMs: ALSHROUQ_CREATE_TIMEOUT_MS,
  });
  return { state: readAlShrouqState(raw), raw };
}

/**
 * `GET /integrations/alshrouq/orders/{local_id}/refresh` — ask again.
 *
 * A GET, which is what the Desktop issues and what `crmSend`'s own header note
 * records. It was briefly sent as a POST and the CRM answered `405 Method Not
 * Allowed` — the path exists, the verb did not. Reading a status is a read, so
 * the method matches the meaning; create and cancel remain POSTs.
 */
export async function refreshAlShrouqOrder(
  localId: string,
): Promise<{ state: AlShrouqOrderState; raw: unknown }> {
  const raw = await crmFetch<unknown>(ALSHROUQ_PATHS.refresh(localId));
  return { state: readAlShrouqState(raw), raw };
}

/** `POST /integrations/alshrouq/orders/{local_id}/cancel`. */
export async function cancelAlShrouqOrder(
  localId: string,
): Promise<{ state: AlShrouqOrderState; raw: unknown }> {
  const raw = await crmSend<unknown>(ALSHROUQ_PATHS.cancel(localId));
  return { state: readAlShrouqState(raw), raw };
}

/**
 * `GET /integrations/alshrouq/orders` — the CRM's own dispatch history.
 *
 * The only endpoint that can answer "did our create actually land?" after a
 * timeout, by looking for our `client_order_id`. The date window is inclusive
 * and defaults to today either side, because that is the only window a create
 * we just attempted can fall into.
 */
export async function fetchAlShrouqHistory(
  opts: { fromDate?: string; toDate?: string } = {},
): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    from_date: opts.fromDate ?? today,
    to_date: opts.toDate ?? today,
    include_raw_data: "false",
  });
  return crmFetch<unknown>(`${ALSHROUQ_PATHS.history}?${params.toString()}`);
}

/**
 * Did the CRM already accept this order?
 *
 * Asked only after a create whose result we do not know. A hit means the courier
 * has it and a second POST would be a second delivery; a miss means the request
 * never landed and retrying is safe. Yesterday is included in the window because
 * a create issued just before midnight can be recorded on the other side of it.
 */
export async function findAlShrouqOrderByClientId(
  clientOrderId: string,
): Promise<{ state: AlShrouqOrderState; raw: unknown } | null> {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60_000);
  const raw = await fetchAlShrouqHistory({
    fromDate: yesterday.toISOString().slice(0, 10),
    toDate: today.toISOString().slice(0, 10),
  });
  const state = findByClientOrderId(raw, clientOrderId);
  return state ? { state, raw } : null;
}
