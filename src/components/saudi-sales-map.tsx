import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { placeFloatingCard } from "@/lib/floating-card";
import { KSA_OUTLINE_PATH, MAP_HEIGHT, MAP_WIDTH, projectPoint } from "@/lib/ksa-geo";
import { MapPin, TrendingUp } from "lucide-react";

/**
 * Saudi Arabia sales heat map — enterprise-grade inline SVG.
 * No external deps. Brand palette, premium gradients, glow layers,
 * collision-aware labels, reduced-motion aware, dark-mode tuned.
 */

// Approximate lat/lon for major Saudi cities. Keys stored in normalized form.
const CITY_COORDS: Record<string, [number, number]> = {
  riyadh: [46.6753, 24.7136],
  jeddah: [39.1925, 21.4858],
  mecca: [39.8579, 21.3891],
  makkah: [39.8579, 21.3891],
  medina: [39.6142, 24.4686],
  madinah: [39.6142, 24.4686],
  dammam: [50.1033, 26.4207],
  khobar: [50.2083, 26.2172],
  dhahran: [50.1033, 26.2361],
  qatif: [50.0089, 26.5205],
  jubail: [49.6225, 27.0046],
  hofuf: [49.5877, 25.3548],
  ahsa: [49.5877, 25.3548],
  ihsa: [49.5877, 25.3548],
  taif: [40.4155, 21.2703],
  abha: [42.5053, 18.2164],
  khamis: [42.7326, 18.306],
  najran: [44.1277, 17.4924],
  jazan: [42.5511, 16.8892],
  jizan: [42.5511, 16.8892],
  bisha: [42.5906, 20.0],
  tabuk: [36.5662, 28.3838],
  hail: [41.6907, 27.5219],
  buraidah: [43.9757, 26.326],
  qassim: [43.9757, 26.326],
  unaizah: [43.9931, 26.0843],
  yanbu: [38.0618, 24.0895],
  rabigh: [39.0347, 22.7986],
  kharj: [47.305, 24.1556],
  arar: [41.0381, 30.9753],
  sakaka: [40.2064, 29.9697],
  qurayyat: [37.3353, 31.332],
  hafar: [45.9636, 28.4337],
  baha: [41.4677, 20.0129],
  rafha: [43.4939, 29.6202],
  الرياض: [46.6753, 24.7136],
  جدة: [39.1925, 21.4858],
  مكة: [39.8579, 21.3891],
  المدينة: [39.6142, 24.4686],
  الدمام: [50.1033, 26.4207],
  الخبر: [50.2083, 26.2172],
  الظهران: [50.1033, 26.2361],
  القطيف: [50.0089, 26.5205],
  الجبيل: [49.6225, 27.0046],
  الهفوف: [49.5877, 25.3548],
  الإحساء: [49.5877, 25.3548],
  الاحساء: [49.5877, 25.3548],
  الطائف: [40.4155, 21.2703],
  أبها: [42.5053, 18.2164],
  "خميس مشيط": [42.7326, 18.306],
  نجران: [44.1277, 17.4924],
  جازان: [42.5511, 16.8892],
  بيشة: [42.5906, 20.0],
  تبوك: [36.5662, 28.3838],
  حائل: [41.6907, 27.5219],
  بريدة: [43.9757, 26.326],
  القصيم: [43.9757, 26.326],
  عنيزة: [43.9931, 26.0843],
  ينبع: [38.0618, 24.0895],
  رابغ: [39.0347, 22.7986],
  الخرج: [47.305, 24.1556],
  عرعر: [41.0381, 30.9753],
  سكاكا: [40.2064, 29.9697],
  القريات: [37.3353, 31.332],
  "حفر الباطن": [45.9636, 28.4337],
  الباحة: [41.4677, 20.0129],
  رفحاء: [43.4939, 29.6202],
};

// Outline, projection bounds and the projection itself now live in
// `@/lib/ksa-geo` — the Branch Directory map draws the same country, and two
// copies of a 57-vertex polygon is one edit away from two different shapes.
const W = MAP_WIDTH;
const H = MAP_HEIGHT;
const project = projectPoint;

