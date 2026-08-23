/**
 * Shams Pharmacy MIS server functions.
 *
 * The only way Shams data reaches the browser. Everything below runs on the
 * server, behind `requireSupabaseAuth` and an explicit permission check, and
 * returns a normalized model — the browser never learns the MIS base URL, never
 * sees a raw upstream payload, and never receives an upstream error message.
 *
 * That boundary matters more here than it would for a typical vendor API. The
 * MIS data endpoints perform **no authentication of their own** (see
 * `lib/shams/client.server.ts`), so MilaServ's own gate is the only access
 * control in the path. Nothing in this file is reachable anonymously.
 *
 * ## Permissions — one page-level key
 *
 * `view_shams_mis`, on every handler. This replaces the earlier arrangement of
 * borrowing `view_orders` for the catalog and `view_invoice_analytics` for
 * sales, which had two problems now that the page is an operational tool rather
 * than a milestone: access to Shams could not be granted or revoked without also
 * changing someone's Orders or Invoice Verification rights, and an auditor —
 * who holds both borrowed keys — could not be kept out. One key, declared in
 * `lib/permissions.ts` and in `has_permission()`, says exactly the thing that is
 * meant. `npm run check:permissions` fails if the two ever drift.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  ShamsBranchStock,
  ShamsInvoice,
  ShamsProduct,
  ShamsProductDetail,
} from "@/lib/shams/types";
import type { InvoiceBranchMatch } from "@/lib/shams/types";
import type { ItemAvailability } from "@/lib/shams/availability";
import type { CatalogDiagnostics } from "@/lib/shams/diagnostics.server";
import type { CrmSearchDiagnostics, CrmSmokeResult } from "@/lib/shams-crm/diagnostics.server";
import type {
  AlShrouqConfigProbe,
  AlShrouqDispatchOptions,
  AlShrouqPaymentOption,
} from "@/lib/shams-crm/alshrouq-config.server";
import type { AlShrouqBranchResolution } from "@/lib/shams-crm/alshrouq-branches";
import type { AlShrouqDispatchResult } from "@/lib/shams-crm/alshrouq-dispatch.server";
import type {
  CancelScheduledResult,
  ScheduleResult,
} from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { ResolveDispatchResult } from "@/lib/shams-crm/alshrouq-resolve.server";
import type { AlShrouqLocationResult } from "@/features/alshrouq/location";
import type { AgentSetupSummary } from "@/lib/shams-crm/agent-setup.server";
import type { ShamsCrmOffer, ShamsOfferScope } from "@/lib/shams-crm/types";
import type { ShamsCrmHistory } from "@/lib/shams/types";

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Permission gate.
 *
 * `has_permission` short-circuits to true for owner and admin, so this reads as
 * "holds the permission, or outranks it" without naming roles here.
 */
async function assertPermission(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown }> },
  userId: string,
  permission: string,
): Promise<void> {
  const { data } = await supabase.rpc("has_permission", {
    _user_id: userId,
    _permission: permission,
  });
  if (!data) throw new Error("Forbidden: insufficient permissions");
}

async function assertAdmin(
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  },
  userId: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("is_administrator", { _user_id: userId });
  if (error || !data) throw new Error("Forbidden: administrator access required");
}

/* -------------------------------------------------------------------------- */
/* Error shaping                                                               */
/* -------------------------------------------------------------------------- */

/** The failure shape the browser is allowed to see. */
export interface ShamsFailure {
  kind: string;
  message: string;
}

/**
 * Reduce any thrown value to a safe, user-facing failure.
 *
 * Authorization errors are rethrown so they surface as errors rather than being
 * flattened into an `ok: false` payload a UI might render as "no results".
 * Anything unrecognized becomes a generic message: an unexpected exception can
 * carry a URL or an upstream body, and neither belongs in a browser.
 */
async function toFailure(err: unknown): Promise<ShamsFailure> {
  if (err instanceof Error && err.message.startsWith("Forbidden")) throw err;

  const { ShamsError } = await import("@/lib/shams/client.server");
  const { ShamsQueryError } = await import("@/lib/shams/sales.server");

  if (err instanceof ShamsError) return { kind: err.kind, message: err.message };
  if (err instanceof ShamsQueryError) return { kind: "invalid_query", message: err.message };

  console.warn("[shams] unexpected failure:", (err as Error)?.name ?? "unknown");
  return { kind: "unknown", message: "Shams lookup failed." };
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

const searchInput = z.object({ q: z.string().max(120) });
const itemInput = z.object({ itemCode: z.string().min(1).max(40) });
/**
 * One part of a branch sweep.
 *
 * `parts` is bounded here rather than trusted: it decides how many concurrent
 * sweeps the browser can ask for, and each one costs upstream requests.
 */
const docNoInput = z.object({
  docNo: z.string().min(1).max(12),
  part: z.number().int().min(0).max(7).optional(),
  parts: z.number().int().min(1).max(8).optional(),
});
const invoiceInput = z.object({
  branchCode: z.string().min(1).max(16),
  docNoStart: z.string().min(1).max(12),
  docNoEnd: z.string().max(12).optional(),
  startDate: z.string().max(8).optional(),
  endDate: z.string().max(8).optional(),
});
/**
 * One document at one branch, plus its lines' availability.
 *
 * Deliberately narrower than `invoiceInput`: no range and no date window,
 * because this is the single-document read the Orders panel makes and a bare
 * query is also the only shape `sweptDocuments` can answer from.
 */
const invoiceStockInput = z.object({
  branchCode: z.string().min(1).max(16),
  docNo: z.string().min(1).max(12),
});
/**
 * One page of one customer's history.
 *
 * `mobile` is accepted in whatever form the agent typed and canonicalized
 * server-side — the browser is not trusted to know the wire format, and a
 * rejected number should say so through the same `invalid_query` path as a bad
 * date. `perPage` is bounded here as well as in `crm.server.ts`: this is the
 * boundary the browser actually reaches, and it decides how much of the MIS one
 * call reads.
 */
const crmHistoryInput = z.object({
  mobile: z.string().min(1).max(24),
  fromDate: z.string().length(8),
  toDate: z.string().length(8),
  page: z.number().int().min(1).max(1000).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});
/**
 * Items to check offer coverage for.
 *
 * The `max(12)` is the load-bearing part and it is asserted here as well as in
 * `getOfferScopes`. There is no bulk offers endpoint, so every code in this
 * array is one ~62 KB CRM request: the browser does not get to decide how many
 * of those a single call makes. Anything longer is a rejected request rather
 * than a silently truncated one, so a caller that outgrows the cap finds out.
 */
const offerScopesInput = z.object({
  itemCodes: z.array(z.string().min(1).max(40)).min(1).max(12),
});

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

export interface ShamsSearchResult {
  ok: boolean;
  configured: boolean;
  products: ShamsProduct[];
  error: ShamsFailure | null;
}

export const shamsSearchProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => searchInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsSearchResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isConfigured } = await import("@/lib/shams/client.server");
    if (!isConfigured()) {
      return { ok: false, configured: false, products: [], error: null };
    }

    try {
      const { searchProducts } = await import("@/lib/shams/catalog.server");
      return { ok: true, configured: true, products: await searchProducts(data.q), error: null };
    } catch (err) {
      return { ok: false, configured: true, products: [], error: await toFailure(err) };
    }
  });

