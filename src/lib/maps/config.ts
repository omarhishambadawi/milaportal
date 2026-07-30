/**
 * Google Maps Platform credentials and options, server side.
 *
 * The **server key** (`GOOGLE_MAPS_API_KEY`, never `VITE_`-prefixed). Geocoding,
 * Distance Matrix, Routes and Places are plain REST APIs called from our own
 * server, so this key never reaches a browser and should be restricted by IP,
 * not referrer. It is the one that can run up a bill.
 *
 * Everything degrades rather than breaks when it is missing: the Distance Engine
 * falls back to straight-line distances. Nothing throws, and no feature is
 * hidden — the app simply tells the user what it could not do.
 *
 * The browser half of this module — the `VITE_GOOGLE_MAPS_BROWSER_KEY` reader,
 * the SDK library list and the map ID — went with the interactive map when the
 * Branch Directory dropped it. There is no longer any client-side Maps SDK in the
 * app, so a browser key is not read anywhere and does not need to be issued. If
 * an interactive map returns, the deleted loader and provider are recoverable
 * from git history rather than worth carrying unused.
 */

/** Bias results and place names to Saudi Arabia, in the user's script. */
export const MAPS_REGION = "SA";

/** Base URL for the server-side REST APIs. */
export const MAPS_REST_BASE = "https://maps.googleapis.com/maps/api";

/** Routes API — the successor to Distance Matrix, used first. */
export const ROUTES_API_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
