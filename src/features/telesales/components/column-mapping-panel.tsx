import { AlertTriangle, CheckCircle2, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  describeProblem,
  manualCount,
  type MappingRow,
  type MappingVerdict,
} from "@/lib/telesales/column-mapping";

/**
 * Which column means what.
 *
 * ===========================================================================
 * Shown always, needed rarely
 * ===========================================================================
 * A file built from a MilaPortal template maps with nothing to decide, and the
 * three source workbooks do too. This panel exists for the fourth file, and it
 * is visible rather than hidden behind a "having trouble?" link because the
 * operator cannot know they need it until they can see what the importer
 * understood — which is the same reason it opens showing the detected answer
 * rather than an empty form.
 *
 * ===========================================================================
 * Detected and chosen look different
 * ===========================================================================
 * A row still on its detected column is marked as such; touching it makes it
 * the operator's. That distinction is the panel's real content: "the importer
 * worked this out" and "somebody decided this" carry different weight when an
 * import turns out to have read the wrong column, and only one of them has a
 * person attached.
 *
 * Nothing is inferred beyond what the parser already inferred. This offers the
 * file's own columns and the template's own fields, and lets a person connect
 * them.
 */

const NONE = "__none__";

export interface ColumnMappingPanelProps {
  rows: MappingRow[];
  /** The file's header row, as read. */
  headers: string[];
  verdict: MappingVerdict;
  /** Set one field's column. `null` unmaps it. */
  onChange: (field: string, column: number | null) => void;
  /** Drop every override and go back to what detection found. */
  onReset: () => void;
  disabled?: boolean;
}

export function ColumnMappingPanel({
  rows,
  headers,
  verdict,
  onChange,
  onReset,
  disabled,
}: ColumnMappingPanelProps) {
  const manual = manualCount(rows);
  const mapped = rows.filter((r) => r.column != null).length;

  /*
   * Columns the file actually has. A blank header is still a column and is
   * still selectable — an export with an unlabelled first column is common, and
   * refusing to offer it would make that file unmappable.
   */
  const options = headers.map((h, i) => ({
    value: String(i),
    label: h.trim() === "" ? `Column ${i + 1} (no header)` : h,
  }));

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium">
            Column mapping · {mapped} of {rows.length} fields
            {manual > 0 ? ` · ${manual} set by hand` : ""}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Detected from the header row. Change any of them if this file spells a column
            differently.
          </p>
        </div>
        {manual > 0 ? (
          <Button size="sm" variant="ghost" onClick={onReset} disabled={disabled}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset to detected
          </Button>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => {
          const missing = row.required && row.column == null;
          return (
            <div
              key={row.field}
              className={cn(
                "rounded border p-2",
                missing ? "border-destructive/40 bg-destructive/5" : "border-border bg-background",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs" htmlFor={`map-${row.field}`}>
                  {row.label}
                  {row.required ? (
                    <span className="ml-1 text-destructive" aria-label="required">
                      *
                    </span>
                  ) : (
                    <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                  )}
                </Label>
                {/*
                 * Which of the two this is. A tick for a column the importer
                 * worked out, a wand for one a person chose.
                 */}
                {row.column == null ? null : row.auto ? (
                  <CheckCircle2
                    className="h-3.5 w-3.5 shrink-0 text-[#047857] dark:text-emerald-300"
                    aria-label="detected"
                  />
                ) : (
                  <Wand2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="set by hand" />
                )}
              </div>

              <Select
                value={row.column == null ? NONE : String(row.column)}
                onValueChange={(v) => onChange(row.field, v === NONE ? null : Number(v))}
                disabled={disabled}
              >
                <SelectTrigger id={`map-${row.field}`} className="mt-1 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Not mapping an optional field is a legitimate answer, so
                      it is an option rather than something to clear. */}
                  <SelectItem value={NONE}>— not in this file —</SelectItem>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                {row.description}
              </p>
            </div>
          );
        })}
      </div>

      {verdict.problems.length > 0 ? (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            This mapping cannot be imported yet
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {verdict.problems.map((p, i) => (
              <li key={i}>{describeProblem(p)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
