import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { businessToday, formatBusinessDate } from "@/lib/telesales/dates";
import { LEAD_TYPE_LABELS } from "@/lib/telesales/types";
import type { AgentWorkload, GenerationRun, ManagementMetrics } from "@/features/telesales/types";

export const Route = createFileRoute("/_app/telesales/management")({
  head: () => ({ meta: [{ title: "Telesales Management — MilaServ Portal" }] }),
  component: TelesalesManagementPage,
});

const EMPTY_METRICS: ManagementMetrics = {
  leads_today: 0,
  cash_today: 0,
  retention_today: 0,
  wasfaty_today: 0,
  open_total: 0,
  unassigned: 0,
  assigned: 0,
  contacted_today: 0,
  converted_today: 0,
  closed_today: 0,
  followups_due: 0,
  followups_overdue: 0,
  followups_upcoming: 0,
  calls_today: 0,
  no_answer_today: 0,
};

/**
 * The team lead's board.
 *
 * Deliberately operational, and deliberately not analytics. The brief asks for
 * that in as many words, and the reason is that the desk has never had a
 * baseline: the spreadsheets could not answer "how many leads were contacted
 * today", so nobody knows what a normal day looks like yet. Charts built on top
 * of that would be decoration.
 *
 * What is here is the set of numbers somebody actually acts on before lunch:
 * what came in, what nobody owns, what is overdue, and who is carrying what. The
 * KPI groundwork underneath — every outcome, timestamped, attributed and
 * append-only — is what makes the analytics possible later, and it is already
 * complete.
 */
