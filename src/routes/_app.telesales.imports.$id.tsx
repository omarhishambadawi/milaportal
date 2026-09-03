import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  Loader2,
  Play,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { businessToday } from "@/lib/telesales/dates";
import {
  DIAGNOSIS_EXPLANATIONS,
  DIAGNOSIS_LABELS,
  describeDiagnosis,
  isActionable,
  type DiagnosisReason,
} from "@/lib/telesales/diagnostics";
import { SOURCE_TYPE_LABELS } from "@/lib/telesales/types";
import { telesalesDiagnoseImport, telesalesGenerate } from "@/lib/telesales.functions";

export const Route = createFileRoute("/_app/telesales/imports/$id")({
  head: () => ({ meta: [{ title: "Import review — MilaServ Portal" }] }),
  component: ImportReviewPage,
});

/**
 * Reviewing an import before generating anything from it.
 *
 * ===========================================================================
 * The screen that was missing
 * ===========================================================================
 * A Wasfaty file of 3,937 rows was imported and 46 leads appeared. Every part of
 * that was correct — 3,891 rows carried a dispense date outside today and
 * tomorrow — and there was no way to find it out short of reading the generator
 * and querying the database by hand.
 *
 * So this page answers one question: **of the rows in this import, how many are
 * leads, and what is each of the others waiting for?** The buckets are the
 * generator's own verdicts, they are mutually exclusive, and they sum to the
 * number of rows examined. A reconciliation that does not reconcile would be
 * worse than none.
 *
 * ===========================================================================
 * Generating is a decision made here, not a consequence of uploading
 * ===========================================================================
 * Importing stores rows. Generation is a separate act, scoped to this import,
 * optionally narrowed further, and safe to repeat — the `dedup_key` unique index
 * refuses a second lead for the same opportunity and the run records how many it
 * refused.
 */
