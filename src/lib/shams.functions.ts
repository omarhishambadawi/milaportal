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
 * ## Permissions, reused rather than minted
 *
 * `view_orders` for the catalog and `view_invoice_analytics` for sales. Both
 * already exist in `lib/permissions.ts` and in `has_permission()`, and both
 * already mean what is needed: agents who take orders look products up, and the
 * "Invoice Verification" group is exactly the population that reconciles
 * documents. A new permission key would have to be added to the TypeScript
 * source *and* to a SQL migration or `npm run check:permissions` fails — an
 * expensive way to say something the existing keys already say.
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
const invoiceInput = z.object({
  branchCode: z.string().min(1).max(16),
  docNoStart: z.string().min(1).max(12),
  docNoEnd: z.string().max(12).optional(),
  startDate: z.string().max(8).optional(),
  endDate: z.string().max(8).optional(),
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
    await assertPermission(supabase, userId, "view_orders");

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
    await assertPermission(supabase, userId, "view_orders");

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
    await assertPermission(supabase, userId, "view_invoice_analytics");

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

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

export interface ShamsStatusResult {
  ok: boolean;
  configured: boolean;
  /** Whether MIS credentials are present — never their values. */
  credentialsConfigured: boolean;
  /** Result of an actual `auth/login` round trip, when credentials are set. */
  credentialCheck: { ok: boolean; username: string | null; needsPasswordReset: boolean } | null;
  error: ShamsFailure | null;
}

/**
 * Administrator-only connectivity check.
 *
 * The one place `auth/login` is called. It confirms the credentials still work;
 * it does not gate any of the reads above, because the MIS data endpoints do not
 * consult it.
 */
export const shamsStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ShamsStatusResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);

    const { isConfigured } = await import("@/lib/shams/client.server");
    const configured = isConfigured();
    const credentialsConfigured = Boolean(
      process.env.SHAMS_MIS_USERNAME?.trim() && process.env.SHAMS_MIS_PASSWORD,
    );

    if (!configured || !credentialsConfigured) {
      return {
        ok: configured,
        configured,
        credentialsConfigured,
        credentialCheck: null,
        error: null,
      };
    }

    try {
      const { login } = await import("@/lib/shams/client.server");
      const check = await login();
      return {
        ok: true,
        configured,
        credentialsConfigured,
        credentialCheck: check,
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        configured,
        credentialsConfigured,
        credentialCheck: null,
        error: await toFailure(err),
      };
    }
  });