function normalizeCity(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^al[- ]/, "")
    .replace(/^ال/, "")
    .replace(/[’'ـ]/g, "");
}

function lookupCoords(name: string): [number, number] | undefined {
  if (CITY_COORDS[name]) return CITY_COORDS[name];
  const key = normalizeCity(name);
  if (CITY_COORDS[key]) return CITY_COORDS[key];
  const hit = Object.entries(CITY_COORDS).find(([k]) => {
    const nk = normalizeCity(k);
    return nk && (nk === key || nk.includes(key) || key.includes(nk));
  });
  return hit?.[1];
}

/**
 * City labels render the city's own name.
 *
 * There used to be a hard-coded visual swap here that printed "الطائف" over the
 * Jeddah point and vice versa. The coordinates for both cities were already
 * correct (Jeddah 39.19/21.49, Taif 40.42/21.27), so the swap was itself the
 * bug being reported: each point showed its neighbour's name. Labels follow the
 * data — no per-city special cases.
 */


export interface CitySales {
  name: string;
  sales: number;
  count: number;
  total?: number;
  completed?: number;
}

type Placed = CitySales & {
  lon: number;
  lat: number;
  cx: number;
  cy: number;
  r: number;
  ratio: number;
  share: number;
  rank: number;
  tier: "low" | "mid" | "high";
  color: string;
  labelX: number;
  labelY: number;
  anchor: "start" | "end" | "middle";
};

/**
 * The heat ramp, as theme tokens rather than literals.
 *
 * These were three hard-coded HSL values, so the same teal/amber/red was
 * painted onto a near-white land mass and a near-black one — the "Low" teal in
 * particular sat around 2:1 against the dark map, which is not a colour anyone
 * can read a rank off. The tokens carry a light and a dark value each; the
 * ordering cool → warm → hot is what encodes the tier, not the absolute hue.
 */
const HEAT = {
  low: "var(--heat-low)",
  mid: "var(--heat-mid)",
  high: "var(--heat-high)",
} as const;

/**
 * Height of one city label's collision box, in SVG units.
 *
 * Shared by the label solver and the tooltip's offset calculation — they are
 * reasoning about the same rectangle, and two copies of the number is how the
 * card ends up half a line over the name it is describing.
 */
const LABEL_HEIGHT = 16;

/**
 * A colour derived from one of the heat tokens.
 *
 * `${color}66` — appending a hex alpha pair — is what the literals allowed and
 * what a `var()` does not: it produces `var(--heat-low)66`, which is not a
 * colour and silently drops the declaration. Every translucent use goes through
 * here instead.
 */
function heatAlpha(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export function SaudiSalesMap({ cities }: { cities: CitySales[] }) {
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cityRefs = useRef<Map<string, SVGCircleElement>>(new Map());
  const tooltipId = "saudi-map-tooltip";
  const liveRegionId = "saudi-map-live";
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const t = window.setTimeout(() => setMounted(true), 30);
    return () => window.clearTimeout(t);
  }, []);

  const outlinePath = KSA_OUTLINE_PATH;

  const tierOf = (ratio: number): "low" | "mid" | "high" =>
    ratio < 0.34 ? "low" : ratio < 0.67 ? "mid" : "high";

  const colorFor = (tier: "low" | "mid" | "high") => HEAT[tier];

  const totalCompleted = useMemo(() => cities.reduce((s, c) => s + (c.sales || 0), 0), [cities]);

  const placed: Placed[] = useMemo(() => {
    const raw = cities
      .map((c) => {
        const coords = lookupCoords(c.name);
        if (!coords) return null;
        const [lon, lat] = coords;
        const [cx, cy] = project(lon, lat);
        return { c, lon, lat, cx, cy };
      })
      .filter((v): v is NonNullable<typeof v> => !!v);

    const maxSales = Math.max(1, ...raw.map((p) => p.c.sales));

    // Sort by sales desc so largest bubbles get first pick on labels
    raw.sort((a, b) => b.c.sales - a.c.sales);

    const PAD = 10;
    const placedLabels: { x: number; y: number; w: number; h: number }[] = [];
    const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
      placedLabels.some(
        (p) => !(r.x + r.w < p.x || p.x + p.w < r.x || r.y + r.h < p.y || p.y + p.h < r.y),
      );

    const out: Placed[] = raw.map(({ c, lon, lat, cx, cy }, idx) => {
      const ratio = c.sales / maxSales;
      const share = totalCompleted > 0 ? c.sales / totalCompleted : 0;
      const r = 7 + Math.sqrt(ratio) * 28;
      const tier = tierOf(ratio);
      const color = colorFor(tier);
      const labelW = Math.max(44, c.name.length * 7.6) + 6;
      const labelH = LABEL_HEIGHT;
      const gap = 8;

      const build = (dist: number) => [
        { x: cx + r + dist, y: cy + 4, anchor: "start" as const },
        { x: cx - r - dist, y: cy + 4, anchor: "end" as const },
        { x: cx, y: cy - r - dist, anchor: "middle" as const },
        { x: cx, y: cy + r + dist + labelH - 4, anchor: "middle" as const },
        { x: cx + r + dist * 0.7, y: cy - r - dist * 0.4, anchor: "start" as const },
        { x: cx - r - dist * 0.7, y: cy - r - dist * 0.4, anchor: "end" as const },
        { x: cx + r + dist * 0.7, y: cy + r + dist * 0.4 + labelH - 4, anchor: "start" as const },
        { x: cx - r - dist * 0.7, y: cy + r + dist * 0.4 + labelH - 4, anchor: "end" as const },
      ];

      const rectFor = (cand: { x: number; y: number; anchor: "start" | "end" | "middle" }) => {
        const rectX =
          cand.anchor === "start"
            ? cand.x
            : cand.anchor === "end"
              ? cand.x - labelW
              : cand.x - labelW / 2;
        return { x: rectX, y: cand.y - labelH + 2, w: labelW, h: labelH };
      };

      let chosen: { x: number; y: number; anchor: "start" | "end" | "middle" } | null = null;
      for (const dist of [gap, gap + 8, gap + 18, gap + 30]) {
        for (const cand of build(dist)) {
          const rect = rectFor(cand);
          if (
            rect.x < PAD ||
            rect.x + rect.w > W - PAD ||
            rect.y < PAD ||
            rect.y + rect.h > H - PAD
          )
            continue;
          if (!overlaps(rect)) {
            chosen = cand;
            placedLabels.push(rect);
            break;
          }
        }
        if (chosen) break;
      }

      if (!chosen) {
        for (const cand of build(gap)) {
          const rect = rectFor(cand);
          const clampedX = Math.min(Math.max(rect.x, PAD), W - PAD - rect.w);
          const clampedY = Math.min(Math.max(rect.y, PAD), H - PAD - rect.h);
          const dx = clampedX - rect.x;
          const dy = clampedY - rect.y;
          chosen = { x: cand.x + dx, y: cand.y + dy, anchor: cand.anchor };
          placedLabels.push({ ...rect, x: clampedX, y: clampedY });
          break;
        }
      }

      return {
        ...c,
        lon,
        lat,
        cx,
        cy,
        r,
        ratio,
        share,
        rank: idx + 1,
        tier,
        color,
        labelX: chosen!.x,
        labelY: chosen!.y,
        anchor: chosen!.anchor,
      };
    });

    return out;
  }, [cities, totalCompleted]);

  const activeName = pinned ?? hoverName;
  const hover = placed.find((p) => p.name === activeName) ?? null;
  const sortedByRank = useMemo(() => [...placed].sort((a, b) => a.rank - b.rank), [placed]);

  /**
   * Pointer position in SVG user units.
   *
   * Via `getScreenCTM`, not by scaling the client rect: the SVG carries
   * `preserveAspectRatio="xMidYMid meet"` under a `max-h` clamp, so whenever the
   * height cap bites, the viewBox is letterboxed inside the element and a naive
   * `(clientX - rect.left) / rect.width * W` is wrong by the letterbox offset.
   * The CTM already knows the real mapping.
   */
  const svgPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  /**
   * The city a pointer at (x, y) is asking about — nearest wins, within reach.
   *
   * This replaces per-city hit circles, which could not work here. The old
   * radius was `min(max(r, 8), nearest/2 - 1)` — capped at half the distance to
   * the neighbouring city so two targets never overlapped — and the Eastern
   * Province is four cities inside seven SVG units: Khobar and Dhahran are 4.2
   * units apart, so every one of them collapsed to the `max(4, …)` floor. A
   * radius-4 target in a 900-unit viewBox is about seven screen pixels across,
   * which is why hovering "did not reliably show the tooltip".
   *
   * Nearest-marker has no such failure mode: the whole map is live, every city
   * owns the region closest to it, and no city can be occluded by another. The
   * reach cap is what stops the empty Rub' al Khali from claiming a tooltip.
   */
  const cityAt = (x: number, y: number): Placed | null => {
    let best: Placed | null = null;
    let bestDistance = Infinity;
    for (const p of placed) {
      const d = Math.hypot(p.cx - x, p.cy - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = p;
      }
    }
    if (!best) return null;
    return bestDistance <= Math.max(best.r + 34, 56) ? best : null;
  };

  const handlePointer = (clientX: number, clientY: number): Placed | null => {
    const pt = svgPoint(clientX, clientY);
    if (!pt) return null;
    const next = cityAt(pt.x, pt.y);
    setHoverName(next?.name ?? null);
    return next;
  };

  const focusCityByOffset = (currentName: string, offset: number) => {
    const idx = sortedByRank.findIndex((p) => p.name === currentName);
    if (idx < 0) return;
    const nextIdx = (idx + offset + sortedByRank.length) % sortedByRank.length;
    const next = sortedByRank[nextIdx];
    setPinned(next.name);
    setHoverName(next.name);
    cityRefs.current.get(next.name)?.focus();
  };

  const ariaLabelFor = (p: Placed) => {
    const parts = [
      `${p.name}, rank ${p.rank} of ${placed.length}`,
      `${fmtSAR(p.sales)} completed sales`,
      `${p.count} ${p.count === 1 ? "order" : "orders"}`,
      `${(p.share * 100).toFixed(1)} percent share`,
    ];
    return parts.join(", ");
  };

  const unmapped = cities.filter((c) => !lookupCoords(c.name));

  return (
    <Card className="overflow-hidden border-border/60 bg-gradient-to-br from-card via-card to-card/90 shadow-sm hover:shadow-md transition-shadow duration-500">
      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 ring-1 ring-primary/20">
              <MapPin className="h-4 w-4 text-primary" aria-hidden />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base font-semibold tracking-tight truncate">
                Sales by city — Saudi Arabia
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Geographic distribution of completed sales
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
              {placed.length} {placed.length === 1 ? "city" : "cities"}
            </span>
            {totalCompleted > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-foreground/80">
                <TrendingUp className="h-3 w-3 text-[var(--positive)]" />
                {fmtSAR(totalCompleted)}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3 sm:p-5">
        <div
          className="relative w-full overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-[var(--tint-map)] via-background to-background shadow-inner"
          style={{
            backgroundImage:
              "radial-gradient(ellipse 60% 50% at 55% 55%, color-mix(in oklab, var(--primary) 6%, transparent), transparent 70%)",
          }}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            // Shorter on a phone than it was, because the map is no longer the
            // only way to read this: the ranked list below it wants to be above
            // the fold too, and 64vh of bubbles left it entirely off screen.
            className="block h-auto max-h-[min(44vh,420px)] w-full sm:max-h-[min(64vh,560px)]"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Saudi Arabia sales heat map"
          >
            <defs>
              <linearGradient id="ksa-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: "var(--map-land-top)" }} stopOpacity="0.95" />
                <stop
                  offset="100%"
                  style={{ stopColor: "var(--map-land-bottom)" }}
                  stopOpacity="0.7"
                />
              </linearGradient>
              <radialGradient id="ksa-inner-glow" cx="50%" cy="50%" r="60%">
                <stop offset="0%" style={{ stopColor: "var(--map-land-top)" }} stopOpacity="0" />
                <stop
                  offset="100%"
                  style={{ stopColor: "var(--map-outline)" }}
                  stopOpacity="0.25"
                />
              </radialGradient>
              <filter id="ksa-shadow" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
                <feOffset dx="0" dy="3" result="offset" />
                <feComponentTransfer>
                  <feFuncA type="linear" slope="0.2" />
                </feComponentTransfer>
                <feMerge>
                  <feMergeNode />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="bubble-glow" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
              </filter>
              <filter id="bubble-shadow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
                <feOffset dx="0" dy="1.5" result="offset" />
                <feComponentTransfer>
                  <feFuncA type="linear" slope="0.4" />
                </feComponentTransfer>
                <feMerge>
                  <feMergeNode />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path
                  d="M 40 0 L 0 0 0 40"
                  fill="none"
                  style={{ stroke: "var(--map-grid)" }}
                  strokeWidth="0.5"
                  opacity="0.35"
                />
              </pattern>
              {placed.map((p) => (
                <radialGradient
                  key={`grad-${p.name}`}
                  id={`bg-${slug(p.name)}`}
                  cx="50%"
                  cy="50%"
                  r="50%"
                >
                  <stop offset="0%" stopColor={p.color} stopOpacity="0.55" />
                  <stop offset="70%" stopColor={p.color} stopOpacity="0.18" />
                  <stop offset="100%" stopColor={p.color} stopOpacity="0" />
                </radialGradient>
              ))}
            </defs>

            <rect width={W} height={H} fill="url(#grid)" />

            {/* Animated country outline draw-on */}
            <path
              d={outlinePath}
              fill="url(#ksa-fill)"
              style={{ stroke: "var(--map-outline)" }}
              strokeWidth={1.5}
              strokeLinejoin="round"
              filter="url(#ksa-shadow)"
              opacity={mounted ? 1 : 0}
              className="transition-opacity duration-700 ease-out"
            />
            <path
              d={outlinePath}
              fill="url(#ksa-inner-glow)"
              style={{ pointerEvents: "none" }}
              opacity={0.6}
            />

            {/* Leader lines */}
            {placed.map((p) => {
              const active = hoverName === p.name;
              const tx =
                p.anchor === "start" ? p.labelX - 2 : p.anchor === "end" ? p.labelX + 2 : p.labelX;
              const ty = p.anchor === "middle" && p.labelY < p.cy ? p.labelY + 3 : p.labelY - 4;
              return (
                <line
                  key={`ln-${p.name}`}
                  x1={p.cx}
                  y1={p.cy}
                  x2={tx}
                  y2={ty}
                  style={{
                    stroke: "var(--map-leader)",
                    transition: "opacity 220ms ease",
                    // A stroked line is a pointer target by default, and these
                    // criss-cross the map between every bubble and its label.
                    pointerEvents: "none",
                  }}
                  strokeWidth={0.7}
                  opacity={active ? 0.95 : 0.35}
                  strokeDasharray={active ? "0" : "2 3"}
                />
              );
            })}

            {/* Outer glow halos (largest first) */}
            {placed.map((p) => {
              const active = hoverName === p.name;
              return (
                <circle
                  key={`glow-${p.name}`}
                  cx={p.cx}
                  cy={p.cy}
                  r={p.r * (active ? 2.45 : 1.7)}
                  fill={`url(#bg-${slug(p.name)})`}
                  style={{
                    pointerEvents: "none",
                    opacity: reducedMotion || mounted ? (active ? 1 : 0.7) : 0,
                    transition: "opacity 400ms ease, r 260ms cubic-bezier(.34,1.4,.5,1)",
                  }}
                />
              );
            })}

            {/* Bubbles — largest first so smallest paint on top */}
            {placed.map((p, i) => {
              const active = hoverName === p.name;
              const topThree = p.rank <= 3 && !reducedMotion;
              return (
                <g
                  key={p.name}
                  style={{
                    pointerEvents: "none",
                    transformOrigin: `${p.cx}px ${p.cy}px`,
                    // Under reduced motion the staggered scale-in is skipped
                    // entirely — the bubbles are simply there — while the hover
                    // emphasis is kept, since that one carries meaning.
                    transform: reducedMotion
                      ? active
                        ? "scale(1.06)"
                        : "scale(1)"
                      : mounted
                        ? active
                          ? "scale(1.08)"
                          : "scale(1)"
                        : "scale(0)",
                    opacity: reducedMotion || mounted ? 1 : 0,
                    transition: reducedMotion
                      ? "transform 160ms ease"
                      : `transform 520ms cubic-bezier(.34,1.4,.5,1) ${i * 40}ms, opacity 340ms ease ${i * 40}ms`,
                  }}
                >

                  {/* Soft pulse for top cities */}
                  {topThree && (
                    <circle
                      cx={p.cx}
                      cy={p.cy}
                      r={p.r}
                      fill="none"
                      stroke={p.color}
                      strokeWidth={1.25}
                      strokeOpacity={0.5}
                    >
                      <animate
                        attributeName="r"
                        values={`${p.r};${p.r + 12};${p.r}`}
                        dur="2.6s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="stroke-opacity"
                        values="0.55;0;0.55"
                        dur="2.6s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  )}
                  <circle
                    cx={p.cx}
                    cy={p.cy}
                    r={p.r}
                    fill={p.color}
                    fillOpacity={active ? 0.38 : 0.24}
                  />
                  <circle
                    cx={p.cx}
                    cy={p.cy}
                    r={p.r}
                    fill="none"
                    stroke={p.color}
                    strokeWidth={active ? 2.5 : 1.6}
                    strokeOpacity={0.95}
                    style={{ transition: "stroke-width 200ms ease, stroke-opacity 200ms ease" }}
                  />
                  <circle
                    cx={p.cx}
                    cy={p.cy}
                    r={active ? 4.6 : 3.4}
                    fill={p.color}
                    filter="url(#bubble-shadow)"
                    style={{ transition: "r 200ms ease" }}
                  />
                  {/* Inner highlight for depth */}
                  <circle
                    cx={p.cx - p.r * 0.25}
                    cy={p.cy - p.r * 0.25}
                    r={p.r * 0.18}
                    fill="white"
                    fillOpacity={0.35}
                  />
                </g>
              );
            })}

            {/* Hover accent ring */}
            {hover && !reducedMotion && (
              <g style={{ pointerEvents: "none" }}>
                <circle
                  cx={hover.cx}
                  cy={hover.cy}
                  r={hover.r + 3}
                  fill="none"
                  stroke={hover.color}
                  strokeWidth={1.2}
                  strokeOpacity={0.55}
                >
                  <animate
                    attributeName="r"
                    from={hover.r}
                    to={hover.r + 14}
                    dur="1.4s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="stroke-opacity"
                    from="0.6"
                    to="0"
                    dur="1.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              </g>
            )}

            {/*
              Labels, painted last.

              They used to come *before* the expanding accent ring and before the
              hovered bubble's enlarged glow halo, so hovering a city drew its own
              hover chrome straight over its name — the ring's stroke and the
              halo's gradient both landed on the glyphs, and against the halo's
              own background-coloured outline the text read as smeared or gone.
              SVG has no z-index; paint order *is* the stacking, so the fix is to
              be last rather than to fight it.

              Within the pass the active city is sorted to the end as well. Labels
              can legitimately overlap each other where the collision solver ran
              out of candidate positions and fell back to clamping, and the one
              the agent is pointing at should win that.
            */}
            {[...placed]
              .sort((a, b) => Number(a.name === hoverName) - Number(b.name === hoverName))
              .map((p) => {
                const active = hoverName === p.name;
                return (
                  <g
                    key={`lbl-${p.name}`}
                    style={{
                      opacity: reducedMotion || mounted ? 1 : 0,
                      transition: reducedMotion ? "none" : "opacity 340ms ease 260ms",
                      pointerEvents: "none",
                    }}
                  >
                    <text
                      x={p.labelX}
                      y={p.labelY}
                      textAnchor={p.anchor}
                      fontSize={11.5}
                      fontWeight={active ? 700 : 600}
                      // A wider, fully opaque halo than before. It is the only
                      // thing separating a label from the bubble fill, the glow
                      // gradient and the grid behind it, and at 0.98 the land mass
                      // bled through the outline enough to soften every glyph.
                      strokeWidth={active ? 4.5 : 4}
                      strokeOpacity={1}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      style={{
                        fill: "var(--map-label)",
                        stroke: "var(--map-label-halo)",
                        letterSpacing: 0.15,
                        fontFeatureSettings: '"kern"',
                        textRendering: "geometricPrecision",
                        transition: "stroke-width 200ms ease",
                      }}
                    >
                      {p.name}
                    </text>
                  </g>
                );
              })}

            {/*
              Keyboard targets.

              `pointerEvents: none` on purpose — the pointer is served by the
              nearest-marker layer below, and leaving these live would reinstate
              the occlusion problem they used to have. Focusability is
              unaffected: `pointer-events` governs hit testing, not the tab
              order, so every city is still reachable by keyboard and still
              draws its focus ring.
            */}
            {placed.map((p) => {
              const isActive = activeName === p.name;
              // Deliberately no `<title>` child. SVG `title` renders as the
              // *browser's own* tooltip — the small bordered box that appears
              // beside the cursor after a delay — so hovering a city produced
              // two overlapping readouts: the styled card and a bare native
              // label repeating the city name across it. `aria-label` below is
              // what the title was really contributing, and it stays.
              return (
                <circle
                  key={`hit-${p.name}`}
                  ref={(el) => {
                    if (el) cityRefs.current.set(p.name, el);
                    else cityRefs.current.delete(p.name);
                  }}
                  cx={p.cx}
                  cy={p.cy}
                  r={Math.max(p.r, 10)}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={ariaLabelFor(p)}
                  aria-describedby={isActive ? tooltipId : undefined}
                  aria-pressed={pinned === p.name}
                  style={{ pointerEvents: "none", outline: "none" }}
                  onFocus={() => {
                    setHoverName(p.name);
                    setPinned(p.name);
                  }}
                  onBlur={(e) => {
                    // Only clear when focus leaves the map entirely.
                    const svg = svgRef.current;
                    const next = e.relatedTarget as Node | null;
                    if (!svg || !next || !svg.contains(next)) {
                      setPinned((cur) => (cur === p.name ? null : cur));
                      setHoverName((cur) => (cur === p.name ? null : cur));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPinned((cur) => (cur === p.name ? null : p.name));
                    } else if (e.key === "Escape") {
                      setPinned(null);
                      setHoverName(null);
                      (e.currentTarget as SVGCircleElement).blur();
                    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                      e.preventDefault();
                      focusCityByOffset(p.name, 1);
                    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                      e.preventDefault();
                      focusCityByOffset(p.name, -1);
                    } else if (e.key === "Home") {
                      e.preventDefault();
                      const first = sortedByRank[0];
                      if (first) {
                        setPinned(first.name);
                        setHoverName(first.name);
                        cityRefs.current.get(first.name)?.focus();
                      }
                    } else if (e.key === "End") {
                      e.preventDefault();
                      const last = sortedByRank[sortedByRank.length - 1];
                      if (last) {
                        setPinned(last.name);
                        setHoverName(last.name);
                        cityRefs.current.get(last.name)?.focus();
                      }
                    }
                  }}
                  className="focus-visible:[stroke:var(--ring)] focus-visible:[stroke-width:2.5]"
                />
              );
            })}

            {/*
              The pointer surface — last, so it is on top of everything.

              One transparent rectangle over the whole map that resolves the
              pointer to its nearest city. Every marker is therefore always
              reachable, no marker can be hidden behind another, and there are no
              dead zones between them. `touch-action: manipulation` keeps a tap
              from being held back by double-tap-to-zoom detection.
            */}
            <rect
              width={W}
              height={H}
              fill="transparent"
              style={{ cursor: hoverName ? "pointer" : "default", touchAction: "manipulation" }}
              onPointerMove={(e) => handlePointer(e.clientX, e.clientY)}
              onPointerLeave={() => setHoverName(null)}
              onPointerDown={(e) => {
                // Touch has no hover to precede the tap, so resolve the city on
                // the press itself rather than waiting for a move that will
                // never come.
                if (e.pointerType === "touch") handlePointer(e.clientX, e.clientY);
              }}
              onClick={(e) => {
                const next = handlePointer(e.clientX, e.clientY);
                // Clicking bare desert clears the pin rather than leaving a
                // card stuck to a city the pointer has long since left.
                setPinned((cur) => (next && cur !== next.name ? next.name : null));
              }}
            />
          </svg>

          {/* Screen-reader live region — announces the active city on focus/hover. */}
          <div id={liveRegionId} aria-live="polite" aria-atomic="true" className="sr-only">
            {hover ? ariaLabelFor(hover) : ""}
          </div>

          {/*
            The floating readout, on pointer-sized screens only.

            Rendered into a portal on `document.body` and positioned with
            `position: fixed` against the hovered bubble's own client rect, so
            the map container's `overflow-hidden` (and any scroll parent) can no
            longer clip it. The card measures itself and then flips above/below
            and clamps left/right so it always stays inside the viewport.

            Below `sm` the same content renders in the panel underneath the map.
          */}
          {mounted && hover && (
            <FloatingCityCard
              key={hover.name}
              id={tooltipId}
              city={hover}
              getAnchor={() => cityRefs.current.get(hover.name) ?? null}
            />
          )}
        </div>

        {/*
          Mobile: the readout as a panel, and a ranked list to drive it.

          Hitting a 12px bubble with a thumb is not a way to read a chart, and it
          was the only way in. The list is the same data in the order anyone
          actually wants it, each row is a 40px target, and tapping one pins the
          city so the map and the panel both follow.
        */}
        <div className="mt-3 sm:hidden">
          {hover ? (
            <div
              className="rounded-2xl border border-border/60 bg-popover px-3.5 py-3 text-popover-foreground"
              style={{ boxShadow: `inset 0 0 0 1px ${heatAlpha(hover.color, 22)}` }}
            >
              <CityDetail city={hover} />
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-border/60 px-3.5 py-3 text-center text-xs text-muted-foreground">
              Tap a city on the map, or pick one below.
            </p>
          )}

          {sortedByRank.length > 0 && (
            <ul className="mt-2 divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50">
              {sortedByRank.map((p) => (
                <li key={`row-${p.name}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setPinned((cur) => (cur === p.name ? null : p.name));
                      setHoverName((cur) => (cur === p.name ? null : p.name));
                    }}
                    aria-pressed={pinned === p.name}
                    className={cn(
                      "flex min-h-10 w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                      activeName === p.name ? "bg-accent/60" : "active:bg-accent/40",
                    )}
                  >
                    <span className="w-5 shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
                      {p.rank}
                    </span>
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: p.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium" dir="auto">
                      {p.name}
                    </span>
                    <span className="shrink-0 text-[12px] font-semibold tabular-nums">
                      {fmtSAR(p.sales)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Legend + hint */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3 rounded-full border border-border/50 bg-background/60 px-3 py-1.5">
            <LegendDot color={HEAT.low} label="Low" />
            <span className="h-3 w-px bg-border/70" />
            <LegendDot color={HEAT.mid} label="Medium" />
            <span className="h-3 w-px bg-border/70" />
            <LegendDot color={HEAT.high} label="High" />
          </div>
          <span className="ml-auto text-[11px] text-muted-foreground/80">
            Bubble size ∝ completed sales
          </span>
        </div>
        {unmapped.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground/80">
            Not plotted: {unmapped.map((u) => u.name).join(", ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function slug(s: string) {
  return s.replace(/[^a-zA-Z0-9]+/g, "_");
}

/**
 * The readout for one city.
 *
 * Extracted so the floating tooltip and the mobile panel are the same thing
 * rather than two copies that drift — the tooltip had already grown four
 * `sm:` type-size overrides trying to be both.
 */
function CityDetail({ city }: { city: Placed }) {
  const completionRate =
    city.count > 0 ? Math.round(((city.completed ?? 0) / city.count) * 100) : null;

  return (
    <>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            // Ringed against the popover it sits in, not the page behind it —
            // `ring-background` drew a hairline of the wrong surface colour.
            className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-popover"
            style={{
              background: city.color,
              boxShadow: `0 0 12px ${heatAlpha(city.color, 70)}`,
            }}
          />
          <span className="truncate text-[15px] font-semibold leading-tight text-foreground">
            {city.name}
          </span>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{
            background: heatAlpha(city.color, 14),
            // The raw heat colour on a 14% tint of itself is close to invisible
            // for the amber tier in light mode. Pulling it toward the body text
            // colour keeps the hue that ties it to the bubble and buys back the
            // contrast, in whichever direction the theme needs.
            color: `color-mix(in oklab, ${city.color} 65%, var(--color-foreground))`,
          }}
        >
          #{city.rank}
        </span>
      </div>

      <div className="mb-3 rounded-xl bg-muted/40 px-3 py-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Completed sales
        </div>
        <div className="mt-0.5 text-base font-bold tabular-nums text-foreground">
          {fmtSAR(city.sales)}
        </div>
      </div>

      <div className="space-y-1.5 text-xs">
        <Row label="Total sales" value={fmtSAR(city.total ?? city.sales)} />
        <Row label="Total orders" value={String(city.count)} />
        <Row label="Share of total" value={`${(city.share * 100).toFixed(1)}%`} />
        {completionRate != null && <Row label="Completion rate" value={`${completionRate}%`} />}
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${Math.min(100, city.share * 100)}%`,
            background: `linear-gradient(90deg, ${city.color}, color-mix(in oklab, ${city.color} 55%, var(--card)))`,
          }}
        />
      </div>
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`tabular-nums ${strong ? "font-semibold text-foreground" : "text-foreground/90"}`}
      >
        {value}
      </span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-full ring-2 ring-background"
        style={{ background: color, boxShadow: `0 0 8px ${heatAlpha(color, 40)}` }}
      />
      <span className="font-medium">{label}</span>
    </span>
  );
}

/**
 * The hover card, rendered outside the map's clipping context.
 *
 * Positioned in viewport coordinates against the bubble's own rect: flips below
 * when there is no room above, clamps horizontally and vertically to stay fully
 * visible, and re-measures on scroll and resize. `pointer-events-none` keeps the
 * pointer on the marker, so moving toward the card can never flicker it away.
 */
function FloatingCityCard({
  city,
  getAnchor,
  id,
}: {
  city: Placed;
  getAnchor: () => SVGCircleElement | null;
  id: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  /**
   * The anchor lookup, held in a ref rather than a dependency.
   *
   * The caller passes a fresh arrow function on every render of the map, so
   * depending on it directly tore down and rebuilt the scroll and resize
   * listeners on each of those renders — during a hover, which is exactly when
   * the map re-renders most.
   */
  const getAnchorRef = useRef(getAnchor);
  getAnchorRef.current = getAnchor;

  useLayoutEffect(() => {
    const update = () => {
      const el = ref.current;
      const anchor = getAnchorRef.current();
      if (!el || !anchor) return;

      const a = anchor.getBoundingClientRect();
      const next = placeFloatingCard({
        anchor: { top: a.top, left: a.left, width: a.width, height: a.height },
        // Layout size, not the client rect: the card animates in under a
        // `scale(0.95)` transform and a client rect would report it 5% short
        // while that runs, which is enough to place a card near an edge just
        // outside it. See the note on `PlaceOptions.card`.
        card: { width: el.offsetWidth, height: el.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });

      setPos((prev) =>
        prev && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5
          ? prev
          : { left: next.left, top: next.top },
      );
    };

    update();
    // Capture phase, so scrolling *any* ancestor repositions the card and not
    // just the document.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);

    // Cities carry different numbers of rows — a completion rate appears only
    // when there are orders — so the card's height is not constant. Re-place it
    // when its own box changes rather than assuming the first measurement holds.
    const observer = new ResizeObserver(update);
    if (ref.current) observer.observe(ref.current);

    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [city.name]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="pointer-events-none fixed z-[9999] hidden w-[280px] rounded-2xl border border-border/60 bg-popover px-4 py-3.5 text-popover-foreground duration-200 ease-out animate-in fade-in-0 zoom-in-95 sm:block md:w-[300px]"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
        boxShadow: `0 24px 48px -24px ${heatAlpha(city.color, 40)}, 0 0 0 1px ${heatAlpha(
          city.color,
          22,
        )}, 0 2px 8px -2px rgba(0,0,0,0.12)`,
      }}
    >
      <CityDetail city={city} />
    </div>,
    document.body,
  );
}
