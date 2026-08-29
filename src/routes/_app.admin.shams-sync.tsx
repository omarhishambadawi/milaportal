/**
 * Shams CRM Automation Control Center — administrator only.
 *
 * Phase 2A made this page a window; Phase 2B makes it a control panel. The
 * administrator decides *when* stock and promotions are refreshed and *how
 * often*, by editing schedule rows — `pg_cron` is never rescheduled.
 *
 * The gate here is presentational. Every server function calls `assertAdmin`,
 * and all four tables enforce the same rule again in RLS; this only means a
 * non-administrator sees a refusal rather than a thrown error.
 *
 * ## Times are Riyadh, everywhere, always
 *
 * No UTC value is rendered anywhere on this page. Slots store a local time and a
 * named zone, and the "next run" values come from the same function the
 * scheduler uses — so the page cannot promise a run that will not happen.
 *
 * ## What the panels are for
 *
 * Automation answers "is the schedule live". Scheduled Updates answers "when".
 * The Shams panels answer "did it work". The scheduler panel answers "are we
 * still asking" — and that last one matters most, because a page showing only
 * Shams's health would have looked perfectly fine right through the AlShrouq
 * outage, where nothing had been sent for days behind 5,769 "successful" cron
 * runs.
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Play, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { isAdministrator, useAuth } from "@/lib/auth";
import {
  shamsSyncDeleteSlot,
  shamsSyncMonitor,
  shamsSyncRunNow,
  shamsSyncSaveSlot,
  shamsSyncSetAutomation,
} from "@/lib/shams.functions";
import { TD, TH } from "@/features/shams/constants";
import { formatLocalTime, nextOccurrence } from "@/lib/shams-crm/sync-schedule";
import type { ShamsSyncRunRecord, ShamsSyncSide } from "@/lib/shams-crm/sync-monitor.server";

export const Route = createFileRoute("/_app/admin/shams-sync")({
  component: ShamsSyncPage,
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Timestamps render in Riyadh, explicitly labelled.
 *
 * An unlabelled local time on an admin page read from two countries is how the
 * three-hour confusion started in the first place.
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
/* Status panels                                                               */
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
            <Row label="Next scheduled update">{nextRun ? when(nextRun) : "not scheduled"}</Row>
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
            <Row label="Shams internal schedule">
              {status.syncIntervalMinutes && status.syncIntervalMinutes > 0
                ? `every ${status.syncIntervalMinutes} min`
                : "off (manual)"}
            </Row>

            {status.timestampsCorrected && (
              <p className="pt-2 text-xs text-amber-700 dark:text-amber-500">
                Shams reported this endpoint&apos;s times as Riyadh local in a field labelled UTC.
                They have been corrected here. Raw value: {status.lastSuccessAtRaw ?? "—"}
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
      <td className={TD}>
        {run.executionSource}
        {run.executionSource === "scheduled" && run.scheduledFor && (
          <span className="block text-xs text-muted-foreground">for {when(run.scheduledFor)}</span>
        )}
      </td>
      <td className={`${TD} tabular-nums`}>{duration(run.durationSeconds)}</td>
      <td className={`${TD} tabular-nums`}>{count(run.rowsSeen)}</td>
      <td className={`${TD} tabular-nums`}>{count(run.rowsChanged)}</td>
      <td className={TD}>{run.shamsRunId ?? "—"}</td>
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
/* Schedule editing                                                            */
/* -------------------------------------------------------------------------- */

interface SlotDraft {
  id: string | null;
  localTime: string;
  syncStock: boolean;
  syncPromotions: boolean;
  enabled: boolean;
}

function SlotEditor({
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
    <tr className="border-t bg-muted/30 align-top">
      <td className={TD}>
        <Input
          type="time"
          value={draft.localTime}
          onChange={(e) => onChange({ ...draft, localTime: e.target.value })}
          className="w-32"
          aria-label="Time of day (Riyadh)"
        />
        <span className="mt-1 block text-xs text-muted-foreground">Riyadh</span>
      </td>
      <td className={TD}>
        <Switch
          checked={draft.syncStock}
          onCheckedChange={(v) => onChange({ ...draft, syncStock: v })}
          aria-label="Update Stock at this time"
        />
      </td>
      <td className={TD}>
        <Switch
          checked={draft.syncPromotions}
          onCheckedChange={(v) => onChange({ ...draft, syncPromotions: v })}
          aria-label="Update Promotions at this time"
        />
      </td>
      <td className={TD}>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(v) => onChange({ ...draft, enabled: v })}
          aria-label="Schedule enabled"
        />
      </td>
      <td className={TD}>—</td>
      <td className={TD}>
        <div className="flex gap-2">
          <Button size="sm" onClick={onSave} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden="true" />}
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
  const { role } = useAuth();
  const admin = isAdministrator(role);

  const load = useServerFn(shamsSyncMonitor);
  const monitor = useQuery({
    queryKey: ["shams-sync-monitor"],
    queryFn: () => load({ data: undefined }),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    enabled: admin,
  });

  const setAutomation = useServerFn(shamsSyncSetAutomation);
  const saveSlot = useServerFn(shamsSyncSaveSlot);
  const deleteSlot = useServerFn(shamsSyncDeleteSlot);
  const runNow = useServerFn(shamsSyncRunNow);

  const [draft, setDraft] = useState<SlotDraft | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRun, setConfirmRun] = useState<("stock" | "promotions")[] | null>(null);

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

  if (!admin) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          Administrator access is required for Shams synchronisation.
        </CardContent>
      </Card>
    );
  }

  const report = monitor.data?.ok ? monitor.data.report : null;
  const scheduler = report?.scheduler ?? null;
  const automationOn = report?.settings.automationEnabled ?? false;

  const lastPollMs = scheduler?.lastPollAt ? Date.parse(scheduler.lastPollAt) : null;
  const pollStale =
    lastPollMs !== null && Number.isFinite(lastPollMs) && Date.now() - lastPollMs > 15 * 60_000;
  const schedulerUnconfigured = scheduler?.lastOutcome === "unconfigured";

  const anyRunning =
    report?.stock.status?.isRunning === true || report?.promotions.status?.isRunning === true;
  const busy = runMutation.isPending || automationMutation.isPending || slotMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Shams CRM automation</h1>
          <p className="text-sm text-muted-foreground">
            Control when Stock and Promotions are refreshed. All times are Riyadh. The PharmacyCRM
            Desktop remains available as a manual fallback.
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

      {notice && (
        <p
          className={`text-sm ${notice.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}
        >
          {notice.text}
        </p>
      )}

      {monitor.isError && (
        <p className="text-sm text-destructive">
          The status could not be loaded. You may not have administrator access.
        </p>
      )}

      {report && !report.configured && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            The Shams CRM connection is not configured on this deployment, so nothing can be
            synchronised. Set <code>SHAMS_CRM_USERNAME</code> and <code>SHAMS_CRM_PASSWORD</code>.
          </CardContent>
        </Card>
      )}

      {report && (
        <>
          {/* ---------------------------------------------------------------- */}
          <Section
            title="Automation"
            hint="Governs the schedule only. Update Now stays available to administrators either way."
          >
            <Card>
              <CardContent className="space-y-3 py-4 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="font-medium">
                      {automationOn ? "Automation is ON" : "Automation is OFF"}
                    </div>
                    <p className="text-muted-foreground">
                      {automationOn
                        ? "Enabled schedules below will run at their configured times."
                        : "No scheduled update will run. Nothing below is active."}
                    </p>
                  </div>
                  <Switch
                    checked={automationOn}
                    disabled={automationMutation.isPending}
                    onCheckedChange={(v) => automationMutation.mutate(v)}
                    aria-label="Global automation"
                  />
                </div>

                <div className="grid gap-1 border-t pt-3 sm:grid-cols-2">
                  <Row label="Next Stock update">
                    {report.nextStockRun ? when(report.nextStockRun) : "not scheduled"}
                  </Row>
                  <Row label="Next Promotions update">
                    {report.nextPromotionsRun ? when(report.nextPromotionsRun) : "not scheduled"}
                  </Row>
                </div>

                {schedulerUnconfigured && (
                  <p className="border-t pt-3 text-destructive">
                    The scheduler endpoint is not connected on this deployment, so no scheduled
                    update can run even with automation on. An administrator needs to complete the
                    setup.
                  </p>
                )}
              </CardContent>
            </Card>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            title="Scheduled updates"
            hint="Each row is one time of day. Changing them never touches the server's cron configuration."
          >
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    {["Time", "Stock", "Promotions", "Status", "Next run", "Actions"].map((h) => (
                      <th key={h} className={TH}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.slots.length === 0 && !draft && (
                    <tr className="border-t">
                      <td className={`${TD} text-muted-foreground`} colSpan={6}>
                        No schedules configured. Nothing will run automatically.
                      </td>
                    </tr>
                  )}

                  {report.slots.map((slot) =>
                    draft?.id === slot.id ? (
                      <SlotEditor
                        key={slot.id}
                        draft={draft}
                        busy={slotMutation.isPending}
                        onChange={setDraft}
                        onSave={() => slotMutation.mutate(draft)}
                        onCancel={() => setDraft(null)}
                      />
                    ) : (
                      <tr key={slot.id} className="border-t align-top">
                        <td className={`${TD} font-medium tabular-nums`}>
                          {formatLocalTime(slot.localTime)}
                          <span className="block text-xs font-normal text-muted-foreground">
                            Riyadh
                          </span>
                        </td>
                        <td className={TD}>{slot.syncStock ? "ON" : "off"}</td>
                        <td className={TD}>{slot.syncPromotions ? "ON" : "off"}</td>
                        <td className={TD}>
                          {slot.enabled ? (
                            automationOn ? (
                              <span className="text-emerald-700 dark:text-emerald-400">Active</span>
                            ) : (
                              <span className="text-muted-foreground">Enabled, automation off</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">Disabled</span>
                          )}
                        </td>
                        <td className={TD}>
                          {/*
                            Computed from the slot rather than read from the
                            stored `next_due_at`, which is null until the first
                            tick after automation is switched on. Reading the
                            stored value would show "—" on a slot the Automation
                            card above is simultaneously promising a time for.
                          */}
                          {slot.enabled && automationOn
                            ? when(nextOccurrence(slot, new Date())?.toISOString())
                            : "—"}
                        </td>
                        <td className={TD}>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
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
                              onClick={() => deleteMutation.mutate(slot.id)}
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
                    <SlotEditor
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

            <Button
              variant="secondary"
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
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Add schedule
            </Button>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            title="Update now"
            hint="Runs immediately, whether or not automation is on. A manual run never replaces or cancels a scheduled one."
          >
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2 py-4">
                <Button
                  variant="secondary"
                  disabled={busy || anyRunning}
                  onClick={() => setConfirmRun(["stock"])}
                >
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                  Update Stock now
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || anyRunning}
                  onClick={() => setConfirmRun(["promotions"])}
                >
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                  Update Promotions now
                </Button>
                <Button
                  disabled={busy || anyRunning}
                  onClick={() => setConfirmRun(["stock", "promotions"])}
                >
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                  Update both now
                </Button>
                {runMutation.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {anyRunning && (
                  <span className="text-sm text-muted-foreground">
                    A synchronisation is already running at Shams.
                  </span>
                )}
              </CardContent>
            </Card>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            title="Scheduler"
            hint="Whether MilaPortal is still asking, separate from whether Shams is healthy."
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
                <Row label="Last outcome">
                  <span className={schedulerUnconfigured ? "text-destructive" : undefined}>
                    {scheduler?.lastOutcome ?? "—"}
                  </span>
                </Row>
                {scheduler?.lastError && (
                  <p className="pt-2 text-destructive">{scheduler.lastError}</p>
                )}
                {!scheduler && (
                  <p className="text-muted-foreground">
                    The scheduler has never reported in. Check that the migration has been applied.
                  </p>
                )}
              </CardContent>
            </Card>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            title="Current status at Shams"
            hint="Read live from Shams CRM each time this page loads."
          >
            <div className="grid gap-4 md:grid-cols-2">
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
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            title="Recent runs"
            hint="MilaPortal's own record. Shams keeps only its latest run, so this is the only place the history exists."
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
                      "Shams run",
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
                      <td className={`${TD} text-muted-foreground`} colSpan={9}>
                        No runs recorded yet.
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

      {/*
        The confirmation names exactly what will happen and how long it lasts.
        Starting a full catalogue refresh on a third-party production system is
        not something to do on a single click.
      */}
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
    </div>
  );
}
