/**
 * AlShrouq dispatch reconciliation — administrator only.
 *
 * The worklist `20260823120000` built an index for and nobody ever queried.
 * Between 2026-08-23 and 2026-09-12 nine `indeterminate` dispatches and one
 * `failed` one accumulated with no resolution, the oldest twenty days old — not
 * because anyone declined to settle them, but because the only place a stuck
 * dispatch was visible was the order page of the order it belonged to. An
 * operator cannot settle what they cannot find.
 *
 * ## What an operator can do here, and what they cannot
 *
 * Two actions, and neither of them dispatches anything:
 *
 *   **Look up** asks the CRM whether a delivery with this reference exists. One
 *   GET, repeatable, changes nothing. It is the question that matters for a row
 *   with no `local_id` — which is every row on this list — because the order
 *   page's "Check status" button needs a CRM row id that was never recorded.
 *
 *   **Record outcome** writes what a person established. It contacts nobody.
 *
 * There is deliberately **no retry, resend or re-dispatch control anywhere on
 * this page**, and no code path from it to the create transport. A stuck
 * dispatch may already have a driver on the road; the button that would find
 * out by sending it again does not exist.
 *
 * ## The three that are not to be asked about
 *
 * 12389, 12422 and 12428 were dealt with by hand after the 2026-09-10 outage.
 * They render with a "Handled manually" badge, no lookup control, and only one
 * outcome offered. That is the presentation; the enforcement is in
 * `alshrouq-reconciliation.ts` and is checked by the server functions before
 * anything is read or sent. This page not drawing a button is a convenience,
 * not the guarantee.
 *
 * The gate here is presentational for the same reason: `alshrouqUnresolvedDispatches`
 * and `alshrouqLookupDispatch` both assert `admin_access` server-side, and rows
 * are read through the caller's own client so RLS decides visibility first.
 */

import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  alshrouqLookupDispatch,
  alshrouqResolveDispatch,
  alshrouqUnresolvedDispatches,
  type AlShrouqLookupResult,
  type UnresolvedDispatchRow,
} from "@/lib/shams.functions";
import {
  ALSHROUQ_RESOLUTION_OUTCOMES,
  describeResolutionOutcome,
  explainResolutionOutcome,
  isValidResolutionNote,
  RESOLUTION_NOTE_MAX,
  type AlShrouqResolutionOutcome,
} from "@/lib/shams-crm/alshrouq-resolution";
import {
  MANUALLY_HANDLED_BADGE,
  OFFLINE_RESOLUTION_OUTCOMES,
} from "@/lib/shams-crm/alshrouq-reconciliation";
import { AdminPage } from "@/features/admin/components/admin-shell";
import {
  AdminCard,
  AdminSection,
  AdminStatCard,
  EmptyState,
  ErrorState,
  NoticeState,
  StatusBadge,
  TableSkeleton,
} from "@/features/admin/components/primitives";

const ADMIN_TH =
  "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const TD = "px-4 py-3 align-top text-sm";

export const Route = createFileRoute("/_app/admin/alshrouq-reconciliation")({
  component: ReconciliationPage,
});

/** Absolute, then relative — an operator reading a 20-day-old row needs both. */
function when(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * How the transmission evidence is shown.
 *
 * Three answers, never two. "Unknown" is the honest one for a row whose
 * attempt counter cannot settle it, and collapsing it into "not sent" is
 * exactly the mistake that ends with somebody sending a second courier.
 */
function TransmissionBadge({ value }: { value: UnresolvedDispatchRow["transmission"] }) {
  if (value === "confirmed_sent") {
    return <StatusBadge tone="warning" label="Sent — outcome unclear" />;
  }
  if (value === "never_sent") {
    return <StatusBadge tone="info" label="Never sent" />;
  }
  return <StatusBadge tone="neutral" label="Unknown" />;
}

function ReconciliationPage() {
  const queryClient = useQueryClient();
  const listFn = useServerFn(alshrouqUnresolvedDispatches);

  const list = useQuery({
    queryKey: ["alshrouq", "reconciliation"],
    queryFn: () => listFn({ data: undefined }),
  });

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const unresolved = rows.filter((r) => !r.resolutionOutcome);
  const resolved = rows.filter((r) => r.resolutionOutcome);
  const manual = unresolved.filter((r) => r.manuallyHandled);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["alshrouq"] });

  return (
    <AdminPage
      title="AlShrouq dispatch reconciliation"
      description="Dispatches the automated system could not settle, and what operators decided about them."
      requireAdministrator
      actions={
        <Button variant="outline" size="sm" onClick={refresh} disabled={list.isFetching}>
          {list.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Refresh
        </Button>
      }
    >
      <AdminSection title="Outstanding">
        <div className="grid gap-3 sm:grid-cols-3">
          <AdminStatCard label="Awaiting a decision" value={String(unresolved.length)} />
          <AdminStatCard label="Handled manually" value={String(manual.length)} />
          <AdminStatCard label="Settled" value={String(resolved.length)} />
        </div>
      </AdminSection>

      <AdminSection
        title="Needs reconciliation"
        description="Recording an outcome here changes the record only. Nothing on this page sends anything to AlShrouq, and there is no resend control."
      >
        {list.isLoading ? (
          <AdminCard className="overflow-hidden">
            <TableSkeleton rows={4} cols={6} />
          </AdminCard>
        ) : list.isError ? (
          <ErrorState message="The reconciliation worklist could not be read." />
        ) : unresolved.length === 0 ? (
          <EmptyState
            title="Nothing is waiting"
            description="Every stuck dispatch has been settled by an operator."
            icon={ShieldCheck}
          />
        ) : (
          <DispatchTable rows={unresolved} onDone={refresh} />
        )}
      </AdminSection>

      {resolved.length > 0 && (
        <AdminSection
          title="Settled"
          description="The decision, who made it, and when. A resolved dispatch keeps its order's slot — settling one never re-opens the order for a fresh delivery."
        >
          <DispatchTable rows={resolved} onDone={refresh} />
        </AdminSection>
      )}
    </AdminPage>
  );
}

