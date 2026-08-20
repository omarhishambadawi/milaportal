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
  cancel: (localId: string) => `/integrations/alshrouq/orders/${encodeURIComponent(localId)}/cancel`,
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
  customer_address: string;
  payment_type: string;
  details: string;
  customer_lat: number;
  customer_lng: number;
  value: number;
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
  /** The order's display number, prefixed by team. Never agent-editable. */
  clientOrderId: string;
  customerName: string | null | undefined;
  customerPhone: string | null | undefined;
  customerAddress: string | null | undefined;
  paymentType: string | null | undefined;
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
  if (!input.paymentType?.trim()) {
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
    // The CRM's UI has an address field; the Portal has no separate address of
    // its own and does not add a duplicate one, so this carries whatever the
    // order already says about where it is going — usually nothing, in which
    // case the coordinates are the address.
    customer_address: input.customerAddress?.trim() ?? "",
    payment_type: input.paymentType!.trim(),
    details: input.details?.trim() ?? "",
    customer_lat: input.lat as number,
    customer_lng: input.lng as number,
    value: input.value as number,
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
  value: string;
  label: string;
}

export interface AlShrouqConfig {
  /** What the CRM says AlShrouq accepts. Never a hardcoded list. */
  paymentTypes: AlShrouqPaymentOption[];
  defaultPaymentType: string | null;
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
 * Read the payment methods out of whatever shape the config endpoint returns.
 *
 * Tolerant on purpose: the response was not captured, only the fact that the
 * Desktop reads its payment options from it. So several plausible key names and
 * both plausible element shapes — a bare string, or an object with a code and a
 * label — are accepted, and anything unrecognised yields *no* options rather
 * than a fabricated "Cash". An empty list disables dispatch, which is the
 * correct failure: we do not know what AlShrouq accepts, so we do not guess.
 */
export function normalizeAlShrouqConfig(raw: unknown): AlShrouqConfig {
  const root = asRecord(raw);
  const source = Object.keys(asRecord(root["data"])).length > 0 ? asRecord(root["data"]) : root;
  const entries = firstArray(source, [
    "payment_types",
    "payment_methods",
    "payments",
    "paymentTypes",
  ]);

  const seen = new Set<string>();
  const paymentTypes: AlShrouqPaymentOption[] = [];
  for (const entry of entries) {
    let value: string | null = null;
    let label: string | null = null;
    if (typeof entry === "string") {
      value = entry;
    } else {
      const row = asRecord(entry);
      const candidate = row["value"] ?? row["code"] ?? row["id"] ?? row["key"] ?? row["name"];
      if (typeof candidate === "string" || typeof candidate === "number") {
        value = String(candidate);
      }
      const text = row["label"] ?? row["name"] ?? row["title"] ?? row["description"];
      if (typeof text === "string") label = text;
    }
    const key = value?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    paymentTypes.push({ value: key, label: label?.trim() || key });
  }

  const rawDefault = source["default_payment_type"] ?? source["payment_type"];
  const defaultPaymentType =
    typeof rawDefault === "string" && paymentTypes.some((p) => p.value === rawDefault)
      ? rawDefault
      : null;

  return {
    paymentTypes,
    defaultPaymentType,
    defaultPreparationTime: firstNumber(source, [
      "default_preparation_time",
      "preparation_time",
      "preparationTime",
    ]),
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
  /** Verbatim. Not translated, not title-cased, not mapped to an order status. */
  status: string | null;
  statusDetail: string | null;
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
  const order = Object.keys(asRecord(source["order"])).length > 0
    ? asRecord(source["order"])
    : source;

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

  return {
    localId: firstString(order, ["local_id", "id", "order_id", "localId"]),
    status: firstString(order, ["status", "order_status", "state", "delivery_status"]),
    statusDetail: firstString(order, ["status_detail", "status_text", "message", "note"]),
    timeline,
  };
}
