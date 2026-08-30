import { ChartNoAxesColumn } from "lucide-react";

/**
 * The "nothing to plot" state, for every chart panel on the Dashboard.
 *
 * Panels spelled this three ways — a centred `No data`, a `py-8` paragraph
 * reading `No completed orders`, and in one case an empty card with a chart's
 * worth of white space in it. An empty panel that says nothing reads as a panel
 * that failed to load, which is the one thing an empty period is not.
 *
 * So it says which panel is empty and why, in the panel's own voice: a muted
 * glyph, the fact, and the reason underneath. It fills the height its parent
 * reserved rather than collapsing, so a filter that empties one panel in a grid
 * does not resize the row it sits in.
 */
export function ChartEmpty({
  label = "No data for this period",
  hint,
}: {
  label?: string;
  hint?: string;
}) {
  return (
    <div className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-1.5 px-4 text-center">
      <span
        aria-hidden
        className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60 text-muted-foreground/70"
      >
        <ChartNoAxesColumn className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      {hint && <p className="max-w-[28ch] text-xs text-muted-foreground/75">{hint}</p>}
    </div>
  );
}
