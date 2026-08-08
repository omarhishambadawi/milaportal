import { cn } from "@/lib/utils";

/**
 * The dashboard's analytics table.
 *
 * Five tables on this page were hand-rolled from the same eight lines of markup
 * — `border-b text-left text-xs text-muted-foreground` on the head row, `px-3
 * py-2` on every cell — and had already drifted: some rows had a hover state and
 * some did not, currency was `font-mono text-xs` in three of them and plain in
 * the others, and none of them had a header that survived scrolling.
 *
 * The parts are exported separately rather than as one data-driven `<DataTable
 * columns={…}>` because these tables have genuinely different cells — a
 * verification rate, a completion bar, a crosstab of methods — and a column
 * config expressive enough to cover them would be longer than the JSX it
 * replaced. What is shared here is the *chrome*, which is what was inconsistent.
 */

/**
 * Scroll container + table element.
 *
 * Vertical scrolling was removed: a card that clipped its own rows at 26rem
 * forced a nested scrollbar inside the page scroller, so the last rows of
 * "Sales by branch × delivery method" and "Complaints by branch" were hidden
 * behind a gesture nobody looks for. The card now grows with its content and
 * only scrolls horizontally, which is the one axis a wide crosstab genuinely
 * needs on a phone.
 */
export function AnalyticsTable({
  children,
  /** Minimum width before the container scrolls instead of crushing columns. */
  minWidth = 0,
  /**
   * Content-sized columns. `table-auto` + `w-full` lets each column take only
   * the width its longest cell needs and gives the slack to the first (label)
   * column, which is what stops a five-column crosstab from stretching into a
   * field of empty gutters.
   */
  fit,
  /** Tighter cells — for wide crosstabs that must fit a card without scrolling. */
  dense,
  className,
}: {
  children: React.ReactNode;
  minWidth?: number;
  fit?: boolean;
  dense?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative overflow-x-auto", className)}>
      <table
        className={cn(
          "w-full border-separate border-spacing-0 text-sm",
          fit ? "table-auto" : undefined,
          dense &&
            "[&_td]:px-2.5 [&_td]:py-2 [&_th]:px-2.5 [&_th]:py-2 sm:[&_td]:px-3 sm:[&_th]:px-3",
        )}
        style={minWidth ? { minWidth } : undefined}
      >
        {children}
      </table>
    </div>
  );
}

/**
 * Header row.
 *
 * `border-separate` on the table above keeps each cell's own bottom border, so
 * the rule under the header belongs to the header rather than to the table.
 */
export function Thead({ children }: { children: React.ReactNode }) {
  return <thead className="[&_th]:bg-muted/50">{children}</thead>;
}

export function Th({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap border-b border-border/70 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

/** Zebra striping and a hover state, applied to the body rather than each row. */
export function Tbody({ children }: { children: React.ReactNode }) {
  return (
    <tbody className="[&_tr:nth-child(even)]:bg-muted/25 [&_tr:hover]:bg-accent/40 [&_tr]:transition-colors">
      {children}
    </tbody>
  );
}

export function Td({
  children,
  align = "left",
  /** Currency and other figures: tabular digits, right-aligned by default. */
  numeric,
  /** For the one-cell row a table uses to say a whole period is unavailable. */
  colSpan,
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  numeric?: boolean;
  colSpan?: number;
  className?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "border-b border-border/40 px-4 py-3 align-middle leading-6",
        // Money never breaks across lines: "12,300 SAR" is one token to a reader,
        // and letting the currency wrap is what made these columns look ragged.
        numeric
          ? "whitespace-nowrap text-right tabular-nums"
          : align === "right"
            ? "text-right"
            : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** The "no rows" row, so five tables stop spelling it five ways. */
export function EmptyRow({ colSpan, label = "No data" }: { colSpan: number; label?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-muted-foreground">
        {label}
      </td>
    </tr>
  );
}
