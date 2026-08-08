/**
 * The managed Google Maps connection, as configuration.
 *
 * Its own module so that whether a map *can* render is answerable without
 * importing the map. `branch-map.tsx` is `lazy()`-loaded and pulls in the Maps
 * SDK loader; a route that imported it just to read an env var would undo that
 * split, and reading the variable name a second time at the call site would be
 * two places to change it.
 *
 * The key is published by the Lovable Google Maps connector at build time, so
 * these are plain constants rather than a hook — a connection that is absent at
 * build is absent for the life of the bundle.
 */

/** Browser key for the Maps JavaScript SDK. Absent when the connector is off. */
export const GOOGLE_MAPS_BROWSER_KEY = import.meta.env
  .VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY as string | undefined;

/** Usage-attribution channel, when the connector supplies one. */
export const GOOGLE_MAPS_TRACKING_ID = import.meta.env
  .VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID as string | undefined;

/**
 * Whether a map surface should be on the page at all.
 *
 * Callers gate on this rather than rendering a map that explains it cannot
 * render: an empty 380px panel announcing a missing connector is a deployment
 * detail taking up the fold, and it is not something the person looking at a
 * branch list can act on.
 */
export const isGoogleMapsConfigured = Boolean(GOOGLE_MAPS_BROWSER_KEY);
