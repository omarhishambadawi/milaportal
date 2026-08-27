/**
 * AlShrouq connectivity probe (server-only).
 *
 * One question, one request: can this deployment reach the CRM's AlShrouq
 * integration layer, and does its configuration still match the contract we
 * established from the PharmacyCRM Desktop package?
 *
 * `GET /integrations/alshrouq/config` is the only endpoint touched. It is a
 * read: it cannot create, modify or cancel a delivery, which is why it is the
 * first thing built after the previous integration was reverted. The create,
 * refresh and cancel endpoints are deliberately absent from this file.
 *
 * ## Deliberately not here
 *
 * A client, a payload builder, a branch map, a dispatch record, an order. This
 * module is reachable only from the admin diagnostics page and is imported by
 * nothing in the Orders path — the previous integration destabilised order entry
 * by reaching into `orderFormSchema` and `buildOrderPayload`, and the way that
 * does not happen again is for the courier code to have no edge into them at
 * all.
 *
 * ## What crosses this boundary
 *
 * Counts, booleans, an error kind, and the CRM's numeric payment ids. Never the
 * username, the password, the session token, any header, the webhook auth value,
 * or the raw response. `missingSecrets` carries the *names* of configuration the
 * CRM reports as absent — identifiers of what is missing, never a value.
 */

import { crmFetch, isCrmConfigured, ShamsCrmError } from "./client.server";
import type { AlShrouqBranchOption } from "./alshrouq-branches";

/** The one path this module is allowed to call. */
const CONFIG_PATH = "/integrations/alshrouq/config";

/**
 * The payment ids the CRM published on 2026-08-20, as read from the Desktop
 * package's own cached response: 1 COD, 2 SPAN Machine, 3 Paid, 4 AlshrouqPay.
 *
 * Used to *report* whether the live list still matches, never to substitute for
 * it. The list belongs to the CRM; a deployment that adds a fifth method should
 * see `paymentOptionsMatchContract: false` and a new id in `paymentOptionIds`,
 * not have it silently dropped.
 */
const CONTRACT_PAYMENT_IDS = [1, 2, 3, 4] as const;

/** Every field a branch option carried in the verified response. */
const BRANCH_FIELDS = ["id", "internal_code", "branch_name", "label", "covered", "note"] as const;

/** The raw response, named only so the reader below can be typed. Never returned. */
interface RawConfig {
  branch_options?: unknown;
  payment_options?: unknown;
  webhook_url?: unknown;
  webhook_auth_header?: unknown;
  missing_secrets?: unknown;
}

export interface AlShrouqConfigProbe {
  /** Whether this deployment holds Shams CRM credentials at all. */
  configured: boolean;
  /** Whether the authenticated config read completed. Login is implicit in it. */
  request: "success" | "failed" | null;
  /** The CRM's own numeric payment ids, ascending. */
  paymentOptionIds: number[] | null;
  /** Whether those ids are exactly 1, 2, 3, 4. */
  paymentOptionsMatchContract: boolean | null;
  branchOptionCount: number | null;
  coveredBranchCount: number | null;
  /** Whether every branch option carried all six expected fields. */
  branchFieldsComplete: boolean | null;
  /** Presence only. The auth *value* is a secret and never leaves the server. */
  webhookUrlPresent: boolean | null;
  webhookAuthHeaderPresent: boolean | null;
  /** Names of configuration the CRM reports as absent. Identifiers, not values. */
  missingSecrets: string[] | null;
  /** Whether the response satisfied every check above. */
  shapeValid: boolean | null;
  /** `ShamsCrmError.kind` when the read failed, else null. */
  errorKind: string | null;
}

function emptyResult(configured: boolean, errorKind: string | null): AlShrouqConfigProbe {
  return {
    configured,
    request: configured ? "failed" : null,
    paymentOptionIds: null,
    paymentOptionsMatchContract: null,
    branchOptionCount: null,
    coveredBranchCount: null,
    branchFieldsComplete: null,
    webhookUrlPresent: null,
    webhookAuthHeaderPresent: null,
    missingSecrets: null,
    shapeValid: null,
    errorKind,
  };
}

/**
 * Read the AlShrouq configuration once and describe it.
 *
 * A failure is reported, never thrown: this is a diagnostic, and "the CRM
 * refused our credentials" is one of the answers it exists to give.
 */
