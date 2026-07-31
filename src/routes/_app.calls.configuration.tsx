/**
 * Calls — Configuration. Owner only.
 *
 * A read-only view of the settings the call pipeline actually runs on, and
 * where each one comes from.
 *
 * Deliberately not editable. Every value here is either a deployment
 * environment variable or PBX-side configuration, so an in-app editor would
 * change nothing at runtime — it would be a control that lies. Making these
 * settings writable needs a settings store and a deployment reload path, which
 * is a change to the data model rather than to this page.
 *
 * What it does give an owner is the thing that was previously impossible: a
 * single place to see the effective configuration, including the two values
 * that silently move every KPI when wrong — business hours and the outbound
 * ring timeout — and a note on each saying how to decide it.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, Info } from "lucide-react";
import { useAuth, isOwnerRole } from "@/lib/auth";
import { callsConfiguration } from "@/lib/yeastar.functions";

export const Route = createFileRoute("/_app/calls/configuration")({
  head: () => ({ meta: [{ title: "Call Configuration — MilaServ Portal" }] }),
  component: CallConfiguration,
});

const sourceTone: Record<string, "outline" | "secondary" | "default"> = {
  environment: "secondary",
  pbx: "default",
  application: "outline",
};

function CallConfiguration() {
  const { role, loading } = useAuth();
  const isOwner = isOwnerRole(role);

  const fn = useServerFn(callsConfiguration);
  const q = useQuery({
    queryKey: ["calls", "configuration"],
    queryFn: () => fn(),
    enabled: !loading && isOwner,
    staleTime: 60_000,
  });

  if (!loading && !isOwner) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          Configuration is restricted to the account owner.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Configuration</h1>
        <p className="text-sm text-muted-foreground">
          Effective call-pipeline settings · owner only
        </p>
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="p-4 flex items-start gap-2 text-sm">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
          <span className="text-muted-foreground">
            These values are read-only here. Settings marked{" "}
            <Badge variant="secondary" className="font-normal mx-0.5">
              environment
            </Badge>{" "}
            are deployment variables and change on redeploy;{" "}
            <Badge variant="default" className="font-normal mx-0.5">
              pbx
            </Badge>{" "}
            values are configured on the phone system itself. Secret values are never displayed —
            only whether they loaded.
          </span>
        </CardContent>
      </Card>

      {q.isError && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            {String((q.error as Error)?.message ?? q.error)}
          </CardContent>
        </Card>
      )}

      {q.isPending || loading ? (
        <Card>
          <CardContent className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : (
        q.data?.groups.map((g) => (
          <Card key={g.group}>
            <CardHeader>
              <CardTitle className="text-base">{g.group}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {g.settings.map((setting) => (
                    <tr key={setting.key} className="border-b last:border-0 align-top">
                      <td className="px-4 py-3 w-64">
                        <div className="font-medium">{setting.label}</div>
                        <div className="font-mono text-[11px] text-muted-foreground break-all">
                          {setting.key}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-xs break-words">{setting.value}</div>
                        {setting.note && (
                          <div className="mt-1 text-xs text-muted-foreground">{setting.note}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 w-32 text-right">
                        <Badge
                          variant={sourceTone[setting.source] ?? "outline"}
                          className="font-normal"
                        >
                          {setting.source}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
