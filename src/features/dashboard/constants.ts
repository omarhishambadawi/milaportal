/** Chart palette + per-status colors used by the Dashboard charts. */

export const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export const STATUS_COLORS: Record<string, string> = {
  Pending: "#eab308",
  Completed: "#16a34a",
  Cancelled: "#dc2626",
  "Follow-up": "#2563eb",
  "No Answer": "#6b7280",
};
