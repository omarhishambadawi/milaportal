import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bike, Copy, Crosshair, ExternalLink, Minus, Navigation, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KSA_OUTLINE_PATH, MAP_HEIGHT, MAP_WIDTH, projectPoint } from "@/lib/ksa-geo";
import type { MapCoverage } from "@/lib/maps/markers";
import { cn } from "@/lib/utils";
import { copyText } from "../clipboard";
import type { BranchView } from "../types";

/**
 * Interactive branch map.
 *
 * Built as an inline SVG with no mapping library and no tile server, which is a
 * deliberate choice rather than a shortcut:
 *
 *   - The app's Content-Security-Policy allows `connect-src` to self and
 *     Supabase only. A tile-based map would need that widened to a third-party
 *     host on every page load, weakening a policy that exists for good reasons.
 *   - The dashboard already ships a hand-drawn KSA map, so the two now share one
 *     outline (`@/lib/ksa-geo`) and read as one product rather than two.
 *   - 145 markers over a country outline is what this view has to show. Street
 *     geometry would be decoration; the branch is reached through the Google
 *     Maps link, which is what a driver actually uses.
 *
 * Pan and zoom are applied as a manual transform rather than an SVG `viewBox`
 * animation, because markers must keep a constant screen size while the land
 * scales — so the land sits in a scaled `<g>` and the markers are positioned in
 * screen space by hand.
 */

