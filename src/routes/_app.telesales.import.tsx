import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Play,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { ACCEPTED_EXTENSIONS, parseWorkbookFile } from "@/lib/telesales/parse";
import { businessToday } from "@/lib/telesales/dates";
import { SOURCE_TYPES, SOURCE_TYPE_LABELS, type ParsedWorkbook } from "@/lib/telesales/types";
import {
  telesalesGenerate,
  telesalesImportHistory,
  telesalesImportWorkbook,
  telesalesSeedRetentionBacklog,
} from "@/lib/telesales.functions";
import type { ImportHistoryEntry } from "@/features/telesales/types";

export const Route = createFileRoute("/_app/telesales/import")({
  head: () => ({ meta: [{ title: "Telesales Import — MilaServ Portal" }] }),
  component: TelesalesImportPage,
});

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
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

type Preview = ParsedWorkbook & { availableSheets: string[] };

/**
 * Importing a source workbook, and running lead generation.
 *
 * The two live on one screen because they are one operator task: a file arrives,
 * it goes in, and the desk expects leads. Splitting them across two pages would
 * make "I imported it but nothing appeared" a support question rather than a
 * button.
 *
 * The workbook is parsed **in the browser**, and only the normalised rows are
 * posted. `July Leads.xlsx` is 15 MB; shipping it to a Worker to get a preview
 * back would double the transfer to answer a question the browser can answer
 * itself, and the operator has to see the detected type and the row counts
 * before anything is written either way.
 */
