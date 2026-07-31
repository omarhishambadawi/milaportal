import { memo, useMemo, type ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, X } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";

export type NavItemData = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Reserved for future notification badges — layout is already allocated. */
  badge?: number | string | null;
};


type SidebarProps = {
  nav: NavItemData[];
  activePath: string;
  expanded: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  name: string;
  role?: string | null;
  avatarUrl?: string | null;
  onSignOut: () => void;
};

/*
 * Collapse is CSS-only.
 *
 * The rail used to unmount every label, group heading, the brand text and the
 * footer caption on collapse (`{!collapsed && …}`), so a toggle began with a
 * synchronous React commit that removed ~15 DOM nodes — reconcile, DOM
 * mutation and a full layout on the very frame the 300ms width animation was
 * trying to start. That first dropped frame is what read as stutter.
 *
 * Now the desktop <aside> carries `data-state="expanded|collapsed"` and a
 * named group (`group/rail`), and every collapse affordance is a
 * `group-data-[state=collapsed]/rail:` variant on an element that stays
 * mounted:
 *
 *   - text collapses via max-width + opacity inside overflow-hidden — with
 *     border-box sizing, max-w-0 closes the box (padding included) to exactly
 *     0, so the icons land in the same place the old conditional layout put
 *     them;
 *   - group headings collapse via a fixed height;
 *   - the divider that replaces a heading in rail mode fades in via
 *     border-color, from transparent;
 *   - everything rides the same 300ms/cubic-bezier clock as the aside's own
 *     width, so icons, labels and content arrive together.
 *
 * The mobile drawer renders the same inner tree WITHOUT the group/rail marker,
 * so none of the collapsed variants can ever apply there — it is always the
 * expanded rendering, as before.
 *
 * A width animation is layout-bound by nature; the point here is that the
 * browser now runs exactly one layout per frame (the width tween), instead of
 * layout plus a React commit on frame one, and the per-frame style work is
 * opacity/max-width on a handful of small boxes.
 */

/**
 * Every collapse affordance shares the aside's width clock. Expanding is given
 * slightly more time than collapsing (180ms vs 130ms) — revealing content reads
 * better when it eases in, while hiding it should feel immediate.
 */
const RAIL_CLOCK =
  "duration-[130ms] group-data-[state=expanded]/rail:duration-[180ms] ease-[cubic-bezier(0.4,0,0.2,1)]";


/**
 * Presentational grouping of the (already permission-filtered) nav items into
 * labelled sections. Purely visual — routing/permissions are untouched; any
 * item not matched by a section falls through into "More".
 */
const SECTIONS: { id: string; label: string; match: (to: string) => boolean }[] = [
  { id: "overview", label: "Overview", match: (t) => t === "/dashboard" },
  {
    id: "workspace",
    label: "Workspace",
    match: (t) => t === "/orders" || t === "/orders/new" || t === "/complaints",
  },
  { id: "calls", label: "Calls", match: (t) => t.startsWith("/calls") },
  { id: "admin", label: "Administration", match: (t) => t.startsWith("/admin") },
];

function groupNav(nav: NavItemData[]) {
  const groups = SECTIONS.map((s) => ({
    id: s.id,
    label: s.label,
    items: nav.filter((n) => s.match(n.to)),
  })).filter((g) => g.items.length > 0);
  const claimed = new Set(groups.flatMap((g) => g.items.map((i) => i.to)));
  const rest = nav.filter((n) => !claimed.has(n.to));
  if (rest.length) groups.push({ id: "more", label: "More", items: rest });
  return groups;
}

/**
 * Memoized, and no longer told about collapse at all: its rendering is
 * identical in both states and the collapsed appearance comes entirely from
 * the group-data variants. On a toggle these elements are not reconciled —
 * memo sees the same props and React never enters them.
 *
 * `title` is now unconditional (it used to appear only when collapsed). The
 * tooltip is the only label a collapsed rail has, and browsers only surface it
 * on a deliberate hover pause, so carrying it in the expanded state too is
 * harmless — that trade is what lets `collapsed` disappear from the props.
 */
