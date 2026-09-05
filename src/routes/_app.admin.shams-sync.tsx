/**
 * Shams Sync Control Center — administrator only.
 *
 * The operational console for automated stock and promotions synchronisation:
 * whether automation is on, when it next runs, what happened last time, and the
 * manual override.
 *
 * ## What this file is and is not
 *
 * It is presentation. Every server function, mutation, guard and confirmation it
 * calls is unchanged from Phase 2B — `assertAdmin` server-side, RLS on all four
 * tables, the claim index, the `is_running` pre-check, and no automatic retry.
 * Rewriting the layout must not, and does not, move any of that.
 *
 * ## Times are Riyadh, everywhere, always
 *
 * No UTC value is rendered on this page. Slots store a local time and a named
 * zone, and every "next run" comes from the same pure function the scheduler
 * uses, so the page cannot promise a run that will not happen.
 *
 * ## Reading order
 *
 * Automation first, because it governs everything below it; then the schedule;
 * then the manual override; then what Shams itself reports; then history. That
 * is the order an administrator asks the questions in.
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CalendarClock,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  shamsCatalogHealth,
  shamsCatalogRefreshNow,
  shamsSyncDeleteSlot,
  shamsSyncMonitor,
  shamsSyncRunNow,
  shamsSyncSaveSlot,
  shamsSyncSetAutomation,
} from "@/lib/shams.functions";
import { formatLocalTime, nextOccurrence } from "@/lib/shams-crm/sync-schedule";
import type { ShamsSyncRunRecord, ShamsSyncSide } from "@/lib/shams-crm/sync-monitor.server";
import { AdminPage, LastUpdated } from "@/features/admin/components/admin-shell";
import {
  AdminCard,
  AdminCardHeader,
  AdminSection,
  CardSkeleton,
  DataRow,
  EmptyState,
  HealthIndicator,
  NoticeState,
  StatusBadge,
  TableSkeleton,
  statusTone,
  type Tone,
} from "@/features/admin/components/primitives";
import { count, duration, relativeToNow, riyadh, riyadhShort } from "@/features/admin/format";

export const Route = createFileRoute("/_app/admin/shams-sync")({
  component: ShamsSyncPage,
});

/* -------------------------------------------------------------------------- */
/* Status panel                                                                */
/* -------------------------------------------------------------------------- */

