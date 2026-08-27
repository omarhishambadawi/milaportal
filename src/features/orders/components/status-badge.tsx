import { STATUS_STYLES } from "@/lib/branches";
import { cn } from "@/lib/utils";

/**
 * The order page's chip.
 *
 * One geometry for every state the header reports — the order's status, the
 * verified value, the AlShrouq delivery — so three facts of the same kind stop
 * being three different shapes. Each was invented at its call site: the status
 * was a `text-xs` outlined pill, the verified mark an `11px` soft pill, the
 * delivery a `Badge` with its border made transparent. Side by side they read as
 * three unrelated components rather than as one row of states.
 *
 * Soft on purpose: colour and weight carry the meaning, and an outline around
 * every one of them turns the line beside the title into a row of boxes
 * competing with the title itself. Tone classes come from the caller — the
 * existing `STATUS_STYLES` and `ALSHROUQ_TONE_STYLES` — so no status changes
 * colour or meaning here.
 */
export const ORDER_CHIP =
  "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4";

export function StatusBadge({
  s,
  /**
   * `outlined` is the table's chip and the default: down a column of rows the
   * border is what separates one status from the cells either side of it.
   * `soft` is the page header's, where the title supplies that separation and
   * the border only adds weight.
   */
  variant = "outlined",
}: {
  s: string;
  variant?: "outlined" | "soft";
}) {
  return (
    <span
      className={cn(
        variant === "soft"
          ? ORDER_CHIP
          : "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        STATUS_STYLES[s] ?? "bg-muted",
      )}
    >
      {s}
    </span>
  );
}
