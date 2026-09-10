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

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  shamsAlshrouqConfigProbe,
  shamsCrmSetupAgentLinks,
  shamsCatalogDiagnostics,
  shamsCrmSearchDiagnostic,
  shamsCrmSmokeTest,
} from "@/lib/shams.functions";
import { TD } from "@/features/shams/constants";
import { AdminPage } from "@/features/admin/components/admin-shell";
import { AdminCard, AdminSection, NoticeState } from "@/features/admin/components/primitives";

/** Shared with the other admin tables so column headers read alike. */
const ADMIN_TH =
  "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";

export const Route = createFileRoute("/_app/admin/shams-diagnostics")({
  component: ShamsDiagnosticsPage,
});

/**
 * The probe result table.
 *
 * Delegates to the shared admin surfaces so diagnostics looks like the rest of
 * the console. Deliberately a thin wrapper rather than a rewrite: every probe
 * below renders its own cells, and this phase changes how they are framed, not
 * what they report.
 */
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <AdminCard className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              {head.map((h) => (
                <th key={h} className={ADMIN_TH} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </AdminCard>
  );
}

/** One probe, framed by the shared section heading. */
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
    <AdminSection title={title} description={hint}>
      {children}
    </AdminSection>
  );
}

function ShamsDiagnosticsPage() {
  const run = useServerFn(shamsCatalogDiagnostics);
  const probe = useMutation({ mutationFn: () => run({ data: undefined }) });
  const runCrm = useServerFn(shamsCrmSmokeTest);
  const crm = useMutation({ mutationFn: () => runCrm({ data: undefined }) });
  const runCrmSearch = useServerFn(shamsCrmSearchDiagnostic);
  const crmSearch = useMutation({ mutationFn: () => runCrmSearch({ data: undefined }) });
  const runAlshrouq = useServerFn(shamsAlshrouqConfigProbe);
  const alshrouq = useMutation({ mutationFn: () => runAlshrouq({ data: undefined }) });
  const runAgentSetup = useServerFn(shamsCrmSetupAgentLinks);
  /*
   * Off by default, and deliberately so: with it off a run contacts the CRM only
   * for agents whose mapping is new or changed, which is the ordinary case after
   * a workbook edit. Turning it on logs in as every mapped agent again — worth
   * it for a credential rotation, wasted refusals against working accounts
   * otherwise.
   */
  const [force, setForce] = useState(false);
  const agentSetup = useMutation({
    mutationFn: (dryRun: boolean) => runAgentSetup({ data: { dryRun, force } }),
  });

  const result = probe.data;
  const report = result?.report ?? null;

  return (
    <AdminPage
      title="Shams diagnostics"
      description="On-demand health checks against the Shams systems: connectivity, credentials, catalogue and search. Every probe here is read-only unless its own description says otherwise."
    >
      <Section
        title="Shams CRM — connection smoke test"
        hint="Authenticates against the Shams CRM backend and downloads the catalog once."
      >
        <Button onClick={() => crm.mutate()} disabled={crm.isPending} variant="secondary">
          {crm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {crm.isPending ? "Running…" : "Run CRM test"}
        </Button>

        {crm.isError && (
          <p className="text-sm text-destructive">
            The CRM test call failed. You may not have administrator access.
          </p>
        )}

        {crm.data && (
          <Table
            head={[
              "Configured",
              "Client version",
              "Compatible",
              "Login",
              "Catalog HTTP",
              "Products",
              "Cache reused",
              "Error",
            ]}
          >
            <tr className="border-t">
              <td className={TD}>{crm.data.configured ? "yes" : "no"}</td>
              <td className={TD}>{crm.data.clientVersion ?? "—"}</td>
              <td className={TD}>
                {crm.data.compatible === null ? "—" : crm.data.compatible ? "yes" : "no"}
              </td>
              <td className={TD}>{crm.data.login ?? "—"}</td>
              <td className={TD}>{crm.data.catalogStatus ?? "—"}</td>
              <td className={TD}>{crm.data.catalogCount ?? "—"}</td>
              <td className={TD}>
                {crm.data.cacheReused === null ? "—" : crm.data.cacheReused ? "yes" : "no"}
              </td>
              <td className={TD}>{crm.data.errorKind ?? "—"}</td>
            </tr>
          </Table>
        )}
      </Section>

      {/*
        The one place the agent workbook is read.
        Verify proves every mapping and writes nothing; Store moves each
        verified password into Vault. Neither shows a credential — the summary
        has no field that could carry one — and neither dispatches anything.
      */}
      <Section
        title="AlShrouq — agent CRM credentials"
        hint="Verifies each agent in the mapping workbook against Shams CRM, then stores their password in Vault. Agents already linked to the same CRM account are left alone. No courier is contacted."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => agentSetup.mutate(true)}
            disabled={agentSetup.isPending}
            variant="secondary"
          >
            {agentSetup.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Verify only (dry run)
          </Button>
          <Button onClick={() => agentSetup.mutate(false)} disabled={agentSetup.isPending}>
            Verify and store in Vault
          </Button>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            disabled={agentSetup.isPending}
          />
          <span>
            Re-verify agents that are already linked
            <span className="block text-muted-foreground">
              Needed after a password changes in the workbook — a new password under an unchanged
              username looks like no change at all. Otherwise it only spends a failed login on every
              agent whose account already works.
            </span>
          </span>
        </label>

        {agentSetup.isError && (
          <p className="text-sm text-destructive">
            The setup call failed. You may not have permission to manage users.
          </p>
        )}

        {agentSetup.data && (
          <>
            <p className="text-sm text-muted-foreground">
              Verified {agentSetup.data.verified} · Stored {agentSetup.data.stored} · Skipped{" "}
              {agentSetup.data.skipped} · Failed {agentSetup.data.failed}
            </p>
            <Table head={["Agent", "Status", "Reason", "CRM user ID"]}>
              {agentSetup.data.rows.map((r) => (
                <tr key={`${r.agent}-${r.status}`} className="border-t">
                  <td className={TD}>{r.agent}</td>
                  <td className={TD}>{r.status}</td>
                  <td className={TD}>{r.reason}</td>
                  <td className={TD}>{r.crmUserId ?? "—"}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Section>

      <Section
        title="AlShrouq — configuration probe"
        hint="One read of GET /integrations/alshrouq/config. It cannot create, modify or cancel a delivery."
      >
        <Button onClick={() => alshrouq.mutate()} disabled={alshrouq.isPending} variant="secondary">
          {alshrouq.isPending && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          {alshrouq.isPending ? "Running…" : "Run AlShrouq probe"}
        </Button>

        {alshrouq.isError && (
          <p className="text-sm text-destructive">
            The AlShrouq probe call failed. You may not have administrator access.
          </p>
        )}

        {alshrouq.data && (
          <Table
            head={[
              "Configured",
              "Config read",
              "Payment IDs",
              "Branches",
              "Covered",
              "Branch fields",
              "Webhook",
              "Missing secrets",
              "Shape",
              "Error",
            ]}
          >
            <tr className="border-t">
              <td className={TD}>{alshrouq.data.configured ? "yes" : "no"}</td>
              <td className={TD}>{alshrouq.data.request ?? "—"}</td>
              <td className={TD}>
                {alshrouq.data.paymentOptionIds?.join(", ") ?? "—"}
                {alshrouq.data.paymentOptionsMatchContract === false && " (unexpected)"}
              </td>
              <td className={TD}>{alshrouq.data.branchOptionCount ?? "—"}</td>
              <td className={TD}>{alshrouq.data.coveredBranchCount ?? "—"}</td>
              <td className={TD}>
                {alshrouq.data.branchFieldsComplete === null
                  ? "—"
                  : alshrouq.data.branchFieldsComplete
                    ? "complete"
                    : "incomplete"}
              </td>
              <td className={TD}>
                {alshrouq.data.webhookUrlPresent === null
                  ? "—"
                  : alshrouq.data.webhookUrlPresent && alshrouq.data.webhookAuthHeaderPresent
                    ? "present"
                    : "missing"}
              </td>
              <td className={TD}>
                {alshrouq.data.missingSecrets === null
                  ? "—"
                  : alshrouq.data.missingSecrets.length === 0
                    ? "none"
                    : alshrouq.data.missingSecrets.join(", ")}
              </td>
              <td className={TD}>
                {alshrouq.data.shapeValid === null
                  ? "—"
                  : alshrouq.data.shapeValid
                    ? "ok"
                    : "check"}
              </td>
              <td className={TD}>{alshrouq.data.errorKind ?? "—"}</td>
            </tr>
          </Table>
        )}
      </Section>

      <Section
        title="Shams CRM — product search verification"
        hint="Runs four fixed queries through the same search the Stock page uses."
      >
        <Button
          onClick={() => crmSearch.mutate()}
          disabled={crmSearch.isPending}
          variant="secondary"
        >
          {crmSearch.isPending && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          {crmSearch.isPending ? "Running…" : "Run CRM search tests"}
        </Button>

        {crmSearch.isError && (
          <p className="text-sm text-destructive">
            The search diagnostic failed. You may not have administrator access.
          </p>
        )}

        {crmSearch.data && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Catalog available: {crmSearch.data.catalogAvailable ? "yes" : "no"} · Overall:{" "}
              <span
                className={
                  crmSearch.data.allPassed ? "font-medium" : "font-medium text-destructive"
                }
              >
                {crmSearch.data.allPassed ? "all passed" : "check results"}
              </span>
            </p>
            <Table head={["Query", "Status", "Results", "Sample", "Error"]}>
              {crmSearch.data.queries.map((r) => (
                <tr key={r.query} className="border-t align-top">
                  <td className={`${TD} font-mono text-xs`}>{r.query}</td>
                  <td className={TD}>{r.status}</td>
                  <td className={TD}>{r.count ?? "—"}</td>
                  <td className={`${TD} text-xs`}>
                    {r.sample?.map((s) => `${s.itemCode} ${s.itemName}`).join(" · ") || "—"}
                  </td>
                  <td className={TD}>{r.errorKind ?? "—"}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Section>

      <Button onClick={() => probe.mutate()} disabled={probe.isPending}>
        {probe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        {probe.isPending ? "Running…" : "Run diagnostics"}
      </Button>

      {probe.isError && (
        <NoticeState
          tone="danger"
          message="The diagnostics call failed. You may not have administrator access."
        />
      )}

      {result && !result.configured && (
        <NoticeState
          tone="warning"
          message="The Shams MIS connection is not configured for this deployment."
        />
      )}

      {result?.error && (
        <NoticeState tone="danger" message={`${result.error.kind}: ${result.error.message}`} />
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
            <Table
              head={["q", "HTTP", "count", "data.length", "NAN OPTIPRO", "Metadata", "Sample"]}
            >
              {report.reported.map((r) => (
                <tr key={r.q} className="border-t align-top">
                  <td className={`${TD} font-mono text-xs`}>{r.q}</td>
                  <td className={TD}>{r.httpStatus ?? r.failure ?? "—"}</td>
                  <td className={TD}>{r.count ?? "—"}</td>
                  <td className={TD}>{r.dataLength ?? "—"}</td>
                  <td className={TD}>{r.nanOptipro}</td>
                  <td className={`${TD} text-xs`}>
                    {r.meta
                      ? Object.entries(r.meta)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" · ")
                      : `keys: ${r.envelopeKeys?.join(", ") ?? "—"}`}
                  </td>
                  <td className={`${TD} text-xs`}>
                    {r.sample.map((s) => `${s.itemCode} ${s.itemName}`).join(" · ") || "—"}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      )}
    </AdminPage>
  );
}
