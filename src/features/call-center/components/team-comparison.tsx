import { memo } from "react";
import { PhoneOutgoing, Headphones } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { hhmmss } from "../utils";
import { INBOUND, OUTBOUND } from "./chart-primitives";

export interface TeamCompareRow {
  team: "customer_care" | "telesales";
  calls: number;
  answered: number;
  missed: number;
  inbound: number;
  outbound: number;
  talkSeconds: number;
  handlingSeconds: number;
  answerRate: number;
  missedRate: number;
}

const TEAM_META = {
  customer_care: { label: "Customer Care", icon: Headphones, color: INBOUND },
  telesales: { label: "Telesales", icon: PhoneOutgoing, color: OUTBOUND },
} as const;

/**
 * The two teams side by side, with a shared bar for relative volume.
 *
 * A table would put the numbers next to each other; the bar is what makes the
 * split legible at a glance, which is the only reason a combined page exists.
 * The bar is scaled against the LARGER team rather than the total, so a team
 * carrying a fifth of the traffic reads as a fifth of the leader rather than as
 * a sliver of a whole nobody asked about.
 *
 * Derives nothing — `teamCompare` arrives from the analytics engine already
 * split, rated and totalled.
 */
export const TeamComparison = memo(function TeamComparison({
  rows,
  loading,
}: {
  rows: TeamCompareRow[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-2 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // Both teams always render, even at zero, so the comparison does not silently
  // become a single card on a day one team did not work.
  const byTeam = new Map(rows.map((r) => [r.team, r]));
  const teams: Array<TeamCompareRow["team"]> = ["customer_care", "telesales"];
  const peak = Math.max(1, ...rows.map((r) => r.calls));

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {teams.map((team) => {
        const r = byTeam.get(team);
        const meta = TEAM_META[team];
        const Icon = meta.icon;
        const calls = r?.calls ?? 0;
        return (
          <Card key={team} className="h-full">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                  style={{ background: `color-mix(in oklab, ${meta.color} 16%, transparent)` }}
                >
                  <Icon className="h-4 w-4" style={{ color: meta.color }} aria-hidden="true" />
                </span>
                <span className="text-sm font-semibold tracking-tight">{meta.label}</span>
                <span className="ml-auto text-2xl font-semibold tabular-nums">{calls}</span>
              </div>

              <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${meta.label}: ${calls} calls`}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${(calls / peak) * 100}%`, background: meta.color }}
                />
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                <Figure label="Answered" value={r?.answered ?? 0} tone="success" />
                <Figure label="Missed" value={r?.missed ?? 0} tone="destructive" />
                <Figure label="Answer rate" value={`${(r?.answerRate ?? 0).toFixed(1)}%`} />
                <Figure label="Talk time" value={hhmmss(r?.talkSeconds ?? 0)} />
                <Figure label="Inbound" value={r?.inbound ?? 0} />
                <Figure label="Outbound" value={r?.outbound ?? 0} />
                <Figure label="Missed rate" value={`${(r?.missedRate ?? 0).toFixed(1)}%`} />
                <Figure label="Handling" value={hhmmss(r?.handlingSeconds ?? 0)} />
              </dl>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
});

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "success" | "destructive";
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-sm font-semibold tabular-nums",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
