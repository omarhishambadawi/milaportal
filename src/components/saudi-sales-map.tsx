import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";
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

// Visual-only label swap requested by ops (data unchanged).
function displayLabel(name: string): string {
  if (name === "جدة") return "الطائف";
  if (name === "الطائف") return "جدة";
  if (name.toLowerCase() === "jeddah") return "Taif";
  if (name.toLowerCase() === "taif") return "Jeddah";
  return name;
}

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
  const [mounted, setMounted] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const t = window.setTimeout(() => setMounted(true), 30);
    return () => window.clearTimeout(t);
  }, []);

  const outlinePath = KSA_OUTLINE_PATH;

  const tierOf = (ratio: number): "low" | "mid" | "high" =>
    ratio < 0.34 ? "low" : ratio < 0.67 ? "mid" : "high";

  const colorFor = (tier: "low" | "mid" | "high") =>
    tier === "low" ? "hsl(184 66% 44%)" : tier === "mid" ? "hsl(38 92% 50%)" : "hsl(0 78% 58%)";

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
      const labelH = 16;
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

  const hover = placed.find((p) => p.name === hoverName) ?? null;
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
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
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
            className="block w-full h-auto"
            style={{ maxHeight: "min(64vh, 560px)" }}
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
                  style={{ stroke: "var(--map-leader)", transition: "opacity 220ms ease" }}
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
                  r={p.r * (active ? 2.2 : 1.7)}
                  fill={`url(#bg-${slug(p.name)})`}
                  style={{
                    pointerEvents: "none",
                    opacity: mounted ? (active ? 1 : 0.75) : 0,
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
                    transform: mounted ? (active ? "scale(1.08)" : "scale(1)") : "scale(0)",
                    opacity: mounted ? 1 : 0,
                    transition: `transform 520ms cubic-bezier(.34,1.4,.5,1) ${i * 40}ms, opacity 340ms ease ${i * 40}ms`,
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

            {/* Labels */}
            {placed.map((p) => {
              const active = hoverName === p.name;
              return (
                <g
                  key={`lbl-${p.name}`}
                  style={{
                    opacity: mounted ? 1 : 0,
                    transition: "opacity 340ms ease 260ms",
                    pointerEvents: "none",
                  }}
                >
                  <text
                    x={p.labelX}
                    y={p.labelY}
                    textAnchor={p.anchor}
                    fontSize={11.5}
                    fontWeight={active ? 700 : 600}
                    strokeWidth={3.5}
                    strokeOpacity={0.98}
                    paintOrder="stroke"
                    style={{
                      fill: "var(--map-label)",
                      stroke: "var(--map-label-halo)",
                      letterSpacing: 0.15,
                      fontFeatureSettings: '"kern"',
                      textRendering: "geometricPrecision",
                    }}
                  >
                    {displayLabel(p.name)}
                  </text>
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

            {/* Hit-target layer */}
            {[...placed]
              .map((p) => {
                let nearest = Infinity;
                for (const q of placed) {
                  if (q.name === p.name) continue;
                  const d = Math.hypot(p.cx - q.cx, p.cy - q.cy);
                  if (d < nearest) nearest = d;
                }
                const cap = Number.isFinite(nearest) ? Math.max(4, nearest / 2 - 1) : Infinity;
                const hitR = Math.min(Math.max(p.r, 8), cap);
                return { ...p, hitR };
              })
              .sort((a, b) => b.hitR - a.hitR)
              .map((p) => (
                <circle
                  key={`hit-${p.name}`}
                  cx={p.cx}
                  cy={p.cy}
                  r={p.hitR}
                  fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHoverName(p.name)}
                  onMouseLeave={() => setHoverName((n) => (n === p.name ? null : n))}
                  onTouchStart={() => setHoverName(p.name)}
                >
                  <title>{p.name}</title>
                </circle>
              ))}
          </svg>

          {hover &&
            (() => {
              const labelAbove = hover.labelY < hover.cy;
              const leftPct = (hover.cx / W) * 100;
              const topPct = (hover.cy / H) * 100;
              const flipBelow = labelAbove || hover.cy < H * 0.35;
              const nearLeft = leftPct < 22;
              const nearRight = leftPct > 78;
              const xShift = nearLeft ? "0%" : nearRight ? "-100%" : "-50%";
              const yShift = flipBelow
                ? `calc(${hover.r + 18}px)`
                : `calc(-100% - ${hover.r + 16}px)`;
              const completionRate =
                hover.count > 0 ? Math.round(((hover.completed ?? 0) / hover.count) * 100) : null;
              return (
                <div
                  className="pointer-events-none absolute z-10 w-[min(280px,86vw)] sm:w-[280px] md:w-[300px] rounded-2xl border border-border/50 bg-popover/95 backdrop-blur-2xl px-3.5 py-3 sm:px-4 sm:py-3.5 text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-200 ease-out"
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    transform: `translate(${xShift}, ${yShift})`,
                    maxWidth: "min(320px, 92vw)",
                    boxShadow: `0 24px 48px -24px ${hover.color}66, 0 0 0 1px color-mix(in oklab, ${hover.color} 22%, transparent), 0 2px 8px -2px rgba(0,0,0,0.12)`,
                  }}
                >
                  {/* Header — city + rank chip */}
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0 ring-2 ring-background"
                        style={{
                          background: hover.color,
                          boxShadow: `0 0 12px ${hover.color}`,
                        }}
                      />
                      <span className="font-semibold text-[14px] sm:text-[15px] leading-tight truncate text-foreground">
                        {hover.name}
                      </span>
                    </div>
                    <span
                      className="text-[10px] font-bold uppercase tracking-wider shrink-0 rounded-full px-2 py-0.5"
                      style={{
                        background: `color-mix(in oklab, ${hover.color} 14%, transparent)`,
                        color: hover.color,
                      }}
                    >
                      #{hover.rank}
                    </span>
                  </div>

                  {/* Hero metric */}
                  <div className="mb-3 rounded-xl bg-muted/40 px-3 py-2">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Completed sales
                    </div>
                    <div className="mt-0.5 text-[15px] sm:text-base font-bold tabular-nums text-foreground">
                      {fmtSAR(hover.sales)}
                    </div>
                  </div>

                  {/* Secondary rows */}
                  <div className="space-y-1.5 text-[11px] sm:text-xs">
                    <Row label="Total sales" value={fmtSAR(hover.total ?? hover.sales)} />
                    <Row label="Total orders" value={String(hover.count)} />
                    <Row label="Share of total" value={`${(hover.share * 100).toFixed(1)}%`} />
                    {completionRate != null && (
                      <Row label="Completion rate" value={`${completionRate}%`} />
                    )}
                  </div>

                  {/* Share bar */}
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className="h-full rounded-full transition-all duration-500 ease-out"
                      style={{
                        width: `${Math.min(100, hover.share * 100)}%`,
                        background: `linear-gradient(90deg, ${hover.color}, color-mix(in oklab, ${hover.color} 55%, white))`,
                      }}
                    />
                  </div>
                </div>
              );
            })()}
        </div>

        {/* Legend + hint */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3 rounded-full border border-border/50 bg-background/60 px-3 py-1.5">
            <LegendDot color="hsl(184 66% 44%)" label="Low" />
            <span className="h-3 w-px bg-border/70" />
            <LegendDot color="hsl(38 92% 50%)" label="Medium" />
            <span className="h-3 w-px bg-border/70" />
            <LegendDot color="hsl(0 78% 58%)" label="High" />
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
        style={{ background: color, boxShadow: `0 0 8px ${color}66` }}
      />
      <span className="font-medium">{label}</span>
    </span>
  );
}
