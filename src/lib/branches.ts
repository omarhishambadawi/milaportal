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
export const fmtSAR = (v: number | string | null | undefined) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (n == null || isNaN(n as number)) return "—";
  return `${(n as number).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${CURRENCY}`;
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
