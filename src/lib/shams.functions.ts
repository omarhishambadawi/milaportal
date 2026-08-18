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
import type { ShamsCrmOffer } from "@/lib/shams-crm/types";
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

export interface ShamsProductOffersResult {
  ok: boolean;
  offers: ShamsCrmOffer[];
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
    if (!isCrmCatalogAvailable()) return { ok: false, offers: [], error: null };

    try {
      const { getProductOffer } = await import("@/lib/shams-crm/offers.server");
      return { ok: true, offers: await getProductOffer(data.itemCode), error: null };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Forbidden")) throw err;
      const { ShamsCrmError } = await import("@/lib/shams-crm/client.server");
      const kind = err instanceof ShamsCrmError ? err.kind : "unknown";
      // The message is this module's, not the CRM's.
      return { ok: false, offers: [], error: { kind, message: "Offer pricing is unavailable." } };
    }
  });