export interface ShamsProductResult {
  ok: boolean;
  configured: boolean;
  product: ShamsProductDetail | null;
  stock: ShamsBranchStock[];
  error: ShamsFailure | null;
}

/**
 * One product with its branch availability.
 *
 * Detail and stock are fetched together because that is the pairing a product
 * view needs; search deliberately does not do this per row.
 */
export const shamsGetProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => itemInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsProductResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isConfigured } = await import("@/lib/shams/client.server");
    if (!isConfigured()) {
      return { ok: false, configured: false, product: null, stock: [], error: null };
    }

    try {
      const { getProductWithStock } = await import("@/lib/shams/catalog.server");
      const { product, stock } = await getProductWithStock(data.itemCode);
      return { ok: true, configured: true, product, stock, error: null };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        product: null,
        stock: [],
        error: await toFailure(err),
      };
    }
  });

/* -------------------------------------------------------------------------- */
/* Sales                                                                       */
/* -------------------------------------------------------------------------- */

export interface ShamsInvoiceResult {
  ok: boolean;
  configured: boolean;
  invoices: ShamsInvoice[];
  error: ShamsFailure | null;
}

/**
 * Invoice lookup.
 *
 * Gated on `view_invoice_analytics` rather than `view_orders`: the normalized
 * document carries `totalCost` and `profit`, which is margin data and a
 * narrower audience than product availability.
 */
export const shamsGetInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => invoiceInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsInvoiceResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isConfigured } = await import("@/lib/shams/client.server");
    if (!isConfigured()) {
      return { ok: false, configured: false, invoices: [], error: null };
    }

    try {
      const { getInvoices } = await import("@/lib/shams/sales.server");
      const invoices = await getInvoices({
        branchCode: data.branchCode,
        docNoStart: data.docNoStart,
        docNoEnd: data.docNoEnd,
        startDate: data.startDate,
        endDate: data.endDate,
      });
      return { ok: true, configured: true, invoices, error: null };
    } catch (err) {
      return { ok: false, configured: true, invoices: [], error: await toFailure(err) };
    }
  });

export interface ShamsInvoiceStockResult {
  ok: boolean;
  configured: boolean;
  /**
   * The document at this branch, or `null` when the branch does not hold it.
   *
   * `null` is an answer, not a failure: Shams reports a missing document with
   * `200` and an empty payload, and for the Orders panel that is the meaningful
   * "this number is not at the branch on the order" case.
   */
  invoice: ShamsInvoice | null;
  /** Per-line availability at that branch. Empty when there is no document. */
  items: ItemAvailability[];
  /** True when stock was not asked for at all — no document, or no item codes. */
  stockSkipped: boolean;
  error: ShamsFailure | null;
}

/**
 * One document at one branch, with what that branch still holds of each line.
 *
 * This is the Order → Invoice → Branch → Stock step, and it is one server call
 * on purpose. The two halves are chained (the item codes come out of the
 * document) so splitting them would cost the browser a second round trip to
 * learn something the server already knew, and both halves read caches that
 * live *here*: `getInvoices` answers from `sweptDocuments` when discovery has
 * already fetched this document — the common case, since the Orders panel calls
 * this straight after a branch is confirmed — and `getStockForItems` answers
 * from the same 60 s stock cache the Branch Stock tab fills.
 *
 * A stock failure never costs the caller the document: `getStockForItems`
 * reports per-item omissions rather than throwing, and those render as
 * `unknown`. Only the document lookup can fail this call.
 */
export const shamsGetInvoiceStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => invoiceStockInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsInvoiceStockResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isConfigured } = await import("@/lib/shams/client.server");
    if (!isConfigured()) {
      return {
        ok: false,
        configured: false,
        invoice: null,
        items: [],
        stockSkipped: true,
        error: null,
      };
    }

    try {
      const { getInvoices } = await import("@/lib/shams/sales.server");
      const invoices = await getInvoices({
        branchCode: data.branchCode,
        docNoStart: data.docNo,
      });
      const invoice = invoices[0] ?? null;
      if (!invoice) {
        return {
          ok: true,
          configured: true,
          invoice: null,
          items: [],
          stockSkipped: true,
          error: null,
        };
      }

      const { invoiceItemCodes, resolveItemAvailability } =
        await import("@/lib/shams/availability");
      const codes = invoiceItemCodes(invoice.items);
      if (codes.length === 0) {
        // A document with no item lines has nothing to ask stock about. Saying
        // so beats sending a request that can only come back empty.
        return {
          ok: true,
          configured: true,
          invoice,
          items: resolveItemAvailability(invoice.items, new Map(), data.branchCode),
          stockSkipped: true,
          error: null,
        };
      }

      const { getStockForItems } = await import("@/lib/shams/catalog.server");
      const stockByCode = await getStockForItems(codes);
      return {
        ok: true,
        configured: true,
        invoice,
        items: resolveItemAvailability(invoice.items, stockByCode, data.branchCode),
        stockSkipped: false,
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        invoice: null,
        items: [],
        stockSkipped: true,
        error: await toFailure(err),
      };
    }
  });

