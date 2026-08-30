import { memo } from "react";
import { Eye, Pencil, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATUSES, STATUS_STYLES, fmtSAR, formatOrderNo } from "@/lib/branches";
import { cn } from "@/lib/utils";

import { CallCentreCell, callCentreState } from "./call-centre-cell";
import { CopyableOrderNo } from "./copyable-order-no";
import { FulfillmentBadge } from "./fulfillment-badge";
import { InvoiceCell } from "./invoice-cell";
import { StatusBadge } from "./status-badge";
import { TeamBadge } from "./team-badge";
import { fmtOrderDateShort } from "../utils";

interface OrderRowProps {
  /** One enriched row from `useOrdersListData`. Memoised upstream. */
  order: any;
  /** `canEditOrder(order)`, resolved by the caller so this stays a primitive. */
  editable: boolean;
  isStarred: boolean;
  canStar: boolean;
  /** The row the agent has just come back from, for a couple of seconds. */
  highlighted: boolean;
  onToggleStar: (orderId: string) => void;
  onUpdateStatus: (order: any, status: string) => void;
  onOpen: (orderId: string) => void;
}

/**
 * One row of the Orders table.
 *
 * ## Why it is a component
 *
 * Made a component so it can be memoised. Everything that re-renders the Orders
 * page — a keystroke in the search box (which re-renders on every character,
 * ahead of the 300ms debounce that gates the *query*), opening a filter dropdown,
 * a background refetch settling, the scroll-restoration highlight arming and
 * disarming — used to re-render all 25–100 rows with it, and each row carries a
 * Radix `Select`, two Radix tooltips and a copy-to-clipboard button.
 *
 * With `memo` a render of the page reconciles only the rows whose own data
 * changed. The props are built to make that hit: `order` comes from the
 * `enrichedRows` memo, `editable`/`isStarred`/`canStar`/`highlighted` are
 * booleans, and the three callbacks are `useCallback`ed at their source (see the
 * notes in `use-orders-mutations` and `use-starred-orders`).
 *
 * ## Why the row folds instead of scrolling
 *
 * The table used to be twelve fixed columns behind `min-width: 1240`, so every
 * width under about 1500px of content read the list through a horizontal
 * scrollbar — and a horizontally scrolled table is the one layout where the
 * column you are reading and the row you are reading it for can be on screen at
 * different times.
 *
 * There is still exactly one layout (the alternative, a second card list for
 * phones, is what this page had before and it drifted: a column added to the
 * table never appeared in the cards). What changes with width is how many of the
 * row's facts get a *column* of their own. The rest fold into the meta line
 * under the customer, in the same reading order, so nothing is ever hidden —
 * only re-laid-out:
 *
 * | from   | gains its own column                       |
 * | ------ | ------------------------------------------ |
 * | base   | verified · star · order · status · action  |
 * | `sm`   | customer                                   |
 * | `lg`   | delivery/pickup · value · date             |
 * | `xl`   | invoice · agent                            |
 * | `2xl`  | branch, and the delivery badge gains words |
 *
 * The reveal order is the priority order in reverse, and `md` deliberately gains
 * no new column: the app rail appears there and takes width out of the same row,
 * so `md` is the one step that can be *narrower* than the breakpoint below it.
 *
 * The widths were budgeted against the folding 256px sidebar this was written
 * on, where `md` had 480px of content against `sm`'s 608. The rail is a fixed
 * 92px now, so every tier from `md` up has about 164px more than the table is
 * sized for. The reveal points stay where they are — they are a lower bound, and
 * one that still holds if the rail ever expands again.
 */
