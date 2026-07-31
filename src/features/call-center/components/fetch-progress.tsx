import { Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Background-refresh feedback, sized so the user barely notices it.
 *
 * This replaced a full progress card with a percentage. The percentage was
 * fiction — a CDR sweep reports no measurable progress — and the card sat in
 * the layout, pushing the content being read down the page every time a filter
 * changed. A refresh keeps the previous numbers on screen, so the only honest
 * signal is "working", next to the title.
 *
 * First load shows nothing here at all: the page is already full of skeletons,
 * and a second spinner on top of them is noise.
 */
export function RefreshIndicator({
  refreshing,
  failed,
  className,
}: {
  refreshing: boolean;
  /** A refresh failed, but the last good analytics are still displayed. */
  failed?: boolean;
  className?: string;
}) {
  if (failed) {
    return (
      <span
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning",
          className,
        )}
      >
        <TriangleAlert className="h-3 w-3" />
        Couldn&apos;t refresh — showing last known figures
      </span>
    );
  }

  if (!refreshing) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
        // Fades in only if the refresh is slow enough to be worth mentioning,
        // so a fast one never flashes.
        "animate-in fade-in duration-500 delay-300 fill-mode-both",
        className,
      )}
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      Updating analytics…
    </span>
  );
}
