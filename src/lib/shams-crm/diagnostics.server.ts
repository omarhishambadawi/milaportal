/**
 * Shams CRM smoke test (server-only).
 *
 * Phase 1 built the client; its credentials live only in the deployed runtime,
 * so the only place it can be exercised is inside that runtime. This answers
 * five questions and returns nothing else:
 *
 *   1. is the CRM configured here?
 *   2. does this client still speak the CRM's protocol?
 *   3. does the login flow authenticate?
 *   4. does `GET /products/names` return the catalog, and how many rows?
 *   5. does a second `getCatalog()` reuse the cache?
 *
 * Two and three are separate answers because the CRM answers them separately:
 * it gates `/login` on the declared client version and refuses an out-of-date
 * client with 426 *before* reading the credential. Folding that into `login:
 * "failed"` is what once had this page reporting a protocol break as a
 * rejected password.
 *
 * Cache reuse is decided by the catalog's successful-fetch count, not by
 * reference equality alone. `getCatalog()` serves the previous catalog when a
 * refresh fails, so two identical stale arrays would otherwise read as a cache
 * hit and report green over a broken CRM.
 *
 * Never returned: the username, the password, the session token, any header, any
 * raw response, and any product row. Only counts, a status and an error kind.
 */

import { catalogStatus, getCatalog, refreshCatalog } from "./catalog.server";
import { crmClientVersion, isCrmConfigured, ShamsCrmError } from "./client.server";

export interface CrmSmokeResult {
  configured: boolean;
  /**
   * Whether the CRM accepted this client's declared version. `false` means a
   * 426 — nothing was asked about the credential. `null` means the CRM was not
   * reached at all, so nothing was learned either way.
   */
  compatible: boolean | null;
  /** The version this deployment declares at login. Not a secret. */
  clientVersion: string | null;
  login: "success" | "failed" | null;
  catalogStatus: number | null;
  catalogCount: number | null;
  cacheReused: boolean | null;
  errorKind: string | null;
}

/**
 * One run. Two `getCatalog()` calls, the first forced to be cold.
 *
 * `refreshCatalog()` marks the cache stale first, so the run genuinely exercises
 * the network path rather than reporting on a catalog a previous run left
 * behind — otherwise a warm isolate would return `cacheReused: true` without
 * having proved anything. It costs one ~700 KB download per run, which is the
 * price of the test being real.
 *
 * The session may still be reused from an earlier run — its TTL is separate —
 * and that is fine: a successful authenticated request proves authentication
 * works whether the token was minted now or minutes ago.
 */
