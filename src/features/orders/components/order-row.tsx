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
import { InvoiceCell } from "./invoice-cell";
import { StatusBadge } from "./status-badge";
import { TeamBadge } from "./team-badge";
import { fmtOrderDate } from "../utils";

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
 * The markup is an exact move out of the route's `pageRows.map(...)`, made a
 * component purely so it can be memoised. Everything that re-renders the Orders
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
 * No behaviour, permission check or class name is changed by the move.
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
  const cellCls = "align-middle border-b border-border/40 py-3";

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
        "group bg-background transition-colors hover:bg-accent/50",
        highlighted && "order-row-return",
      )}
    >
      <td className={cn("text-center px-2 relative", cellCls)} onClick={(e) => e.stopPropagation()}>
        {/* The 3px rail, which is what carries the row's state
            now that dark mode no longer tints the row itself.
            Cancelled and walk-in both read destructive; they are
            told apart by the glyph, not the colour. */}
        {ccState !== "pending" && (
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-0 bottom-0 w-[3px]",
              ccState === "verified" ? "bg-success" : "bg-destructive",
            )}
          />
        )}
        <CallCentreCell state={ccState} />
      </td>
      <td className={cn("text-center px-1", cellCls)} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => onToggleStar(o.id)}
          disabled={!canStar}
          aria-pressed={isStarred}
          aria-label={isStarred ? "Remove star" : "Star this order"}
          title={isStarred ? "Starred — only you see this" : "Star — only you see this"}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isStarred
              ? "text-[var(--attention)]"
              : "text-muted-foreground/60 hover:text-foreground",
            !canStar && "pointer-events-none opacity-40",
          )}
        >
          <Star className={cn("h-4 w-4", isStarred && "fill-current")} />
        </button>
      </td>
      <td className={cn("px-3", cellCls)}>
        <div className="flex flex-col items-start gap-1 min-w-0">
          <CopyableOrderNo value={formatOrderNo(o.team, o.display_no)} />
          <TeamBadge team={o.team} />
        </div>
      </td>

      <td
        className={cn("whitespace-nowrap px-3 text-xs tabular-nums text-muted-foreground", cellCls)}
      >
        {fmtOrderDate(o.order_date)}
      </td>
      <td className={cn("px-3 text-sm", cellCls)}>
        <div className="truncate font-semibold text-foreground leading-tight">
          {o.customer_name || <span className="text-muted-foreground font-normal">—</span>}
        </div>
        {o.customer_phone && (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">
            {o.customer_phone}
          </div>
        )}
      </td>
      <td className={cn("px-3 text-sm", cellCls)}>
        <div className="truncate text-foreground leading-tight">
          {o.agent_name || <span className="text-muted-foreground">—</span>}
        </div>
        {o.agent_code && (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">
            {o.agent_code}
          </div>
        )}
      </td>
      <td className={cn("px-3 text-[13px] font-mono text-foreground/90", cellCls)}>
        <InvoiceCell value={o.invoice_no} />
      </td>
      <td className={cn("px-2 text-xs text-muted-foreground whitespace-nowrap", cellCls)}>
        {o.order_type}
      </td>
      <td className={cn("px-3 text-sm", cellCls)}>
        <div className="font-mono font-medium truncate leading-tight">{o.branch_no ?? "—"}</div>
        {o.city && (
          <div className="mt-0.5 text-[11px] text-muted-foreground truncate">{o.city}</div>
        )}
      </td>
      <td
        className={cn(
          "px-3 text-right text-sm font-mono font-semibold tabular-nums whitespace-nowrap text-foreground",
          cellCls,
        )}
      >
        {fmtSAR(o.invoice_value)}
      </td>
      <td onClick={(e) => e.stopPropagation()} className={cn("px-3", cellCls)}>
        {editable ? (
          <Select value={o.status} onValueChange={(v) => onUpdateStatus(o, v)}>
            <SelectTrigger
              className={cn(
                "h-8 w-full border px-2.5 text-xs font-semibold rounded-md",
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
      <td className={cn("px-1 text-center", cellCls)}>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-70 group-hover:opacity-100 transition-opacity"
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
