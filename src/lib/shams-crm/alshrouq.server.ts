/**
 * The five AlShrouq calls the CRM makes, and no others.
 *
 * A thin server-only layer over `crmFetch`/`crmSend`: it owns the paths and the
 * timeout, and hands the raw bodies to the pure readers in `./alshrouq.ts`. It
 * deliberately holds no policy — who may dispatch, what a duplicate is, what gets
 * written down — because that belongs to `src/lib/alshrouq.functions.ts`, where
 * the caller's identity is known.
 */

import { crmFetch, crmSend } from "./client.server";
import {
  ALSHROUQ_CREATE_TIMEOUT_MS,
  ALSHROUQ_PATHS,
  normalizeAlShrouqConfig,
  readAlShrouqState,
  type AlShrouqConfig,
  type AlShrouqCreatePayload,
  type AlShrouqOrderState,
} from "./alshrouq";

/** `GET /integrations/alshrouq/config` — the payment methods AlShrouq accepts. */
export async function fetchAlShrouqConfig(): Promise<AlShrouqConfig> {
  return normalizeAlShrouqConfig(await crmFetch<unknown>(ALSHROUQ_PATHS.config));
}

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

/** `GET /integrations/alshrouq/orders/{local_id}/refresh` — ask again. */
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
 * Unused by any Portal surface today and kept for exactly one reason: it is the
 * only endpoint that can answer "did our create actually land?" after a timeout,
 * by looking for our `client_order_id`. Declaring it here keeps that recovery
 * path one function call away instead of a re-derivation of the contract.
 */
export async function fetchAlShrouqHistory(): Promise<unknown> {
  return crmFetch<unknown>(ALSHROUQ_PATHS.history);
}
