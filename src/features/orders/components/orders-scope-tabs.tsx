import { Star, User, Users } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Which orders am I looking at — All · Mine · Starred.
 *
 * One segmented control on a recessed track, replacing three `variant="default"`
 * / `"outline"` buttons. Three filled brand-turquoise buttons sitting in a page
 * header were the loudest thing on it, and with only fill separating on from
 * off, the *unselected* two shouted as loudly as the selected one. On a track,
 * the active segment is the one lifted out of it — a raised card on a recessed
 * strip — which is the same "selected" language the sidebar and the tab bars use
 * and needs no colour at all to be obvious at a glance.
 *
 * ## Starred is not a third segment
 *
 * It narrows whichever of All/Mine is selected — and every other filter on top
 * of that — rather than replacing them, so it is an `aria-pressed` toggle and
 * can be lit at the same time as one of the two beside it. A third radio segment
 * would promise a mutual exclusivity it does not have. The hairline before it
 * says so visually: same track, same geometry, but a different kind of control.
 *
 * The active pill uses a `transition` rather than a sliding indicator. A slider
 * has to be measured, and it cannot express two lit segments — which is exactly
 * the state Starred + Mine puts this control in.
 */
export function OrdersScopeTabs({
  mineOnly,
  starredOnly,
  starredCount,
  canStar,
  onSelectScope,
  onToggleStarred,
}: {
  mineOnly: boolean;
  starredOnly: boolean;
  starredCount: number;
  canStar: boolean;
  /** `true` for "my orders". Guarded by the caller so re-picking is a no-op. */
  onSelectScope: (mine: boolean) => void;
  onToggleStarred: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Order scope"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/60 p-0.5"
    >
      <ScopeButton
        active={!mineOnly}
        icon={Users}
        label="All"
        srLabel="All orders"
        onClick={() => onSelectScope(false)}
      />
      <ScopeButton
        active={mineOnly}
        icon={User}
        label="Mine"
        srLabel="My orders"
        onClick={() => onSelectScope(true)}
      />

      <span className="mx-0.5 h-4 w-px shrink-0 bg-border/80" aria-hidden />

      <ScopeButton
        active={starredOnly}
        toggle
        icon={Star}
        label="Starred"
        srLabel="Starred orders only"
        disabled={!canStar}
        iconClassName={starredOnly ? "fill-current" : undefined}
        title={
          starredOnly
            ? "Showing only orders you starred — click to show all"
            : "Show only orders you starred"
        }
        onClick={onToggleStarred}
        badge={starredCount > 0 ? starredCount : undefined}
      />
    </div>
  );
}

function ScopeButton({
  active,
  toggle,
  icon: Icon,
  label,
  srLabel,
  badge,
  disabled,
  title,
  iconClassName,
  onClick,
}: {
  active: boolean;
  /** Renders as `aria-pressed` rather than a radio-style `aria-checked`. */
  toggle?: boolean;
  icon: typeof Star;
  label: string;
  srLabel: string;
  badge?: number;
  disabled?: boolean;
  title?: string;
  iconClassName?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={srLabel}
      {...(toggle ? { "aria-pressed": active } : { "aria-current": active ? "true" : undefined })}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
        // Colour and shadow only. Nothing here changes the element's size, so a
        // segment becoming active cannot reflow the row beside it.
        "transition-[background-color,color,box-shadow] duration-200 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {/* The **glyph** goes below `sm`, not the label.
          It was the other way round, to keep the group narrow on a phone — but
          "all orders" and "my orders" differ by one silhouette at 14px, and two
          person icons side by side read as the same button twice. A word never
          has that problem. The count chip stays either way. */}
      <Icon
        className={cn("hidden h-3.5 w-3.5 shrink-0 sm:inline-block", iconClassName)}
        aria-hidden
      />
      <span>{label}</span>
      {badge !== undefined && (
        <span
          className={cn(
            "rounded px-1 text-[10px] font-semibold leading-4 tabular-nums",
            // Solid in both states: a translucent chip over the lifted segment
            // measured about 1:1 against it, which is a count you cannot read.
            active ? "bg-muted text-foreground" : "bg-background/80 text-muted-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
