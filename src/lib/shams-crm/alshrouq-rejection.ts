/**
 * Why AlShrouq refused a delivery, read out of the refusal. Pure, no I/O.
 *
 * ## The gap this closes
 *
 * `createAlshrouqOrder` already classifies a 4xx as `rejected` and already
 * carries the response body — sanitized, credential- and PII-stripped, by
 * `sanitizeResponseBody`. `dispatchOrderToAlShrouq` then threw that body away
 * and returned one fixed sentence, which reached an agent as:
 *
 *     AlShrouq refused the delivery. No courier was sent.
 *
 * True, and useless. The CRM had said *why* — a validation failure, an
 * unrecognised branch, a malformed phone number — and the only copy of that
 * answer was discarded inside the function that received it. Nothing was
 * logged and nothing was persisted, so a production refusal could not be
 * diagnosed after the fact by any means short of reproducing it.
 *
 * This module does the one thing that was missing: it turns a refusal body into
 * a short sentence, so the reason can be shown to the agent looking at the
 * order and written to the log an operator reads later.
 *
 * ## Why it guesses at the shape
 *
 * The create endpoint's **error** shape has never been captured — the same
 * reason `alshrouq-create.server.ts` refuses to type its success body. So this
 * reads the shapes an HTTP JSON API actually uses, in order, and returns `null`
 * when it recognises none. `null` is a real answer: the caller falls back to the
 * generic sentence, which is exactly today's behaviour. Nothing here can make
 * the message *worse* than it currently is, and it cannot invent a reason —
 * every string it returns was read out of the response.
 *
 * `detail` is checked first and handled in both its forms because the CRM
 * presents as a FastAPI application (`POST /login`, `X-Session-Token`, the
 * `detail` convention), and FastAPI reports request-validation failures as
 * `{"detail": [{"loc": [...], "msg": "..."}]}` — the single most likely shape
 * behind a 4xx on a create.
 *
 * ## What it will not do
 *
 * It does not read `token`, `password`, `session` or any other key
 * `sanitizeResponseBody` has already replaced with `"[redacted]"`, and it skips
 * that marker wherever it appears rather than reporting it as a reason. The
 * output is length-capped, because it is destined for a toast and a log line
 * and neither should be able to receive a paragraph.
 */

/** As much of a refusal as is worth putting in front of a person. */
const MAX_REASON = 240;

/** What `sanitizeResponseBody` leaves behind. Never a reason. */
const REDACTED = "[redacted]";

/** Keys that carry an API's explanation, most specific first. */
const MESSAGE_KEYS = ["detail", "message", "error", "error_message", "msg", "reason"] as const;

/** Keys that carry a machine-readable code worth quoting alongside the sentence. */
const CODE_KEYS = ["code", "error_code", "status_code"] as const;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === REDACTED) return null;
  return trimmed.length > MAX_REASON ? `${trimmed.slice(0, MAX_REASON)}…` : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One entry of a validation list, as `{loc, msg}` or as a bare string.
 *
 * The field path is kept when there is one: "customer_phone: invalid format"
 * is a fix an agent can act on, where "invalid format" alone is not.
 */
function readValidationEntry(entry: unknown): string | null {
  if (typeof entry === "string") return clean(entry);
  if (!isRecord(entry)) return null;

  const msg = clean(entry.msg) ?? clean(entry.message) ?? clean(entry.detail);
  if (!msg) return null;

  // `loc` is FastAPI's path to the offending value — `["body", "customer_phone"]`.
  // The last segment is the field; the leading "body" tells an agent nothing.
  const loc = Array.isArray(entry.loc)
    ? entry.loc.filter((p): p is string => typeof p === "string" && p !== "body")
    : [];
  const field = loc.length > 0 ? loc[loc.length - 1] : clean(entry.field);
  return field ? `${field}: ${msg}` : msg;
}

/** Several validation failures, joined. Capped so one bad request is one line. */
function readValidationList(list: readonly unknown[]): string | null {
  const parts = list.map(readValidationEntry).filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  const joined = parts.slice(0, 3).join("; ");
  const rest = parts.length > 3 ? ` (+${parts.length - 3} more)` : "";
  const text = `${joined}${rest}`;
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
}