export async function runCrmSmokeTest(): Promise<CrmSmokeResult> {
  if (!isCrmConfigured()) {
    return {
      configured: false,
      compatible: null,
      clientVersion: null,
      login: null,
      catalogStatus: null,
      catalogCount: null,
      cacheReused: null,
      errorKind: null,
    };
  }

  try {
    const before = catalogStatus().fetches;
    refreshCatalog();
    const first = await getCatalog();
    const afterFirst = catalogStatus().fetches;

    // `getCatalog` returns the previous catalog when a refresh fails, and says
    // nothing about which happened — so reference identity alone would call two
    // stale results a cache hit and report green over a broken CRM. An
    // unchanged fetch count after a forced refresh means exactly one thing: no
    // fresh rows arrived, and the array in hand is the old one.
    if (afterFirst === before) {
      return {
        configured: true,
        // The request that would have settled this is the one that failed.
        compatible: null,
        clientVersion: crmClientVersion(),
        // Nothing was proved about the credentials either way: the request that
        // would have exercised them is the one that failed.
        login: null,
        // Deliberately not 200. The real status was swallowed by the fallback,
        // and inventing one is what made this diagnostic lie.
        catalogStatus: null,
        catalogCount: null,
        cacheReused: false,
        errorKind: "stale_fallback",
      };
    }

    const second = await getCatalog();
    const afterSecond = catalogStatus().fetches;

    return {
      configured: true,
      // A catalog came back over an authenticated session, so the version gate
      // was passed on the way in.
      compatible: true,
      clientVersion: crmClientVersion(),
      login: "success",
      // Inferred, not observed, and only claimed once a fetch is confirmed:
      // `crmFetch` throws on any non-2xx, so fresh rows imply a 2xx.
      catalogStatus: 200,
      catalogCount: first.length,
      // Both must hold: no second download, and the same array back.
      cacheReused: afterSecond === afterFirst && first === second,
      errorKind: null,
    };
  } catch (err) {
    const kind = err instanceof ShamsCrmError ? err.kind : "unknown";
    return {
      configured: true,
      /*
       * `false` only for the one kind that says so. `null` where the CRM was
       * never reached — a timeout proves nothing about compatibility — and
       * `true` for the rest, because a CRM that got as far as refusing the
       * credential or erroring on the catalog had already accepted the client.
       */
      compatible:
        kind === "incompatible_client"
          ? false
          : kind === "timeout" || kind === "unavailable" || kind === "unknown"
            ? null
            : true,
      clientVersion: crmClientVersion(),
      // Only an auth failure is a *login* failure; a 500 on the catalog is not,
      // and neither is a 426 — that one never reached the credential.
      login: kind === "auth_failed" ? "failed" : null,
      catalogStatus: err instanceof ShamsCrmError ? err.httpStatus : null,
      catalogCount: null,
      cacheReused: null,
      errorKind: kind,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 4 search verification                                                 */
/* -------------------------------------------------------------------------- */

/** Fixed, and fixed on purpose: these are the queries Phase 4 was opened against. */
const SEARCH_QUERIES = ["Mounjaro", "nan", "nan*op", "104*746"];

/** Rows shown back. Enough to recognise a product, not enough to be a catalog. */
const SAMPLE_SIZE = 3;

export interface SearchProbe {
  query: string;
  status: "success" | "failed";
  count: number | null;
  sample: { itemCode: string; itemName: string }[] | null;
  errorKind: string | null;
}

export interface CrmSearchDiagnostics {
  catalogAvailable: boolean;
  queries: SearchProbe[];
  allPassed: boolean;
}

/**
 * The four queries, through the **production** search function.
 *
 * `searchProducts` is imported and called as-is — the same function the Stock
 * page reaches through `shamsSearchProducts`. Reimplementing the matching here
 * would verify the diagnostic instead of the thing being diagnosed, which is the
 * whole reason this exists: local tests run against a 237-row fixture, and the
 * real catalog is 36× larger.
 *
 * Sequential, so the first query fills the CRM catalog cache and the other three
 * read it. No cache is added and none is bypassed; `searchProducts` keeps its own
 * five-minute per-query result cache, so a second run inside that window is
 * answered without rescanning.
 *
 * `allPassed` means every query ran **and** returned at least one row. A search
 * that succeeds and finds nothing is not a pass here — `104*746` finding no
 * product is exactly the kind of result this is meant to surface rather than
 * round up.
 */
export async function runCrmSearchDiagnostic(): Promise<CrmSearchDiagnostics> {
  const catalogAvailable = isCrmConfigured();
  if (!catalogAvailable) {
    return {
      catalogAvailable: false,
      queries: SEARCH_QUERIES.map((query) => ({
        query,
        status: "failed" as const,
        count: null,
        sample: null,
        errorKind: "not_configured",
      })),
      allPassed: false,
    };
  }

  const { searchProducts } = await import("@/lib/shams/catalog.server");
  const queries: SearchProbe[] = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const products = await searchProducts(query);
      queries.push({
        query,
        status: "success",
        count: products.length,
        // Item code and name only. No price, no full result set.
        sample: products.slice(0, SAMPLE_SIZE).map((p) => ({
          itemCode: p.itemCode,
          itemName: p.itemName,
        })),
        errorKind: null,
      });
    } catch (err) {
      queries.push({
        query,
        status: "failed",
        count: null,
        sample: null,
        errorKind: err instanceof ShamsCrmError ? err.kind : "unknown",
      });
    }
  }

  return {
    catalogAvailable,
    queries,
    allPassed: queries.every((q) => q.status === "success" && (q.count ?? 0) > 0),
  };
}
