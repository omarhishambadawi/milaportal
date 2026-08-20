import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { KSA_BOUNDS } from "@/lib/geo";
import type { GeoAddress, NearbyBranch, RankedBranch } from "@/lib/geo";
import type { NearbyQuery } from "@/lib/geo/distance-engine.server";

/**
 * The portal's geographic API surface.
 *
 * Every geo capability reaches the browser through here rather than through a
 * direct Google call, for one reason: the server key must never be in a bundle.
 * A client-side `fetch` to the Geocoding API would need the key inlined, and
 * that key is the one that can be billed. Routing it through a server function
 * keeps the credential server-side and gives every call an authorization check
 * for free.
 */

/** Coordinates must be real and inside the country the business operates in. */
const LatLngSchema = z.object({
  lat: z.number().min(KSA_BOUNDS.south).max(KSA_BOUNDS.north),
  lng: z.number().min(KSA_BOUNDS.west).max(KSA_BOUNDS.east),
});

/**
 * Rank the branches nearest a point.
 *
 * Gated on `view_branches` only — this is a read of the same directory every
 * agent can already search, reordered by distance. Requiring anything more
 * would put the Smart Branch Finder out of reach of the people it is for.
 */
export const geoNearestBranches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      origin: { lat: number; lng: number };
      limit?: number;
      radiusM?: number;
      scooterOnly?: boolean;
    }) =>
      z
        .object({
          origin: LatLngSchema,
          limit: z.number().int().min(1).max(25).optional().default(5),
          // Capped at 200km: beyond that the answer is "no branch near you",
          // and an unbounded radius is an invitation to route-check the entire
          // network on one request.
          radiusM: z.number().min(500).max(200_000).optional().default(50_000),
          scooterOnly: z.boolean().optional().default(false),
        })
        .parse(d),
  )
  .handler(async ({ data, context }): Promise<RankedBranch[]> => {
    await assertCanViewBranches(context.supabase, context.userId);
    const { nearestBranches } = await import("@/lib/geo/distance-engine.server");
    return nearestBranches(branchesNearbyVia(context.supabase), data.origin, {
      limit: data.limit,
      radiusM: data.radiusM,
      scooterOnly: data.scooterOnly,
    });
  });

/**
 * Bind the spatial RPC to a Supabase client.
 *
 * The single place Supabase and the Distance Engine meet. `branches_nearby` is
 * not in the generated types (it was added by migration 20260726130000 and the
 * types file is regenerated on its own schedule), so the cast is confined to
 * this one adapter rather than spread through the engine.
 *
 * The caller's own client is used, so the RPC runs under their RLS context.
 */
function branchesNearbyVia(supabase: any): NearbyQuery {
  return async ({ lat, lng, radiusM, limit, scooterOnly }) => {
    const { data, error } = await supabase.rpc("branches_nearby", {
      _lat: lat,
      _lng: lng,
      _radius_m: radiusM,
      _limit: limit,
      _scooter_only: scooterOnly,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as NearbyBranch[];
  };
}

/** Resolve a written address to candidate coordinates. */
export const geoGeocode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { address: string }) =>
    z.object({ address: z.string().min(3).max(400) }).parse(d),
  )
  .handler(async ({ data, context }): Promise<GeoAddress[]> => {
    await assertCanViewBranches(context.supabase, context.userId);
    const { geocodeAddress } = await import("@/lib/maps/google.server");
    return geocodeAddress(data.address);
  });

/** Resolve coordinates to a written address. */
export const geoReverseGeocode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { point: { lat: number; lng: number } }) =>
    z.object({ point: LatLngSchema }).parse(d),
  )
  .handler(async ({ data, context }): Promise<GeoAddress | null> => {
    await assertCanViewBranches(context.supabase, context.userId);
    const { reverseGeocode } = await import("@/lib/maps/google.server");
    return reverseGeocode(data.point);
  });

/**
 * Follow a shortened Google Maps link to the location behind it.
 *
 * Gated on authentication alone, deliberately, and it is the one function here
 * that is: it reads no portal data, so there is nothing for a permission to
 * protect. What makes it safe is the host allow-list in the resolver, not an
 * RBAC check — and tying it to `view_branches` would put it out of reach of a
 * telesales agent capturing a customer's location, which is what it is for.
 *
 * `redirect: "manual"` and the allow-list live in the resolver; see the header
 * comment there for why a user-supplied URL is not simply fetched.
 */
export const geoResolveMapLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { url: string }) => z.object({ url: z.string().min(1).max(2000) }).parse(d))
  .handler(async ({ data }) => {
    const { resolveMapLink } = await import("@/lib/geo/short-link.server");
    return resolveMapLink(data.url);
  });

/**
 * Shared gate.
 *
 * Routed through `has_permission` rather than a role comparison so this and the
 * branches RLS policy agree by construction — the same reasoning as the branch
 * import functions.
 */
async function assertCanViewBranches(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_permission", {
    _user_id: userId,
    _permission: "view_branches",
  });
  if (error) {
    console.error("[authz] has_permission RPC error", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  if (!data) throw new Error("Forbidden: branch access required");
}
