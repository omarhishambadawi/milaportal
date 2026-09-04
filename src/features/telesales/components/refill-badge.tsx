import { cn } from "@/lib/utils";
import { describeRefill, type BusinessDate } from "@/lib/telesales/dates";
import { REFILL_SEVERITY_STYLES } from "@/features/telesales/constants";

/**
 * Days to Refill, wherever it is shown.
 *
 * It was two copies of the same three lines — one in the queue row, one in the
 * customer profile — each calling `describeRefill` and indexing
 * `REFILL_SEVERITY_STYLES` by hand. That was survivable while the badge was
 * only ever a coloured pill; it stopped being survivable the moment one of the
 * three states started carrying motion, because a second copy of an animated
 * component is a second answer to "what does today look like".
 *
 * So: one component, and the wording and the styling both come from the same
 * places they always did. Nothing here decides what "due" means — `describeRefill`
 * does, and it is the same function the recommendation engine uses.
 */
export function RefillBadge({
  dueOn,
  today,
  className,
}: {
  dueOn: BusinessDate | null | undefined;
  today: BusinessDate;
  className?: string;
}) {
  const refill = describeRefill(dueOn, today);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] tracking-wide",
        REFILL_SEVERITY_STYLES[refill.severity],
        className,
      )}
    >
      {/*
       * The dot exists only for today.
       *
       * `currentColor` rather than a colour of its own, so it is whatever the
       * badge's ink is in whichever theme is on — one value to keep in step
       * instead of three. `aria-hidden` because the label beside it already
       * says "REFILL DUE TODAY"; a screen reader gains nothing from a shape.
       */}
      {refill.severity === "due" ? (
        <span
          aria-hidden
          className="refill-today-dot h-1.5 w-1.5 shrink-0 rounded-full bg-current"
        />
      ) : null}
      {refill.label}
    </span>
  );
}