export interface ShamsInvoiceBranchesResult {
  ok: boolean;
  configured: boolean;
  /** Branches Shams actually returned this document for. */
  matches: InvoiceBranchMatch[];
  /** How many branches were asked, so the UI can say "searched N branches". */
  probed: number;
  error: ShamsFailure | null;
}

/**
 * Which branches hold a given document number?
 *
 * The MIS has no cross-branch lookup — `sales/details` takes exactly one
 * `wh_cd` — so this asks each branch in turn (bounded concurrency, server-side).
 * The candidate list is MilaServ's own branch directory, which discovery
 * established shares an identifier space with Shams `Whouse`; a branch reaches
 * the result only because Shams returned a document for it, never because the
 * portal knows the branch exists.
 *
 * Deliberately not exposed as a per-keystroke search: one call is one sweep of
 * the chain, and it runs when an agent submits.
 */
export const shamsFindInvoiceBranches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => docNoInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsInvoiceBranchesResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isConfigured } = await import("@/lib/shams/client.server");
    if (!isConfigured()) {
      return { ok: false, configured: false, matches: [], probed: 0, error: null };
    }

    try {
      const { data: rows } = await supabase.from("branches").select("branch_no").order("branch_no");
      const branchCodes = ((rows ?? []) as { branch_no: string }[]).map((b) => b.branch_no);

      const { findInvoiceBranches } = await import("@/lib/shams/sales.server");
      const { matches, probed } = await findInvoiceBranches(data.docNo, branchCodes, {
        part: data.part,
        parts: data.parts,
      });
      return { ok: true, configured: true, matches, probed, error: null };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        matches: [],
        probed: 0,
        error: await toFailure(err),
      };
    }
  });

/* -------------------------------------------------------------------------- */
/* CRM — customer sales history                                                */
/* -------------------------------------------------------------------------- */

export interface ShamsCustomerHistoryResult {
  ok: boolean;
  configured: boolean;
  /** `null` for a failure *and* for a number that matched nobody. */
  history: ShamsCrmHistory | null;
  error: ShamsFailure | null;
}

/**
 * One page of a customer's purchase history, by mobile number.
 *
 * Note which CRM this is. The portal talks to two systems whose names collide:
 * `lib/shams-crm/*` is PharmacyCRM at `shams-crm.cloud`, which supplies the
 * product catalog and offer pricing, while this is the MIS's own
 * `/api/v2/crm/data` — the loyalty and purchase-history endpoint on the same
 * host as `sales/details`. They share no transport, no credentials and no
 * types.
 *
 * ## Access
 *
 * `view_shams_mis`, the page-level key every other handler in this file uses.
 * That is a deliberate choice rather than an oversight: this endpoint returns
 * more identifiable data than any other read here — a name, a mobile number and
 * a purchase history — and the case for a narrower key is real. It is not made
 * here because a new permission is a migration plus a `has_permission()` change
 * plus the parity script, and inventing one that only the frontend enforces
 * would be worse than reusing the one the server already checks. See
 * `docs/shams/api-discovery.md` §6.
 *
 * ## Why one page per call
 *
 * Paging is the API's, and it stays the API's. Fetching every page server-side
 * to hand the browser one array would turn an agent's first search into an
 * unbounded number of upstream requests for a history they will read the first
 * screen of.
 */
export const shamsGetCustomerHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => crmHistoryInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsCustomerHistoryResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isConfigured } = await import("@/lib/shams/client.server");
    if (!isConfigured()) {
      return { ok: false, configured: false, history: null, error: null };
    }

    try {
      const { getCustomerHistory } = await import("@/lib/shams/crm.server");
      const history = await getCustomerHistory({
        mobile: data.mobile,
        fromDate: data.fromDate,
        toDate: data.toDate,
        page: data.page,
        perPage: data.perPage,
      });
      return { ok: true, configured: true, history, error: null };
    } catch (err) {
      return { ok: false, configured: true, history: null, error: await toFailure(err) };
    }
  });

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

export interface ShamsStatusResult {
  ok: boolean;
  /** Base URL + account identifier + API key all present — never their values. */
  configured: boolean;
  /** Result of a real `auth/token` exchange. Carries no token. */
  auth: { ok: boolean; tokenType: string; expiresInSec: number | null } | null;
  error: ShamsFailure | null;
}

/**
 * Administrator-only connectivity check.
 *
 * Exercises the exact credential path every read depends on: it forces a fresh
 * `auth/token` exchange rather than reporting on a cached token, so a pass here
 * means the API credentials genuinely work right now. It returns the token's
 * lifetime and type — never the identifier, the key, or the token itself.
 */
export const shamsStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ShamsStatusResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);

    const { isConfigured } = await import("@/lib/shams/client.server");
    const configured = isConfigured();

    if (!configured) {
      return { ok: false, configured, auth: null, error: null };
    }

    try {
      const { checkAuth } = await import("@/lib/shams/client.server");
      return { ok: true, configured, auth: await checkAuth(), error: null };
    } catch (err) {
      return { ok: false, configured, auth: null, error: await toFailure(err) };
    }
  });

export interface ShamsDiagnosticsResult {
  ok: boolean;
  configured: boolean;
  report: CatalogDiagnostics | null;
  error: ShamsFailure | null;
}

/**
 * Administrator-only catalog diagnostics.
 *
 * Answers the three questions in `scripts/shams-catalog-probe.mjs` from inside
 * the deployment, because the MIS credentials live in this runtime and nowhere
 * else. Same gate as `shamsStatus` — `assertAdmin`, not `view_shams_mis` — since
 * this spends ~20 requests against a third-party production API.
 *
 * Returns shapes and counts only; see `diagnostics.server.ts` for what is
 * deliberately left out.
 */
