import { cn } from "@/lib/utils";

export function TeamBadge({ team }: { team: string }) {
  const isTs = team === "telesales";
  const cls = isTs
    ? "bg-chart-3/10 text-chart-3 border-chart-3/25"
    : "bg-primary/10 text-primary-ink border-primary/25";
  const full = isTs ? "Telesales" : "Customer Care";
  const abbr = isTs ? "TS" : "CC";
  return (
    <span
      title={full}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none shrink-0",
        cls,
      )}
    >
      <span className="sm:hidden">{abbr}</span>
      <span className="hidden sm:inline">{full}</span>
    </span>
  );
}
