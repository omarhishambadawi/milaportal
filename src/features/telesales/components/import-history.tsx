import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { ListChecks, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { SOURCE_TYPE_LABELS } from "@/lib/telesales/types";
import { telesalesDeleteImpact, telesalesDeleteImport } from "@/lib/telesales.functions";

/**
 * Imported source files, and what can be done with them.
 *
 * The counts are live rather than remembered: `live_leads` is what the import
 * still has in the queue *now*, which is the number that matters when deciding
 * whether to remove it. `worked_leads` is counted separately because it is the
 * part a delete will not take.
 *
 * ===========================================================================
 * Remove is a delete
 * ===========================================================================
 * It used to archive: the file stayed in this list behind a badge, its rows
 * stamped and hidden, restorable. That protected the call history, but it
 * answered a different question from the one being asked — a file uploaded by
 * mistake stayed on screen forever, underneath the corrected one.
 *
 * The confirmation therefore has to be honest about two different fates in one
 * sentence, which is why it quotes both numbers: the leads that go, and the
 * leads that stay because somebody has already worked them.
 */

interface ImportRow {
  id: string;
  source_type: string;
  file_name: string;
  sheet_name: string | null;
  status: string;
  rows_total: number;
  rows_stored: number;
  rows_duplicate: number;
  rows_rejected: number;
  imported_at: string;
  importer_name: string | null;
  actor_role: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  archived_leads: number | null;
  live_source_records: number;
  live_leads: number;
  worked_leads: number;
}

interface Impact {
  fileName: string;
  sourceRecords: number;
  leadsDeleted: number;
  leadsKept: number;
  followups: number;
  runs: number;
}

function ts(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: BUSINESS_TIMEZONE,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function ImportHistory({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<ImportRow | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);

  const history = useQuery<ImportRow[]>({
    queryKey: queryKeys.telesales.imports(20),
    enabled: canManage,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("telesales_import_summary", {
        _limit: 20,
      });
      if (error) throw new Error(error.message);
      return (data as ImportRow[]) ?? [];
    },
  });

  const sweep = () => qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });

  const remove = useMutation({
    mutationFn: (input: { importId: string }) => telesalesDeleteImport({ data: input }),
    onSuccess: (r) => {
      sweep();
      toast.success(
        `Deleted ${r.fileName}: ${r.sourceRecords.toLocaleString("en-US")} source rows and ` +
          `${r.leadsDeleted.toLocaleString("en-US")} leads.` +
          (r.leadsKept > 0
            ? ` ${r.leadsKept.toLocaleString("en-US")} worked leads were kept.`
            : ""),
      );
      setPending(null);
      setImpact(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "The delete failed."),
  });

  /**
   * Ask what would happen, then show it.
   *
   * The dialog opens only once the numbers are in, because a confirmation whose
   * figures arrive a moment later is a confirmation somebody has already
   * clicked through — and this one cannot be undone.
   */
  async function beginDelete(row: ImportRow) {
    setLoadingImpact(true);
    try {
      const res = await telesalesDeleteImpact({ data: { importId: row.id } });
      if (!res.impact) {
        toast.error("That import no longer exists.");
        return;
      }
      setImpact(res.impact as Impact);
      setPending(row);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the import.");
    } finally {
      setLoadingImpact(false);
    }
  }

  if (!canManage) return null;

  const rows = history.data ?? [];

  return (
    <>
      {history.isLoading ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing has been imported yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((h) => (
            <li key={h.id} className={cn("px-4 py-3", h.archived_at && "bg-muted/40")}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={cn("text-sm font-medium", h.archived_at && "line-through")}>
                  {h.file_name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {SOURCE_TYPE_LABELS[h.source_type as keyof typeof SOURCE_TYPE_LABELS] ??
                    h.source_type}
                  {h.sheet_name ? ` · ${h.sheet_name}` : ""}
                </span>
                {/*
                 * Archived is a state nothing produces any more, and a handful
                 * of imports in production still carry it from before removal
                 * became a delete. Shown so those rows are not mysterious, and
                 * they delete like any other.
                 */}
                {h.archived_at ? (
                  <span
                    className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                    title="Archived under the previous behaviour. Its rows are out of the queue."
                  >
                    Archived
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {ts(h.imported_at)}
                  {h.importer_name ? ` · ${h.importer_name}` : ""}
                </span>
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
                {h.archived_at ? (
                  <>
                    {(h.archived_leads ?? 0).toLocaleString("en-US")} leads archived
                    {h.archive_reason ? ` · ${h.archive_reason}` : ""}
                  </>
                ) : (
                  <>
                    {h.live_source_records.toLocaleString("en-US")} source rows ·{" "}
                    {h.live_leads.toLocaleString("en-US")} leads in the queue
                    {h.worked_leads > 0 ? ` · ${h.worked_leads} worked` : ""}
                    {h.rows_duplicate ? ` · ${h.rows_duplicate} duplicate` : ""}
                    {h.rows_rejected ? ` · ${h.rows_rejected} rejected` : ""}
                  </>
                )}
              </p>

              <div className="mt-2 flex items-center gap-2">
                {/* Where the import's rows are accounted for: how many are
                    leads, and what each of the others is waiting for. The
                    answer to "3,937 rows imported and 46 leads appeared". */}
                <Button asChild size="sm" variant="outline">
                  <Link to="/telesales/imports/$id" params={{ id: h.id }}>
                    <ListChecks className="mr-1.5 h-4 w-4" />
                    Review &amp; generate
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={loadingImpact || remove.isPending}
                  onClick={() => beginDelete(h)}
                >
                  {loadingImpact ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-1.5 h-4 w-4" />
                  )}
                  Delete import
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={Boolean(pending && impact)}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setImpact(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {impact?.fileName}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This permanently deletes{" "}
                  <strong>{(impact?.sourceRecords ?? 0).toLocaleString("en-US")}</strong> imported
                  source rows and{" "}
                  <strong>{(impact?.leadsDeleted ?? 0).toLocaleString("en-US")}</strong> leads
                  generated from them
                  {impact && impact.followups > 0
                    ? `, along with ${impact.followups.toLocaleString("en-US")} scheduled follow-up${
                        impact.followups === 1 ? "" : "s"
                      }`
                    : ""}
                  . The import disappears from this list.
                </p>
                {impact && impact.leadsKept > 0 ? (
                  <p className="text-[#B45309] dark:text-amber-300">
                    {impact.leadsKept.toLocaleString("en-US")} lead
                    {impact.leadsKept === 1 ? " has" : "s have"} already been worked. Those stay in
                    the CRM with their full call history — they are no longer linked to this file.
                  </p>
                ) : null}
                <p className="text-muted-foreground">
                  Customer records are untouched and leads from other imports are unaffected.
                  {impact && impact.runs > 0
                    ? ` ${impact.runs} generation run${impact.runs === 1 ? "" : "s"} stay in the history.`
                    : ""}{" "}
                  <strong>This cannot be undone.</strong>
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pending && remove.mutate({ importId: pending.id })}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