export const shamsCatalogDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ShamsDiagnosticsResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);

    const { isConfigured } = await import("@/lib/shams/client.server");
    const configured = isConfigured();
    if (!configured) return { ok: false, configured, report: null, error: null };

    try {
      const { runCatalogDiagnostics } = await import("@/lib/shams/diagnostics.server");
      return { ok: true, configured, report: await runCatalogDiagnostics(), error: null };
    } catch (err) {
      return { ok: false, configured, report: null, error: await toFailure(err) };
    }
  });

/**
 * Administrator-only Shams CRM smoke test.
 *
 * Same gate as `shamsStatus` and `shamsCatalogDiagnostics` — `assertAdmin`, not
 * `view_shams_mis` — because it authenticates against a second third-party
 * system and downloads its catalog.
 *
 * The result is the closed shape in `diagnostics.server.ts`: counts, a status
 * and an error kind. No credential, token, header or product row crosses this
 * boundary.
 */
export const shamsCrmSmokeTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CrmSmokeResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);

    const { runCrmSmokeTest } = await import("@/lib/shams-crm/diagnostics.server");
    return runCrmSmokeTest();
  });

/**
 * Administrator-only Phase 4 search verification.
 *
 * Runs four fixed queries through the same `searchProducts` the Stock page uses,
 * inside the runtime where the real CRM credentials live — local tests only ever
 * see a 237-row fixture. Same gate as the other Shams diagnostics.
 *
 * Returns item code and name only; never a price, never a full result set.
 */
export const shamsCrmSearchDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CrmSearchDiagnostics> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);

    const { runCrmSearchDiagnostic } = await import("@/lib/shams-crm/diagnostics.server");
    return runCrmSearchDiagnostic();
  });

/**
 * Administrator-only AlShrouq connectivity probe.
 *
 * Same gate as the other CRM diagnostics — `assertAdmin`, not `view_shams_mis`
 * — because it authenticates against the CRM. Narrower than those in what it
 * touches: one `GET /integrations/alshrouq/config`, which is a read and cannot
 * create, modify or cancel a delivery.
 *
 * The result is the closed shape in `alshrouq-config.server.ts`: counts,
 * booleans, the CRM's payment ids and an error kind. No credential, token,
 * header, webhook secret or raw response crosses this boundary.
 */
export const shamsAlshrouqConfigProbe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AlShrouqConfigProbe> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);

    const { runAlShrouqConfigProbe } = await import("@/lib/shams-crm/alshrouq-config.server");
    return runAlShrouqConfigProbe();
  });

/**
 * Send an order to AlShrouq.
 *
 * The browser's only route to a courier, and it is a narrow one: the handler
 * takes an order id plus what the agent typed, re-reads the order server-side,
 * and hands the whole workflow to `dispatchOrderToAlShrouq`. The payload, the
 * endpoint and the transport are never assembled here or in a component.
 *
 * **Authorization is enforced here, independently of the UI** — the same rule
 * the order form uses to decide whether this agent may edit this order. A
 * request that skips the dialog entirely still has to pass it.
 *
 * **There is no way to ask for a live dispatch.** The input carries no such
 * field, and the service reads the gate from the server environment. With
 * `ALSHROUQ_LIVE_DISPATCH_ENABLED` unset, the only outcome that can reach a
 * caller is `prepared` — nothing is sent and nothing is written.
 */
export const alshrouqDispatchOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        orderId: z.string().uuid(),
        customerName: z.string().max(120),
        customerPhone: z.string().max(40),
        paymentType: z.string().max(12),
        mapUrl: z.string().max(2048),
        lat: z.string().max(32),
        lng: z.string().max(32),
        orderValue: z.string().max(32),
        details: z.string().max(500),
        /**
         * When the courier should be called, as a canonical UTC instant.
         *
         * Absent means now. Present and in the future means the dispatch is
         * parked with a frozen snapshot and **nothing is contacted** — the
         * server decides which, from the time itself. There is still no way for
         * a caller to ask for a live send.
         */
        scheduledFor: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }): Promise<ScheduleResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };

    const { data: order, error } = await supabase
      .from("orders")
      .select("id,display_no,branch_no,delivery_type,agent_id")
      .eq("id", data.orderId)
      .maybeSingle();
    if (error || !order) throw new Error("Order not found");

    const { data: canAll } = await supabase.rpc("has_permission", {
      _user_id: userId,
      _permission: "edit_all_orders",
    });
    const { data: canOwn } = await supabase.rpc("has_permission", {
      _user_id: userId,
      _permission: "edit_orders",
    });
    if (!canAll && !(order.agent_id === userId && canOwn)) {
      throw new Error("Forbidden: insufficient permissions");
    }

    const request = {
      orderId: order.id,
      displayNo: order.display_no ?? null,
      branchNo: order.branch_no ?? null,
      // The authenticated caller. Never defaulted to anyone. Records who acted.
      userId,
      /*
       * Whose delivery it is: the order's assigned agent, from the row this
       * handler already read — never from the request body.
       *
       * The CRM stamps `created_by` from the session, so this is what decides
       * the name on the delivery. It is `agent_id` and not `userId` because a
       * supervisor or administrator may hand an order over on an agent's
       * behalf: they hold `edit_all_orders`, they have no Shams CRM account of
       * their own, and the delivery belongs to the agent servicing it. For an
       * agent dispatching their own order the two are the same value, so
       * nothing changes for the ordinary case.
       *
       * The caller cannot choose it. Reaching this line at all means passing the
       * permission check above, which admits only `edit_all_orders` or ownership
       * of this order — so the identity available to a caller is exactly the one
       * the order is already assigned to.
       */
      orderAgentId: (order.agent_id as string | null) ?? null,
      form: {
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        paymentType: data.paymentType,
        mapUrl: data.mapUrl,
        lat: data.lat,
        lng: data.lng,
        orderValue: data.orderValue,
        details: data.details,
      },
    };

    /*
     * Which path, decided here from the time rather than by the caller.
     *
     * A time still ahead parks the dispatch: the snapshot is frozen, the row is
     * written `scheduled`, and no courier is contacted. Anything else goes
     * through the immediate path, which still stops at the safety gate. The
     * comparison is against the server's clock, so a browser with a wrong clock
     * cannot turn a scheduled delivery into an immediate one.
     */
    /*
     * The dispatch write goes through the service-role client, not the caller's.
     *
     * `alshrouq_dispatches` carries exactly one RLS policy — `SELECT`, for
     * `authenticated` — and none for `INSERT`, `UPDATE` or `DELETE`. Under RLS a
     * command with no permissive policy is denied, so the insert this function
     * needs is refused for the caller's own client and no dispatch record would
     * ever be written.
     *
     * **RLS is what blocks it, not the table grant.** Verified against the live
     * database in Phase 10H: `authenticated` and `anon` do in fact hold
     * INSERT/UPDATE/DELETE *grants* on this table, because Supabase grants them
     * by default on new public-schema tables and the migration's `GRANT SELECT`
     * is additive rather than restrictive. The 20260820180000 migration comment
     * claiming there is "no grant" describes the intent, not the outcome. The
     * protection is real either way — and it is the policy, so anyone reasoning
     * about this table should look there.
     *
     * That silence was the danger, not the failure: an uncertain dispatch whose
     * row never lands is an order that still looks sendable. So the writes use
     * `supabaseAdmin`, the same pattern `admin.functions.ts` uses throughout and
     * the same client the scheduled worker already runs on — and, as there, only
     * *after* the permission check above has passed. Authorization is enforced by
     * this handler; RLS is not what is protecting this table's writes, because
     * there are no writes for it to protect.
     *
     * The order read and the permission RPCs above stay on the caller's client,
     * where RLS is exactly what should decide them.
     */
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const scheduledFor = data.scheduledFor ? new Date(data.scheduledFor) : null;
    if (scheduledFor && scheduledFor.getTime() > Date.now()) {
      const { scheduleAlShrouqDispatch } =
        await import("@/lib/shams-crm/alshrouq-scheduler.server");
      return scheduleAlShrouqDispatch(request, scheduledFor, supabaseAdmin);
    }

    const { dispatchOrderToAlShrouq } = await import("@/lib/shams-crm/alshrouq-dispatch.server");
    return dispatchOrderToAlShrouq(request, supabaseAdmin);
  });

