/**
 * Shams CRM synchronisation monitoring — administrator only.
 *
 * Read-only. There is no button on this page that starts a synchronisation, and
 * that is a deliberate property of this phase rather than an omission: the
 * automated scheduler is new, and manual controls are Phase 2B. The PharmacyCRM
 * Desktop remains the manual fallback and is unaffected by any of this.
 *
 * The gate here is presentational. `shamsSyncMonitor` calls `assertAdmin`
 * server-side and the two tables enforce the same rule again in RLS; this only
 * means a non-administrator sees a refusal rather than a thrown error.
 *
 * ## What the three panels are for
 *
 * Shams's live status answers "did the data sync". The scheduler panel answers
 * "are we still asking" — and it is first among equals, because a page showing
 * only the former would have looked perfectly healthy right through the AlShrouq
 * outage, where nothing had been sent for days behind 5,769 consecutive
 * "successful" cron runs. History answers "has this been reliable", which the
 * CRM cannot answer at all: it keeps only its latest run.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isAdministrator, useAuth } from "@/lib/auth";
import { shamsSyncMonitor } from "@/lib/shams.functions";
import { TD, TH } from "@/features/shams/constants";
import type { ShamsSyncRunRecord, ShamsSyncSide } from "@/lib/shams-crm/sync-monitor.server";

export const Route = createFileRoute("/_app/admin/shams-sync")({
  component: ShamsSyncPage,
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Timestamps are rendered in Riyadh time, explicitly labelled.
 *
 * The whole point of the normalisation in `sync-status.ts` is that instants are
 * unambiguous by the time they reach here, and showing them in the zone the
 * operation actually runs in is what makes "last night's sync" a checkable
 * claim. An unlabelled local time on an admin page read from two countries is
 * how the three-hour confusion started in the first place.
 */