/**
 * The reason a refusal gives, or `null` when it gives none this recognises.
 *
 * Takes `unknown` rather than the transport's `JsonValue` on purpose: this
 * module is pure and must stay importable from anywhere, including a test that
 * has no server modules loaded.
 */
export function readAlshrouqRejectionReason(body: unknown): string | null {
  if (body === null || body === undefined) return null;

  // A body that is simply a string is its own reason.
  const direct = clean(body);
  if (direct) return direct;

  if (Array.isArray(body)) return readValidationList(body);
  if (!isRecord(body)) return null;

  for (const key of MESSAGE_KEYS) {
    const value = body[key];
    if (Array.isArray(value)) {
      const list = readValidationList(value);
      if (list) return list;
      continue;
    }
    // A nested object under `error` is common: `{error: {message: "..."}}`.
    if (isRecord(value)) {
      const nested = readAlshrouqRejectionReason(value);
      if (nested) return nested;
      continue;
    }
    const text = clean(value);
    if (text) return text;
  }

  // `{errors: {customer_phone: ["invalid"]}}` — the field-keyed form.
  const errors = body.errors;
  if (isRecord(errors)) {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(errors)) {
      const text = Array.isArray(value)
        ? readValidationList(value)
        : (clean(value) ?? readAlshrouqRejectionReason(value));
      if (text) parts.push(`${field}: ${text}`);
    }
    if (parts.length > 0) return readValidationList(parts);
  }
  if (Array.isArray(errors)) {
    const list = readValidationList(errors);
    if (list) return list;
  }

  return null;
}

/**
 * The `order_activity.action` a refused dispatch writes.
 *
 * Lives in this pure module rather than beside the dispatch service, because
 * the order timeline renders it and must not import a server-only file.
 * `alshrouq-resolution.ts` holds `RESOLUTION_ACTIVITY_ACTION` for the same
 * reason; this is deliberately a *different* action, because an operator's
 * conclusion and the courier's refusal are not the same event and must not read
 * as one on the timeline.
 */
export const REJECTION_ACTIVITY_ACTION = "alshrouq_dispatch_rejected";

/** How many top-level key names are worth keeping from a shape we cannot read. */
const MAX_SHAPE_KEYS = 12;

/**
 * The *shape* of a refusal this module could not read — key names only.
 *
 * The blind spot that remains after everything else here: if the CRM answers
 * with a shape `readAlshrouqRejectionReason` does not recognise, it returns
 * `null` and the body is discarded, and the next incident is diagnosed exactly
 * as badly as this one was. Recording which keys the body carried is enough to
 * teach the parser that shape afterwards, and it is the smallest thing that
 * could be.
 *
 * **Names, never values.** A key name cannot be a customer's phone number or a
 * token; a value can. That is the whole reason this returns keys rather than the
 * body — the body is already sanitized by `sanitizeResponseBody`, but that
 * redacts by *known* key name, and a shape nobody has seen is precisely where an
 * unknown key could carry something personal. Key names are safe under that
 * uncertainty in a way values are not.
 */
export function rejectionBodyShape(body: unknown): string[] {
  if (Array.isArray(body)) return [`[array:${body.length}]`];
  if (!isRecord(body)) return typeof body === "object" ? [] : [`[${typeof body}]`];
  return Object.keys(body).slice(0, MAX_SHAPE_KEYS);
}

/** A machine-readable code from the refusal, when it carries one. */
export function readAlshrouqRejectionCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  for (const key of CODE_KEYS) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    const text = clean(value);
    if (text) return text;
  }
  return null;
}

/**
 * The whole refusal as one sentence, for an agent.
 *
 * Always mentions the HTTP status, because that is the one fact that is always
 * present and it is what an operator quotes when chasing the CRM. The reason is
 * appended when there is one.
 *
 * The leading clause is deliberately unchanged from the sentence this replaces —
 * "AlShrouq refused this order. Nothing was dispatched." — because that part was
 * correct and agents already recognise it. Only the missing half is added.
 */
export function describeAlshrouqRejection(status: number, body: unknown): string {
  const reason = readAlshrouqRejectionReason(body);
  const code = readAlshrouqRejectionCode(body);
  const detail = reason ?? (code ? `code ${code}` : null);

  return detail
    ? `AlShrouq refused this order (${status}): ${detail} Nothing was dispatched.`
    : `AlShrouq refused this order (${status}) and gave no reason. Nothing was dispatched.`;
}