/**
 * Call off a scheduled AlShrouq delivery.
 *
 * **It contacts nobody.** There is no transport on this path: a scheduled
 * dispatch has not been sent, so calling it off is a local decision about a
 * request that was never made. This function cannot reach `createAlshrouqOrder`,
 * and there is no branch in it that sends anything.
 *
 * Gated on the same rule as dispatching and as editing the order —
 * `edit_all_orders`, or `edit_orders` on an order the agent owns. Cancelling a
 * delivery an agent could have sent needs no wider ceiling than sending it, and
 * a new permission key would mean a migration plus a parity change for no gain.
 *
 * Only a `scheduled` dispatch can be cancelled. The service refuses every other
 * state and says which one it is in — in particular it will not touch a
 * `processing` row, which a worker may be mid-request on, and will not mark an
 * `indeterminate` one cancelled, because that would free the order's slot on the
 * strength of an outcome nobody has established.
 */
export const alshrouqCancelScheduledDispatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ orderId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }): Promise<CancelScheduledResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };

    // RLS already limits this read to orders the caller may see.
    const { data: order, error } = await supabase
      .from("orders")
      .select("id,agent_id")
      .eq("id", data.orderId)
      .maybeSingle();
    if (error || !order) throw new Error("Order not found");

    const { data: canAll } = await supabase.rpc("has_permission", {
      _user_id: userId,
      _permission: "edit_all_orders",
    });
    const { data: canOwn } = await supabase.rpc("has_permission", {
      _user_id: userId,
      _permission: "edit_orders",
    });
    if (!canAll && !(order.agent_id === userId && canOwn)) {
      throw new Error("Forbidden: insufficient permissions");
    }

    // The write, like every other write to this table, runs as the service role
    // after this handler has decided the caller may make it. See the note in
    // `alshrouqDispatchOrder`.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { cancelScheduledAlShrouqDispatch } =
      await import("@/lib/shams-crm/alshrouq-scheduler.server");

    // The actor is the verified session's subject, never anything the caller
    // sent — the validator above accepts an order id and nothing else.
    return cancelScheduledAlShrouqDispatch(data.orderId, userId, supabaseAdmin);
  });

/**
 * Record what an operator established about a stuck dispatch.
 *
 * **It contacts nobody.** `alshrouq-resolve.server.ts` has no transport, and no
 * outcome — including "confirmed not delivered" — has a branch that sends
 * anything. This is reconciliation after a human rang the courier, never a
 * resend. An `indeterminate` dispatch may already have a driver on the road,
 * which is the whole reason the machine refuses to guess and the whole reason
 * the answer is recorded rather than acted on.
 *
 * **Gated on `admin_access`**, the narrowest existing permission that fits.
 * Resolving a dispatch is a supervisory act, not order editing: it overrides an
 * uncertain courier outcome with a person's judgement, and an agent who may edit
 * their own orders should not be able to declare a delivery settled. `owner`,
 * `admin` and `supervisor` hold it by default; `customer_care`, `telesales` and
 * `auditor` do not. No new permission key, so no migration and no parity change.
 *
 * **The client controls none of the identity.** The input is a dispatch id, an
 * outcome from a fixed set, and a note. `resolved_by` and `resolved_at` are
 * derived here — there is no field through which a browser could attribute a
 * resolution to somebody else, backdate one, or ask for a lifecycle transition.
 */
