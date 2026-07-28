import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  FileDown,
  FileSpreadsheet,
  Loader2,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { ImportHistoryTable } from "@/features/branches/components/import-history-table";
import { ImportPreviewPanel } from "@/features/branches/components/import-preview-panel";
import { downloadImportTemplate } from "@/features/branches/import-template";
import { useBranchDirectory } from "@/features/branches/hooks/use-branch-directory";
import { ACCEPTED_EXTENSIONS, useBranchImport } from "@/features/branches/hooks/use-branch-import";
import { FACILITY_DUPLICATE_STRATEGIES, IMPORT_MODES } from "@/features/branches/types";

export const Route = createFileRoute("/_app/branches/import")({
  head: () => ({ meta: [{ title: "Import Branches — MilaServ Portal" }] }),
  component: BranchImportPage,
});

/** "48 KB". One decimal past a megabyte, none below it — nobody needs "48.3 KB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatUploadedAt(iso: string): string {
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

function BranchImportPage() {
  const { canManage, canRollback } = useBranchDirectory();
  const {
    preview,
    parsing,
    mode,
    setMode,
    importOptions,
    setDuplicateStrategy,
    readFile,
    clear,
    apply,
    rollback,
    history,
    historyLoading,
    summary,
    lastUpload,
    downloadLastUpload,
  } = useBranchImport();

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  if (!canManage) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Import is restricted</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Only Owners, Admins and Supervisors can change the Branch Directory.
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link to="/branches">Back to the directory</Link>
        </Button>
      </div>
    );
  }

  const nothingToImport = !summary || summary.valid === 0;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="-ml-2 mb-1 h-7 text-xs" asChild>
            <Link to="/branches">
              <ArrowLeft className="h-3.5 w-3.5" />
              Branch Directory
            </Link>
          </Button>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Import Branches</h1>
          <p className="text-xs text-muted-foreground sm:text-sm">
            Upload the master workbook. Nothing is written until you review the preview and confirm.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* The working loop is: get the current sheet, edit it offline, map
              the columns, upload it again. The first step had no answer inside
              the portal — the file lived on whoever ran the last import's
              laptop. Offered only when one has actually been kept, so it is
              never a button that explains itself with an error. */}
          {lastUpload && (
            <Button
              variant="outline"
              size="sm"
              disabled={downloadLastUpload.isPending}
              onClick={() => downloadLastUpload.mutate()}
              title={`${lastUpload.fileName ?? "Workbook"} · uploaded ${formatUploadedAt(
                lastUpload.importedAt,
              )}`}
            >
              {downloadLastUpload.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4" />
              )}
              Last upload
              {lastUpload.size != null && (
                <span className="text-xs font-normal text-muted-foreground">
                  {formatBytes(lastUpload.size)}
                </span>
              )}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => downloadImportTemplate()}>
            <Download className="h-4 w-4" />
            Download template
          </Button>
        </div>
      </div>

      {/* Upload */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file) readFile(file);
        }}
        className={cn(
          "rounded-2xl border-2 border-dashed p-6 text-center transition-colors duration-150 sm:p-10",
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border/70 bg-card/50 hover:border-border",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) readFile(file);
            // Reset so re-picking the same file after a correction still fires
            // a change event.
            event.target.value = "";
          }}
        />
        {parsing ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Reading the workbook…</p>
          </div>
        ) : (
          <>
            <FileSpreadsheet className="mx-auto h-9 w-9 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium">
              Drop the workbook here, or{" "}
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="text-primary underline underline-offset-2 hover:no-underline"
              >
                browse for it
              </button>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {ACCEPTED_EXTENSIONS.join(" · ")} — the sheet named “Branches” is read when the file
              has several.
            </p>
          </>
        )}
      </div>

      {/* Preview + commit */}
      {preview && summary && (
        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-4 shadow-sm sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Review before importing
            </h2>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clear}>
              <X className="h-3.5 w-3.5" />
              Discard
            </Button>
          </div>

          <ImportPreviewPanel preview={preview} summary={summary} />

          <div className="space-y-2 border-t border-border/60 pt-4">
            <div>
              <p className="text-sm font-medium">Repeated branch codes</p>
              <p className="text-xs text-muted-foreground">
                Pharmacy codes (P0001…) always have to be unique — a repeat is an error whatever is
                chosen here. This decides what happens to repeated <em>facility</em> codes, such as
                the two rows both coded “المستودع”.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FACILITY_DUPLICATE_STRATEGIES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.description}
                  onClick={() => setDuplicateStrategy(option.value)}
                  aria-pressed={importOptions.facilityDuplicates === option.value}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    importOptions.facilityDuplicates === option.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border/70 hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {
                FACILITY_DUPLICATE_STRATEGIES.find(
                  (option) => option.value === importOptions.facilityDuplicates,
                )?.description
              }
            </p>
          </div>

          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-sm font-medium">How should this be applied?</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {IMPORT_MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMode(option.value)}
                  aria-pressed={mode === option.value}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors duration-150",
                    mode === option.value
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border/70 hover:border-border hover:bg-accent/40",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={cn(
                        "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                        mode === option.value ? "border-primary" : "border-muted-foreground/40",
                      )}
                      aria-hidden
                    >
                      {mode === option.value && (
                        <span className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </span>
                    {option.label}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p className="text-xs text-muted-foreground">
              {nothingToImport
                ? "There is nothing importable in this file."
                : summary.critical > 0
                  ? `${summary.valid} rows will be written; ${summary.rejected} are skipped for critical issues. Warnings do not block the import.`
                  : `${summary.valid} rows will be written. The directory is snapshotted first, so this can be rolled back.`}
            </p>
            <Button
              onClick={() => apply.mutate()}
              disabled={nothingToImport || apply.isPending}
              className="min-w-40"
            >
              {apply.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Import {summary.valid} branches
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <ImportHistoryTable
        entries={history}
        loading={historyLoading}
        canRollback={canRollback}
        onRollback={(id) => rollback.mutate(id)}
        rollingBack={rollback.isPending}
      />
    </div>
  );
}
