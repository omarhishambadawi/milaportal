/**
 * Google Maps Platform credentials and options.
 *
 * Two keys, deliberately, because the two halves of Google Maps have opposite
 * security models and conflating them is how map keys get abused:
 *
 *   - **Browser key** (`VITE_GOOGLE_MAPS_BROWSER_KEY`). The Maps JavaScript API
 *     loads via `<script src="…&key=…">`, so this key is *necessarily* visible
 *     to anyone who opens devtools. That is not a leak, it is how the product
 *     works; Google's control for it is an HTTP-referrer restriction, which
 *     must be set on the key in the Cloud console. Restrict it to the portal's
 *     own domains and to the Maps JavaScript API alone.
 *
 *   - **Server key** (`GOOGLE_MAPS_API_KEY`, never `VITE_`-prefixed). Geocoding,
 *     Distance Matrix, Routes and Places are plain REST APIs called from our
 *     own server, so this key never reaches a browser and should be restricted
 *     by IP, not referrer. It is the one that can run up a bill, which is
 *     exactly why it must not be the same key as the one above.
 *
 * Everything degrades rather than breaks when either is missing: the map falls
 * back to the built-in SVG renderer, and the Distance Engine falls back to
 * straight-line distances. Nothing throws, and no feature is hidden — the app
 * simply tells the user what it could not do.
 */

/** Browser-side key. Read through Vite's inlined env. */
export function browserMapsKey(): string | null {
  const key = import.meta.env?.VITE_GOOGLE_MAPS_BROWSER_KEY;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
}

/** Is the interactive Google map available in this build? */
export function isGoogleMapsConfigured(): boolean {
  return browserMapsKey() != null;
}

/**
 * Libraries requested at load time.
 *
 * `marker` is required for AdvancedMarkerElement, which is the only marker API
 * that accepts arbitrary DOM — needed for the custom branch pins. `places` and
 * `geometry` are listed now because adding a library later forces a *reload* of
 * the SDK (the loader refuses a second load with different libraries), and the
 * Places-backed customer address lookup is a scheduled module.
 */
export const MAPS_LIBRARIES = ["marker", "places", "geometry"] as const;

/**
 * Map ID.
 *
 * Advanced Markers require a map ID; cloud-styled maps use it to pick up their
 * styling. `DEMO_MAP_ID` is Google's public identifier, valid for development
 * and for unstyled production use.
 */
export const MAPS_MAP_ID = "DEMO_MAP_ID";

/** Bias results and place names to Saudi Arabia, in the user's script. */
export const MAPS_REGION = "SA";

/** Base URL for the server-side REST APIs. */
export const MAPS_REST_BASE = "https://maps.googleapis.com/maps/api";

/** Routes API — the successor to Distance Matrix, used first. */
export const ROUTES_API_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
