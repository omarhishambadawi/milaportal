import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
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
import { ImportHistory } from "@/features/telesales/components/import-history";
import {
  TEMPLATE_ORDER,
  checkMapping,
  templateFor,
  wasfatyUsesFillDateFallback,
  type MappingCheck,
} from "@/lib/telesales/templates";
import { TEMPLATE_DATA_SHEET, downloadTemplate } from "@/lib/telesales/template-file";
import { UploadProgress, type UploadStage } from "@/features/telesales/components/upload-progress";
import { ColumnMappingPanel } from "@/features/telesales/components/column-mapping-panel";
import { buildMapping, storedMapping, validateMapping } from "@/lib/telesales/column-mapping";
import type { ColumnOverrides } from "@/lib/telesales/parse";

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
  const [stage, setStage] = useState<UploadStage>("idle");
  const [stageDetail, setStageDetail] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  /*
   * The operator's own column choices, for this file only.
   *
   * Empty is the normal case: detection answered and nobody disagreed. Cleared
   * whenever a new file or a new sheet is read, because a mapping is about a
   * particular set of columns and carrying it to a different one would apply
   * silently to the wrong file.
   */
  const [overrides, setOverrides] = useState<ColumnOverrides>({});

  /*
   * One boolean derived from the stage, rather than a second piece of state
   * that can disagree with it. A duplicate submit is prevented by the stage
   * machine itself — there is no state in which the button is enabled and work
   * is in flight.
   */
  const busy = stage === "reading" || stage === "uploading" || stage === "storing";
  const [anchorDate, setAnchorDate] = useState(businessToday());

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

  /**
   * Read the file again with a different mapping.
   *
   * The same `parseWorkbookFile` and the same options object — the override is
   * one more field on it, so there is one parser and one code path, and a file
   * parsed with no overrides is byte-for-byte the file parsed before this
   * feature existed.
   */
  async function applyMapping(next: ColumnOverrides) {
    setOverrides(next);
    if (file) await readFile(file, sheetName || undefined, next);
  }

  async function readFile(
    f: File,
    sheet?: string,
    mapping: ColumnOverrides = overrides,
    /** Force the type, when the operator has just overridden it. */
    forcedType?: string,
  ) {
    setParsing(true);
    setStage("reading");
    setStageDetail(`${f.name} · ${formatBytes(f.size)}`);
    try {
      /*
       * Yield a frame before parsing.
       *
       * `parseWorkbookFile` is synchronous CPU work once the bytes are in hand,
       * and a 15 MB workbook blocks the main thread for long enough that the
       * "Reading" state would otherwise never paint — the operator would see
       * the click do nothing, which is the exact complaint this addresses.
       */
      await new Promise((resolve) => setTimeout(resolve, 0));
      const parsed = await parseWorkbookFile(f, {
        ...(sheet ? { sheetName: sheet } : {}),
        ...(Object.keys(mapping).length > 0 ? { columnOverrides: mapping } : {}),
        ...(forcedType ? { sourceType: forcedType as "cash" | "retention" | "wasfaty" } : {}),
      });
      setPreview(parsed);
      setFile(f);
      // The detected type only leads when nothing has been mapped by hand:
      // re-parsing after a mapping change must not undo the operator's choice
      // of source type.
      if (!forcedType && Object.keys(mapping).length === 0) setSourceType(parsed.sourceType);
      setSheetName(parsed.sheetName);
      setStage("idle");
      setStageDetail(null);
      if (parsed.records.length === 0) {
        toast.warning("No usable rows were found in that sheet.");
      }
    } catch (err) {
      setStage("failed");
      setStageDetail(err instanceof Error ? err.message : "That file could not be read.");
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
    setOverrides({});
    setStage("idle");
    setStageDetail(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  /**
   * Which template columns this file supplied, and which it did not.
   *
   * Computed from the fields the parser *resolved*, not from the header text, so
   * an external spreadsheet that spells a column differently still counts as
   * supplying it. The template is the reliable path, not the only one.
   */
  /*
   * The mapping as it stands: what detection found, with the operator's choices
   * laid over it, against the template's own field list for this source type.
   */
  const mappingRows = preview
    ? buildMapping(
        sourceType as "cash" | "retention" | "wasfaty",
        new Map(Object.entries(preview.mappedColumns)),
        overrides,
      )
    : [];
  const mappingVerdict = validateMapping(mappingRows, preview?.headers ?? []);

  const mapping: MappingCheck | null = preview
    ? checkMapping(
        templateFor(sourceType as "cash" | "retention" | "wasfaty"),
        new Set(preview.mappedFields as any),
      )
    : null;

  /*
   * The single most expensive mapping mistake this module has seen, called out
   * on its own rather than left in the missing-columns list: a Wasfaty file
   * carrying a fill date and no next-dispense date parses perfectly and then
   * generates almost nothing, because the forward window is measured against a
   * backward-looking column.
   */
  const wasfatyDateTrap =
    sourceType === "wasfaty" &&
    preview != null &&
    wasfatyUsesFillDateFallback(new Set(preview.mappedFields as any));

  async function getTemplate(type: "cash" | "retention" | "wasfaty") {
    setDownloading(type);
    try {
      await downloadTemplate(templateFor(type));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The template could not be built.");
    } finally {
      setDownloading(null);
    }
  }

  async function apply() {
    if (!preview || !file || busy) return;
    setStage("uploading");
    setStageDetail(`${preview.records.length.toLocaleString("en-US")} rows`);
    try {
      /*
       * One request carries the parsed rows, and the server writes them in
       * batches of 500. There is no byte-level progress to report for it —
       * `fetch` exposes none for a request body — so the stage says "Sending"
       * and then "Storing" rather than animating a number that would be
       * invented. The row count is the honest measure of size.
       */
      setStage("storing");
      const result = await telesalesImportWorkbook({
        data: {
          fileName: file.name,
          fileSize: file.size,
          sheetName: preview.sheetName,
          sourceType: sourceType as "cash" | "wasfaty" | "retention",
          contentDigest: preview.contentDigest,
          rowsSeen: preview.rowsSeen,
          headers: preview.headers,
          mappedFields: preview.mappedFields,
          mappedColumns: preview.mappedColumns,
          columnMapping: storedMapping(mappingRows, preview.headers),
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
      setStage("done");
      setStageDetail(
        `${result.rowsStored.toLocaleString("en-US")} of ${preview.records.length.toLocaleString(
          "en-US",
        )} rows stored. Review the import, then generate leads when you are ready.`,
      );
      setPreview(null);
      setFile(null);
      setSheetName("");
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setStage("failed");
      // The server's own message, kept rather than replaced by a generic one:
      // "duplicate key" and "payload too large" need different actions.
      setStageDetail(err instanceof Error ? err.message : "The import failed.");
      toast.error(err instanceof Error ? err.message : "The import failed.");
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

      {/* Templates */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">MilaPortal templates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            A file built from one of these maps with no guessing: every header is one the importer
            recognises, and the sheet says which columns are required and what the dates mean. Your
            existing spreadsheets still work — this is the reliable path, not the only one.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {TEMPLATE_ORDER.map((type) => {
              const t = templateFor(type);
              return (
                <div key={type} className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium">{t.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.purpose}</p>
                  <Button
                    className="mt-2 w-full"
                    variant="outline"
                    size="sm"
                    disabled={downloading != null}
                    onClick={() => void getTemplate(type)}
                  >
                    {downloading === type ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    Download
                  </Button>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

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
              disabled={parsing || busy}
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

          <UploadProgress stage={stage} detail={stageDetail} />

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
                      // A different sheet is a different set of columns, so a
                      // mapping made against the old one cannot carry over.
                      setOverrides({});
                      if (file) void readFile(file, v, {});
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
                  {/*
                   * Overriding the type re-reads the file.
                   *
                   * It used to set the label and nothing else, so the rows kept
                   * whatever rules the *detected* type had parsed them under —
                   * and for Wasfaty that is a different date column entirely
                   * (`primaryDateField` takes the next-dispense or fill date,
                   * where Cash and Retention take the invoice date). A file
                   * detected as Cash and switched to Wasfaty was imported with
                   * invoice dates standing in for dispense dates, which the
                   * today-and-tomorrow window then judged.
                   *
                   * The mapping is kept: it is keyed by field, and a field the
                   * new type does not use is simply not read.
                   */}
                  <Select
                    value={sourceType}
                    onValueChange={(v) => {
                      setSourceType(v);
                      if (file) void readFile(file, sheetName || undefined, overrides, v);
                    }}
                  >
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

              {/* ------------------------------------------------------------
                  What the importer understood.

                  Shown before the import rather than after, because this is the
                  last moment at which a wrong file is cheap to fix. It lists the
                  template's columns against what the file supplied, so "it
                  imported fine and produced nothing" stops being a surprise
                  discovered a day later.
                  ------------------------------------------------------------ */}
              {/* ------------------------------------------------------------
                  The manual mapping.

                  Below the detected summary rather than instead of it: the
                  summary says what the importer understood, and this is where
                  it gets corrected. Auto-detection remains the default and a
                  field nobody touches keeps what the headers said.
                  ------------------------------------------------------------ */}
              {preview.headers.length > 0 ? (
                <ColumnMappingPanel
                  rows={mappingRows}
                  headers={preview.headers}
                  verdict={mappingVerdict}
                  disabled={busy || parsing}
                  onChange={(field, column) => void applyMapping({ ...overrides, [field]: column })}
                  onReset={() => void applyMapping({})}
                />
              ) : null}

              {mapping ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs font-medium">
                    Mapping · {mapping.matched.length} of{" "}
                    {templateFor(sourceType as "cash" | "retention" | "wasfaty").columns.length}{" "}
                    template columns found
                  </p>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {mapping.matched.slice(0, 8).map((c) => (
                      <li key={c.header} className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-3 w-3 shrink-0 text-[#047857] dark:text-emerald-300" />
                        <span className="truncate">
                          {c.header}
                          {c.required ? "" : " (optional)"}
                        </span>
                      </li>
                    ))}
                    {mapping.matched.length > 8 ? (
                      <li className="pl-4.5">+{mapping.matched.length - 8} more</li>
                    ) : null}
                  </ul>

                  {mapping.missingRequired.length > 0 ? (
                    <div className="rounded border border-destructive/40 bg-destructive/5 p-2">
                      <p className="text-xs font-medium text-destructive">
                        Missing required: {mapping.missingRequired.map((c) => c.header).join(", ")}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        The rows will import and be kept, but they cannot become leads without
                        these. Importing anyway is safe; nothing is discarded.
                      </p>
                    </div>
                  ) : null}

                  {wasfatyDateTrap ? (
                    <div className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-2">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-[#B45309] dark:text-amber-200">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        This file has a fill date but no next-dispense date
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Wasfaty eligibility is measured against the date a prescription becomes
                        collectable — today or tomorrow. A fill date is a past event, so almost
                        every row will fall outside the window and produce no lead. The rows are
                        still stored, and the import review will show exactly how many.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {/*
                 * Blocked on an invalid mapping, not on a warning.
                 *
                 * A required field with no column, or one column claimed by two
                 * fields, produces rows that either cannot become leads or are
                 * quietly wrong -- and both are far cheaper to fix here than
                 * after 3,937 rows are stored.
                 */}
                <Button
                  disabled={busy || preview.records.length === 0 || !mappingVerdict.ok}
                  onClick={apply}
                >
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Import {preview.records.length.toLocaleString("en-US")} rows
                </Button>
                {/* Says what the button does *not* do. The distinction between
                    storing rows and creating work is the one this screen has
                    been failing to make. */}
                <p className="text-xs text-muted-foreground">
                  Stores the rows only. Leads are generated separately, once you have reviewed the
                  import.
                </p>
              </div>
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
          <ImportHistory canManage={canManage} />
        </CardContent>
      </Card>
    </div>
  );
}
