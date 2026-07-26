import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGoogleMaps } from "@/lib/maps/use-google-maps";
import type { MapPoint } from "@/lib/maps/markers";
import { cn } from "@/lib/utils";
import { GoogleMap } from "./google-map";

/**
 * The map every feature mounts.
 *
 * It owns the one decision no individual feature should re-make: whether this
 * deployment can show a Google map, and what to do when it cannot. Google is
 * the primary provider; the caller's own renderer is the graceful fallback.
 *
 * Three states, and the distinction between the first two is the reason this
 * component exists:
 *
 *   - **Unconfigured.** No browser key in this build. Not an error, and not
 *     worth interrupting anyone about — the fallback renders silently, exactly
 *     as if it were the intended map.
 *   - **Error.** A key exists but the SDK could not load: offline, blocked, or
 *     the key's referrer restriction does not cover this domain. The fallback
 *     still renders, but with a quiet, dismissible notice and a retry, because
 *     this one is a misconfiguration somebody should fix.
 *   - **Ready.** The real thing.
 */

interface Props<T> {
  points: MapPoint<T>[];
  selectedId?: string | null;
  onSelect?: (point: MapPoint<T> | null) => void;
  renderInfo?: (point: MapPoint<T>) => React.ReactNode;
  /** Rendered whenever Google Maps is unavailable. */
  renderFallback: () => React.ReactNode;
  className?: string;
  focusZoom?: number;
  emptyMessage?: string;
}

export function MapSurface<T>({
  points,
  selectedId,
  onSelect,
  renderInfo,
  renderFallback,
  className,
  focusZoom,
  emptyMessage,
}: Props<T>) {
  const { status, error, retry, isReady } = useGoogleMaps();

  if (isReady) {
    return (
      <GoogleMap
        points={points}
        selectedId={selectedId}
        onSelect={onSelect}
        renderInfo={renderInfo}
        className={className}
        focusZoom={focusZoom}
        emptyMessage={emptyMessage}
      />
    );
  }

  // While the SDK is in flight the fallback is shown rather than a spinner:
  // it is a working map, and swapping a usable view for a loading state is a
  // downgrade. The spinner is a small corner badge instead.
  return (
    <div className={cn("relative", className)}>
      {renderFallback()}

      {status === "loading" && (
        <span className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/90 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading Google Maps…
        </span>
      )}

      {status === "error" && (
        <div className="absolute inset-x-3 top-3 z-10 flex items-start gap-2 rounded-lg border border-[var(--attention)]/40 bg-card/95 p-2.5 text-xs shadow-sm backdrop-blur-sm">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--attention)]" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Google Maps could not load</p>
            <p className="mt-0.5 text-muted-foreground">
              {error?.message ?? "Showing the built-in map instead."}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={retry}
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