function ImportReviewPage() {
  const { id } = Route.useParams();
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  /*
   * Manage-only, end to end.
   *
   * Not a stricter choice than the data allows -- it is the only consistent
   * one. `telesales_imports`, `telesales_source_records` and
   * `telesales_generation_runs` all carry RLS policies keyed on
   * `manage_telesales`, so an agent reaching this page would see an empty
   * header and an empty run list beside a populated report. The import surface
   * is a supervisor surface.
   */
  const canManage = hasPerm(role, perms, "manage_telesales");
  const canView = canManage;
  const qc = useQueryClient();

  const [anchorDate, setAnchorDate] = useState(businessToday());
  const [branchFilter, setBranchFilter] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [phoneFilter, setPhoneFilter] = useState<"any" | "with" | "without">("any");
  const [generating, setGenerating] = useState(false);

  /** The import row itself, read straight from PostgREST under RLS. */
  const meta = useQuery({
    queryKey: [...queryKeys.telesales.all(), "import", id],
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_imports")
        .select(
          "id,file_name,source_type,sheet_name,status,rows_total,rows_stored,rows_rejected," +
            "imported_at,archived_at",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as Record<string, any> | null;
    },
  });

  /**
   * The reconciliation.
   *
   * Recomputed whenever the anchor moves, because "how many are eligible" is a
   * question about a day — the whole point of the report is that the answer
   * changes as dates arrive.
   */
  const diagnosis = useQuery({
    queryKey: [...queryKeys.telesales.all(), "import", id, "diagnosis", anchorDate],
    enabled: canView,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await telesalesDiagnoseImport({ data: { importId: id, anchorDate } });
      return res.diagnosis;
    },
  });

  /** The runs already made against this import. */
  const runs = useQuery({
    queryKey: [...queryKeys.telesales.all(), "import", id, "runs"],
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_generation_runs")
        .select(
          "id,lead_type,status,anchor_date,window_from,window_to,candidates,leads_created," +
            "skipped_duplicate,skipped_ineligible,errors,error_summary,filters,started_at",
        )
        .eq("import_id", id)
        .order("started_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return (data as Record<string, any>[]) ?? [];
    },
  });

  const d = diagnosis.data;
  const sourceType = (meta.data?.source_type ?? d?.sourceType) as
    | "cash"
    | "retention"
    | "wasfaty"
    | undefined;

  const filters = useMemo(() => {
    const branchNos = branchFilter
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const cities = cityFilter
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return {
      importId: id,
      branchNos: branchNos.length ? branchNos : null,
      cities: cities.length ? cities : null,
      hasPhone: phoneFilter === "any" ? null : phoneFilter === "with",
    };
  }, [id, branchFilter, cityFilter, phoneFilter]);

  const filtered =
    Boolean(filters.branchNos) || Boolean(filters.cities) || filters.hasPhone != null;

  async function generate() {
    if (!sourceType || generating) return;
    setGenerating(true);
    try {
      const res = await telesalesGenerate({
        data: { leadType: sourceType, anchorDate, filters },
      });
      const run = res.runs[0];
      if (!run) {
        toast.error("Generation returned no run.");
        return;
      }
      if (run.errors > 0) {
        toast.error(`Generation failed: ${run.errorSummary ?? "unknown error"}`);
      } else {
        /*
         * The numbers reconcile out loud. "Created 0" on its own reads as a
         * failure; "created 0, 46 already existed" reads as idempotency, which
         * is what it is.
         */
        toast.success(
          `Considered ${run.candidates}, created ${run.created}` +
            (run.skippedDuplicate ? `, ${run.skippedDuplicate} already existed` : "") +
            (run.skippedIneligible ? `, ${run.skippedIneligible} ineligible` : "") +
            ".",
        );
      }
      qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Import review is restricted</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Only team leads and administrators can review imports.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-xl font-semibold">
              {meta.data?.file_name ?? d?.fileName ?? "Import"}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {sourceType ? SOURCE_TYPE_LABELS[sourceType] : "—"}
            {meta.data?.sheet_name ? ` · ${meta.data.sheet_name}` : ""}
            {meta.data?.rows_stored != null
              ? ` · ${Number(meta.data.rows_stored).toLocaleString("en-US")} rows stored`
              : ""}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/telesales/import">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Import
          </Link>
        </Button>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The reconciliation                                                */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 pb-3">
          <CardTitle className="text-base">Where the rows stand</CardTitle>
          <div className="flex items-center gap-2">
            <Label className="text-xs" htmlFor="review-anchor">
              As of
            </Label>
            <Input
              id="review-anchor"
              type="date"
              className="h-8 w-[150px]"
              value={anchorDate}
              onChange={(e) => setAnchorDate(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {diagnosis.isPending ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working through the rows…
            </div>
          ) : diagnosis.isError ? (
            <p className="py-6 text-center text-sm text-destructive">
              {(diagnosis.error as Error).message}
            </p>
          ) : d ? (
            <>
              <p className="text-sm">{describeDiagnosis(d)}</p>
              {d.window ? (
                <p className="text-xs text-muted-foreground">
                  The {SOURCE_TYPE_LABELS[d.leadType as "cash" | "retention" | "wasfaty"]} window
                  for {anchorDate} is {d.window.from} to {d.window.to}.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Retention has no date window — the backlog is taken as it stands.
                </p>
              )}

              {d.truncated ? (
                <p className="flex items-center gap-1.5 rounded-md border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-2 text-xs text-[#B45309] dark:text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  This import is larger than the report examines, so the counts below cover the
                  first {d.rowsExamined.toLocaleString("en-US")} rows only.
                </p>
              ) : null}

              <div className="divide-y divide-border rounded-lg border border-border">
                {d.buckets.map((b) => (
                  <div key={b.reason} className="flex flex-wrap items-start gap-x-4 gap-y-1 p-3">
                    <span className="mt-0.5 shrink-0">
                      {b.reason === "eligible" ? (
                        <CheckCircle2 className="h-4 w-4 text-[#047857] dark:text-emerald-300" />
                      ) : b.reason === "already_generated" ? (
                        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                      ) : b.reason === "outside_window_future" ? (
                        <Clock className="h-4 w-4 text-muted-foreground" />
                      ) : isActionable(b.reason as DiagnosisReason) ? (
                        <AlertTriangle className="h-4 w-4 text-[#B45309] dark:text-amber-300" />
                      ) : (
                        <XCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </span>
                    <div className="min-w-[220px] flex-1">
                      <p className="text-sm font-medium">
                        {DIAGNOSIS_LABELS[b.reason as DiagnosisReason]}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {DIAGNOSIS_EXPLANATIONS[b.reason as DiagnosisReason]}
                      </p>
                      {b.earliest && b.latest ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Dates {b.earliest}
                          {b.earliest === b.latest ? "" : ` to ${b.latest}`} · {b.withPhone} with a
                          phone number
                        </p>
                      ) : null}
                    </div>
                    <p
                      className={cn(
                        "text-sm tabular-nums",
                        b.reason === "eligible" ? "font-semibold" : "text-muted-foreground",
                      )}
                    >
                      {b.rows.toLocaleString("en-US")}
                    </p>
                  </div>
                ))}
              </div>

              {/* The equation, stated. This is the sentence nobody had. */}
              <p className="text-xs text-muted-foreground">
                {d.rowsExamined.toLocaleString("en-US")} rows ={" "}
                {d.eligibleNow.toLocaleString("en-US")} eligible +{" "}
                {d.alreadyGenerated.toLocaleString("en-US")} already generated +{" "}
                {d.pendingFutureDate.toLocaleString("en-US")} waiting for their date +{" "}
                {d.permanentlyExcluded.toLocaleString("en-US")} excluded.
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Generation                                                        */}
      {/* ---------------------------------------------------------------- */}
      {canManage ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Generate leads from this import</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Only the eligible rows above become leads. Running this again is safe — the database
              refuses a second lead for the same opportunity and the run reports how many it
              refused.
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="f-branch">
                  Branches
                </Label>
                <Input
                  id="f-branch"
                  className="h-9 w-[180px]"
                  placeholder="P0001, P0503"
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="f-city">
                  Cities
                </Label>
                <Input
                  id="f-city"
                  className="h-9 w-[180px]"
                  placeholder="Riyadh, Jeddah"
                  value={cityFilter}
                  onChange={(e) => setCityFilter(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Phone</Label>
                <div className="flex gap-1">
                  {(["any", "with", "without"] as const).map((v) => (
                    <Button
                      key={v}
                      size="sm"
                      variant={phoneFilter === v ? "default" : "outline"}
                      onClick={() => setPhoneFilter(v)}
                    >
                      {v === "any" ? "Any" : v === "with" ? "Has one" : "None"}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={generating || !sourceType} onClick={() => void generate()}>
                {generating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                Generate{filtered ? " (filtered)" : ""}
              </Button>
              {/* A filter can only ever shrink the set. Saying so stops it being
                  mistaken for a way to reach rows the window excludes. */}
              <p className="text-xs text-muted-foreground">
                Filters narrow which rows are considered. They never make an ineligible row
                eligible, and they cannot reach outside the window.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Runs                                                              */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Generation runs for this import</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.isPending ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : (runs.data?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No leads have been generated from this import yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {runs.data!.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                  <div className="min-w-[200px] flex-1">
                    <p className="text-sm">
                      {SOURCE_TYPE_LABELS[r.lead_type as "cash" | "retention" | "wasfaty"]} · anchor{" "}
                      {r.anchor_date}
                      {r.filters ? " · filtered" : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(r.started_at).toLocaleString("en-GB")}
                      {r.window_from ? ` · window ${r.window_from} to ${r.window_to}` : ""}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {Number(r.candidates ?? 0)} considered · {Number(r.leads_created ?? 0)} created
                    {Number(r.skipped_duplicate ?? 0)
                      ? ` · ${r.skipped_duplicate} already existed`
                      : ""}
                    {Number(r.skipped_ineligible ?? 0)
                      ? ` · ${r.skipped_ineligible} ineligible`
                      : ""}
                  </p>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      r.status === "completed"
                        ? "border-[#10B981]/40 bg-[#10B981]/15 text-[#047857] dark:text-emerald-200"
                        : r.status === "failed"
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : "border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
