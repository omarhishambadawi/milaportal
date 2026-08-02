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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
        >
          <Icon className="h-4 w-4" strokeWidth={2} />
        </span>
      )}
      <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">{title}</h2>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
