import { ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A one-line explanatory strip that can be opened for the full story.
 *
 * Replaces the paragraph-sized notice that used to sit between the Queue KPIs
 * and the charts. The explanation is worth keeping — a supervisor comparing this
 * page against the PBX deserves to know why two numbers differ — but it is
 * reference material, and reference material that occupies a full card competes
 * with the KPIs for attention every single render.
 *
 * Built on `<details>` rather than a controlled disclosure: it needs no state
 * and so survives the 20-second background refresh without snapping shut, which
 * a `useState` disclosure on a re-rendering page does not reliably do.
 */
export function InfoBanner({
  summary,
  children,
  className,
}: {
  /** The single line that is always visible. Keep it under ~90 characters. */
  summary: React.ReactNode;
  /** The full explanation, revealed on click. */
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group rounded-lg border border-border/60 bg-muted/30", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180 print:hidden" />
      </summary>
      <div className="border-t border-border/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground sm:pl-9">
        {children}
      </div>
    </details>
  );
}
