import { Card, CardContent } from "@/components/ui/card";

/** Compact single-figure stat card (Complaints summary row). */
export function StatCard({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string | number;
  accent?: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3 sm:p-4">
        <div className="text-[10px] sm:text-[11px] uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </div>
        <div className={`text-base sm:text-xl font-semibold mt-1 truncate ${accent ?? ""}`}>
          {value}
        </div>
        {sub && (
          <div className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5 truncate">
            {sub}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