function SidePanel({
  title,
  side,
  unit,
  nextRun,
}: {
  title: string;
  side: ShamsSyncSide;
  unit: "pages" | "branches";
  nextRun: string | null;
}) {
  const status = side.status;
  const latest = status?.latestRun ?? null;

  const tone: Tone = side.error
    ? "danger"
    : status?.isRunning
      ? "info"
      : statusTone(latest?.status);
  const label = side.error
    ? "Status unavailable"
    : status?.isRunning
      ? "Running now"
      : latest?.status
        ? latest.status === "success"
          ? "Healthy"
          : latest.status
        : "No run recorded";

  return (
    <AdminCard>
      <AdminCardHeader
        title={title}
        actions={
          <StatusBadge
            tone={tone}
            label={
              side.error ? "Unavailable" : status?.isRunning ? "Running" : (latest?.status ?? "—")
            }
          />
        }
      />
      <div className="space-y-3 px-4 py-3 sm:px-5">
        <HealthIndicator
          tone={tone}
          label={label}
          detail={
            side.error
              ? "The scheduler is unaffected and will try again."
              : status?.lastSuccessAt
                ? `Last success ${riyadh(status.lastSuccessAt)}`
                : undefined
          }
          pulse={status?.isRunning === true}
        />

        {!side.error && status && (
          <div>
            <DataRow label="Next scheduled">{nextRun ? riyadh(nextRun) : "Not scheduled"}</DataRow>
            <DataRow label="Duration">{duration(latest?.durationSeconds)}</DataRow>
            <DataRow label="Rows seen">{count(latest?.rowsSeen)}</DataRow>
            <DataRow label="Rows changed">{count(latest?.rowsChanged)}</DataRow>
            <DataRow label={unit === "pages" ? "Pages fetched" : "Branches fetched"}>
              {count(unit === "pages" ? latest?.pagesFetched : latest?.branchesSeen)}
            </DataRow>
            <DataRow label="Shams run id">{latest?.runId ?? "—"}</DataRow>
            <DataRow label="Internal Shams schedule">
              {status.syncIntervalMinutes && status.syncIntervalMinutes > 0
                ? `Every ${status.syncIntervalMinutes} min`
                : "Off (manual)"}
            </DataRow>
          </div>
        )}

        {status?.timestampsCorrected && (
          <NoticeState
            tone="warning"
            message={
              <>
                Shams reports this endpoint&apos;s times as Riyadh local in a field labelled UTC.
                They are corrected here. Raw value:{" "}
                <span className="font-mono text-xs">{status.lastSuccessAtRaw ?? "—"}</span>
              </>
            }
          />
        )}
        {status?.timestampsUnexplained && (
          <NoticeState
            tone="danger"
            message="Shams reported a time in the future that the Riyadh offset does not explain. It has been left exactly as sent rather than guessed at."
          />
        )}
      </div>
    </AdminCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Schedule editing                                                            */
/* -------------------------------------------------------------------------- */

interface SlotDraft {
  id: string | null;
  localTime: string;
  syncStock: boolean;
  syncPromotions: boolean;
  enabled: boolean;
}

const CELL = "px-4 py-3 align-middle";
const HEAD =
  "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";

/* -------------------------------------------------------------------------- */
/* The local product catalogue                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Is product search working, and is what it searches current?
 *
 * The catalogue Branch Stock searches is MilaPortal's own table, not a live read
 * of Shams CRM, which is what makes search instant and what makes it survive a
 * CRM outage. The cost of that is a question nobody could previously ask: *how
 * old are these rows*. This panel is the answer, and it is deliberately four
 * facts rather than a dashboard — a row count, a freshness, an outcome, and one
 * sentence when something went wrong.
 *
 * It reads one row of `shams_catalog_state` and contacts Shams not at all, so it
 * still answers during exactly the outage it would be consulted about.
 *
 * Its own query, separate from the monitor's, for the same reason: the monitor
 * reads live status from Shams CRM and fails when the CRM does. Folding the
 * catalogue's health into it would mean losing the health signal precisely when
 * the CRM is down — the moment it matters most, because that is when someone
 * needs to be told that search is unaffected.
 */
function CatalogPanel() {
  const loadHealth = useServerFn(shamsCatalogHealth);
  const refreshNow = useServerFn(shamsCatalogRefreshNow);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const health = useQuery({
    queryKey: ["shams-catalog-health"],
    queryFn: () => loadHealth({ data: undefined }),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const refresh = useMutation({
    mutationFn: () => refreshNow({ data: undefined }),
    onSuccess: (result) => {
      setNotice({ ok: result.ok, text: result.message });
      void health.refetch();
    },
  });

  const row = health.data?.ok ? health.data.health : null;
  const rows = row?.rowCount ?? 0;
  const ageHours = row?.ageMs === null || row?.ageMs === undefined ? null : row.ageMs / 3_600_000;

  /**
   * Tone is about *search*, not about the refresh.
   *
   * An empty catalogue is the only state in which agents cannot search, so it is
   * the only danger. A refresh that failed is a warning — the previous rows are
   * still serving and nobody on a call notices — and so is a catalogue that has
   * gone more than a day and a half without one, which is past the point where
   * the age fallback should have fired.
   */
  const tone: Tone =
    rows === 0
      ? "danger"
      : row?.lastOutcome === "failed" || (ageHours !== null && ageHours > 36)
        ? "warning"
        : "success";

  return (
    <AdminSection
      title="Product catalogue"
      description="What Branch Stock search reads. Held in MilaPortal, so a Shams CRM outage cannot stop an agent finding a product."
    >
      <AdminCard>
        <div className="flex flex-wrap items-center justify-between gap-4 border-b px-4 py-4 sm:px-5">
          <HealthIndicator
            tone={tone}
            label={rows === 0 ? "Search is unavailable" : `${count(rows)} products searchable`}
            detail={
              rows === 0
                ? "The catalogue is empty, so product search cannot return anything. Refresh it, or check that the migrations have run."
                : row?.lastSuccessAt
                  ? `Last refreshed ${relativeToNow(row.lastSuccessAt)}.`
                  : "Serving the shipped seed; no refresh from Shams CRM has completed yet."
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
            Refresh catalogue
          </Button>
        </div>

        <div className="grid gap-x-6 px-4 py-2 sm:grid-cols-2 sm:px-5">
          <DataRow label="Products">{count(rows)}</DataRow>
          <DataRow label="Last refreshed">
            {row?.lastSuccessAt ? riyadh(row.lastSuccessAt) : "Never"}
          </DataRow>
          <DataRow label="Last checked">
            {row?.lastAttemptAt ? riyadh(row.lastAttemptAt) : "—"}
          </DataRow>
          <DataRow label="Last outcome">
            <StatusBadge
              tone={
                row?.lastOutcome === "failed"
                  ? "danger"
                  : row?.lastOutcome === "success"
                    ? "success"
                    : "neutral"
              }
              label={row?.lastOutcome ?? "Never checked"}
            />
          </DataRow>
          <DataRow label="Next check">
            {row?.nextRefreshDueAt ? riyadh(row.nextRefreshDueAt) : "Due now"}
          </DataRow>
          {/* The upstream marker the current rows were fetched against. A
              timestamp Shams already publishes; nothing sensitive. */}
          <DataRow label="Source marker">{row?.sourceMarker ?? "—"}</DataRow>
        </div>

        {(row?.lastError || notice) && (
          <div className="space-y-2 border-t px-4 py-3 sm:px-5">
            {notice && (
              <NoticeState tone={notice.ok ? "success" : "danger"} message={notice.text} />
            )}
            {row?.lastError && (
              <NoticeState
                tone={rows === 0 ? "danger" : "warning"}
                message={
                  rows === 0
                    ? row.lastError
                    : `${row.lastError} The previous catalogue is still serving searches.`
                }
              />
            )}
          </div>
        )}

        {!health.isLoading && !row && (
          <div className="border-t px-4 py-3 sm:px-5">
            <NoticeState
              tone="warning"
              message="The catalogue's health could not be read. Product search may still be working; this panel is a separate query."
            />
          </div>
        )}
      </AdminCard>
    </AdminSection>
  );
}

function SlotEditorRow({
  draft,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: SlotDraft;
  busy: boolean;
  onChange: (next: SlotDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <tr className="border-t bg-muted/40">
      <td className={CELL}>
        <Input
          type="time"
          value={draft.localTime}
          onChange={(e) => onChange({ ...draft, localTime: e.target.value })}
          className="h-8 w-32"
          aria-label="Time of day, Riyadh"
        />
        <span className="mt-1 block text-xs text-muted-foreground">Riyadh</span>
      </td>
      <td className={CELL}>
        <Switch
          checked={draft.syncStock}
          onCheckedChange={(v) => onChange({ ...draft, syncStock: v })}
          aria-label="Update Stock at this time"
        />
      </td>
      <td className={CELL}>
        <Switch
          checked={draft.syncPromotions}
          onCheckedChange={(v) => onChange({ ...draft, syncPromotions: v })}
          aria-label="Update Promotions at this time"
        />
      </td>
      <td className={CELL}>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(v) => onChange({ ...draft, enabled: v })}
          aria-label="Schedule enabled"
        />
      </td>
      <td className={`${CELL} text-muted-foreground`}>—</td>
      <td className={CELL}>
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onSave} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />}
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

function ShamsSyncPage() {
  const load = useServerFn(shamsSyncMonitor);
  const monitor = useQuery({
    queryKey: ["shams-sync-monitor"],
    queryFn: () => load({ data: undefined }),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const setAutomation = useServerFn(shamsSyncSetAutomation);
  const saveSlot = useServerFn(shamsSyncSaveSlot);
  const deleteSlot = useServerFn(shamsSyncDeleteSlot);
  const runNow = useServerFn(shamsSyncRunNow);

  const [draft, setDraft] = useState<SlotDraft | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRun, setConfirmRun] = useState<("stock" | "promotions")[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; time: string } | null>(null);

  const after = (result: { ok: boolean; message: string | null }) => {
    setNotice({ ok: result.ok, text: result.message ?? "" });
    setDraft(null);
    void monitor.refetch();
  };

  const automationMutation = useMutation({
    mutationFn: (enabled: boolean) => setAutomation({ data: { enabled } }),
    onSuccess: after,
  });
  const slotMutation = useMutation({
    mutationFn: (d: SlotDraft) => saveSlot({ data: { ...d, id: d.id ?? null } }),
    onSuccess: after,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSlot({ data: { id } }),
    onSuccess: after,
  });
  const runMutation = useMutation({
    mutationFn: (kinds: ("stock" | "promotions")[]) => runNow({ data: { kinds } }),
    onSuccess: (r) => {
      setNotice({ ok: r.ok, text: r.message });
      void monitor.refetch();
    },
  });

  const report = monitor.data?.ok ? monitor.data.report : null;
  const scheduler = report?.scheduler ?? null;
  const automationOn = report?.settings.automationEnabled ?? false;

  const lastPollMs = scheduler?.lastPollAt ? Date.parse(scheduler.lastPollAt) : null;
  const pollStale =
    lastPollMs !== null && Number.isFinite(lastPollMs) && Date.now() - lastPollMs > 15 * 60_000;
  const schedulerUnconfigured = scheduler?.lastOutcome === "unconfigured";
  const schedulerTone: Tone = !scheduler
    ? "neutral"
    : schedulerUnconfigured
      ? "danger"
      : pollStale
        ? "warning"
        : "success";

  const anyRunning =
    report?.stock.status?.isRunning === true || report?.promotions.status?.isRunning === true;
  const busy = runMutation.isPending || automationMutation.isPending || slotMutation.isPending;

  return (
    <AdminPage
      title="Shams Sync Control Center"
      description="Automated stock and promotions synchronisation with Shams CRM. Set when updates run, start one by hand, and review what happened."
      actions={
        <>
          <StatusBadge
            tone={automationOn ? "success" : "neutral"}
            label={automationOn ? "Automation on" : "Automation off"}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => monitor.refetch()}
            disabled={monitor.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-3.5 w-3.5 ${monitor.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </>
      }
      meta={<LastUpdated at={report?.observedAt} refreshing={monitor.isFetching} />}
    >
      {notice && <NoticeState tone={notice.ok ? "success" : "danger"} message={notice.text} />}

      {monitor.isError && (
        <NoticeState
          tone="danger"
          message="The status could not be loaded. You may not have administrator access."
        />
      )}
      {monitor.data && !monitor.data.ok && (
        <NoticeState
          tone="danger"
          message={monitor.data.error?.message ?? "The synchronisation status could not be read."}
        />
      )}
      {report && !report.configured && (
        <NoticeState
          tone="warning"
          message="The Shams CRM connection is not configured on this deployment, so nothing can be synchronised."
        />
      )}

      {monitor.isLoading && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <CardSkeleton rows={5} />
            <CardSkeleton rows={5} />
          </div>
          <AdminCard>
            <TableSkeleton rows={4} cols={6} />
          </AdminCard>
        </>
      )}

      {report && (
        <>
          {/* ------------------------------------------------------------ */}
          <AdminSection
            title="Automation"
            description="Governs the schedule only. Update now stays available to administrators either way."
          >
            <AdminCard emphasis>
              <div className="flex flex-wrap items-center justify-between gap-4 border-b px-4 py-4 sm:px-5">
                <HealthIndicator
                  tone={automationOn ? "success" : "neutral"}
                  label={automationOn ? "Automation is ON" : "Automation is OFF"}
                  detail={
                    automationOn
                      ? "Enabled schedules below will run at their configured times."
                      : "No scheduled update will run. Nothing below is active."
                  }
                  pulse={automationOn && !pollStale && !schedulerUnconfigured}
                />
                <div className="flex items-center gap-3">
                  {automationMutation.isPending && (
                    <Loader2
                      className="h-4 w-4 animate-spin text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <Switch
                    checked={automationOn}
                    disabled={automationMutation.isPending}
                    onCheckedChange={(v) => automationMutation.mutate(v)}
                    aria-label="Global automation"
                  />
                </div>
              </div>

              <div className="grid gap-x-6 px-4 py-2 sm:grid-cols-2 sm:px-5">
                <DataRow label="Next stock update">
                  {report.nextStockRun ? riyadh(report.nextStockRun) : "Not scheduled"}
                </DataRow>
                <DataRow label="Next promotions update">
                  {report.nextPromotionsRun ? riyadh(report.nextPromotionsRun) : "Not scheduled"}
                </DataRow>
                <DataRow label="Scheduler">
                  <StatusBadge
                    tone={schedulerTone}
                    label={
                      !scheduler
                        ? "Never reported"
                        : schedulerUnconfigured
                          ? "Not connected"
                          : pollStale
                            ? "Stale"
                            : "Healthy"
                    }
                  />
                </DataRow>
                <DataRow label="Last scheduler activity">
                  {scheduler?.lastPollAt ? riyadh(scheduler.lastPollAt) : "—"}
                </DataRow>
              </div>

              {(schedulerUnconfigured || pollStale || scheduler?.lastError) && (
                <div className="border-t px-4 py-3 sm:px-5">
                  <NoticeState
                    tone={schedulerUnconfigured ? "danger" : "warning"}
                    message={
                      schedulerUnconfigured
                        ? "The scheduler endpoint is not connected on this deployment, so no scheduled update can run even with automation on."
                        : pollStale
                          ? "The scheduler has not polled in over 15 minutes. Check that the scheduled job is running."
                          : (scheduler?.lastError ?? "")
                    }
                  />
                </div>
              )}
            </AdminCard>
          </AdminSection>

          {/* ------------------------------------------------------------ */}
          <AdminSection
            title="Scheduled updates"
            description="Each row is one time of day. Changing them never touches the server's scheduled-job configuration."
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={busy || draft !== null}
                onClick={() =>
                  setDraft({
                    id: null,
                    localTime: "15:00",
                    syncStock: true,
                    syncPromotions: true,
                    enabled: true,
                  })
                }
              >
                <Plus className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Add schedule
              </Button>
            }
          >
            <AdminCard className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className={HEAD} scope="col">
                        Time
                      </th>
                      <th className={HEAD} scope="col">
                        Stock
                      </th>
                      <th className={HEAD} scope="col">
                        Promotions
                      </th>
                      <th className={HEAD} scope="col">
                        Status
                      </th>
                      <th className={HEAD} scope="col">
                        Next run
                      </th>
                      <th className={`${HEAD} text-right`} scope="col">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.slots.length === 0 && !draft && (
                      <tr>
                        <td colSpan={6}>
                          <EmptyState
                            icon={CalendarClock}
                            title="No schedules configured"
                            description="Nothing will run automatically until a schedule is added."
                          />
                        </td>
                      </tr>
                    )}

                    {report.slots.map((slot) =>
                      draft?.id === slot.id ? (
                        <SlotEditorRow
                          key={slot.id}
                          draft={draft}
                          busy={slotMutation.isPending}
                          onChange={setDraft}
                          onSave={() => slotMutation.mutate(draft)}
                          onCancel={() => setDraft(null)}
                        />
                      ) : (
                        <tr key={slot.id} className="border-t hover:bg-muted/30">
                          <td className={CELL}>
                            <div className="font-semibold tabular-nums">
                              {formatLocalTime(slot.localTime)}
                            </div>
                            <div className="text-xs text-muted-foreground">Riyadh</div>
                          </td>
                          <td className={CELL}>
                            <StatusBadge
                              tone={slot.syncStock ? "success" : "neutral"}
                              label={slot.syncStock ? "On" : "Off"}
                            />
                          </td>
                          <td className={CELL}>
                            <StatusBadge
                              tone={slot.syncPromotions ? "success" : "neutral"}
                              label={slot.syncPromotions ? "On" : "Off"}
                            />
                          </td>
                          <td className={CELL}>
                            {slot.enabled ? (
                              automationOn ? (
                                <StatusBadge tone="success" label="Active" />
                              ) : (
                                <StatusBadge tone="neutral" label="Automation off" />
                              )
                            ) : (
                              <StatusBadge tone="neutral" label="Disabled" />
                            )}
                          </td>
                          <td className={`${CELL} tabular-nums`}>
                            {/*
                              Computed from the slot rather than read from the
                              stored next_due_at, which is null until the first
                              tick after automation is switched on — otherwise
                              this column would read "—" while the card above
                              promises a time.
                            */}
                            {slot.enabled && automationOn
                              ? riyadhShort(nextOccurrence(slot, new Date())?.toISOString())
                              : "—"}
                          </td>
                          <td className={CELL}>
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  setDraft({
                                    id: slot.id,
                                    localTime: slot.localTime,
                                    syncStock: slot.syncStock,
                                    syncPromotions: slot.syncPromotions,
                                    enabled: slot.enabled,
                                  })
                                }
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || deleteMutation.isPending}
                                onClick={() =>
                                  setConfirmDelete({
                                    id: slot.id,
                                    time: formatLocalTime(slot.localTime),
                                  })
                                }
                                aria-label={`Remove the ${formatLocalTime(slot.localTime)} schedule`}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ),
                    )}

                    {draft && draft.id === null && (
                      <SlotEditorRow
                        draft={draft}
                        busy={slotMutation.isPending}
                        onChange={setDraft}
                        onSave={() => slotMutation.mutate(draft)}
                        onCancel={() => setDraft(null)}
                      />
                    )}
                  </tbody>
                </table>
              </div>
            </AdminCard>
          </AdminSection>

          {/* ------------------------------------------------------------ */}
          <AdminSection
            title="Update now"
            description="Runs immediately, whether or not automation is on. A manual run never replaces or cancels a scheduled one."
          >
            <AdminCard className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  disabled={busy || anyRunning}
                  onClick={() => setConfirmRun(["stock"])}
                >
                  <Play className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Update Stock now
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || anyRunning}
                  onClick={() => setConfirmRun(["promotions"])}
                >
                  <Play className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Update Promotions now
                </Button>
                <Button
                  disabled={busy || anyRunning}
                  onClick={() => setConfirmRun(["stock", "promotions"])}
                >
                  <Zap className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Update both now
                </Button>
                {runMutation.isPending && (
                  <Loader2
                    className="h-4 w-4 animate-spin text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </div>
              <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Shams runs these in the background. Based on observed runs each takes about 25
                minutes. A run will not start if one is already in progress.
              </p>
              {anyRunning && (
                <div className="mt-3">
                  <NoticeState
                    tone="info"
                    message="A synchronisation is already running at Shams, so manual runs are unavailable until it finishes."
                  />
                </div>
              )}
            </AdminCard>
          </AdminSection>

          {/* ------------------------------------------------------------ */}
          <CatalogPanel />

          {/* ------------------------------------------------------------ */}
          <AdminSection
            title="Current status at Shams"
            description="Read live from Shams CRM each time this page loads."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <SidePanel
                title="Stock"
                side={report.stock}
                unit="pages"
                nextRun={report.nextStockRun}
              />
              <SidePanel
                title="Promotions"
                side={report.promotions}
                unit="branches"
                nextRun={report.nextPromotionsRun}
              />
            </div>
          </AdminSection>

          {/* ------------------------------------------------------------ */}
          <AdminSection
            title="Recent runs"
            description="MilaPortal's own record. Shams keeps only its latest run, so this is the only place the history exists."
          >
            <AdminCard className="overflow-hidden">
              <div className="max-h-[32rem] overflow-auto">
                <table className="w-full min-w-[56rem] text-sm">
                  <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80">
                    <tr>
                      {[
                        "Time",
                        "Source",
                        "Type",
                        "Status",
                        "Duration",
                        "Rows seen",
                        "Rows changed",
                        "Shams run",
                        "Notes",
                      ].map((h) => (
                        <th key={h} className={HEAD} scope="col">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.history.length === 0 && (
                      <tr>
                        <td colSpan={9}>
                          <EmptyState
                            title="No runs recorded yet"
                            description="Scheduled and manual synchronisations will appear here."
                          />
                        </td>
                      </tr>
                    )}
                    {report.history.map((run: ShamsSyncRunRecord) => (
                      <tr key={run.id} className="border-t align-top hover:bg-muted/30">
                        <td className={`${CELL} whitespace-nowrap tabular-nums`}>
                          {riyadhShort(run.triggeredAt)}
                        </td>
                        <td className={CELL}>
                          <span className="capitalize">{run.executionSource}</span>
                          {run.executionSource === "scheduled" && run.scheduledFor && (
                            <span className="block text-xs text-muted-foreground">
                              for {riyadhShort(run.scheduledFor)}
                            </span>
                          )}
                        </td>
                        <td className={`${CELL} capitalize`}>{run.syncType}</td>
                        <td className={CELL}>
                          <StatusBadge status={run.status} />
                        </td>
                        <td className={`${CELL} tabular-nums`}>{duration(run.durationSeconds)}</td>
                        <td className={`${CELL} tabular-nums`}>{count(run.rowsSeen)}</td>
                        <td className={`${CELL} tabular-nums`}>{count(run.rowsChanged)}</td>
                        <td className={`${CELL} tabular-nums`}>{run.shamsRunId ?? "—"}</td>
                        <td className={`${CELL} max-w-xs`}>
                          <span className="text-muted-foreground">
                            {run.skipReason ?? run.errorSummary ?? "—"}
                          </span>
                          {run.sourceTimestampsCorrected && (
                            <span className="mt-0.5 block text-xs text-muted-foreground/80">
                              times corrected from Riyadh
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminCard>
          </AdminSection>
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      <AlertDialog open={confirmRun !== null} onOpenChange={(open) => !open && setConfirmRun(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Start{" "}
              {confirmRun?.length === 2
                ? "Stock and Promotions"
                : confirmRun?.[0] === "stock"
                  ? "Stock"
                  : "Promotions"}{" "}
              now?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Shams runs this in the background and it typically takes about 25 minutes, based on
              observed runs. It will not start a second run if one is already in progress, and it
              will not replace or cancel any scheduled update.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRun) runMutation.mutate(confirmRun);
                setConfirmRun(null);
              }}
            >
              Start now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the {confirmDelete?.time} schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              Stock and Promotions will no longer run automatically at this time. Existing run
              history is kept, and any other schedules are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDelete) deleteMutation.mutate(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Remove schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  );
}
