import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { dutyHoursLabel } from "../normalize";
import type { ImportIssue, ImportLevelCounts, ImportPreview, IssueLevel } from "../types";

/** Rows of the parsed data shown before the operator commits. */
const SAMPLE_LIMIT = 25;
/** Issues listed before collapsing behind a "show all". */
const ISSUE_LIMIT = 12;

function Tally({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof CheckCircle2;
  value: number;
  label: string;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3">
      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", tone)}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xl font-bold tabular-nums leading-tight">{value.toLocaleString()}</p>
        <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
      </div>
    </div>
  );
}

/**
 * Per-severity presentation.
 *
 * The consequence clause is the load-bearing part: an operator scanning this
 * needs to know instantly whether a list is something that stops the import or
 * something the importer already dealt with. "12 warnings" alone does not say.
 */
const LEVEL_STYLE: Record<
  IssueLevel,
  { icon: typeof XCircle; label: string; consequence: string; box: string; text: string }
> = {
  critical: {
    icon: XCircle,
    label: "critical issue",
    consequence: "these rows are skipped",
    box: "border-destructive/40 bg-destructive/5",
    text: "text-destructive",
  },
  warning: {
    icon: AlertTriangle,
    label: "warning",
    consequence: "these rows still import",
    box: "border-[var(--attention)]/40 bg-[var(--attention)]/5",
    text: "text-[var(--attention)]",
  },
  info: {
    icon: Info,
    label: "note",
    consequence: "handled automatically",
    box: "border-border/60 bg-muted/40",
    text: "text-muted-foreground",
  },
};

function IssueList({ issues, level }: { issues: ImportIssue[]; level: IssueLevel }) {
  const [expanded, setExpanded] = useState(false);
  const filtered = useMemo(() => issues.filter((issue) => issue.level === level), [issues, level]);
  if (filtered.length === 0) return null;

  const shown = expanded ? filtered : filtered.slice(0, ISSUE_LIMIT);
  const style = LEVEL_STYLE[level];
  const Icon = style.icon;

  return (
    <div className={cn("rounded-xl border p-3", style.box)}>
      <p
        className={cn(
          "mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide",
          style.text,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {filtered.length} {style.label}
        {filtered.length === 1 ? "" : "s"}
        <span className="font-normal normal-case opacity-80">— {style.consequence}</span>
      </p>
      <ul className="space-y-1 text-xs">
        {shown.map((issue, index) => (
          <li key={`${issue.row}-${issue.field}-${index}`} className="flex gap-2">
            <span className="shrink-0 font-mono text-muted-foreground">
              Row {issue.row}
              {issue.branchNo && ` · ${issue.branchNo}`}
            </span>
            <span className="min-w-0 flex-1 text-foreground/85" dir="auto">
              <span className="font-medium">{issue.field}:</span> {issue.message}
            </span>
          </li>
        ))}
      </ul>
      {filtered.length > ISSUE_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs font-medium underline underline-offset-2 hover:no-underline"
        >
          {expanded ? "Show fewer" : `Show all ${filtered.length}`}
        </button>
      )}
    </div>
  );
}

export function ImportPreviewPanel({
  preview,
  summary,
}: {
  preview: ImportPreview;
  summary: ImportLevelCounts;
}) {
  const sample = preview.rows.slice(0, SAMPLE_LIMIT);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{preview.fileName}</span>
        <span className="shrink-0 text-xs text-muted-foreground">sheet “{preview.sheetName}”</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Tally
          icon={CheckCircle2}
          value={summary.valid}
          label="Ready to import"
          tone="bg-[var(--positive)]/12 text-[var(--positive)]"
        />
        <Tally
          icon={XCircle}
          value={summary.critical}
          label="Critical"
          tone="bg-destructive/12 text-destructive"
        />
        <Tally
          icon={AlertTriangle}
          value={summary.warning}
          label="Warnings"
          tone="bg-[var(--attention)]/12 text-[var(--attention)]"
        />
        <Tally
          icon={Info}
          value={summary.info}
          label="Notes"
          tone="bg-muted text-muted-foreground"
        />
      </div>

      {preview.missingColumns.length > 0 && (
        <p className="rounded-lg border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Columns not in this file:</span>{" "}
          {preview.missingColumns.join(", ")}. Those fields will be left empty — except{" "}
          <span className="font-medium">Duty Hours</span>, which is calculated from{" "}
          <span className="font-mono">Start - End</span> when absent.
        </p>
      )}

      <IssueList issues={preview.issues} level="critical" />
      <IssueList issues={preview.issues} level="warning" />
      <IssueList issues={preview.issues} level="info" />

      {sample.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border/60">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Preview
            </p>
            <p className="text-xs text-muted-foreground">
              first {sample.length} of {preview.rows.length}
            </p>
          </div>
          <div className="max-h-80 overflow-auto [scrollbar-width:thin]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border/60 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Code</th>
                  <th className="px-3 py-2 font-medium">City</th>
                  <th className="px-3 py-2 font-medium">Phone</th>
                  <th className="px-3 py-2 font-medium">Hours</th>
                  <th className="px-3 py-2 font-medium">Scooter</th>
                  <th className="px-3 py-2 font-medium">Map</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((row) => (
                  <tr key={row.branch_no} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-1.5 font-mono font-medium">{row.branch_no}</td>
                    <td className="px-3 py-1.5" dir="auto">
                      {row.city}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground" dir="ltr">
                      {row.phone ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {row.duty_hours != null ? dutyHoursLabel(row.duty_hours) : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      {row.scooter ? (
                        <span className="text-[var(--positive)]">Yes</span>
                      ) : (
                        <span className="text-muted-foreground">No</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {row.latitude != null ? (
                        <span className="text-[var(--positive)]">✓</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
