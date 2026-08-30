export const ORDER_TYPES = ["Cash", "Wasfaty"] as const;
export const DELIVERY_TYPES = ["AlShrouq", "Store Pickup", "Branch Scooter", "Azman"] as const;
export const STATUSES = ["Pending", "Completed", "Cancelled"] as const;
export const COMPLAINT_STATUSES = ["In Progress", "Resolved"] as const;
export const TEAMS = [
  { value: "customer_care", label: "Customer Care" },
  { value: "telesales", label: "Telesales" },
] as const;

// Modern rounded badge styles using the requested brand colors
// Pending #F59E0B · Completed #10B981 · Cancelled #EF4444
export const STATUS_STYLES: Record<string, string> = {
  Pending: "bg-[#F59E0B]/15 text-[#B45309] border-[#F59E0B]/40 dark:text-amber-200",
  Completed: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200",
  Cancelled: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200",
  "In Progress": "bg-[#F59E0B]/15 text-[#B45309] border-[#F59E0B]/40 dark:text-amber-200",
  Resolved: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200",
};

export const CURRENCY = "SAR";
/**
 * The locale every number in the app is formatted through. Pinned, never the
 * runtime default.
 *
 * `toLocaleString()` with no locale means "whatever locale the process happens
 * to run under", and this app renders the same component twice in two different
 * processes: the SSR pass in Node/workerd and the hydration pass in the browser.
 * A dev machine whose Node resolves to `ar-EG` serves `١٬٢٩٠ SAR` in the HTML and
 * then hydrates `1,290 SAR` over it — React throws away the tree with a hydration
 * mismatch. It costs nothing to be explicit, and matches `money()` in
 * features/reports/daily.ts, which pins the same locale for the same reason.
 *
 * Exported so the formatters that live outside this file — `formatCompactSAR`
 * and `formatCount` in features/dashboard/format.ts — pin the same one, rather
 * than each carrying its own copy of the string.
 */
export const DISPLAY_LOCALE = "en-US";
/**
 * Money, in the one place the app formats it.
 *
 * `exact` fixes the fraction at two digits. The default rounds *up to* two and
 * drops trailing zeros, which is right for a KPI card or a chart axis — `1,200
 * SAR` reads better than `1,200.00 SAR` — but wrong down a column of invoice
 * lines, where `45 SAR` above `167.5 SAR` above `212.60 SAR` gives three
 * different shapes for the same kind of figure and nothing lines up.
 *
 * `bare` drops the ` SAR` suffix, for a column whose *header* already carries
 * the unit. Repeating it on every cell of a narrow table costs about 34px a
 * column, which on this page comes straight out of the product name beside it.
 *
 * Options on this function rather than formatters beside it: two currency
 * helpers is how an app ends up rendering the same riyal two ways on one screen.
 */
export const fmtSAR = (
  v: number | string | null | undefined,
  opts?: { exact?: boolean; bare?: boolean },
) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (n == null || isNaN(n as number)) return "—";
  const digits = opts?.exact ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {};
  const text = (n as number).toLocaleString(DISPLAY_LOCALE, {
    maximumFractionDigits: 2,
    ...digits,
  });
  return opts?.bare ? text : `${text} ${CURRENCY}`;
};

/** Team-aware display number, e.g. CC-43435 or TS-4323. Strips leading "#". */
export function formatOrderNo(
  team: string | null | undefined,
  displayNo: string | null | undefined,
): string {
  if (!displayNo) return "—";
  const n = String(displayNo).replace(/^#/, "");
  const prefix = team === "telesales" ? "TS-" : "CC-";
  return `${prefix}${n}`;
}

/** Strip team prefix to get the numeric portion, for searching. */
export function stripOrderPrefix(s: string): string {
  return s.replace(/^(cc-|ts-|#)/i, "");
}