function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Riyadh",
  }).format(ms)} (Riyadh)`;
}

function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function count(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-GB");
}

/** Colour carries the same meaning as the word, never instead of it. */
const STATUS_TONE: Record<string, string> = {
  success: "text-emerald-700 dark:text-emerald-400",
  running: "text-sky-700 dark:text-sky-400",
  triggered: "text-sky-700 dark:text-sky-400",
  failed: "text-destructive",
  indeterminate: "text-amber-700 dark:text-amber-500",
  skipped: "text-muted-foreground",
};

function Status({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return <span className={STATUS_TONE[value] ?? ""}>{value}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{children}</span>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One sync kind.
 *
 * `unit` names what that kind counts, because the two report different things:
 * stock reports pages, promotions reports branches. Showing "Pages: —" on the
 * promotions panel would read as a missing value rather than an inapplicable
 * one.
 */
function SidePanel({
  title,
  side,
  unit,
}: {
  title: string;
  side: ShamsSyncSide;
  unit: "pages" | "branches";
}) {
  const status = side.status;
  const latest = status?.latestRun ?? null;

  return (
    <Card>
      <CardContent className="space-y-1 py-4 text-sm">
        <div className="flex items-baseline justify-between pb-2">
          <h3 className="font-semibold">{title}</h3>
          <span className="text-xs">
            {status?.isRunning ? (
              <span className="text-sky-700 dark:text-sky-400">running now</span>
            ) : (
              <span className="text-muted-foreground">idle</span>
            )}
          </span>
        </div>

        {side.error && (
          <p className="pb-2 text-destructive">
            Status unavailable ({side.error.kind}). The scheduler is unaffected and will try again.
          </p>
        )}

        {status && (
          <>
            <Row label="Last successful run">{when(status.lastSuccessAt)}</Row>
            <Row label="Latest run">
              <Status value={latest?.status ?? null} />
            </Row>
            <Row label="Duration">{duration(latest?.durationSeconds)}</Row>
            <Row label="Rows seen">{count(latest?.rowsSeen)}</Row>
            <Row label="Rows changed">{count(latest?.rowsChanged)}</Row>
            <Row label={unit === "pages" ? "Pages fetched" : "Branches fetched"}>
              {count(unit === "pages" ? latest?.pagesFetched : latest?.branchesSeen)}
            </Row>
            <Row label="Shams run id">{latest?.runId ?? "—"}</Row>

            {/*
              Shams's own scheduler, reported rather than assumed. Phase 1 found
              it present in the contract and switched off; if it is ever enabled
              upstream we need to find out by reading this line, not by a
              collision at one in the morning.
            */}
            <Row label="Shams internal schedule">
              {status.syncIntervalMinutes && status.syncIntervalMinutes > 0
                ? `every ${status.syncIntervalMinutes} min`
                : "off (manual)"}
            </Row>

            {status.timestampsCorrected && (
              <p className="pt-2 text-xs text-amber-700 dark:text-amber-500">
                Shams reported this endpoint's times as Riyadh local in a field labelled UTC. They
                have been corrected here. Raw value: {status.lastSuccessAtRaw ?? "—"}
              </p>
            )}
            {status.timestampsUnexplained && (
              <p className="pt-2 text-xs text-destructive">
                Shams reported a time in the future that the Riyadh offset does not explain. It has
                been left exactly as sent rather than guessed at.
              </p>
            )}
          </>
        )}

        {!status && !side.error && (
          <p className="text-muted-foreground">Not configured on this deployment.</p>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryRow({ run }: { run: ShamsSyncRunRecord }) {
  return (
    <tr className="border-t align-top">
      <td className={TD}>{when(run.triggeredAt)}</td>
      <td className={TD}>{run.syncType}</td>
      <td className={TD}>
        <Status value={run.status} />
      </td>
      <td className={TD}>{run.executionSource}</td>
      <td className={`${TD} tabular-nums`}>{duration(run.durationSeconds)}</td>
      <td className={`${TD} tabular-nums`}>{count(run.rowsSeen)}</td>
      <td className={`${TD} tabular-nums`}>{count(run.rowsChanged)}</td>
      <td className={TD}>
        {run.skipReason ?? run.errorSummary ?? "—"}
        {run.sourceTimestampsCorrected && (
          <span className="block text-xs text-muted-foreground">times corrected from Riyadh</span>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

function ShamsSyncPage() {
  const { role } = useAuth();
  const load = useServerFn(shamsSyncMonitor);

  const monitor = useQuery({
    queryKey: ["shams-sync-monitor"],
    queryFn: () => load({ data: undefined }),
    // Each load spends two requests against a third-party production API, so it
    // refreshes when asked and when the tab is returned to — not on a timer.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    enabled: isAdministrator(role),
  });

  if (!isAdministrator(role)) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          Administrator access is required for Shams synchronisation monitoring.
        </CardContent>
      </Card>
    );
  }

  const report = monitor.data?.ok ? monitor.data.report : null;
  const scheduler = report?.scheduler ?? null;

  /*
   * A poll that has not run in fifteen minutes is the alarm, and it is computed
   * here rather than stored: the reconcile job runs every five minutes, so three
   * missed ticks means pg_cron is not running the job at all — the one failure
   * no amount of Shams-side health can reveal.
   */
  const lastPollMs = scheduler?.lastPollAt ? Date.parse(scheduler.lastPollAt) : null;
  const pollStale =
    lastPollMs !== null && Number.isFinite(lastPollMs) && Date.now() - lastPollMs > 15 * 60_000;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Shams CRM synchronisation</h1>
          <p className="text-sm text-muted-foreground">
            Read-only. Stock and promotions are triggered automatically at 01:00 Riyadh; the
            PharmacyCRM Desktop remains the manual fallback.
          </p>
        </div>
        <Button variant="secondary" onClick={() => monitor.refetch()} disabled={monitor.isFetching}>
          {monitor.isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>

      {monitor.isError && (
        <p className="text-sm text-destructive">
          The status could not be loaded. You may not have administrator access.
        </p>
      )}

      {monitor.data && !monitor.data.ok && (
        <p className="text-sm text-destructive">
          {monitor.data.error?.message ?? "The synchronisation status could not be read."}
        </p>
      )}

      {report && !report.configured && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            The Shams CRM connection is not configured on this deployment, so nothing is being
            synchronised. Set <code>SHAMS_CRM_USERNAME</code> and <code>SHAMS_CRM_PASSWORD</code>.
          </CardContent>
        </Card>
      )}

      {report && (
        <>
          <Section
            title="Scheduler"
            hint="Whether MilaPortal is still asking. This is separate from whether Shams is healthy — a scheduler that has stopped polling looks like nothing at all on the panels below."
          >
            <Card>
              <CardContent className="space-y-1 py-4 text-sm">
                <Row label="Last poll">
                  {when(scheduler?.lastPollAt)}
                  {pollStale && (
                    <span className="ml-2 text-destructive">stale — is pg_cron running?</span>
                  )}
                </Row>
                <Row label="Last request sent">{when(scheduler?.lastPokeAt)}</Row>
                <Row label="Last task">{scheduler?.lastTask ?? "—"}</Row>
                <Row label="Last outcome">
                  <span
                    className={
                      scheduler?.lastOutcome === "unconfigured" ? "text-destructive" : undefined
                    }
                  >
                    {scheduler?.lastOutcome ?? "—"}
                  </span>
                </Row>
                {scheduler?.lastError && (
                  <p className="pt-2 text-destructive">{scheduler.lastError}</p>
                )}
                {!scheduler && (
                  <p className="text-muted-foreground">
                    The scheduler has never reported in. Check that the migration has been applied
                    and that the vault holds <code>shams_sync_scheduler_url</code>.
                  </p>
                )}
              </CardContent>
            </Card>
          </Section>

          <Section
            title="Current status at Shams"
            hint="Read live from Shams CRM each time this page loads."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <SidePanel title="Stock" side={report.stock} unit="pages" />
              <SidePanel title="Promotions" side={report.promotions} unit="branches" />
            </div>
          </Section>

          <Section
            title="Recent runs"
            hint="MilaPortal's own record. Shams keeps only its latest run, so this is the only place the daily history exists."
          >
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    {[
                      "Triggered",
                      "Type",
                      "Status",
                      "Source",
                      "Duration",
                      "Rows seen",
                      "Rows changed",
                      "Note",
                    ].map((h) => (
                      <th key={h} className={TH}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.history.length === 0 && (
                    <tr className="border-t">
                      <td className={`${TD} text-muted-foreground`} colSpan={8}>
                        No runs recorded yet. The first scheduled run is at 01:00 Riyadh.
                      </td>
                    </tr>
                  )}
                  {report.history.map((run) => (
                    <HistoryRow key={run.id} run={run} />
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <p className="text-xs text-muted-foreground">As of {when(report.observedAt)}</p>
        </>
      )}

      {monitor.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Reading status from Shams CRM…
        </p>
      )}
    </div>
  );
}