interface Viewport {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 40;
/** Zoom applied when a branch is selected from the list. */
const FOCUS_ZOOM = 12;
/** Screen-space grid used to collapse overlapping markers into clusters. */
const CLUSTER_CELL = 46;

interface Props {
  branches: BranchView[];
  selected: string | null;
  onSelect: (branchNo: string | null) => void;
  /** The delivery coverage ring, when the locator has resolved an origin. */
  coverage?: MapCoverage | null;
  /**
   * Marker colour, when the caller wants to encode something other than scooter
   * availability. Returning null falls back to the default.
   */
  toneFor?: (branch: BranchView) => "primary" | "positive" | "attention" | null;
  className?: string;
}

/** Marker/ring colours, as theme tokens. */
const TONE_COLOUR: Record<"primary" | "positive" | "attention", string> = {
  primary: "var(--primary)",
  positive: "var(--positive)",
  attention: "var(--attention)",
};

interface Placed {
  branch: BranchView;
  /** Position in projected (pre-transform) space. */
  px: number;
  py: number;
}

export function BranchMap({ branches, selected, onSelect, coverage, toneFor, className }: Props) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: MAP_WIDTH, height: MAP_HEIGHT });
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const animationRef = useRef(0);

  /* ---------------------------------------------------------------------- */
  /* Sizing                                                                  */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = () =>
      setSize({
        width: element.clientWidth || MAP_WIDTH,
        height: element.clientHeight || MAP_HEIGHT,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Base scale that fits the whole country into the frame, before user zoom.
   * `k` in the viewport is a multiplier on top of this, so k=1 always means
   * "the whole country", whatever the panel's aspect ratio.
   */
  const fit = useMemo(() => {
    const scale = Math.min(size.width / MAP_WIDTH, size.height / MAP_HEIGHT);
    return {
      scale,
      offsetX: (size.width - MAP_WIDTH * scale) / 2,
      offsetY: (size.height - MAP_HEIGHT * scale) / 2,
    };
  }, [size]);

  const toScreen = useCallback(
    (px: number, py: number) => ({
      x: (px * fit.scale + fit.offsetX) * view.k + view.x,
      y: (py * fit.scale + fit.offsetY) * view.k + view.y,
    }),
    [fit, view],
  );

  const placed: Placed[] = useMemo(
    () =>
      branches
        .filter((branch) => branch.latitude != null && branch.longitude != null)
        .map((branch) => {
          const [px, py] = projectPoint(branch.longitude as number, branch.latitude as number);
          return { branch, px, py };
        }),
    [branches],
  );

  /**
   * The coverage ring in screen coordinates.
   *
   * Recomputed with the camera, because `toScreen` already folds in the pan and
   * zoom — so the ring stays glued to the ground as the map moves instead of
   * being a fixed-size decal on the viewport.
   */
  const coverageRing = useMemo(() => {
    if (!coverage) return null;
    const [cx, cy] = projectPoint(coverage.center.lng, coverage.center.lat);
    // One radius due north of the centre. Latitude degrees are a constant
    // 111.32 km everywhere, which is what makes this the safe axis to measure on.
    const northLat = coverage.center.lat + coverage.radiusMetres / 111_320;
    const [, northY] = projectPoint(coverage.center.lng, northLat);
    const centre = toScreen(cx, cy);
    const edge = toScreen(cx, northY);
    const r = Math.abs(centre.y - edge.y);
    if (!Number.isFinite(r) || r <= 0) return null;
    return {
      x: centre.x,
      y: centre.y,
      r,
      colour: TONE_COLOUR[coverage.tone ?? "positive"],
    };
  }, [coverage, toScreen]);

  /* ---------------------------------------------------------------------- */
  /* Camera                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Tween the viewport. Cancels any tween already running. */
  const animateTo = useCallback((target: Viewport, duration = 420) => {
    cancelAnimationFrame(animationRef.current);
    const start = performance.now();
    let from: Viewport | null = null;
    const step = (now: number) => {
      setView((current) => {
        from ??= current;
        const t = Math.min(1, (now - start) / duration);
        // easeOutCubic — decelerating motion reads as the map settling rather
        // than snapping, without the overshoot a spring would add.
        const e = 1 - Math.pow(1 - t, 3);
        if (t >= 1) return target;
        return {
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          k: from.k + (target.k - from.k) * e,
        };
      });
      if (now - start < duration) animationRef.current = requestAnimationFrame(step);
    };
    animationRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => cancelAnimationFrame(animationRef.current), []);

  /** Centre the frame on a projected point at a given zoom. */
  const centreOn = useCallback(
    (px: number, py: number, k: number) => {
      const base = { x: px * fit.scale + fit.offsetX, y: py * fit.scale + fit.offsetY };
      animateTo({ x: size.width / 2 - base.x * k, y: size.height / 2 - base.y * k, k });
    },
    [fit, size, animateTo],
  );

  const reset = useCallback(() => animateTo({ x: 0, y: 0, k: 1 }), [animateTo]);

  /**
   * Follow the list's selection.
   *
   * Only pulls the camera in when the branch is off screen or the map is zoomed
   * out — clicking through a filtered list of Riyadh branches should nudge
   * between neighbours, not re-fly the camera from scratch on every click.
   */
  useEffect(() => {
    if (!selected) return;
    const target = placed.find((entry) => entry.branch.branch_no === selected);
    if (!target) return;
    const screen = toScreen(target.px, target.py);
    const margin = 60;
    const offScreen =
      screen.x < margin ||
      screen.y < margin ||
      screen.x > size.width - margin ||
      screen.y > size.height - margin;
    if (offScreen || view.k < FOCUS_ZOOM * 0.5) {
      centreOn(target.px, target.py, Math.max(view.k, FOCUS_ZOOM));
    }
    // `view` is read but deliberately not a dependency: reacting to it would
    // re-run this on every pan frame and fight the user for the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, placed, size, centreOn]);

  /* ---------------------------------------------------------------------- */
  /* Interaction                                                             */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    // Registered non-passively so the page does not scroll while zooming. React's
    // onWheel is passive by default and cannot preventDefault.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((current) => {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor));
        if (k === current.k) return current;
        // Keep the point under the cursor fixed: the standard zoom-to-pointer
        // identity, solved for the new translation.
        const rect = element.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const ratio = k / current.k;
        return { k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    // A few pixels of slop so a click on a marker is not read as a one-pixel
    // drag, which would swallow the selection.
    if (!dragging && Math.hypot(dx, dy) < 4) return;
    setDragging(true);
    cancelAnimationFrame(animationRef.current);
    setView((current) => ({ ...current, x: drag.vx + dx, y: drag.vy + dy }));
  };

  const endDrag = (event: React.PointerEvent) => {
    if (dragRef.current) {
      (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
      dragRef.current = null;
    }
    // Deferred so the click event that follows this pointerup still sees
    // `dragging` and can decide whether it was a real click.
    window.setTimeout(() => setDragging(false), 0);
  };

  /* ---------------------------------------------------------------------- */
  /* Clustering                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Collapse markers that would overlap into one bubble.
   *
   * Necessary rather than decorative: 39 Riyadh branches sit inside a few
   * hundred metres of each other at country zoom, which without clustering is a
   * single unreadable blob that also costs 39 DOM nodes to paint. Grouping is
   * done in *screen* space, so it dissolves naturally as the user zooms in.
   */
  const clusters = useMemo(() => {
    const cells = new Map<string, { x: number; y: number; members: Placed[] }>();
    for (const entry of placed) {
      const screen = toScreen(entry.px, entry.py);
      // Everything off-frame is dropped before it reaches the DOM.
      if (
        screen.x < -CLUSTER_CELL ||
        screen.y < -CLUSTER_CELL ||
        screen.x > size.width + CLUSTER_CELL ||
        screen.y > size.height + CLUSTER_CELL
      ) {
        // The selected branch is kept regardless, so its popover can still anchor.
        if (entry.branch.branch_no !== selected) continue;
      }
      const key = `${Math.floor(screen.x / CLUSTER_CELL)}:${Math.floor(screen.y / CLUSTER_CELL)}`;
      const cell = cells.get(key);
      if (cell) {
        cell.members.push(entry);
        cell.x += (screen.x - cell.x) / cell.members.length;
        cell.y += (screen.y - cell.y) / cell.members.length;
      } else {
        cells.set(key, { x: screen.x, y: screen.y, members: [entry] });
      }
    }
    return [...cells.values()];
  }, [placed, toScreen, size, selected]);

  const selectedEntry = placed.find((entry) => entry.branch.branch_no === selected) ?? null;
  const selectedScreen = selectedEntry ? toScreen(selectedEntry.px, selectedEntry.py) : null;
  const plottable = placed.length;
  const missing = branches.length - plottable;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-[var(--tint-map)] via-background to-background shadow-inner",
        className,
      )}
    >
      <div
        ref={frameRef}
        role="application"
        aria-label="Branch locations map"
        className={cn(
          "relative h-full w-full touch-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setView((c) => ({ ...c, k: Math.min(MAX_ZOOM, c.k * 1.8) }))}
      >
        <svg width={size.width} height={size.height} className="block select-none" aria-hidden>
          <defs>
            <linearGradient id="branch-map-land" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--map-land-top)" }} stopOpacity="0.95" />
              <stop
                offset="100%"
                style={{ stopColor: "var(--map-land-bottom)" }}
                stopOpacity="0.75"
              />
            </linearGradient>
            <pattern id="branch-map-grid" width="38" height="38" patternUnits="userSpaceOnUse">
              <path
                d="M 38 0 L 0 0 0 38"
                fill="none"
                style={{ stroke: "var(--map-grid)" }}
                strokeWidth="0.5"
                opacity="0.4"
              />
            </pattern>
          </defs>

          <rect width={size.width} height={size.height} fill="url(#branch-map-grid)" />

          {/* Land. Scaled with the camera; `vector-effect` keeps the coastline a
              hairline instead of a fat band at high zoom. */}
          <g
            transform={`translate(${view.x} ${view.y}) scale(${view.k}) translate(${fit.offsetX} ${fit.offsetY}) scale(${fit.scale})`}
          >
            <path
              d={KSA_OUTLINE_PATH}
              fill="url(#branch-map-land)"
              style={{ stroke: "var(--map-outline)" }}
              strokeWidth={1.4}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>

          {/*
            The delivery coverage ring, in screen space.

            Drawn between the land and the markers so it reads as ground shading
            rather than as something floating over the pins, and `pointerEvents:
            none` so a 10 km disc does not swallow the clicks of every marker
            inside it.

            The radius is measured rather than converted: projecting the centre
            and a second point one radius due north gives the pixel length of that
            distance under this projection and the current camera, which is
            exactly what the circle needs. A metres-per-pixel constant would drift
            with latitude, since the projection is equirectangular.
          */}
          {coverageRing && (
            <g style={{ pointerEvents: "none" }}>
              <circle
                cx={coverageRing.x}
                cy={coverageRing.y}
                r={coverageRing.r}
                fill={coverageRing.colour}
                fillOpacity={0.07}
                stroke={coverageRing.colour}
                strokeOpacity={0.85}
                strokeWidth={1.5}
                // The dash is dropped once the ring is small. At country zoom
                // 10 km is a handful of pixels across, and a 6-4 dash on a
                // circumference that short renders as three detached specks that
                // read as artefacts rather than as a boundary. The ring itself is
                // never faked bigger than it is — the radius stays honest at every
                // zoom, it just draws solid when it is tiny.
                strokeDasharray={coverageRing.r >= 24 ? "6 4" : undefined}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={coverageRing.x}
                cy={coverageRing.y}
                r={3}
                fill={coverageRing.colour}
                stroke="var(--card)"
                strokeWidth={1}
              />
            </g>
          )}

          {/* Markers, in screen space so they stay a constant size. */}
          {clusters.map((cluster) => {
            const count = cluster.members.length;
            if (count === 1) {
              const entry = cluster.members[0];
              const branch = entry.branch;
              const isSelected = branch.branch_no === selected;
              const isHovered = branch.branch_no === hovered;
              const radius = isSelected ? 9 : isHovered ? 7.5 : 6;
              // The caller's encoding wins when it supplies one — in locator mode
              // that is coverage, which matters more than scooter availability
              // because it decides whether the branch can serve the order at all.
              const tone = toneFor?.(branch);
              const colour = tone
                ? TONE_COLOUR[tone]
                : branch.scooter
                  ? "var(--positive)"
                  : "var(--primary)";
              return (
                <g
                  key={branch.branch_no}
                  transform={`translate(${cluster.x} ${cluster.y})`}
                  style={{ cursor: "pointer" }}
                  onPointerEnter={() => setHovered(branch.branch_no)}
                  onPointerLeave={() => setHovered((h) => (h === branch.branch_no ? null : h))}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!dragging) onSelect(isSelected ? null : branch.branch_no);
                  }}
                >
                  {isSelected && (
                    <circle r={radius + 8} fill={colour} fillOpacity={0.18}>
                      <animate
                        attributeName="r"
                        values={`${radius + 4};${radius + 14};${radius + 4}`}
                        dur="2s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="fill-opacity"
                        values="0.28;0;0.28"
                        dur="2s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  )}
                  <circle
                    r={radius}
                    fill={colour}
                    fillOpacity={isSelected ? 0.95 : 0.75}
                    stroke="var(--card)"
                    strokeWidth={2}
                    style={{ transition: "r 150ms ease" }}
                  />
                  {/* A generous invisible hit target — a 6px dot is not a
                      comfortable click, least of all on a touch screen. */}
                  <circle r={16} fill="transparent" />
                </g>
              );
            }

            const radius = Math.min(22, 11 + Math.log2(count) * 3);
            const withScooter = cluster.members.filter((m) => m.branch.scooter).length;
            return (
              <g
                key={`cluster-${cluster.x.toFixed(0)}-${cluster.y.toFixed(0)}-${count}`}
                transform={`translate(${cluster.x} ${cluster.y})`}
                style={{ cursor: "zoom-in" }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (dragging) return;
                  // Zoom toward the cluster until it splits, rather than jumping
                  // to max zoom — two taps to reach a branch beats one that
                  // overshoots past its neighbours.
                  const first = cluster.members[0];
                  centreOn(first.px, first.py, Math.min(MAX_ZOOM, view.k * 3.2));
                }}
              >
                <circle
                  r={radius + 5}
                  fill={withScooter > count / 2 ? "var(--positive)" : "var(--primary)"}
                  fillOpacity={0.16}
                />
                <circle
                  r={radius}
                  fill={withScooter > count / 2 ? "var(--positive)" : "var(--primary)"}
                  fillOpacity={0.85}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
                <text
                  textAnchor="middle"
                  dy="0.35em"
                  fontSize={Math.max(10, radius * 0.75)}
                  fontWeight={700}
                  fill="var(--primary-foreground)"
                  style={{ pointerEvents: "none" }}
                >
                  {count}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Marker popover. HTML rather than SVG so it inherits the app's card
            styling and its buttons are real buttons. */}
        {selectedEntry && selectedScreen && (
          <div
            className="pointer-events-auto absolute z-20 w-[min(19rem,80vw)] rounded-xl border border-border/60 bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur-sm animate-in fade-in zoom-in-95 duration-150"
            style={{
              left: Math.min(Math.max(selectedScreen.x, 12), Math.max(12, size.width - 12)),
              top: selectedScreen.y,
              // Flip above the marker unless that would clip the top of the frame.
              transform:
                selectedScreen.y > 190
                  ? "translate(-50%, calc(-100% - 18px))"
                  : "translate(-50%, 18px)",
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-sm font-bold">{selectedEntry.branch.branch_no}</p>
                <p className="truncate text-xs text-muted-foreground" dir="auto">
                  {selectedEntry.branch.city}
                  {selectedEntry.branch.cityEnglish && ` · ${selectedEntry.branch.cityEnglish}`}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => onSelect(null)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <p className="mt-2 text-xs text-foreground/90">
              {selectedEntry.branch.working_hours ?? "Hours not recorded"}
            </p>
            {selectedEntry.branch.scooter && (
              <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--positive)]">
                <Bike className="h-3 w-3" />
                {selectedEntry.branch.scooter_note ?? "Scooter delivery"}
              </p>
            )}
            {selectedEntry.branch.address && (
              <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground" dir="auto">
                {selectedEntry.branch.address}
              </p>
            )}

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {selectedEntry.branch.mapsLink && (
                <Button size="sm" variant="default" className="h-7 text-xs" asChild>
                  <a href={selectedEntry.branch.mapsLink} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" />
                    Google Maps
                  </a>
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => copyText(selectedEntry.branch.address ?? "", "Address")}
              >
                <Copy className="h-3 w-3" />
                Copy address
              </Button>
              {selectedEntry.branch.navLink && (
                <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                  <a href={selectedEntry.branch.navLink} target="_blank" rel="noopener noreferrer">
                    <Navigation className="h-3 w-3" />
                    Navigate
                  </a>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-border/60 bg-card/90 p-1 shadow-sm backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Zoom in"
          onClick={() => setView((c) => ({ ...c, k: Math.min(MAX_ZOOM, c.k * 1.6) }))}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Zoom out"
          onClick={() =>
            setView((c) => {
              const k = Math.max(MIN_ZOOM, c.k / 1.6);
              // Snap the pan back to centre as the map returns to full extent,
              // so zooming out never strands the country off-screen.
              return k === MIN_ZOOM ? { x: 0, y: 0, k } : { ...c, k };
            })
          }
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Reset view"
          onClick={reset}
        >
          <Crosshair className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded-full border border-border/60 bg-card/90 px-2.5 py-1 font-medium text-muted-foreground backdrop-blur-sm">
          {plottable} on map
          {missing > 0 && <span className="opacity-70"> · {missing} without coordinates</span>}
        </span>
        <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/90 px-2.5 py-1 backdrop-blur-sm">
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: "var(--positive)" }}
              aria-hidden
            />
            Scooter
          </span>
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: "var(--primary)" }}
              aria-hidden
            />
            No scooter
          </span>
        </span>
      </div>
    </div>
  );
}
