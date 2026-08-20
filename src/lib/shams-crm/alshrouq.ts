/**
 * The AlShrouq contract, as the Shams CRM states it — and nothing more.
 *
 * Pure, browser-safe, and deliberately separate from `alshrouq.server.ts`: the
 * payload shape and the reading of a response are the parts worth pinning with
 * tests, and neither needs a session token to be exercised.
 *
 * ## Where this contract comes from
 *
 * From the PharmacyCRM Desktop package itself — the create endpoint, the eleven
 * payload keys, the `X-Session-Token` header and the 120-second timeout are read
 * off the shipped client, not guessed from AlShrouq's public API. The Portal does
 * **not** call `alshrouqdelivery.com`; it goes through the same
 * `shams-crm.cloud` integration the Desktop uses, so one system owns the courier
 * relationship. See `docs/shams/api-discovery.md` §11.
 *
 * ## What is deliberately *not* here
 *
 * A status vocabulary. The CRM returns a status and (sometimes) a timeline, but
 * the set of names it can return is not established by anything we have
 * verified, so this module carries no mapping from courier status to Portal
 * status and no ordered lifecycle. Statuses are read, stored and displayed
 * verbatim. Inventing "picked_up → on_the_way → delivered" would put words in
 * AlShrouq's mouth and would silently mis-report the one case that matters — a
 * failed delivery whose name we guessed wrong.
 */

import { mapSearchUrl } from "@/lib/geo/maps-url";

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

/** Verified paths, relative to the CRM origin. */
export const ALSHROUQ_PATHS = {
  config: "/integrations/alshrouq/config",
  create: "/integrations/alshrouq/orders",
  history: "/integrations/alshrouq/orders",
  refresh: (localId: string) =>
    `/integrations/alshrouq/orders/${encodeURIComponent(localId)}/refresh`,
  cancel: (localId: string) =>
    `/integrations/alshrouq/orders/${encodeURIComponent(localId)}/cancel`,
} as const;

/**
 * The Desktop's own create timeout. Kept rather than shortened: the CRM is
 * brokering a call to the courier, so the slow case is normal and a Portal that
 * gave up at 30 s would abandon deliveries the Desktop completes.
 */
export const ALSHROUQ_CREATE_TIMEOUT_MS = 120_000;

/* -------------------------------------------------------------------------- */
/* The create payload                                                          */
/* -------------------------------------------------------------------------- */

/** Exactly the keys the CRM sends. Nothing added, nothing renamed. */
export interface AlShrouqCreatePayload {
  branch_id: string;
  client_order_id: string;
  customer_name: string;
  customer_phone: string;
  /**
   * The customer's Google Maps link — **not** a street address.
   *
   * Verified against the CRM's own dispatch history, where every record carries
   * the link the customer sent (`https://www.google.com/maps?q=…`, and short
   * `maps.app.goo.gl/…` links too) alongside the coordinates. The link names the
   * place; the coordinates are what the courier routes to. Sending coordinates
   * here instead would discard the half a human reads.
   */
  customer_address: string;
  /**
   * The CRM's own payment id, as a number.
   *
   * `1` COD, `2` SPAN Machine, `3` Paid, `4` AlshrouqPay — read from
   * `GET /integrations/alshrouq/config`, never hardcoded here. Numeric because
   * that is what the CRM's stored orders hold (`"payment_type": 1`).
   */
  payment_type: number;
  details: string;
  customer_lat: number;
  customer_lng: number;
  /**
   * The order's value, under the CRM's own name for it.
   *
   * `order_value`, not `value`. Read off the Desktop's `_collect_alshrouq_payload`
   * constant table, where the create body's keys appear as one run:
   * `customer_phone, customer_address, customer_lat, customer_lng, order_value,
   * client_order_id`. The CRM's stored orders use the same name, which was the
   * hint that went unread — sending `value` left the create body without a field
   * the CRM requires, and it rejected the request.
   */
  order_value: number;
  /**
   * Minutes the branch needs before collection.
   *
   * Optional here, and that is the honest shape: how the Desktop populates it is
   * not established from anything verified, so the Portal sends it only when it
   * has a value from the CRM's own config or from the dispatching agent, and
   * omits the key entirely otherwise rather than sending a made-up number.
   */
  preparation_time?: number;
}

