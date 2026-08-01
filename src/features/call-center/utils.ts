import { format } from "date-fns";

export const toISO = (d: Date) => format(d, "yyyy-MM-dd");

// Re-exported, not redefined. The Metrics Engine owns every derivation the
// dashboards render, hour labels included, so there is exactly one of these.
export { hourLabel } from "@/lib/yeastar/metrics-engine";

export function pct(v?: number) {
  return `${(v ?? 0).toFixed(1)}%`;
}

export function hhmmss(sec?: number): string {
  const s = Math.max(0, Math.floor(sec ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
