import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What the import is doing, right now.
 *
 * ===========================================================================
 * Stages, not a percentage
 * ===========================================================================
 * The complaint this answers is "did the file upload, or is the browser stuck".
 * A progress bar would answer it beautifully if there were a number to put in
 * it, and there is not:
 *
 *   * **Reading** is synchronous CPU work in the browser. `xlsx` parses the
 *     whole workbook in one call and reports nothing while it does.
 *   * **Sending** is one `fetch` with a JSON body. `fetch` exposes no upload
 *     progress; only `XMLHttpRequest` does, and swapping the transport to
 *     animate a bar would be a real architectural change bought with nothing.
 *   * **Storing** happens on the server, in batches of 500, after the request
 *     has arrived. A client-side bar cannot see it at all.
 *
 * So the honest thing — and what the brief asks for — is to name the stage and
 * say how much work it covers. A percentage here would be a number that moved
 * because of a timer rather than because of the file, which is worse than no
 * number: it teaches the operator to trust a value that knows nothing.
 *
 * The row count *is* a real measure of size and is shown instead.
 */

export type UploadStage = "idle" | "reading" | "uploading" | "storing" | "done" | "failed";

interface StageSpec {
  key: Exclude<UploadStage, "idle" | "done" | "failed">;
  label: string;
  /** What is actually happening, for somebody watching it sit there. */
  hint: string;
}

const STAGES: StageSpec[] = [
  {
    key: "reading",
    label: "Reading the file",
    hint: "Parsing the workbook in your browser. Large files hold the page briefly.",
  },
  {
    key: "uploading",
    label: "Sending",
    hint: "Transferring the parsed rows. Nothing has been written yet.",
  },
  {
    key: "storing",
    label: "Storing rows",
    hint: "Writing the source records in batches. Do not close this tab.",
  },
];

const ORDER: UploadStage[] = ["reading", "uploading", "storing"];

function positionOf(stage: UploadStage): number {
  const i = ORDER.indexOf(stage);
  if (i >= 0) return i;
  // `done` sits past the last stage so every step renders complete.
  return stage === "done" ? ORDER.length : -1;
}

export interface UploadProgressProps {
  stage: UploadStage;
  /** File name and size, row counts, or an error message. */
  detail?: string | null;
  className?: string;
}

/**
 * The stage indicator.
 *
 * Renders nothing at `idle`, so the panel appears only while there is something
 * to say. Every non-idle state is distinguishable at a glance: in-flight stages
 * spin, completed ones tick, and a failure is the only thing that turns red.
 */
export function UploadProgress({ stage, detail, className }: UploadProgressProps) {
  if (stage === "idle") return null;

  const failed = stage === "failed";
  const done = stage === "done";
  const active = positionOf(stage);

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        failed
          ? "border-destructive/40 bg-destructive/5"
          : done
            ? "border-[#10B981]/40 bg-[#10B981]/10"
            : "border-border bg-muted/40",
        className,
      )}
      // Announced, because the whole point is telling somebody something is
      // happening — including somebody who is not watching the pixels.
      role="status"
      aria-live="polite"
    >
      {failed ? (
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-destructive">The import did not complete</p>
            {detail ? (
              <p className="mt-0.5 break-words text-xs text-muted-foreground">{detail}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing partial is left behind — an import that fails is recorded as failed and stores
              no leads.
            </p>
          </div>
        </div>
      ) : done ? (
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#047857] dark:text-emerald-300" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[#047857] dark:text-emerald-300">
              Import complete
            </p>
            {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <ol className="space-y-1.5">
            {STAGES.map((spec, i) => {
              const state = i < active ? "done" : i === active ? "active" : "pending";
              return (
                <li key={spec.key} className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    {state === "done" ? (
                      <CheckCircle2 className="h-4 w-4 text-[#047857] dark:text-emerald-300" />
                    ) : state === "active" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "text-sm",
                        state === "active"
                          ? "font-medium"
                          : state === "pending"
                            ? "text-muted-foreground"
                            : "text-muted-foreground line-through decoration-muted-foreground/40",
                      )}
                    >
                      {spec.label}
                    </p>
                    {state === "active" ? (
                      <p className="text-xs text-muted-foreground">{spec.hint}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {detail ? (
            <p className="border-t border-border pt-2 text-xs text-muted-foreground">{detail}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
