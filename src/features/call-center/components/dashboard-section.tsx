import { cn } from "@/lib/utils";

/**
 * One titled band of a dashboard: a rule, a header, and its content.
 *
 * The Customer Care page is a long single column of KPI grids, and the thing
 * that made it hard to scan was not the cards — it was that every grid was the
 * same distance from the next, so the eye had nothing to anchor on. This gives
 * each band a hairline rule and a labelled header at a fixed rhythm, which is
 * cheaper to read than the extra whitespace it replaces.
 *
 * `SectionHeader` is deliberately left alone: Telesales renders it directly and
 * this sprint is not meant to move that page.
 */
export function DashboardSection({
  title,
  description,
  icon: Icon,
  actions,
  id,
  flush,
  children,
}: {
  title: string;
  /** One line under the title. Say what the band answers, not what it contains. */
  description?: string;
  icon?: any;
  /** Controls that belong to this band, right-aligned. Hidden when printing. */
  actions?: React.ReactNode;
  /** Anchor target, so links elsewhere on the page can scroll here. */
  id?: string;
  /** Drop the top rule — for the first band on the page. */
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-20 print:break-inside-avoid",
        flush ? "pt-0" : "border-t border-border/60 pt-5 print:pt-3",
      )}
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-xs leading-snug text-muted-foreground/70">{description}</p>
          )}
        </div>
        {actions && <div className="shrink-0 print:hidden">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