export interface AlShrouqOrderInput {
  alshrouqBranchId: string | null | undefined;
  /**
   * The order's operational number, bare. Never agent-editable.
   *
   * The CRM's own history holds `"6529"`, `"6527"`, `"06441"` — the number and
   * nothing else. A team-prefixed `CC-6529` is a *display* rendering and would
   * make the Portal's orders unmatchable against the ones the Desktop created.
   */
  clientOrderId: string;
  customerName: string | null | undefined;
  customerPhone: string | null | undefined;
  /** The customer's Google Maps link. See `customer_address` on the payload. */
  mapUrl: string | null | undefined;
  paymentType: number | null | undefined;
  details: string | null | undefined;
  lat: number | null | undefined;
  lng: number | null | undefined;
  value: number | null | undefined;
  preparationTime: number | null | undefined;
}

/** A refusal to send, worded for the agent who has to fix it. */
export type AlShrouqValidationError = { field: keyof AlShrouqOrderInput; message: string };

const KSA_LAT = [15, 33] as const;
const KSA_LNG = [34, 56] as const;

/**
 * Everything wrong with this order, in the order an agent would fix it.
 *
 * The Desktop validates name, phone and branch before creating; this validates
 * those three plus the fields the payload cannot be built without. Coordinates
 * are bounds-checked against Saudi Arabia because a transposed pair — lat and
 * lng swapped — is the one input error that produces a *valid-looking* request
 * and a courier sent to the wrong hemisphere.
 */
export function validateAlShrouqOrder(input: AlShrouqOrderInput): AlShrouqValidationError[] {
  const errors: AlShrouqValidationError[] = [];
  const name = input.customerName?.trim() ?? "";
  const phone = input.customerPhone?.trim() ?? "";

  if (!input.alshrouqBranchId?.trim()) {
    errors.push({
      field: "alshrouqBranchId",
      message: "This branch has no AlShrouq id, so AlShrouq does not cover it.",
    });
  }
  if (name.length < 2) {
    errors.push({ field: "customerName", message: "A customer name is required." });
  }
  // Digits only, because that is all a courier can dial. Length is left to the
  // CRM: it knows which prefixes AlShrouq accepts and this does not.
  if (phone.replace(/\D/g, "").length < 9) {
    errors.push({ field: "customerPhone", message: "A valid customer phone is required." });
  }
  if (typeof input.paymentType !== "number" || !Number.isInteger(input.paymentType)) {
    errors.push({ field: "paymentType", message: "Choose an AlShrouq payment method." });
  }
  if (typeof input.lat !== "number" || !Number.isFinite(input.lat)) {
    errors.push({ field: "lat", message: "A delivery latitude is required." });
  } else if (input.lat < KSA_LAT[0] || input.lat > KSA_LAT[1]) {
    errors.push({ field: "lat", message: "That latitude is outside Saudi Arabia." });
  }
  if (typeof input.lng !== "number" || !Number.isFinite(input.lng)) {
    errors.push({ field: "lng", message: "A delivery longitude is required." });
  } else if (input.lng < KSA_LNG[0] || input.lng > KSA_LNG[1]) {
    errors.push({ field: "lng", message: "That longitude is outside Saudi Arabia." });
  }
  if (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value < 0) {
    errors.push({ field: "value", message: "The order value is required." });
  }
  return errors;
}

/**
 * The request body, built only from a validated order.
 *
 * Throws rather than returning a partial payload: a half-built delivery request
 * has no honest use, and the caller has already been given every reason it
 * cannot be built.
 */
