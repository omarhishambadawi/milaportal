/**
 * The CRM catalog, as Portal products (server-only).
 *
 * The seam between the Shams CRM integration and the Portal's own product layer.
 * Everything upstream of this file — login, session, the 700 KB download, the
 * six-hour cache, the stale-fallback rule — is Phase 1 and is reused unchanged.
 * Everything downstream consumes `ShamsProduct`, the type the Portal already
 * uses everywhere.
 *
 * ## There is deliberately no field mapping
 *
 * `ShamsCrmProduct` and `ShamsProduct` are the same three fields with the same
 * types — `itemCode`, `itemName`, `retailPrice` — so an adapter would be a
 * function that renames nothing and copies 8 484 objects for no reason. The
 * conversion is a type assertion at the boundary and nothing else.
 *
 * That is a coupling worth stating once, here, rather than discovering later: if
 * either shape gains a field the other lacks, this is the file that stops
 * compiling, and the adapter belongs here when it does.
 *
 * ## What this is not
 *
 * Not search. No matching, ranking, normalization or filtering happens here —
 * those arrive with the search phase and will consume this. The MIS catalog in
 * `src/lib/shams/catalog.server.ts` is untouched and remains the source for
 * everything the Stock page does today.
 */

import type { ShamsProduct } from "@/lib/shams/types";
import { getCatalog } from "./catalog.server";
import { isCrmConfigured } from "./client.server";

/**
 * Is the CRM catalog usable on this deployment?
 *
 * Configuration only — it makes no request and proves nothing about whether the
 * credentials still work. It exists so a caller can decide whether to reach for
 * the CRM at all without paying an exception to find out, mirroring
 * `isConfigured()` on the MIS side.
 */
export function isCrmCatalogAvailable(): boolean {
  return isCrmConfigured();
}

/**
 * Every product in the CRM catalog, typed for the Portal.
 *
 * **`readonly`, and that is load-bearing.** This hands back the live cached
 * array, not a copy — copying 8 484 objects per call would defeat the point of
 * the cache. A consumer that sorted or spliced it in place would corrupt the
 * catalog for every other caller in the isolate, so the type forbids it. Callers
 * that need their own ordering copy first, at their own cost.
 *
 * **Failures propagate.** A cold cache that cannot be filled throws
 * `ShamsCrmError`; it is not flattened into an empty array. An empty catalog and
 * an unreachable one lead to opposite decisions, and a caller that cannot tell
 * them apart will show "no products" for an outage.
 *
 * A *stale* catalog is not a failure: Phase 1 keeps serving the previous rows
 * when a refresh fails, deliberately, and that behaviour is unchanged here.
 */
export async function getCrmProducts(): Promise<readonly ShamsProduct[]> {
  return getCatalog();
}
