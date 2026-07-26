import { useState } from "react";
import { History, Undo2 } from "lucide-react";
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
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { IMPORT_MODES, type ImportHistoryEntry } from "../types";

function modeLabel(mode: string): string {
  if (mode === "rollback") return "Rollback";
  return IMPORT_MODES.find((entry) => entry.value === mode)?.label ?? mode;
}

/** Same shape as the admin activity log, in the business timezone. */
function formatBusinessTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function ImportHistoryTable({
  entries,
  loading,
  canRollback,
  onRollback,
  rollingBack,
}: {
  entries: ImportHistoryEntry[];
  loading: boolean;
  canRollback: boolean;
  onRollback: (importId: string) => void;
  rollingBack: boolean;
}) {
  const [confirming, setConfirming] = useState<ImportHistoryEntry | null>(null);

  return (
    <div className="overflow-hidden rounded-xl border border-border/60">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2.5">
        <History className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-semibold">Import history</p>
        {!canRollback && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            Rollback is administrator-only
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded bg-muted/60" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing imported yet. The first upload will appear here.
        </p>
      ) : (
        <div className="overflow-x-auto [scrollbar-width:thin]">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">By</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 text-right font-medium">Added</th>
                <th className="px-3 py-2 text-right font-medium">Updated</th>
                <th className="px-3 py-2 text-right font-medium" title="Deactivated, never deleted">
                  Disabled
                </th>
                <th
                  className="px-3 py-2 text-right font-medium"
                  title="Carried by the file but skipped by the chosen mode"
                >
                  Ignored
                </th>
                <th
                  className="px-3 py-2 text-right font-medium"
                  title="Rejected for a critical validation issue"
                >
                  Failed
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border/40 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {formatBusinessTime(entry.imported_at)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {entry.importer_name ?? (
                      <span className="text-muted-foreground">Deleted account</span>
                    )}
                    {entry.actor_role && (
                      // The role held at the time, not now — see the migration.
                      <span className="block text-[10px] capitalize text-muted-foreground">
                        {entry.actor_role.replace(/_/g, " ")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        entry.mode === "rollback"
                          ? "bg-[var(--attention)]/15 text-[var(--attention)]"
                          : "bg-primary/12 text-primary",
                      )}
                    >
                      {modeLabel(entry.mode)}
                    </span>
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-2 text-xs text-muted-foreground">
                    {entry.file_name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-[var(--positive)]">
                    {entry.rows_added || "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {entry.rows_updated || "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                    {entry.rows_removed || "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                    {entry.rows_ignored || "—"}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right text-xs tabular-nums",
                      entry.rows_failed > 0 ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {entry.rows_failed || "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canRollback && entry.restorable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={rollingBack}
                        onClick={() => setConfirming(entry)}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                        Roll back
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={confirming != null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll the Branch Directory back?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Every branch will be restored to how it stood{" "}
                  <span className="font-medium text-foreground">
                    immediately before the {confirming ? modeLabel(confirming.mode) : ""} import of{" "}
                    {confirming ? formatBusinessTime(confirming.imported_at) : ""}
                  </span>
                  .
                </p>
                <p>
                  Anything changed since then is discarded, including corrections made by other
                  people. Branches created after that point are deactivated rather than deleted, so
                  orders that reference them stay intact.
                </p>
                <p className="text-muted-foreground">
                  This is itself recorded and reversible — the current state is snapshotted first.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) onRollback(confirming.id);
                setConfirming(null);
              }}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