export function buildAlShrouqCreatePayload(input: AlShrouqOrderInput): AlShrouqCreatePayload {
  const errors = validateAlShrouqOrder(input);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join(" "));

  const payload: AlShrouqCreatePayload = {
    branch_id: input.alshrouqBranchId!.trim(),
    client_order_id: input.clientOrderId,
    customer_name: input.customerName!.trim(),
    customer_phone: input.customerPhone!.trim(),
    // Always a link, never blank. The agent's pasted link when there is one —
    // it names the customer's building, which is what a driver actually reads —
    // and a generated pin link when the point was typed as coordinates. The CRM
    // has no record without one, so an empty string here would be the Portal
    // inventing a shape the courier system has never been sent.
    customer_address:
      input.mapUrl?.trim() || mapSearchUrl({ lat: input.lat as number, lng: input.lng as number }),
    payment_type: input.paymentType as number,
    details: input.details?.trim() ?? "",
    customer_lat: input.lat as number,
    customer_lng: input.lng as number,
    order_value: input.value as number,
  };
  if (typeof input.preparationTime === "number" && Number.isFinite(input.preparationTime)) {
    payload.preparation_time = Math.max(0, Math.round(input.preparationTime));
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

export interface AlShrouqPaymentOption {
  /** The CRM's numeric id — what `payment_type` carries. */
  value: number;
  label: string;
}

/**
 * One branch as AlShrouq knows it.
 *
 * `code` is the Shams branch number (`P0111`); `id` is AlShrouq's own
 * identifier. `covered` is the part that matters operationally: the CRM marks
 * branches AlShrouq does not serve, and 18 of them are so marked today.
 */
export interface AlShrouqBranchOption {
  id: string;
  code: string;
  name: string;
  covered: boolean;
  note: string | null;
}

export interface AlShrouqConfig {
  /** What the CRM says AlShrouq accepts. Never a hardcoded list. */
  paymentTypes: AlShrouqPaymentOption[];
  defaultPaymentType: number | null;
  /**
   * The branch mapping, live from the CRM.
   *
   * The single source of truth for Shams code → AlShrouq id. It is deliberately
   * *not* mirrored into a table: the CRM's list already drifts from the shipped
   * workbook by one branch, and a frozen copy is how the previous
   * implementation ended up dispatching 27 branches to the wrong pharmacy.
   */
  branches: AlShrouqBranchOption[];
  /** A default only if the CRM states one; otherwise the agent supplies it. */
  defaultPreparationTime: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstArray(source: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Read the config the CRM actually returns.
 *
 * The shape is verified against a live `GET /integrations/alshrouq/config`
 * captured from the PharmacyCRM Desktop's own cache, so this reads the real key
 * names rather than guessing at plausible ones: `payment_options` and
 * `branch_options`. The previous implementation looked for `payment_types`,
 * which the CRM has never sent — so it found no payment methods and dispatch
 * could never be enabled at all.
 *
 * Anything unreadable yields an empty list rather than a fabricated default. An
 * empty payment list disables dispatch, and an empty branch list makes every
 * branch unmapped; both are refusals, which is the correct failure for an
 * integration that does not know what the courier accepts.
 */
export function normalizeAlShrouqConfig(raw: unknown): AlShrouqConfig {
  const root = asRecord(raw);
  const source = Object.keys(asRecord(root["data"])).length > 0 ? asRecord(root["data"]) : root;

  const paymentTypes: AlShrouqPaymentOption[] = [];
  const seenPayment = new Set<number>();
  for (const entry of firstArray(source, ["payment_options"])) {
    const row = asRecord(entry);
    const id = typeof row["id"] === "string" ? Number(row["id"]) : row["id"];
    if (typeof id !== "number" || !Number.isInteger(id) || seenPayment.has(id)) continue;
    const label = typeof row["label"] === "string" ? row["label"].trim() : "";
    seenPayment.add(id);
    paymentTypes.push({ value: id, label: label || String(id) });
  }

  const branches: AlShrouqBranchOption[] = [];
  const seenBranch = new Set<string>();
  for (const entry of firstArray(source, ["branch_options"])) {
    const row = asRecord(entry);
    const id = row["id"];
    const code = row["internal_code"];
    if (typeof code !== "string" || code.trim() === "") continue;
    if (typeof id !== "string" && typeof id !== "number") continue;
    const key = code.trim();
    if (seenBranch.has(key)) continue;
    seenBranch.add(key);
    branches.push({
      id: String(id).trim(),
      code: key,
      name: typeof row["branch_name"] === "string" ? row["branch_name"] : key,
      // Absent `covered` is treated as covered: the CRM states it on every row
      // today, and defaulting to "not covered" would silently stop dispatching
      // everywhere if the key were ever renamed.
      covered: row["covered"] !== false,
      note: typeof row["note"] === "string" ? row["note"] : null,
    });
  }

  const rawDefault = source["default_payment_type"];
  const defaultCandidate = typeof rawDefault === "string" ? Number(rawDefault) : rawDefault;
  const defaultPaymentType =
    typeof defaultCandidate === "number" && paymentTypes.some((p) => p.value === defaultCandidate)
      ? defaultCandidate
      : null;

  return {
    paymentTypes,
    defaultPaymentType,
    branches,
    defaultPreparationTime: firstNumber(source, ["default_preparation_time", "preparation_time"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a create / refresh response                                        */
/* -------------------------------------------------------------------------- */

export interface AlShrouqTimelineEntry {
  status: string;
  at: string | null;
  note: string | null;
}

export interface AlShrouqOrderState {
  /** The CRM's own reference for this delivery — what refresh and cancel take. */
  localId: string | null;
  /**
   * AlShrouq's own order number, as opposed to the CRM's.
   *
   * `external_order_id` in the verified record (`5648616`). This is the number a
   * supervisor quotes to AlShrouq on the phone; `localId` only means anything to
   * the CRM. Both are kept because neither substitutes for the other.
   */
  externalOrderId: string | null;
  /** Echoed back by the CRM — used to confirm a create actually landed. */
  clientOrderId: string | null;
  /** Verbatim. Not translated, not title-cased, not mapped to an order status. */
  status: string | null;
  statusDetail: string | null;
  /** The customer-facing tracking page, when the CRM returns one. */
  trackingUrl: string | null;
  /** The CRM's own `is_cancelled`, when it states one. */
  cancelled: boolean | null;
  timeline: AlShrouqTimelineEntry[];
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * What the CRM said about a delivery, from a create or a refresh response.
 *
 * Same tolerance as the config reader, for the same reason: the envelope was not
 * captured. Every field is nullable, and a response we cannot read produces a
 * state of all nulls — which the panel renders as "AlShrouq has not reported a
 * status", not as an invented one.
 */
export function readAlShrouqState(raw: unknown): AlShrouqOrderState {
  const root = asRecord(raw);
  const source = Object.keys(asRecord(root["data"])).length > 0 ? asRecord(root["data"]) : root;
  const order =
    Object.keys(asRecord(source["order"])).length > 0 ? asRecord(source["order"]) : source;

  const timelineRows = firstArray(order, ["timeline", "events", "history", "statuses"]).concat(
    firstArray(source, ["timeline", "events", "history", "statuses"]),
  );
  const timeline: AlShrouqTimelineEntry[] = [];
  for (const row of timelineRows) {
    const entry = asRecord(row);
    const status = firstString(entry, ["status", "state", "name", "event"]);
    if (!status) continue;
    timeline.push({
      status,
      at: firstString(entry, ["at", "created_at", "timestamp", "time", "date"]),
      note: firstString(entry, ["note", "message", "detail", "description"]),
    });
  }

  const cancelled = order["is_cancelled"];

  return {
    // `id` first: in the verified record it is the CRM's own row id, which is
    // what the refresh and cancel paths take.
    localId: firstString(order, ["id", "local_id", "order_id", "localId"]),
    externalOrderId: firstString(order, ["external_order_id", "externalOrderId"]),
    clientOrderId: firstString(order, ["client_order_id", "clientOrderId"]),
    // `status_label` first: `status_id` is a bare code ("23") and reads as
    // nothing to an agent, while the label is the courier's own wording.
    status: firstString(order, ["status_label", "status", "order_status", "delivery_status"]),
    statusDetail: firstString(order, [
      "last_tracking_status",
      "status_detail",
      "status_text",
      "message",
    ]),
    trackingUrl: firstString(order, ["tracking_url", "trackingUrl"]),
    cancelled: typeof cancelled === "boolean" ? cancelled : null,
    timeline,
  };
}

/**
 * Find our order in the CRM's dispatch history.
 *
 * The recovery path after an ambiguous create: the POST may have reached the
 * courier before the connection died, so before sending a second one we ask the
 * CRM whether it already knows this `client_order_id`. Returns the matching
 * record's state, or null when the CRM has never heard of it — which is the only
 * safe basis for trying again.
 */
export function findByClientOrderId(
  raw: unknown,
  clientOrderId: string,
): AlShrouqOrderState | null {
  const root = asRecord(raw);
  const rows = Array.isArray(raw) ? raw : firstArray(root, ["data", "orders", "results", "items"]);
  const wanted = clientOrderId.trim();
  for (const row of rows) {
    const entry = asRecord(row);
    const candidate = firstString(entry, ["client_order_id", "clientOrderId"]);
    // Compared as numbers when both look numeric: the CRM's history holds
    // "06441" for an order the Portal calls "6441", and a string compare would
    // miss it and dispatch a duplicate.
    if (candidate == null) continue;
    const same =
      candidate === wanted ||
      (/^\d+$/.test(candidate) && /^\d+$/.test(wanted) && Number(candidate) === Number(wanted));
    if (same) return readAlShrouqState(entry);
  }
  return null;
}