function DispatchTable({ rows, onDone }: { rows: UnresolvedDispatchRow[]; onDone: () => void }) {
  return (
    <AdminCard className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {[
                "Order",
                "Branch",
                "State",
                "Transmission",
                "Attempts",
                "Last attempt",
                "Reason",
                "Resolution",
                "",
              ].map((h, i) => (
                <th key={`${h}-${i}`} className={ADMIN_TH} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <DispatchRow key={row.dispatchId} row={row} onDone={onDone} />
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

function DispatchRow({ row, onDone }: { row: UnresolvedDispatchRow; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [lookup, setLookup] = useState<AlShrouqLookupResult | null>(null);
  const lookupFn = useServerFn(alshrouqLookupDispatch);

  const look = useMutation({
    mutationFn: () => lookupFn({ data: { dispatchId: row.dispatchId } }),
    onSuccess: (r) => {
      setLookup(r);
      if (r.kind === "blocked") toast.info(r.message);
    },
    onError: () => toast.error("The lookup could not be completed. Nothing was sent."),
  });

  return (
    <>
      <tr className="hover:bg-muted/30">
        <td className={TD}>
          <div className="font-medium">{row.displayNo ?? row.clientOrderId ?? "—"}</div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {row.dispatchId.slice(0, 8)}
          </div>
          <div className="text-[11px] text-muted-foreground">Order {row.orderStatus ?? "—"}</div>
        </td>
        <td className={TD}>{row.branchNo ?? "—"}</td>
        <td className={TD}>
          <StatusBadge status={row.dispatchStatus} />
          {row.manuallyHandled && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
              <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
              {MANUALLY_HANDLED_BADGE}
            </div>
          )}
        </td>
        <td className={TD}>
          <TransmissionBadge value={row.transmission} />
        </td>
        <td className={TD}>{row.attemptCount ?? "—"}</td>
        <td className={TD}>
          <div>{when(row.lastAttemptAt)}</div>
          {row.scheduledFor && (
            <div className="text-[11px] text-muted-foreground">Due {when(row.scheduledFor)}</div>
          )}
        </td>
        <td className={`${TD} max-w-[22rem]`}>
          <span className="text-muted-foreground">{row.lastError ?? "—"}</span>
        </td>
        <td className={TD}>
          {row.resolutionOutcome ? (
            <div className="space-y-1">
              <StatusBadge
                tone={row.resolutionOutcome === "delivered" ? "success" : "neutral"}
                label={describeResolutionOutcome(
                  row.resolutionOutcome as AlShrouqResolutionOutcome,
                )}
              />
              <div className="text-[11px] text-muted-foreground">
                {row.resolvedByName ?? "Operator"} · {when(row.resolvedAt)}
              </div>
              {row.resolutionNote && <div className="text-[11px]">{row.resolutionNote}</div>}
              {row.evidenceConflict && (
                <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>
                    <strong>Record disagrees with the evidence.</strong> {row.evidenceConflict}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground">Not settled</span>
          )}
        </td>
        <td className={`${TD} whitespace-nowrap text-right`}>
          {!row.resolutionOutcome && (
            <div className="flex justify-end gap-2">
              {/*
               * Offered only where contact is permitted. The server refuses
               * regardless — see `alshrouqLookupDispatch` — so this is about not
               * showing an operator a control that would only tell them no.
               */}
              {row.externalLookupAllowed && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => look.mutate()}
                  disabled={look.isPending}
                >
                  {look.isPending ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="mr-2 h-3.5 w-3.5" />
                  )}
                  Look up
                </Button>
              )}
              <Button size="sm" onClick={() => setOpen(true)}>
                Record outcome
              </Button>
            </div>
          )}
        </td>
      </tr>

      {lookup && (
        <tr>
          <td colSpan={9} className="bg-muted/20 px-4 pb-3">
            <NoticeState
              tone={lookup.kind === "found" ? "success" : "info"}
              message={
                lookup.kind === "found"
                  ? `AlShrouq holds a delivery for this reference (${lookup.externalOrderId ?? "no number"}${lookup.statusLabel ? `, ${lookup.statusLabel}` : ""}${lookup.isCancelled ? ", cancelled" : ""}). This is evidence for your decision, not a decision.`
                  : lookup.kind === "not_found"
                    ? "AlShrouq has no delivery with this reference in the search window. That is not proof none was created — confirm with the courier before recording an outcome."
                    : lookup.kind === "blocked"
                      ? lookup.message
                      : lookup.kind === "not_configured"
                        ? "The Shams CRM connection is not configured on this deployment."
                        : "AlShrouq could not be reached. Nothing was sent; try again later."
              }
            />
          </td>
        </tr>
      )}

      <ResolveDialog row={row} open={open} onOpenChange={setOpen} onDone={onDone} />
    </>
  );
}

function ResolveDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: {
  row: UnresolvedDispatchRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const blocked = row.manuallyHandled;
  /*
   * A manually-handled dispatch is offered exactly one outcome.
   *
   * The other three all read "AlShrouq confirmed …", and this is the dispatch
   * nobody was allowed to ask. Offering them would invite an operator to record
   * a confirmation they could not have obtained — and the server refuses them
   * anyway, so showing them would only produce a rejection.
   */
  const options = blocked ? OFFLINE_RESOLUTION_OUTCOMES : ALSHROUQ_RESOLUTION_OUTCOMES;

  const [outcome, setOutcome] = useState<AlShrouqResolutionOutcome>(options[0]);
  const [note, setNote] = useState(
    blocked ? "Handled manually outside the Portal after the 2026-09-10 outage." : "",
  );

  const resolveFn = useServerFn(alshrouqResolveDispatch);
  const resolve = useMutation({
    mutationFn: () => resolveFn({ data: { dispatchId: row.dispatchId, outcome, note } }),
    onSuccess: (r) => {
      if (r.kind === "resolved") {
        toast.success("Outcome recorded. The record was updated; nothing was sent to AlShrouq.");
        onOpenChange(false);
        onDone();
      } else if (r.kind === "already_resolved") {
        toast.info("Another operator settled this first. Their answer stands.");
        onOpenChange(false);
        onDone();
      } else if (r.kind === "conflict") {
        toast.error(r.message);
      } else {
        toast.error("This dispatch could not be found.");
      }
    },
    onError: () => toast.error("The outcome could not be recorded. Nothing was changed."),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Record an outcome — {row.displayNo ?? row.clientOrderId ?? "dispatch"}
          </DialogTitle>
          <DialogDescription>
            This records a decision. It does not resend the delivery, and nothing here contacts
            AlShrouq.
          </DialogDescription>
        </DialogHeader>

        {blocked && (
          <NoticeState
            tone="info"
            message={
              <>
                <strong>{MANUALLY_HANDLED_BADGE}.</strong> AlShrouq was never asked about this
                delivery, so the only honest record is that it was handled outside the system.
              </>
            }
          />
        )}

        {row.transmission === "confirmed_sent" && !blocked && (
          <NoticeState
            tone="warning"
            message={
              <span className="inline-flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                This request reached AlShrouq and the outcome was unclear. A driver may already have
                been assigned — confirm with the courier before deciding.
              </span>
            }
          />
        )}

        <fieldset className="space-y-2">
          <legend className="sr-only">Outcome</legend>
          {options.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-muted/40"
            >
              <input
                type="radio"
                name={`outcome-${row.dispatchId}`}
                value={option}
                checked={outcome === option}
                onChange={() => setOutcome(option)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {describeResolutionOutcome(option)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {explainResolutionOutcome(option)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="space-y-1.5">
          <label htmlFor={`note-${row.dispatchId}`} className="text-sm font-medium">
            How was this established?
          </label>
          <Textarea
            id={`note-${row.dispatchId}`}
            value={note}
            maxLength={RESOLUTION_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Branch delivered it with their own driver, confirmed with the pharmacist."
          />
          <p className="text-xs text-muted-foreground">
            Required — this note is the evidence, and it appears on the order timeline. Do not paste
            customer contact details.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => resolve.mutate()}
            disabled={resolve.isPending || !isValidResolutionNote(note)}
          >
            {resolve.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Record outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
