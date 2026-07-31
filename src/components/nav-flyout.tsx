import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { NavItemData } from "./app-sidebar";

/**
 * Right-hand flyout for a nav item with children.
 *
 * Rendered through a PORTAL, which is the whole point. The sidebar's scrolling
 * `<nav>` carries `overflow-x-hidden` (it has to — the rail collapses by
 * animating widths), so a panel positioned at `left-full` inside it is clipped
 * away the instant it appears. That is why the first CSS-only attempt showed a
 * chevron and nothing else. Escaping to `document.body` and positioning from
 * the trigger's measured rect is the only reliable fix.
 *
 * One `open` state drives both presentations:
 *   - Desktop: the portal panel. Hover opens, click toggles, focus opens.
 *   - Mobile: an inline accordion (`lg:hidden`), because a floating panel on a
 *     narrow touch screen has nowhere to go.
 *
 * Closing is deliberately forgiving. Leaving the trigger starts a short grace
 * period rather than closing immediately, so the diagonal mouse path from the
 * item to the panel does not snap it shut — the single most common way a
 * hover menu becomes unusable.
 */

const CLOSE_GRACE_MS = 140;

/** Rough panel height: one row per child, plus the container's padding. */
const ROW_HEIGHT = 44;
const PANEL_PADDING = 24;
const VIEWPORT_MARGIN = 8;
const MAX_PANEL_HEIGHT = 420;

/**
 * Where to put the panel's top edge so it never runs off the viewport.
 *
 * Aligns with the trigger when there is room, and otherwise slides up just
 * enough to stay on screen — a long menu opened from a low sidebar item would
 * otherwise have its last entries below the fold and unreachable.
 *
 * Exported for tests: this is the one part of the flyout with arithmetic worth
 * pinning, and it needs no DOM to check.
 */
export function clampFlyoutTop(
  triggerTop: number,
  childCount: number,
  viewportHeight: number,
): number {
  const panelHeight = Math.min(childCount * ROW_HEIGHT + PANEL_PADDING, MAX_PANEL_HEIGHT);
  const lowestTop = viewportHeight - panelHeight - VIEWPORT_MARGIN;
  return Math.max(VIEWPORT_MARGIN, Math.min(triggerTop, lowestTop));
}

export function NavFlyout({
  item,
  activePath,
  trigger,
  onNavigate,
}: {
  item: NavItemData;
  activePath: string;
  /** The parent link itself, rendered by the caller so styling stays in one place. */
  trigger: ReactNode;
  /** Called after a child is chosen, so the mobile drawer can close. */
  onNavigate?: () => void;
}) {
  const children = item.children ?? [];
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = useId();

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
  }, [cancelClose]);

  /** Measure from the trigger each time, so scrolling the rail cannot strand it. */
  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.right + 8 });
  }, []);

  const openNow = useCallback(() => {
    cancelClose();
    place();
    setOpen(true);
  }, [cancelClose, place]);

  useEffect(() => cancelClose, [cancelClose]);

  // Close on navigation. The path changing IS the navigation, so this covers
  // clicks, keyboard activation and browser back alike.
  useEffect(() => {
    setOpen(false);
  }, [activePath]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Return focus to the trigger; dropping it on a removed node would send
      // the user back to the top of the document.
      wrapRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Reposition rather than close: closing on scroll would fight the user.
    const onReflow = () => place();

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, place]);

  if (children.length === 0) return <>{trigger}</>;

  const top =
    rect == null
      ? 0
      : clampFlyoutTop(
          rect.top,
          children.length,
          typeof window !== "undefined" ? window.innerHeight : 800,
        );

  const childLink = (c: NavItemData, dense: boolean) => (
    <Link
      key={c.to}
      to={c.to}
      onClick={() => {
        setOpen(false);
        onNavigate?.();
      }}
      aria-current={activePath === c.to ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/60",
        dense ? "px-2.5 py-1.5 text-sm" : "px-2.5 py-2 text-sm",
        activePath === c.to
          ? "bg-primary/10 font-semibold text-foreground"
          : "text-foreground/75 hover:bg-accent/70 hover:text-foreground",
      )}
    >
      <c.icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{c.label}</span>
    </Link>
  );

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocusCapture={openNow}
      onBlurCapture={(e) => {
        // Only close when focus actually left both the trigger and the panel.
        const next = e.relatedTarget as Node | null;
        if (next && (wrapRef.current?.contains(next) || panelRef.current?.contains(next))) return;
        scheduleClose();
      }}
    >
      <div
        onClick={(e) => {
          // Toggle without swallowing the parent link's own navigation: the
          // chevron area toggles, the label still goes to the overview page.
          const el = e.target as HTMLElement;
          if (el.closest("[data-flyout-toggle]")) {
            e.preventDefault();
            e.stopPropagation();
            if (open) setOpen(false);
            else openNow();
          }
        }}
      >
        {trigger}
      </div>

      {/* Desktop: portal panel, escaping the sidebar's overflow clipping. */}
      {open &&
        rect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="group"
            aria-label={`${item.label} sections`}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{ top, left: rect.left }}
            className={cn(
              "fixed z-50 hidden min-w-56 lg:block",
              "rounded-xl border border-border/60 bg-popover p-1.5 shadow-lg",
              "animate-in fade-in-0 zoom-in-95 slide-in-from-left-1 duration-150",
            )}
          >
            {children.map((c) => (
              <div key={c.to}>
                {c.separatorBefore && <div className="my-1.5 border-t border-border/60" />}
                {childLink(c, false)}
              </div>
            ))}
          </div>,
          document.body,
        )}

      {/* Mobile / narrow: inline accordion. No floating panel on touch. */}
      <div
        className={cn(
          "grid lg:hidden",
          "transition-[grid-template-rows,opacity] duration-200 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="mt-0.5 space-y-0.5 pl-3">
            {children.map((c) => (
              <div key={c.to}>
                {c.separatorBefore && <div className="my-1.5 ml-2.5 border-t border-border/60" />}
                {childLink(c, true)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
