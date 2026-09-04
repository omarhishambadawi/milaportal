import { cn } from "@/lib/utils";
import { OUTCOME_BY_KEY } from "@/lib/telesales/types";
import { OUTCOME_STYLES, OUTCOME_STYLE_FALLBACK } from "@/features/telesales/constants";

/**
 * A recorded action, wherever one is shown.
 *
 * One component so the eight Wasfaty actions carry the same colour in the
 * queue, on the lead and on the customer profile — the colour is doing the work
 * of telling them apart at a glance, and a green "Order Created" in one place
 * and a grey one in another would defeat that entirely.
 *
 * The label comes from `OUTCOME_BY_KEY` and falls back to the stored key. That
 * fallback is the point of keeping keys and labels separate: an outcome
 * recorded under a key this build does not know still renders as *something*
 * rather than as a blank, and renaming a label never rewrites history.
 */
export function OutcomeBadge({
  outcome,
  className,
}: {
  outcome: string | null | undefined;
  className?: string;
}) {
  if (!outcome) return null;
  return (
    <span
      className={cn(
        "inline-block rounded-full border px-2 py-0.5 text-[11px]",
        OUTCOME_STYLES[outcome] ?? OUTCOME_STYLE_FALLBACK,
        className,
      )}
    >
      {OUTCOME_BY_KEY.get(outcome)?.label ?? outcome}
    </span>
  );
}