const NavItem = memo(function NavItem({ item, active }: { item: NavItemData; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      title={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Denser vertical rhythm (36px icon + 8px padding = 44px target, still
        // comfortably above the 44px touch minimum).
        "group relative flex items-center overflow-hidden rounded-xl px-2 py-1 outline-none",
        "transition-[background-color,box-shadow] duration-150 ease-out",
        "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        active
          ? "bg-primary/[0.12] shadow-sm shadow-primary/10"
          : "hover:bg-accent/60 hover:shadow-sm hover:shadow-foreground/[0.04]",
      )}
    >
      {/* Active rail — animates in from the left edge; fades away in rail mode
          instead of unmounting. */}
      {active && (
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary animate-in fade-in slide-in-from-left-1 duration-200",
            "transition-opacity group-data-[state=collapsed]/rail:opacity-0",
          )}
        />
      )}
      {/* Icon container — the core of the visual language. Its box never
          changes size between states; only colour and background move. */}
      <span
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-[color,background-color,box-shadow,transform] duration-150 ease-out",
          active
            ? "bg-primary text-primary-foreground shadow-sm shadow-primary/30"
            : "text-foreground/65 group-hover:bg-background group-hover:text-foreground group-active:scale-95",
        )}
      >
        <Icon className="h-[18px] w-[18px] shrink-0" />
      </span>
      {/* pl-3 replaces the parent's old gap-3, so the whole spacing collapses
          with the box: border-box max-w-0 closes padding and content together,
          leaving the 36px icon exactly centred in the 52px collapsed slot. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate pl-3 text-[13.5px] leading-5 tracking-[-0.005em]",
          "max-w-40 transition-[max-width,opacity,color] ",
          RAIL_CLOCK,
          "group-data-[state=collapsed]/rail:max-w-0 group-data-[state=collapsed]/rail:opacity-0",
          active
            ? "font-semibold text-foreground"
            : "font-medium text-foreground/70 group-hover:text-foreground",
        )}
      >
        {item.label}
      </span>
      {/* Badge slot — reserved. Renders nothing until `badge` is supplied, and
          collapses away with the labels in rail mode. */}
      {item.badge != null && item.badge !== "" && (
        <span
          className={cn(
            "ml-2 shrink-0 overflow-hidden rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold leading-[18px] text-primary",
            "transition-[max-width,opacity,margin]",
            RAIL_CLOCK,
            "max-w-10 group-data-[state=collapsed]/rail:ml-0 group-data-[state=collapsed]/rail:max-w-0 group-data-[state=collapsed]/rail:px-0 group-data-[state=collapsed]/rail:opacity-0",
          )}
        >
          {item.badge}
        </span>
      )}
    </Link>
  );
});


