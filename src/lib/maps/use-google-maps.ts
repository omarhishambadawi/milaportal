import { useCallback, useEffect, useState } from "react";
import { MapsUnavailableError, loadGoogleMaps, type MapsStatus } from "./loader";
import { isGoogleMapsConfigured } from "./config";

/**
 * Availability of the Maps JavaScript SDK, for any component that renders a map.
 *
 * Returns a status rather than throwing or suspending, because "no map" is a
 * supported state of this product, not an error page: the portal must stay
 * fully usable with the Google key absent, and the caller decides whether to
 * show a fallback renderer, a plain list, or nothing at all.
 */
export function useGoogleMaps(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [status, setStatus] = useState<MapsStatus>(() =>
    isGoogleMapsConfigured() ? "loading" : "unconfigured",
  );
  const [error, setError] = useState<MapsUnavailableError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    if (!isGoogleMapsConfigured()) {
      setStatus("unconfigured");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    loadGoogleMaps()
      .then(() => {
        if (cancelled) return;
        setStatus("ready");
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failure =
          cause instanceof MapsUnavailableError
            ? cause
            : new MapsUnavailableError({
                reason: "rejected",
                message: cause instanceof Error ? cause.message : String(cause),
              });
        setError(failure);
        setStatus(failure.reason === "unconfigured" ? "unconfigured" : "error");
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  /** Retry after a network failure. The loader clears its cache on error. */
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    status,
    error,
    retry,
    /** The SDK is present and a map can be constructed. */
    isReady: status === "ready",
    /** Nothing is wrong — there is simply no key in this deployment. */
    isUnconfigured: status === "unconfigured",
  };
}