export async function runAlShrouqConfigProbe(): Promise<AlShrouqConfigProbe> {
  if (!isCrmConfigured()) return emptyResult(false, null);

  let raw: RawConfig;
  try {
    raw = await crmFetch<RawConfig>(CONFIG_PATH);
  } catch (err) {
    return emptyResult(true, err instanceof ShamsCrmError ? err.kind : "unknown");
  }

  const branches = Array.isArray(raw.branch_options) ? (raw.branch_options as unknown[]) : null;
  const payments = Array.isArray(raw.payment_options) ? (raw.payment_options as unknown[]) : null;

  // Ids only, and only the numeric ones — the contract is that `payment_type`
  // goes on the wire as a number, so a non-numeric id is a contract break worth
  // surfacing rather than coercing.
  const paymentOptionIds = payments
    ? payments
        .map((p) => (p as { id?: unknown } | null)?.id)
        .filter((id): id is number => typeof id === "number")
        .sort((a, b) => a - b)
    : null;

  const paymentOptionsMatchContract =
    paymentOptionIds === null
      ? null
      : paymentOptionIds.length === CONTRACT_PAYMENT_IDS.length &&
        CONTRACT_PAYMENT_IDS.every((id, i) => paymentOptionIds[i] === id);

  const branchOptionCount = branches?.length ?? null;
  const coveredBranchCount = branches
    ? branches.filter((b) => (b as { covered?: unknown } | null)?.covered === true).length
    : null;

  // `note` is legitimately null on a covered branch, so presence of the *key* is
  // what is checked, not truthiness — otherwise 118 healthy branches would read
  // as incomplete.
  const branchFieldsComplete = branches
    ? branches.every(
        (b) =>
          typeof b === "object" &&
          b !== null &&
          BRANCH_FIELDS.every((f) => f in (b as Record<string, unknown>)),
      )
    : null;

  const webhookUrlPresent = typeof raw.webhook_url === "string" && raw.webhook_url.length > 0;
  const webhookAuthHeaderPresent =
    typeof raw.webhook_auth_header === "string" && raw.webhook_auth_header.length > 0;

  const missingSecrets = Array.isArray(raw.missing_secrets)
    ? (raw.missing_secrets as unknown[]).filter((s): s is string => typeof s === "string")
    : null;

  const shapeValid =
    paymentOptionsMatchContract === true &&
    branchFieldsComplete === true &&
    (branchOptionCount ?? 0) > 0 &&
    webhookUrlPresent &&
    webhookAuthHeaderPresent &&
    missingSecrets !== null &&
    missingSecrets.length === 0;

  return {
    configured: true,
    request: "success",
    paymentOptionIds,
    paymentOptionsMatchContract,
    branchOptionCount,
    coveredBranchCount,
    branchFieldsComplete,
    webhookUrlPresent,
    webhookAuthHeaderPresent,
    missingSecrets,
    shapeValid,
    errorKind: null,
  };
}

/* -------------------------------------------------------------------------- */
/* The dispatch options, for the order page                                    */
/* -------------------------------------------------------------------------- */

/** One payment method, as the CRM publishes it. No enum is kept here. */
export interface AlShrouqPaymentOption {
  id: number;
  label: string;
}

export interface AlShrouqDispatchOptions {
  branchOptions: AlShrouqBranchOption[];
  paymentOptions: AlShrouqPaymentOption[];
}

/**
 * Five minutes.
 *
 * The branch list and the payment list change on the CRM's schedule, not ours,
 * and a dispatch dialog opened twice in a minute should not cost two round
 * trips. Short enough that a newly covered branch appears the same shift it was
 * added; long enough that it is not a per-keystroke concern.
 */
const OPTIONS_TTL_MS = 5 * 60_000;

let cached: { at: number; value: AlShrouqDispatchOptions } | null = null;
let inFlight: Promise<AlShrouqDispatchOptions> | null = null;

/** Test seam. Also lets a diagnostics surface force a cold read. */
export function _resetAlShrouqOptionsCache(): void {
  cached = null;
  inFlight = null;
}

function toBranchOptions(raw: unknown): AlShrouqBranchOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    return [
      {
        id: typeof o.id === "string" ? o.id : null,
        internal_code: typeof o.internal_code === "string" ? o.internal_code : null,
        branch_name: typeof o.branch_name === "string" ? o.branch_name : null,
        label: typeof o.label === "string" ? o.label : null,
        covered: o.covered === true,
        note: typeof o.note === "string" ? o.note : null,
      },
    ];
  });
}

function toPaymentOptions(raw: unknown): AlShrouqPaymentOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "number" || !Number.isFinite(o.id)) return [];
    return [{ id: o.id, label: typeof o.label === "string" ? o.label : String(o.id) }];
  });
}

/**
 * The branch and payment lists the dispatch dialog needs.
 *
 * Reads the same `GET /integrations/alshrouq/config` the probe does — one source
 * of truth, one endpoint, no second copy of the mapping anywhere.
 *
 * **Returns two lists and nothing else.** The config body also carries
 * `webhook_auth_value`, which is a secret; it is not read here and cannot reach
 * a caller. Single-flight, so a page that mounts two dialogs pays for one fetch.
 */
export async function fetchAlShrouqDispatchOptions(): Promise<AlShrouqDispatchOptions> {
  if (!isCrmConfigured()) {
    throw new ShamsCrmError(
      "not_configured",
      "The Shams CRM connection is not configured on this deployment.",
    );
  }
  if (cached && Date.now() - cached.at < OPTIONS_TTL_MS) return cached.value;
  if (inFlight) return inFlight;

  inFlight = crmFetch<RawConfig>(CONFIG_PATH)
    .then((raw) => {
      const value: AlShrouqDispatchOptions = {
        branchOptions: toBranchOptions(raw.branch_options),
        paymentOptions: toPaymentOptions(raw.payment_options),
      };
      /*
       * A config with no branches is a malformed config, not a CRM that serves
       * no branches.
       *
       * `toBranchOptions` returns `[]` for a missing key, a non-array, and a
       * list of entries none of which are objects — every way the response can
       * be unusable. Handing that empty list onward makes
       * `resolveAlShrouqBranch` answer `not_in_crm` for every branch there is,
       * and both screens then tell the agent **"This branch is not in
       * AlShrouq's list… Report it to whoever maintains the branch list"** —
       * a confident, false statement about their branch, derived from a
       * response nobody could read.
       *
       * Raised as `malformed` so it travels the path that already exists for an
       * unreadable CRM: both callers catch `ShamsCrmError` and report
       * `optionsError`, so the screens say coverage could not be checked. The
       * live config carries 136 branches; zero is never a real answer.
       *
       * Thrown before the cache is written, so a bad read is never remembered
       * for five minutes.
       */
      if (value.branchOptions.length === 0) {
        throw new ShamsCrmError(
          "malformed",
          "Shams CRM returned no AlShrouq branches, so coverage cannot be determined.",
        );
      }
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