export const alshrouqResolveDispatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        dispatchId: z.string().uuid(),
        // A closed set, validated here as well as by the database's CHECK.
        outcome: z.enum(["delivered", "not_delivered", "undetermined"]),
        // The evidence. Required: a resolution with no account of how it was
        // reached is an unsourced claim in an audit trail.
        note: z.string().min(3).max(280),
      })
      .parse(d),
  )
  .handler(async ({ context, data }): Promise<ResolveDispatchResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };

    await assertPermission(supabase, userId, "admin_access");

    /*
     * The visibility read runs on the *caller's* client, so the dispatch's own
     * RLS policy — which follows the order's visibility — decides whether this
     * operator may see the row at all. A dispatch they cannot see is reported as
     * absent rather than as forbidden.
     */
    const { data: visible } = await (supabase as any)
      .from("alshrouq_dispatches")
      .select("id")
      .eq("id", data.dispatchId)
      .maybeSingle();
    if (!visible) return { kind: "not_found" };

    // And the write runs as the service role, after the check above — the same
    // pattern as every other write to this table. See `alshrouqDispatchOrder`.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveAlShrouqDispatch } = await import("@/lib/shams-crm/alshrouq-resolve.server");

    return resolveAlShrouqDispatch(
      {
        dispatchId: data.dispatchId,
        outcome: data.outcome,
        note: data.note,
        // The verified session's subject, never anything the caller sent.
        resolvedBy: userId,
      },
      supabaseAdmin,
    );
  });

/**
 * The CRM's AlShrouq branch coverage and payment methods.
 *
 * The order form needs both **before an order exists** — an agent choosing
 * AlShrouq on a new order has to be told straight away whether the branch is
 * served and how the customer will pay — so neither can come through the
 * order-scoped dispatch context, which requires an order id. Same endpoint, same
 * five-minute cache, same single flight: `fetchAlShrouqDispatchOptions` already
 * computed both lists, and this stops the branch half being thrown away.
 *
 * **Coverage is the CRM's answer, not a shipped copy.** `branch_options` is the
 * only list carrying `covered`, the flag marking the branches AlShrouq does not
 * serve; a frozen table in this repository could not express it, which is one of
 * the reasons the reverted integration's copy was wrong to exist.
 *
 * Returns the two lists and nothing else — the config body also carries
 * `webhook_auth_value`, which is a secret and is never read.
 *
 * Gated on `create_orders`: choosing a branch and a payment method is part of
 * taking an order. Reads only; dispatches nothing.
 */
/**
 * The CRM's two option lists, plus whether this deployment can call a courier.
 *
 * A superset rather than a change to `AlShrouqDispatchOptions`: that type is the
 * shape of the CRM's own configuration response, and the safety gate is a fact
 * about *this installation*. Merging the gate into it would put a deployment
 * concern inside a description of somebody else's API.
 */
export interface AlShrouqOrderFormOptions extends AlShrouqDispatchOptions {
  /** Read-only, one-way. Nothing a client sends can set it. */
  dispatchAvailable: boolean;
}

export const alshrouqDeliveryOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AlShrouqOrderFormOptions> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "create_orders");

    const { fetchAlShrouqDispatchOptions } = await import("@/lib/shams-crm/alshrouq-config.server");
    // The same one-way report `alshrouqDispatchContext` carries. The create
    // journey has no order id yet, so it cannot ask that function — and it is
    // the journey where the misleading promise was made, so it needs the answer
    // most. Read through the service's accessor, never from `process.env` here.
    const { isAlShrouqLiveDispatchEnabled } =
      await import("@/lib/shams-crm/alshrouq-dispatch.server");
    const dispatchAvailable = isAlShrouqLiveDispatchEnabled();

    try {
      return { ...(await fetchAlShrouqDispatchOptions()), dispatchAvailable };
    } catch {
      // An unreachable CRM leaves the form with no methods to choose and no
      // coverage to report, which blocks the handover — the correct outcome,
      // and better than a guessed list or an assumed "covered".
      return { branchOptions: [], paymentOptions: [], dispatchAvailable };
    }
  });

/**
 * Resolve a customer's Google Maps link to a delivery point.
 *
 * Server-side because it has to be: the shortener sends no CORS headers, so a
 * browser cannot follow `maps.app.goo.gl` at all — and because the authoritative
 * answer must not come from a client that could be asked to report anything.
 *
 * The URL is untrusted input. `resolveMapLink` holds it to an allow-list of
 * Google hosts over HTTPS, re-checked on **every** hop, reads only the
 * `Location` header and never the body, and caps both length and hops. Nothing
 * here can be pointed at an internal address.
 *
 * Gated on `create_orders`: pasting a link is part of taking an order, and this
 * spends an outbound request. It resolves a link and nothing else — it touches
 * no order, writes nothing, and dispatches nothing.
 */
export const alshrouqResolveLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ url: z.string().min(1).max(2048) }).parse(d))
  .handler(async ({ context, data }): Promise<AlShrouqLocationResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "create_orders");

    const { parseMapsUrl, mapUrlLabel } = await import("@/lib/geo/maps-url");
    const { locationFrom } = await import("@/features/alshrouq/location");

    // A link that already carries a point costs no request at all.
    const direct = parseMapsUrl(data.url);
    if (direct.point) {
      return {
        kind: "resolved",
        location: locationFrom(data.url, data.url, direct.point, mapUrlLabel(data.url)),
      };
    }
    if (direct.outOfRange) return { kind: "out_of_range", resolvedUrl: data.url };

    // Not a Maps link, and not a shortener worth following.
    if (!direct.needsResolution) {
      let looksLikeMaps = false;
      try {
        looksLikeMaps = /(^|\.)(google\.[a-z.]+|goo\.gl)$/i.test(new URL(data.url).hostname);
      } catch {
        looksLikeMaps = false;
      }
      if (!looksLikeMaps) return { kind: "unsupported" };
      return { kind: "no_coordinates", resolvedUrl: data.url };
    }

    const { resolveMapLink, ShortLinkError } = await import("@/lib/geo/short-link.server");
    try {
      const resolved = await resolveMapLink(data.url);
      if (resolved.point) {
        return {
          kind: "resolved",
          location: locationFrom(data.url, resolved.url, resolved.point, mapUrlLabel(resolved.url)),
        };
      }
      if (resolved.outOfRange) return { kind: "out_of_range", resolvedUrl: resolved.url };
      // Followed successfully, landed somewhere real, carries no pin. Never
      // reported as resolved: a location without coordinates is not dispatchable.
      return { kind: "no_coordinates", resolvedUrl: resolved.url };
    } catch (err) {
      if (err instanceof ShortLinkError) {
        return err.kind === "not_allowed"
          ? { kind: "unsupported" }
          : { kind: "failed", errorKind: err.kind };
      }
      return { kind: "failed", errorKind: "unavailable" };
    }
  });