/** Shared inner shell used by both the desktop rail and the mobile drawer. */
const SidebarInner = memo(function SidebarInner({
  nav,
  activePath,
  collapsed,
  onToggle,
  onMobileClose,
}: {
  nav: NavItemData[];
  activePath: string;
  /** Consumed ONLY by the footer button's title/aria-expanded. Every visual
   *  collapse affordance is a group-data variant, so on toggle the DOM diff of
   *  this whole tree is two attributes on one <button>. */
  collapsed: boolean;
  onToggle?: () => void;
  onMobileClose?: () => void;
}) {
  // Rebuilt on every render before this — including every frame-adjacent render
  // during a collapse — even though it depends only on `nav`.
  const groups = useMemo(() => groupNav(nav), [nav]);

  return (
    <div className="flex h-full flex-col">
      {/* Brand — px-3 matches the nav's own padding, so the 40px mark lands
          dead centre of the 76px rail exactly like the 36px nav icons do. */}
      <div className="flex h-16 shrink-0 items-center border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center">
          <BrandLogo />
          <div
            className={cn(
              "min-w-0 overflow-hidden pl-2",
              "max-w-36 transition-[max-width,opacity]",
              RAIL_CLOCK,
              "group-data-[state=collapsed]/rail:max-w-0 group-data-[state=collapsed]/rail:opacity-0",
            )}
          >
            <div className="truncate text-[15px] font-bold leading-[18px] tracking-[-0.015em] text-foreground">
              MilaServ
            </div>
            <div className="whitespace-nowrap text-[9px] font-semibold uppercase leading-[12px] tracking-[0.22em] text-muted-foreground/70">
              Portal
            </div>
          </div>
        </div>

        {onMobileClose && (
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav
        className={cn(
          "flex-1 overflow-y-auto overflow-x-hidden px-3 py-3",
          "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
          "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent",
          "hover:[&::-webkit-scrollbar-thumb]:bg-border/70",
        )}
      >
        {groups.map((g, gi) => (
          <div
            key={g.id}
            className={cn(
              gi > 0 && [
                // The hairline that stands in for the heading in rail mode
                // fades in from transparent instead of appearing on a class
                // swap.
                "mt-5 border-t border-transparent transition-[margin,padding,border-color]",
                RAIL_CLOCK,
                "group-data-[state=collapsed]/rail:mt-2 group-data-[state=collapsed]/rail:pt-2 group-data-[state=collapsed]/rail:border-border/50",
              ],
            )}
          >
            <div
              className={cn(
                // Fixed height (not `auto`) so the collapse to h-0 is
                // animatable; 10px type sits comfortably inside 16px.
                "mb-1.5 h-4 overflow-hidden whitespace-nowrap px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70",
                "transition-[height,margin,opacity]",
                RAIL_CLOCK,
                "group-data-[state=collapsed]/rail:mb-0 group-data-[state=collapsed]/rail:h-0 group-data-[state=collapsed]/rail:opacity-0",
              )}
            >
              {g.label}
            </div>
            <div className="space-y-0.5">
              {g.items.map((it) => (
                <NavItem key={it.to} item={it} active={activePath === it.to} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer — sidebar toggle only. Profile & sign out live in the header. */}
      {onToggle && (
        <div className="mt-auto border-t border-border/60 p-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex h-9 w-full items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            <ChevronLeft
              className={cn(
                "h-4 w-4 shrink-0 transition-transform",
                RAIL_CLOCK,
                "group-data-[state=collapsed]/rail:rotate-180",
              )}
            />
            <span
              className={cn(
                "overflow-hidden whitespace-nowrap pl-2",
                "max-w-24 transition-[max-width,opacity]",
                RAIL_CLOCK,
                "group-data-[state=collapsed]/rail:max-w-0 group-data-[state=collapsed]/rail:opacity-0",
              )}
            >
              Collapse
            </span>
          </button>
        </div>
      )}
    </div>
  );
});

export function AppSidebar({
  nav,
  activePath,
  expanded,
  onToggle,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  return (
    <>
      {/* Desktop rail */}
      <aside
        data-state={expanded ? "expanded" : "collapsed"}
        className={cn(
          "group/rail z-20 hidden shrink-0 flex-col md:flex",
          "sticky top-0 h-screen bg-card border-r border-border/70",
          // `will-change-[width]` was here and has been removed. will-change is a
          // hint to promote an element to its own compositor layer, which only
          // helps properties the compositor can animate by itself — transform and
          // opacity. `width` is a layout property: the browser still runs full
          // layout for this element and the main content beside it on every
          // frame, so the hint bought nothing while permanently holding an extra
          // layer (and its memory) for an animation that runs for 300ms.
          "transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
          expanded ? "w-64" : "w-[76px]",
        )}
      >
        <SidebarInner nav={nav} activePath={activePath} collapsed={!expanded} onToggle={onToggle} />
      </aside>

      {/* Mobile drawer — no group/rail marker, so the collapsed variants can
          never apply here; it always renders expanded. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onMobileClose}
          />
          <aside className="absolute inset-y-0 left-0 flex w-[min(17rem,84vw)] flex-col border-r border-border bg-card shadow-2xl animate-in slide-in-from-left duration-300 ease-out">
            <SidebarInner
              nav={nav}
              activePath={activePath}
              collapsed={false}
              onMobileClose={onMobileClose}
            />
          </aside>
        </div>
      )}
    </>
  );
}