function TelesalesImportPage() {
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  const canManage = hasPerm(role, perms, "manage_telesales");
  const qc = useQueryClient();

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceType, setSourceType] = useState<string>("cash");
  const [sheetName, setSheetName] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [anchorDate, setAnchorDate] = useState(businessToday());

  const history = useQuery<ImportHistoryEntry[]>({
    queryKey: queryKeys.telesales.imports(20),
    enabled: canManage,
    queryFn: async () => {
      const res = await telesalesImportHistory({ data: { limit: 20 } });
      return res.imports as ImportHistoryEntry[];
    },
  });

  if (!canManage) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Import is restricted</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Only team leads and administrators can import telesales source files.
        </p>
      </div>
    );
  }

  async function readFile(f: File, sheet?: string) {
    setParsing(true);
    try {
      const parsed = await parseWorkbookFile(f, sheet ? { sheetName: sheet } : {});
      setPreview(parsed);
      setFile(f);
      setSourceType(parsed.sourceType);
      setSheetName(parsed.sheetName);
      if (parsed.records.length === 0) {
        toast.warning("No usable rows were found in that sheet.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That file could not be read.");
      setPreview(null);
      setFile(null);
    } finally {
      setParsing(false);
    }
  }

  function clear() {
    setPreview(null);
    setFile(null);
    setSheetName("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function apply() {
    if (!preview || !file) return;
    setUploading(true);
    try {
      const result = await telesalesImportWorkbook({
        data: {
          fileName: file.name,
          fileSize: file.size,
          sheetName: preview.sheetName,
          sourceType: sourceType as "cash" | "wasfaty" | "retention",
          contentDigest: preview.contentDigest,
          rowsSeen: preview.rowsSeen,
          headers: preview.headers,
          records: preview.records.map((r) => ({ ...r, sourceType })) as any,
          issues: preview.issues,
        },
      });

      toast.success(
        `Imported ${result.rowsStored.toLocaleString("en-US")} rows from ${file.name}.`,
      );
      if (result.previousImportId) {
        // Not an error. Re-importing a corrected file is legitimate; the operator
        // just needs to know they are looking at a repeat.
        toast.info("This file has been imported before. Both imports are kept.");
      }

      /*
       * The retention backlog is seeded immediately, because it has no window to
       * wait for. Cash and Wasfaty rows sit until the generator's window reaches
       * them, which is the correct behaviour for a dated pipeline and the wrong
       * one for a backlog that is already overdue.
       */
      if (sourceType === "retention") {
        const seeded = await telesalesSeedRetentionBacklog({
          data: { importId: result.importId },
        });
        toast.success(`Seeded ${seeded.summary.created} retention leads.`);
      }

      qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });
      clear();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The import failed.");
    } finally {
      setUploading(false);
    }
  }

  async function generate(leadType: "cash" | "wasfaty" | "retention" | null) {
    setGenerating(true);
    try {
      const res = await telesalesGenerate({ data: { leadType, anchorDate } });
      const created = res.runs.reduce((s, r) => s + r.created, 0);
      const dupes = res.runs.reduce((s, r) => s + r.skippedDuplicate, 0);
      const failed = res.runs.filter((r) => r.errors > 0);
      if (failed.length > 0) {
        toast.error(`Generation failed: ${failed[0].errorSummary ?? "unknown error"}`);
      } else {
        toast.success(
          created === 0 && dupes > 0
            ? `No new leads — all ${dupes} candidates already exist.`
            : `Created ${created} lead${created === 1 ? "" : "s"}${dupes ? `, ${dupes} already existed` : ""}.`,
        );
      }
      qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/telesales">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Queue
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Import &amp; generate</h1>
        </div>
      </div>

      {/* Upload */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Source file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={cn(
              "rounded-lg border-2 border-dashed p-8 text-center transition-colors",
              dragOver ? "border-primary bg-primary/5" : "border-border",
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void readFile(f);
            }}
          >
            <FileSpreadsheet className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">Drop a workbook here</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Cash extract, Wasfaty file, or the Retention backlog. {ACCEPTED_EXTENSIONS.join(", ")}
            </p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={parsing}
            >
              {parsing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Choose a file
            </Button>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept={ACCEPTED_EXTENSIONS.join(",")}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
              }}
            />
          </div>

          {preview && file ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.size)} · {preview.rowsSeen.toLocaleString("en-US")} rows read
                    · {preview.records.length.toLocaleString("en-US")} usable
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={clear}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Sheet</Label>
                  {/* `July Leads.xlsx` has thirteen sheets; the parser picks the
                      largest and the operator can override it. */}
                  <Select
                    value={sheetName}
                    onValueChange={(v) => {
                      setSheetName(v);
                      if (file) void readFile(file, v);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {preview.availableSheets.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Detected as</Label>
                  <Select value={sourceType} onValueChange={setSourceType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {SOURCE_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {preview.headers.length > 0 ? (
                <p className="truncate text-xs text-muted-foreground">
                  Columns: {preview.headers.filter(Boolean).join(", ")}
                </p>
              ) : null}

              {preview.issues.length > 0 ? (
                <div className="rounded-md border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-[#B45309] dark:text-amber-200">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {preview.issues.length} thing{preview.issues.length === 1 ? "" : "s"} to know
                  </p>
                  <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
                    {preview.issues.map((i) => (
                      <li key={i.code}>
                        {i.message}
                        {i.rows.length > 0 ? ` — rows ${i.rows.slice(0, 8).join(", ")}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-[#047857] dark:text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Every row read cleanly.
                </p>
              )}

              <Button disabled={uploading || preview.records.length === 0} onClick={apply}>
                {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Import {preview.records.length.toLocaleString("en-US")} rows
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Generation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Lead generation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Running this twice is safe. Every lead carries a deduplication key the database
            enforces, so a second run reports the duplicates it refused rather than creating them.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ts-anchor">Anchor date</Label>
              <Input
                id="ts-anchor"
                type="date"
                className="w-[170px]"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
              />
            </div>
            <Button disabled={generating} onClick={() => generate(null)}>
              {generating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run all three
            </Button>
            <Button variant="outline" disabled={generating} onClick={() => generate("cash")}>
              Cash only
            </Button>
            <Button variant="outline" disabled={generating} onClick={() => generate("wasfaty")}>
              Wasfaty only
            </Button>
            <Button variant="outline" disabled={generating} onClick={() => generate("retention")}>
              Retention only
            </Button>
          </div>
          {/* The anchor date is the thing an operator will get wrong, so it says
              what it does rather than assuming today. */}
          <p className="text-xs text-muted-foreground">
            The anchor is the day the windows are measured from. Cash looks at the three days before
            it; Wasfaty at it and the day after; retention at follow-ups due on or before it. Set it
            to a past date to backfill.
          </p>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Import history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {history.isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (history.data ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing has been imported yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(history.data ?? []).map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                >
                  <span className="text-sm font-medium">{h.file_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {SOURCE_TYPE_LABELS[h.source_type as keyof typeof SOURCE_TYPE_LABELS] ??
                      h.source_type}
                    {h.sheet_name ? ` · ${h.sheet_name}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {h.rows_stored.toLocaleString("en-US")} stored
                    {h.rows_duplicate ? ` · ${h.rows_duplicate} duplicate` : ""}
                    {h.rows_rejected ? ` · ${h.rows_rejected} rejected` : ""}
                  </span>
                  {h.status !== "completed" ? (
                    <span className="text-xs font-medium text-destructive">{h.status}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {ts(h.imported_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