/**
 * What the dispatch dialog is told about an order.
 *
 * `prefill` is what the order already knows; the dialog asks only for what is
 * missing. Nothing here is a courier instruction — this is a read.
 */
export interface AlShrouqDispatchContext {
  orderId: string;
  /** `display_no` minus its stored `#`. What the payload's `client_order_id` takes. */
  clientOrderId: string;
  displayNo: string | null;
  team: string | null;
  branchNo: string | null;
  deliveryType: string | null;
  status: string | null;
  branch: AlShrouqBranchResolution;
  paymentOptions: AlShrouqPaymentOption[];
  /** Set when the CRM could not be reached, so the dialog can say so. */
  optionsError: string | null;
  /**
   * Whether a courier can actually be contacted from this deployment.
   *
   * A **report**, never a request field and never a switch. It is computed on
   * the server from the production gate and travels one way, so the screen can
   * stop offering an action it knows will not reach anybody. Nothing the client
   * sends can set it, and `dispatchOrderToAlShrouq` does not consult it — the
   * gate is still read inside that module, from the environment, and remains the
   * only thing that permits a send.
   *
   * The reason it has to exist: with the gate shut an immediate handover returns
   * `prepared` and writes no row, so the card fell back to *"Ready to send"* and
   * the button promised a courier the deployment could not call. That promise is
   * the bug; this is what lets the card tell the truth **before** the agent
   * commits rather than in a toast afterwards.
   */
  dispatchAvailable: boolean;
  prefill: {
    customerName: string;
    customerPhone: string;
    orderValue: string;
    notes: string;
  };
}

/**
 * Everything the dispatch dialog needs about one order, and nothing it doesn't.
 *
 * Gated on the same rule the order form uses to decide whether the agent may
 * edit this order — `edit_all_orders`, or `edit_orders` on an order they own.
 * No new permission: a new key is a migration plus a `has_permission()` change
 * plus a parity update, and dispatching an order the agent may already edit does
 * not need a wider ceiling than editing it.
 *
 * Read-only. It resolves the branch against the CRM's live `branch_options` and
 * reports what the order is missing; it creates nothing and dispatches nothing.
 */
export const alshrouqDispatchContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ orderId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }): Promise<AlShrouqDispatchContext> => {
    const { supabase, userId } = context as { supabase: any; userId: string };

    // RLS already limits this to orders the caller may see; the permission check
    // below is what decides whether they may act on it.
    const { data: order, error } = await supabase
      .from("orders")
      .select(
        "id,display_no,team,branch_no,delivery_type,status,customer_name,customer_phone,invoice_value,notes,agent_id",
      )
      .eq("id", data.orderId)
      .maybeSingle();
    if (error || !order) throw new Error("Order not found");

    const { data: canAll } = await supabase.rpc("has_permission", {
      _user_id: userId,
      _permission: "edit_all_orders",
    });
    const { data: canOwn } = await supabase.rpc("has_permission", {
      _user_id: userId,
      _permission: "edit_orders",
    });
    const owns = order.agent_id === userId;
    if (!canAll && !(owns && canOwn)) throw new Error("Forbidden: insufficient permissions");

    /*
     * The dispatch row is deliberately *not* read here.
     *
     * It used to be, and the card rendered its status from this context while
     * the timeline read the same row through its own query — two reads of one
     * row that could show different things while one of them was stale. The
     * client now reads it once, through `useOrderAlShrouqDispatch`, under the
     * RLS policy that already follows the order's own visibility.
     *
     * Nothing is lost in the way that matters: whether an order may be sent
     * again is not decided by what this context reports. It is decided by
     * `prepareAlShrouqDispatch`'s duplicate check and, behind that, by the
     * unique index `alshrouq_dispatches_live_order_key`.
     */

    const { stripOrderPrefix } = await import("@/lib/branches");
    const { resolveAlShrouqBranch } = await import("@/lib/shams-crm/alshrouq-branches");
    const { fetchAlShrouqDispatchOptions } = await import("@/lib/shams-crm/alshrouq-config.server");
    // Read through the service's own accessor rather than `process.env` here, so
    // the gate keeps exactly one reader and this stays a report of it.
    const { isAlShrouqLiveDispatchEnabled } =
      await import("@/lib/shams-crm/alshrouq-dispatch.server");

    let branch: AlShrouqBranchResolution = { kind: "unknown", reason: "not_in_crm" };
    let paymentOptions: AlShrouqPaymentOption[] = [];
    let optionsError: string | null = null;
    try {
      const options = await fetchAlShrouqDispatchOptions();
      paymentOptions = options.paymentOptions;
      branch = resolveAlShrouqBranch(options.branchOptions, order.branch_no);
    } catch (err) {
      // The CRM being unreachable is not the order's fault, and the dialog says
      // so rather than reporting the branch as uncovered.
      const { ShamsCrmError } = await import("@/lib/shams-crm/client.server");
      optionsError = err instanceof ShamsCrmError ? err.kind : "unknown";
    }

    return {
      orderId: order.id,
      clientOrderId: stripOrderPrefix(String(order.display_no ?? "")),
      displayNo: order.display_no ?? null,
      team: order.team ?? null,
      branchNo: order.branch_no ?? null,
      deliveryType: order.delivery_type ?? null,
      status: order.status ?? null,
      branch,
      paymentOptions,
      optionsError,
      dispatchAvailable: isAlShrouqLiveDispatchEnabled(),
      prefill: {
        customerName: order.customer_name ?? "",
        customerPhone: order.customer_phone ?? "",
        orderValue: order.invoice_value == null ? "" : String(order.invoice_value),
        notes: order.notes ?? "",
      },
    };
  });

/**
 * Populate the per-agent Shams CRM credential store, once.
 *
 * The one caller of the workbook. It verifies every row against the CRM and
 * moves the passwords that pass into Vault; nothing else in the system reads
 * that file, and everything downstream reads Vault.
 *
 * Gated on `manage_users` — the same key that governs creating accounts and
 * resetting passwords, which is what this is: administering other people's
 * credentials. Deliberately not a new permission, which would be a migration, a
 * `has_permission()` change and a parity update for a ceiling that already
 * exists at exactly the right height.
 *
 * Returns counts, agent names and CRM ids. There is no field on
 * `AgentSetupSummary` that could carry a password, so this cannot leak one even
 * if a future caller logs the whole response.
 */
export const shamsCrmSetupAgentLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ dryRun: z.boolean().optional() }).parse(d ?? {}))
  .handler(async ({ context, data }): Promise<AgentSetupSummary> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "manage_users");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { setUpAgentCrmLinks, verifyAgentAgainstCrm } =
      await import("@/lib/shams-crm/agent-setup.server");

    return setUpAgentCrmLinks(
      {
        async loadPortalAgents() {
          // Paginated for the same reason `listAuthEmails` is: one large page
          // silently returns only the first.
          const byEmail = new Map<string, any>();
          for (let page = 1; ; page++) {
            const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({
              page,
              perPage: 200,
            });
            if (error) throw new Error("Could not list MilaPortal users");
            const users = list?.users ?? [];
            for (const u of users) if (u.email) byEmail.set(u.email.toLowerCase(), { id: u.id });
            if (users.length < 200) break;
          }
          const { data: profiles } = await supabaseAdmin
            .from("profiles" as any)
            .select("id,full_name,agent_code");
          const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
          for (const entry of byEmail.values()) Object.assign(entry, byId.get(entry.id) ?? {});
          return byEmail;
        },
        verifyCrm: verifyAgentAgainstCrm,
        async storeSecret(agentId, password) {
          // The function postdates the generated types, which Lovable re-emits
          // — so it is reached through the cast this codebase already uses for
          // such objects, never by hand-editing `types.ts`.
          const { data: key, error } = await (supabaseAdmin as any).rpc(
            "shams_crm_store_agent_secret",
            { _user_id: agentId, _password: password },
          );
          return error || typeof key !== "string" ? null : key;
        },
        async upsertLink(row) {
          const { error } = await supabaseAdmin.from("shams_crm_agent_links" as any).upsert(
            {
              ...row,
              active: true,
              verified_at: new Date().toISOString(),
              last_error: null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" },
          );
          if (!error) return { ok: true as const };
          return { ok: false as const, duplicate: String((error as any).code) === "23505" };
        },
      },
      { dryRun: data.dryRun === true },
    );
  });

export interface ShamsProductOffersResult {
  ok: boolean;
  offers: ShamsCrmOffer[];
  /**
   * How widely the offer applies, from the same response as `offers`.
   *
   * Returned alongside rather than through `shamsGetOfferScopes` so an opened
   * product costs one call, not two — and so the badge on the product header
   * cannot disagree with the per-branch prices underneath it.
   */
  scope: ShamsOfferScope | null;
  error: ShamsFailure | null;
}

/**
 * CRM offer pricing for one opened product.
 *
 * Deliberately its own function rather than another field on `shamsGetProduct`:
 * offers are an optional enhancement, and pairing them with the MIS stock read
 * would let a slow or unhappy CRM delay the stock table an agent came for. The
 * two load independently and the page renders without this one.
 *
 * Same permission as every other product read. Returns only the fields the row
 * renders — never a raw CRM response, never CRM availability.
 */
export const shamsGetProductOffers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => itemInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsProductOffersResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isCrmCatalogAvailable } = await import("@/lib/shams-crm/products.server");
    // Not configured is not an error: the page simply shows no offers.
    if (!isCrmCatalogAvailable()) return { ok: false, offers: [], scope: null, error: null };

    try {
      const { getProductOffer, getProductOfferScope } =
        await import("@/lib/shams-crm/offers.server");
      // Both read the same cached response — one upstream request, two answers.
      const [offers, scope] = await Promise.all([
        getProductOffer(data.itemCode),
        getProductOfferScope(data.itemCode),
      ]);
      return { ok: true, offers, scope, error: null };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Forbidden")) throw err;
      const { ShamsCrmError } = await import("@/lib/shams-crm/client.server");
      const kind = err instanceof ShamsCrmError ? err.kind : "unknown";
      // The message is this module's, not the CRM's.
      return {
        ok: false,
        offers: [],
        scope: null,
        error: { kind, message: "Offer pricing is unavailable." },
      };
    }
  });

export interface ShamsOfferScopesResult {
  ok: boolean;
  /** Only the items that were actually answered for. */
  scopes: ShamsOfferScope[];
  error: ShamsFailure | null;
}

/**
 * Offer coverage for a set of items, in one call.
 *
 * This exists so an agent can see *from the result list* whether a product is
 * on offer, without opening it — and it is capped rather than open-ended,
 * because there is no bulk offers endpoint. Each item is its own ~62 KB CRM
 * request, so the cap in `getOfferScopes` is what stops a badge on every row
 * from turning one search into a hundred upstream reads.
 *
 * One browser request regardless of how many items are asked about. The fan-out,
 * its concurrency limit and its cache all live server-side, next to the CRM
 * client that owns them.
 *
 * Items the CRM could not answer for are **absent** from `scopes` rather than
 * reported as having no offer. The distinction is the point: the caller renders
 * a missing entry as "not checked".
 */
export const shamsGetOfferScopes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => offerScopesInput.parse(d))
  .handler(async ({ context, data }): Promise<ShamsOfferScopesResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "view_shams_mis");

    const { isCrmCatalogAvailable } = await import("@/lib/shams-crm/products.server");
    // Not configured is not an error: the list simply shows no offer badges.
    if (!isCrmCatalogAvailable()) return { ok: false, scopes: [], error: null };

    try {
      const { getOfferScopes } = await import("@/lib/shams-crm/offers.server");
      return { ok: true, scopes: await getOfferScopes(data.itemCodes), error: null };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Forbidden")) throw err;
      const { ShamsCrmError } = await import("@/lib/shams-crm/client.server");
      const kind = err instanceof ShamsCrmError ? err.kind : "unknown";
      return { ok: false, scopes: [], error: { kind, message: "Offer pricing is unavailable." } };
    }
  });
