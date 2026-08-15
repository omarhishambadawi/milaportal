/**
 * Shams catalog diagnostics — administrator only.
 *
 * The invocation surface for `shamsCatalogDiagnostics`. It exists because the
 * MIS credentials live in the Worker environment and nowhere else, so the
 * questions in `scripts/shams-catalog-probe.mjs` can only be answered from
 * inside the deployment.
 *
 * Deliberately plain: three tables and a button. It runs on demand, never on
 * load — each run spends ~20 requests against a third-party production API.
 *
 * The gate here is presentational. `shamsCatalogDiagnostics` calls `assertAdmin`
 * server-side and that is the enforcement; this only means a non-admin sees a
 * refusal rather than a thrown error.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isAdministrator, useAuth } from "@/lib/auth";
import { shamsCatalogDiagnostics } from "@/lib/shams.functions";
import { TD, TH } from "@/features/shams/constants";

export const Route = createFileRoute("/_app/admin/shams-diagnostics")({
  component: ShamsDiagnosticsPage,
});

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            {head.map((h) => (
              <th key={h} className={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}

function ShamsDiagnosticsPage() {
  const { role } = useAuth();
  const run = useServerFn(shamsCatalogDiagnostics);
  const probe = useMutation({ mutationFn: () => run({ data: undefined }) });

  if (!isAdministrator(role)) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          Administrator access is required for Shams diagnostics.
        </CardContent>
      </Card>
    );
  }

  const result = probe.data;
  const report = result?.report ?? null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Shams catalog diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Read-only. One run spends about twenty requests against the Shams MIS.
        </p>
      </div>

      <Button onClick={() => probe.mutate()} disabled={probe.isPending}>
        {probe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        {probe.isPending ? "Running…" : "Run diagnostics"}
      </Button>

      {probe.isError && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            The diagnostics call failed. You may not have administrator access.
          </CardContent>
        </Card>
      )}

      {result && !result.configured && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            The Shams MIS connection is not configured for this deployment.
          </CardContent>
        </Card>
      )}

      {result?.error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            {result.error.kind}: {result.error.message}
          </CardContent>
        </Card>
      )}

      {report && (
        <div className="space-y-8">
          <p className="text-xs text-muted-foreground">Probed at {report.probedAt}</p>

          <Section title="A — catalog endpoints" hint="Does any path serve a product list?">
            <Table head={["Path", "HTTP", "Body", "Rows", "Fields", "ms"]}>
              {report.catalog.map((r) => (
                <tr key={r.path} className="border-t">
                  <td className={`${TD} font-mono text-xs`}>{r.path}</td>
                  <td className={TD}>{r.httpStatus ?? r.failure ?? "—"}</td>
                  <td className={TD}>{r.bodyKind}</td>
                  <td className={TD}>{r.rows ?? "—"}</td>
                  <td className={`${TD} text-xs`}>{r.fields?.join(", ") ?? "—"}</td>
                  <td className={TD}>{r.durationMs}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section
            title="B — truncation"
            hint="count is what the API says it matched; data.length is what it sent."
          >
            <Table head={["q", "HTTP", "count", "data.length", "Truncated", "ms"]}>
              {report.truncation.map((r) => (
                <tr key={r.q} className="border-t">
                  <td className={`${TD} font-mono text-xs`}>{r.q}</td>
                  <td className={TD}>{r.httpStatus ?? r.failure ?? "—"}</td>
                  <td className={TD}>{r.count ?? "—"}</td>
                  <td className={TD}>{r.dataLength ?? "—"}</td>
                  <td className={TD}>{r.truncated === null ? "—" : r.truncated ? "YES" : "no"}</td>
                  <td className={TD}>{r.durationMs}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="C — reported queries" hint="NAN OPTIPRO counts names reading “nan … op”.">
            <Table head={["q", "HTTP", "count", "data.length", "NAN OPTIPRO", "Sample"]}>
              {report.reported.map((r) => (
                <tr key={r.q} className="border-t align-top">
                  <td className={`${TD} font-mono text-xs`}>{r.q}</td>
                  <td className={TD}>{r.httpStatus ?? r.failure ?? "—"}</td>
                  <td className={TD}>{r.count ?? "—"}</td>
                  <td className={TD}>{r.dataLength ?? "—"}</td>
                  <td className={TD}>{r.nanOptipro}</td>
                  <td className={`${TD} text-xs`}>
                    {r.sample.map((s) => `${s.itemCode} ${s.itemName}`).join(" · ") || "—"}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      )}
    </div>
  );
}