function TelesalesManagementPage() {
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  const canView = hasPerm(role, perms, "view_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const [day, setDay] = useState(businessToday());

  const metrics = useQuery<ManagementMetrics>({
    queryKey: queryKeys.telesales.management(day),
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("telesales_management_summary", {
        _day: day,
      });
      if (error) throw new Error(error.message);
      const out = { ...EMPTY_METRICS };
      for (const row of (data as { metric: string; value: number }[]) ?? []) {
        (out as Record<string, number>)[row.metric] = Number(row.value);
      }
      return out;
    },
  });

  const workload = useQuery<AgentWorkload[]>({
    queryKey: queryKeys.telesales.workload(day),
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("telesales_agent_workload", {
        _day: day,
      });
      if (error) throw new Error(error.message);
      return (data as AgentWorkload[]) ?? [];
    },
  });

  const runs = useQuery<GenerationRun[]>({
    queryKey: queryKeys.telesales.runs(10),
    enabled: canManage,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_generation_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(10);
      if (error) throw new Error(error.message);
      return (data as GenerationRun[]) ?? [];
    },
  });

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Telesales is restricted</p>
      </div>
    );
  }

  const m = metrics.data ?? EMPTY_METRICS;
  const loading = metrics.isLoading;

  /*
   * Contact rate, computed here and nowhere else.
   *
   * Deliberately "leads contacted today ÷ leads assigned to somebody", not
   * "÷ every lead in the system": a lead nobody owns has not been missed, it has
   * not been started, and folding those into the denominator would report a desk
   * that is keeping up as one that is failing.
   *
   * `null` when the denominator is zero rather than 0% — the KPI cards on the
   * orders dashboard already establish that a rate with no basis says
   * "unavailable" instead of inventing a number.
   */
  const contactRate = m.assigned > 0 ? Math.round((m.contacted_today / m.assigned) * 100) : null;
  const conversionRate =
    m.contacted_today > 0 ? Math.round((m.converted_today / m.contacted_today) * 100) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/crm/cash">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Queue
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Telesales management</h1>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="ts-day" className="sr-only">
              Day
            </Label>
            <Input
              id="ts-day"
              type="date"
              className="w-[170px]"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          {canManage ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/telesales/import">Import &amp; generate</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Generated on {formatBusinessDate(day)}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Leads today" value={m.leads_today} loading={loading} />
          <Metric label="Cash" value={m.cash_today} loading={loading} />
          <Metric label="Retention" value={m.retention_today} loading={loading} />
          <Metric label="Wasfaty" value={m.wasfaty_today} loading={loading} />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Open work</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Open leads" value={m.open_total} loading={loading} />
          <Metric
            label="Unassigned"
            value={m.unassigned}
            loading={loading}
            emphasis={m.unassigned > 0}
          />
          <Metric label="Assigned" value={m.assigned} loading={loading} />
          <Metric label="Calls today" value={m.calls_today} loading={loading} />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Outcomes</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Metric label="Contacted" value={m.contacted_today} loading={loading} />
          <Metric label="No answer" value={m.no_answer_today} loading={loading} />
          <Metric label="Converted" value={m.converted_today} loading={loading} />
          <Metric
            label="Contact rate"
            value={contactRate}
            suffix="%"
            loading={loading}
            unavailableNote="No leads assigned"
          />
          <Metric
            label="Conversion rate"
            value={conversionRate}
            suffix="%"
            loading={loading}
            unavailableNote="Nobody contacted yet"
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Follow-ups</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Metric label="Due" value={m.followups_due} loading={loading} />
          <Metric
            label="Overdue"
            value={m.followups_overdue}
            loading={loading}
            emphasis={m.followups_overdue > 0}
          />
          <Metric label="Upcoming" value={m.followups_upcoming} loading={loading} />
        </div>
      </section>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Agent workload</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {workload.isLoading ? (
            <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </p>
          ) : (workload.data ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No telesales agents are set up yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Agent</th>
                    <th className="px-4 py-2 text-right font-medium">Open</th>
                    <th className="px-4 py-2 text-right font-medium">Contacted</th>
                    <th className="px-4 py-2 text-right font-medium">Converted</th>
                    <th className="px-4 py-2 text-right font-medium">Due</th>
                    <th className="px-4 py-2 text-right font-medium">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {(workload.data ?? []).map((a) => (
                    <tr key={a.agent_id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">{a.agent_name ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{a.open_leads}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{a.contacted_today}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{a.converted_today}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{a.followups_due}</td>
                      <td
                        className={cn(
                          "px-4 py-2 text-right tabular-nums",
                          a.followups_overdue > 0 && "font-medium text-destructive",
                        )}
                      >
                        {a.followups_overdue}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent generation runs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {(runs.data ?? []).length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Lead generation has not run yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {(runs.data ?? []).map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                  >
                    <span className="text-sm font-medium">{LEAD_TYPE_LABELS[r.lead_type]}</span>
                    <span className="text-xs text-muted-foreground">
                      anchor {formatBusinessDate(r.anchor_date)}
                      {r.window_from && r.window_to
                        ? ` · window ${formatBusinessDate(r.window_from)} – ${formatBusinessDate(r.window_to)}`
                        : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.candidates} candidates · {r.leads_created} created · {r.skipped_duplicate}{" "}
                      duplicate · {r.skipped_ineligible} ineligible
                    </span>
                    {r.status !== "completed" ? (
                      <span className="text-xs font-medium text-destructive">
                        {r.status}
                        {r.error_summary ? ` — ${r.error_summary}` : ""}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {r.execution_source}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  loading,
  emphasis,
  unavailableNote,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  loading: boolean;
  emphasis?: boolean;
  /** Shown instead of a number when there is no basis for one. */
  unavailableNote?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        {loading ? (
          <div className="mt-1 h-7 w-12 animate-pulse rounded bg-muted" />
        ) : value == null ? (
          <>
            <p className="mt-0.5 text-lg font-medium text-muted-foreground">Unavailable</p>
            {unavailableNote ? (
              <p className="text-[11px] text-muted-foreground">{unavailableNote}</p>
            ) : null}
          </>
        ) : (
          <p
            className={cn(
              "mt-0.5 text-2xl font-semibold tabular-nums",
              emphasis && "text-destructive",
            )}
          >
            {value.toLocaleString("en-US")}
            {suffix ?? ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
