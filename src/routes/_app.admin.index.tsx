/**
 * Admin overview — the landing page for administration.
 *
 * Everything here comes from server functions that already existed:
 * `shamsSyncMonitor` for integration and scheduler health, and
 * `adminListActivity` for the administrative audit trail. **No metric was
 * invented to fill a card**, and where a number is genuinely unavailable the
 * section says so rather than showing a plausible zero — a dashboard that
 * guesses is worse than one that admits a gap.
 *
 * The page answers three operational questions, in the order an administrator
 * asks them on a bad morning: is automation on, did last night work, and who
 * changed something.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, CalendarClock, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shamsSyncMonitor } from "@/lib/shams.functions";
import { adminListActivity } from "@/lib/admin.functions";
import { isAdministrator, useAuth } from "@/lib/auth";
import { AdminPage, LastUpdated } from "@/features/admin/components/admin-shell";
import {
  AdminCard,
  AdminCardHeader,
  AdminSection,
  AdminStatCard,
  CardSkeleton,
  DataRow,
  EmptyState,
  HealthIndicator,
  NoticeState,
  StatusBadge,
  statusTone,
  type Tone,
} from "@/features/admin/components/primitives";
import { ADMIN_NAV } from "@/features/admin/nav";
import { riyadh, riyadhTime } from "@/features/admin/format";

export const Route = createFileRoute("/_app/admin/")({
  component: AdminOverviewPage,
});

function AdminOverviewPage() {
  const { role } = useAuth();
  const admin = isAdministrator(role);

  const loadSync = useServerFn(shamsSyncMonitor);
  const sync = useQuery({
    queryKey: ["shams-sync-monitor"],
    queryFn: () => loadSync({ data: undefined }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: admin,
  });

  const loadActivity = useServerFn(adminListActivity);
  const activity = useQuery({
    queryKey: ["admin-activity", "overview"],
    queryFn: () => loadActivity({ data: { limit: 6 } }),
    staleTime: 60_000,
    enabled: admin,
  });

  const report = sync.data?.ok ? sync.data.report : null;
  const automationOn = report?.settings.automationEnabled ?? false;

  const lastPollMs = report?.scheduler?.lastPollAt ? Date.parse(report.scheduler.lastPollAt) : null;
  const pollStale =
    lastPollMs !== null && Number.isFinite(lastPollMs) && Date.now() - lastPollMs > 15 * 60_000;
  const schedulerUnconfigured = report?.scheduler?.lastOutcome === "unconfigured";

  const schedulerTone: Tone = !report?.scheduler
    ? "neutral"
    : schedulerUnconfigured
      ? "danger"
      : pollStale
        ? "warning"
        : "success";
  const schedulerLabel = !report?.scheduler
    ? "Never reported in"
    : schedulerUnconfigured
      ? "Not connected"
      : pollStale
        ? "Stale — no recent poll"
        : "Healthy";

  /*
   * Only genuine problems. A run that was skipped because Shams was already
   * busy is correct behaviour, not an alert, and listing it here would train
   * administrators to ignore this panel.
   */
  const attention = (report?.history ?? []).filter((r) =>
    ["failed", "indeterminate"].includes(r.status),
  );

  return (
    <AdminPage
      title="Admin overview"
      description="Operational status across the systems this portal administers."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void sync.refetch();
            void activity.refetch();
          }}
          disabled={sync.isFetching}
        >
          <RefreshCw
            className={`mr-2 h-3.5 w-3.5 ${sync.isFetching ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          Refresh
        </Button>
      }
      meta={<LastUpdated at={report?.observedAt} refreshing={sync.isFetching} />}
    >
      {/* ---------------------------------------------------------------- */}
      <AdminSection
        title="At a glance"
        description="Live status of the Shams CRM integration this portal schedules."
      >
        {sync.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <CardSkeleton key={i} rows={1} />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard
              label="Automation"
              value={automationOn ? "On" : "Off"}
              detail={automationOn ? "Schedules will run" : "No scheduled update will run"}
              tone={automationOn ? "success" : "neutral"}
              icon={Zap}
            />
            <AdminStatCard
              label="Scheduler"
              value={schedulerLabel}
              detail={
                report?.scheduler?.lastPollAt
                  ? `Last poll ${riyadhTime(report.scheduler.lastPollAt)}`
                  : undefined
              }
              tone={schedulerTone}
              icon={ShieldCheck}
            />
            <AdminStatCard
              label="Next stock update"
              value={report?.nextStockRun ? riyadhTime(report.nextStockRun) : "—"}
              detail={report?.nextStockRun ? riyadh(report.nextStockRun) : "Not scheduled"}
              tone={report?.nextStockRun ? "info" : "neutral"}
              icon={CalendarClock}
            />
            <AdminStatCard
              label="Next promotions update"
              value={report?.nextPromotionsRun ? riyadhTime(report.nextPromotionsRun) : "—"}
              detail={
                report?.nextPromotionsRun ? riyadh(report.nextPromotionsRun) : "Not scheduled"
              }
              tone={report?.nextPromotionsRun ? "info" : "neutral"}
              icon={CalendarClock}
            />
          </div>
        )}

        {schedulerUnconfigured && (
          <NoticeState
            tone="danger"
            message={
              <>
                The scheduler endpoint is not connected on this deployment, so no scheduled update
                can run even with automation on.
              </>
            }
          />
        )}
        {sync.data && !sync.data.ok && (
          <NoticeState
            tone="warning"
            message={sync.data.error?.message ?? "The integration status could not be read."}
          />
        )}
      </AdminSection>

      {/* ---------------------------------------------------------------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <AdminSection title="Needs attention">
          <AdminCard>
            {attention.length === 0 ? (
              <EmptyState
                title="Nothing needs attention"
                description="No synchronisation has failed or ended in an unknown state in the recent history."
                icon={ShieldCheck}
              />
            ) : (
              <ul className="divide-y">
                {attention.slice(0, 5).map((run) => (
                  <li key={run.id} className="flex items-start gap-3 px-4 py-3">
                    <StatusBadge status={run.status} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-sm font-medium capitalize">
                        {run.syncType} · {run.executionSource}
                      </p>
                      <p className="text-xs text-muted-foreground">{riyadh(run.triggeredAt)}</p>
                      {run.errorSummary && (
                        <p className="text-xs text-muted-foreground">{run.errorSummary}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t px-4 py-2.5">
              <Link
                to="/admin/shams-sync"
                className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open Sync Control Center
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          </AdminCard>
        </AdminSection>

        <AdminSection title="Recent administrative activity">
          <AdminCard>
            {activity.isLoading ? (
              <div className="p-4">
                <CardSkeleton rows={4} />
              </div>
            ) : (activity.data?.entries?.length ?? 0) === 0 ? (
              <EmptyState
                title="No recorded activity"
                description="Administrative changes appear here as they happen."
              />
            ) : (
              <ul className="divide-y">
                {(activity.data?.entries ?? []).map((entry: any) => (
                  <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-sm font-medium">{entry.action}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry.actor_name ?? "Unknown actor"} · {riyadh(entry.created_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t px-4 py-2.5">
              <Link
                to="/admin/users"
                className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open Users and roles
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          </AdminCard>
        </AdminSection>
      </div>

      {/* ---------------------------------------------------------------- */}
      <AdminSection title="Administration">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ADMIN_NAV.flatMap((g) => g.items)
            .filter((i) => i.to !== "/admin")
            .map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="group rounded-lg border bg-card p-4 shadow-sm transition-colors hover:border-primary/30 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start gap-3">
                  <span className="rounded-md border bg-muted/50 p-1.5">
                    <item.icon className="h-4 w-4 text-primary-ink" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-1 text-sm font-semibold">
                      {item.title}
                      <ArrowRight
                        className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                </div>
              </Link>
            ))}
        </div>
      </AdminSection>

      {/* ---------------------------------------------------------------- */}
      {report && (
        <AdminSection
          title="Shams integration detail"
          description="Read live from Shams CRM. Full controls are in the Sync Control Center."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            {[
              ["Stock", report.stock, report.nextStockRun] as const,
              ["Promotions", report.promotions, report.nextPromotionsRun] as const,
            ].map(([label, side, next]) => (
              <AdminCard key={label}>
                <AdminCardHeader
                  title={label}
                  actions={
                    <StatusBadge
                      status={
                        side.status?.isRunning
                          ? "running"
                          : (side.status?.latestRun?.status ?? "unknown")
                      }
                      tone={
                        side.error
                          ? "danger"
                          : side.status?.isRunning
                            ? "info"
                            : statusTone(side.status?.latestRun?.status)
                      }
                      label={
                        side.error
                          ? "Unavailable"
                          : side.status?.isRunning
                            ? "Running"
                            : (side.status?.latestRun?.status ?? "Unknown")
                      }
                    />
                  }
                />
                <div className="px-4 py-2 sm:px-5">
                  {side.error ? (
                    <p className="py-2 text-sm text-muted-foreground">
                      Status unavailable ({side.error.kind}). The scheduler is unaffected.
                    </p>
                  ) : (
                    <>
                      <DataRow label="Next scheduled">
                        {next ? riyadh(next) : "Not scheduled"}
                      </DataRow>
                      <DataRow label="Last success">
                        {side.status?.lastSuccessAt ? riyadh(side.status.lastSuccessAt) : "—"}
                      </DataRow>
                      <DataRow label="Shams run id">{side.status?.latestRun?.runId ?? "—"}</DataRow>
                    </>
                  )}
                </div>
              </AdminCard>
            ))}
          </div>
        </AdminSection>
      )}

      {report && !report.configured && (
        <NoticeState
          tone="warning"
          message="The Shams CRM connection is not configured on this deployment, so nothing can be synchronised."
        />
      )}

      {report?.scheduler && (
        <AdminCard className="p-4">
          <HealthIndicator
            tone={schedulerTone}
            label={`Scheduler: ${schedulerLabel}`}
            detail={
              report.scheduler.lastError ??
              (report.scheduler.lastPollAt
                ? `Last poll ${riyadh(report.scheduler.lastPollAt)} · outcome "${report.scheduler.lastOutcome ?? "—"}"`
                : undefined)
            }
            pulse={schedulerTone === "success" && automationOn}
          />
        </AdminCard>
      )}
    </AdminPage>
  );
}
