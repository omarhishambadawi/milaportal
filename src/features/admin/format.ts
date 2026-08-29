/**
 * How the admin console renders values. PURE.
 *
 * One place, because the alternative is what this project already learned the
 * hard way: an unlabelled local time on a page read from two countries is how
 * the Shams "three hour" confusion started. Every timestamp an administrator
 * sees is Riyadh, and says so.
 */

const RIYADH = "Asia/Riyadh";

/** Full date and time, explicitly labelled. The default for anything historic. */
export function riyadh(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === null) return "—";
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: RIYADH,
  }).format(ms)} (Riyadh)`;
}

/** Time only. For dense cards where the date is implied by context. */
export function riyadhTime(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === null) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: RIYADH }).format(ms);
}

/** Day and time without the trailing label, for tight table cells. */
export function riyadhShort(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === null) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: RIYADH,
  }).format(ms);
}

/** "in 27 min" / "2 h ago" — relative, for at-a-glance scanning only. */
export function relativeToNow(iso: string | null | undefined, now: number = Date.now()): string {
  const ms = parse(iso);
  if (ms === null) return "—";
  const diffMin = Math.round((ms - now) / 60_000);
  const abs = Math.abs(diffMin);
  const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  if (abs < 60) return rtf.format(diffMin, "minute");
  if (abs < 60 * 24) return rtf.format(Math.round(diffMin / 60), "hour");
  return rtf.format(Math.round(diffMin / (60 * 24)), "day");
}

/** Whole seconds as `24m 24s`. Withheld rather than guessed when unknown. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Grouped digits, or an em dash. Never a zero standing in for "unknown". */
export function count(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-GB");
}

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
