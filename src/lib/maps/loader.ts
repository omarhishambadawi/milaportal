import { MAPS_LIBRARIES, MAPS_REGION, browserMapsKey } from "./config";

/**
 * The Maps JavaScript SDK loader.
 *
 * One module, one script tag, one promise, for the whole application. This is
 * not premature tidiness: the Google loader throws a console error and enters a
 * broken state if `<script src="maps.googleapis.com/…">` is injected twice with
 * different `libraries`, and the moment two features each mount a map — the
 * Branch Directory and, later, the Smart Branch Finder — that is exactly what
 * naive per-component loading does. Caching the promise makes the second, third
 * and tenth caller await the first load instead of starting another.
 */

export type MapsStatus = "unconfigured" | "loading" | "ready" | "error";

export interface MapsLoadFailure {
  reason: "unconfigured" | "network" | "rejected";
  message: string;
}

/** Resolved once per page load; `null` until the first caller asks. */
let pending: Promise<typeof google.maps> | null = null;

/** Script element id, so a hot reload does not stack duplicates. */
const SCRIPT_ID = "milaserv-google-maps";

export class MapsUnavailableError extends Error {
  readonly reason: MapsLoadFailure["reason"];
  constructor(failure: MapsLoadFailure) {
    super(failure.message);
    this.name = "MapsUnavailableError";
    this.reason = failure.reason;
  }
}

/**
 * Load the SDK, or explain why it cannot be loaded.
 *
 * Rejects rather than resolving to null so callers cannot accidentally treat
 * "not configured" as "loaded"; the `reason` distinguishes a missing key (an
 * expected deployment state, fall back quietly) from a failed fetch (worth
 * surfacing and retrying).
 */
export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (pending) return pending;

  const key = browserMapsKey();
  if (!key) {
    // Deliberately NOT cached: setting the env var and reloading should work,
    // and in dev the module may outlive the change.
    return Promise.reject(
      new MapsUnavailableError({
        reason: "unconfigured",
        message:
          "VITE_GOOGLE_MAPS_BROWSER_KEY is not set, so the interactive Google map is unavailable.",
      }),
    );
  }

  if (typeof window === "undefined") {
    return Promise.reject(
      new MapsUnavailableError({
        reason: "unconfigured",
        message: "The Maps SDK cannot load during server rendering.",
      }),
    );
  }

  pending = new Promise((resolve, reject) => {
    // Another bundle (or a previous navigation) may already have it.
    if (window.google?.maps) {
      resolve(window.google.maps);
      return;
    }

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    const onReady = () => {
      if (window.google?.maps) resolve(window.google.maps);
      else
        reject(
          new MapsUnavailableError({
            reason: "rejected",
            message: "The Maps SDK loaded but exposed no google.maps namespace.",
          }),
        );
    };

    const onFailure = () => {
      // Clear the cache so a retry is possible: an offline agent who reconnects
      // should get a map on the next attempt, not a permanently poisoned promise.
      pending = null;
      script.remove();
      reject(
        new MapsUnavailableError({
          reason: "network",
          message:
            "Could not reach maps.googleapis.com. Check the network, and that the browser key allows this domain.",
        }),
      );
    };

    script.addEventListener("load", onReady, { once: true });
    script.addEventListener("error", onFailure, { once: true });

    if (!existing) {
      const params = new URLSearchParams({
        key,
        libraries: MAPS_LIBRARIES.join(","),
        region: MAPS_REGION,
        // `v=weekly` rather than a pinned version: Google retires versions on a
        // schedule, and a pin that nobody revisits becomes a broken map.
        v: "weekly",
        loading: "async",
      });
      script.id = SCRIPT_ID;
      script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return pending;
}

/** True once the SDK is present, without triggering a load. */
export function isGoogleMapsLoaded(): boolean {
  return typeof window !== "undefined" && Boolean(window.google?.maps);
}
