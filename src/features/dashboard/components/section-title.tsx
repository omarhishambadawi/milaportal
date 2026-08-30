import type { LucideIcon } from "lucide-react";

/**
 * A dashboard section heading.
 *
 * The optional icon mirrors the one on the cards below it, so scanning the page
 * vertically follows a single visual language instead of switching between
 * iconless section rules and iconed card headers.
 */
export function SectionTitle({ title, icon: Icon }: { title: string; icon?: LucideIcon }) {
  return (
    <div className="mb-3 mt-2 flex items-center gap-2.5">
      {Icon && (
        <span
          aria-hidden
          // Same chip as `AnalyticsCard` and `DashKpiCard`, one size down: the
          // tint, the inset ring and the radius were the one place three icon
          // treatments on one page differed, and a section heading sits directly
          // above the cards whose headers repeat it.
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary/80 ring-1 ring-inset ring-primary/10"
        >
          <Icon className="h-4 w-4" strokeWidth={2} />
        </span>
      )}
      {/* `data-dash-section` is the hook the PDF export's type scale hangs on
          (`.dash-print-layout` in styles.css). It changes nothing on screen, and
          it is an attribute rather than a class because this component is shared
          with the Monthly Report, whose own printed scale must not move. */}
      <h2
        data-dash-section
        className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
      >
        {title}
      </h2>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