function OrderRowImpl({
  order: o,
  editable,
  isStarred,
  canStar,
  highlighted,
  onToggleStar,
  onUpdateStatus,
  onOpen,
}: OrderRowProps) {
  const ccState = callCentreState(o);
  const cellCls = "align-middle border-b border-border/40 py-2.5";

  /** Name over phone. Its own column from `sm`; inside the order cell below. */
  const customerBlock = (
    <>
      {/* `title` on everything that truncates. A name clipped mid-word is the
          one thing on this row an agent cannot recover by widening a column,
          because there are no draggable columns to widen. */}
      <div
        className="truncate text-[13px] font-semibold leading-tight text-foreground"
        title={o.customer_name || undefined}
      >
        {o.customer_name || <span className="font-normal text-muted-foreground">—</span>}
      </div>
      {o.customer_phone && (
        <div className="mt-0.5 truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {o.customer_phone}
        </div>
      )}
    </>
  );

  /**
   * Everything that has not earned a column at this width.
   *
   * One wrapping line rather than a stack, and each item carries the breakpoint
   * at which its own column takes over — so an item is in exactly one place at
   * any width, and the line empties itself out from the right as the viewport
   * grows, ending empty at `2xl` where every fact has a column.
   *
   * Space separates the items rather than interpuncts, and that is not laziness:
   * which item is *first* here depends on the viewport and on the row's own data
   * (an order with no invoice number drops that span), so a separator rendered
   * with an item would sooner or later lead the line with a stray dot. `gap-x-3`
   * is wide enough to read as a break at 11px, and the alternating mono/sans of
   * the values does the rest.
   */
  const metaLine = (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] leading-tight text-muted-foreground 2xl:hidden">
      <span className="lg:hidden">
        <FulfillmentBadge deliveryType={o.delivery_type} showLabel />
      </span>
      <span className="tabular-nums lg:hidden">{fmtOrderDateShort(o.order_date)}</span>
      <span className="font-medium tabular-nums text-foreground/80 lg:hidden">
        {fmtSAR(o.invoice_value)}
      </span>
      {o.invoice_no && (
        <span className="truncate font-mono xl:hidden" title={o.invoice_no}>
          {o.invoice_no}
        </span>
      )}
      {o.agent_name && o.agent_name !== "—" && (
        <span className="truncate xl:hidden" title={o.agent_name}>
          {o.agent_name}
        </span>
      )}
      {o.branch_no && (
        <span
          className="truncate font-mono"
          title={o.city ? `${o.branch_no} · ${o.city}` : o.branch_no}
        >
          {o.branch_no}
          {o.city ? ` · ${o.city}` : ""}
        </span>
      )}
    </div>
  );

  return (
    <tr
      // What the scroll restoration looks the row up by when the
      // agent comes back from editing it. An id rather than an
      // offset, because a save can move the row.
      data-order-id={o.id}
      // Present only while the return mark is up. Not styling —
      // this is what makes "is the state reaching the row?"
      // answerable from DevTools without reading React, which
      // is the question that took three attempts to settle.
      data-return-highlight={highlighted ? "true" : undefined}
      // One background for every row, in both themes. No
      // positional striping and no state tint: the only thing
      // that distinguishes rows is their content — the glyph and
      // rail in the first column, and the status pill.
      //
      // The single exception is temporary and is not state: the
      // order just returned from plays `order-row-return`, a
      // two-and-a-bit-second flash that fades itself out and
      // leaves the row exactly as it found it. Applied by id, so
      // it follows the order if a save re-sorted it.
      className={cn(
        "group bg-background transition-colors duration-150 hover:bg-accent/40",
        highlighted && "order-row-return",
      )}
    >
      <td className={cn("relative px-1 text-center", cellCls)} onClick={(e) => e.stopPropagation()}>
        {/* The 3px rail, which is what carries the row's state
            now that dark mode no longer tints the row itself.
            Cancelled and walk-in both read destructive; they are
            told apart by the glyph, not the colour. */}
        {ccState !== "pending" && (
          <span
            aria-hidden
            className={cn(
              "absolute bottom-0 left-0 top-0 w-[3px]",
              ccState === "verified" ? "bg-success" : "bg-destructive",
            )}
          />
        )}
        <CallCentreCell state={ccState} />
      </td>
      <td className={cn("px-0 text-center", cellCls)} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => onToggleStar(o.id)}
          disabled={!canStar}
          aria-pressed={isStarred}
          aria-label={isStarred ? "Remove star" : "Star this order"}
          title={isStarred ? "Starred — only you see this" : "Star — only you see this"}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150",
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isStarred
              ? "text-[var(--attention)]"
              : "text-muted-foreground/50 hover:text-foreground",
            !canStar && "pointer-events-none opacity-40",
          )}
        >
          <Star className={cn("h-4 w-4", isStarred && "fill-current")} />
        </button>
      </td>

      {/* Order identity. The auto column below `sm`, where it also carries the
          customer and the meta line. */}
      <td className={cn("px-2.5", cellCls)}>
        <div className="flex min-w-0 flex-col items-start gap-1">
          <CopyableOrderNo value={formatOrderNo(o.team, o.display_no)} />
          <TeamBadge team={o.team} />
          <div className="min-w-0 max-w-full sm:hidden">
            {customerBlock}
            {metaLine}
          </div>
        </div>
      </td>

      <td className={cn("hidden px-2.5 sm:table-cell", cellCls)}>
        <div className="min-w-0">
          {customerBlock}
          {metaLine}
        </div>
      </td>

      <td
        className={cn(
          "hidden px-2.5 font-mono text-[12.5px] text-foreground/90 xl:table-cell",
          cellCls,
        )}
      >
        <InvoiceCell value={o.invoice_no} />
      </td>

      <td className={cn("hidden px-2.5 text-[13px] xl:table-cell", cellCls)}>
        <div className="truncate leading-tight text-foreground" title={o.agent_name || undefined}>
          {o.agent_name || <span className="text-muted-foreground">—</span>}
        </div>
        {o.agent_code && (
          <div className="mt-0.5 truncate font-mono text-[11px] leading-tight text-muted-foreground">
            {o.agent_code}
          </div>
        )}
      </td>

      <td className={cn("hidden px-2.5 text-[13px] 2xl:table-cell", cellCls)}>
        <div className="truncate font-mono font-medium leading-tight">{o.branch_no ?? "—"}</div>
        {o.city && (
          <div
            className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground"
            title={o.city}
          >
            {o.city}
          </div>
        )}
      </td>

      <td className={cn("hidden px-2 lg:table-cell", cellCls)}>
        <FulfillmentBadge deliveryType={o.delivery_type} />
      </td>

      {/* Value, with the payment channel under it. `Cash` / `Wasfaty` used to be
          a column of its own headed "Type"; it belongs to the money more than to
          anything else on the row, and pairing them buys back 76px of table for
          a fact that reads better here anyway. The currency lives in the header
          rather than on twenty-five rows — see `fmtSAR`'s `bare`. */}
      <td className={cn("hidden px-2.5 text-right lg:table-cell", cellCls)}>
        <div className="truncate font-mono text-[13px] font-semibold tabular-nums text-foreground">
          {fmtSAR(o.invoice_value, { bare: true })}
        </div>
        {o.order_type && (
          <div className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {o.order_type}
          </div>
        )}
      </td>

      <td onClick={(e) => e.stopPropagation()} className={cn("px-2", cellCls)}>
        {editable ? (
          <Select value={o.status} onValueChange={(v) => onUpdateStatus(o, v)}>
            <SelectTrigger
              className={cn(
                "h-8 w-full rounded-md border px-2 text-xs font-semibold transition-colors duration-150",
                STATUS_STYLES[o.status] ?? "",
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <StatusBadge s={o.status} />
        )}
      </td>

      <td
        className={cn(
          "hidden whitespace-nowrap px-2 text-[12px] tabular-nums text-muted-foreground lg:table-cell",
          cellCls,
        )}
      >
        {fmtOrderDateShort(o.order_date)}
      </td>

      <td className={cn("px-0 text-center", cellCls)}>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-60 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onOpen(o.id)}
          aria-label={editable ? "Edit order" : "View order"}
        >
          {editable ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </td>
    </tr>
  );
}

export const OrderRow = memo(OrderRowImpl);
