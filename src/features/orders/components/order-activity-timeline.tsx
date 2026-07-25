import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock } from "lucide-react";
import { queryKeys } from "@/lib/query-keys";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";

export function OrderActivityTimeline({ orderId }: { orderId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.orders.activity(orderId),
    queryFn: async () => {
      const [{ data: events }, { data: profiles }] = await Promise.all([
        supabase.from("order_activity" as any).select("*").eq("order_id", orderId).order("created_at", { ascending: false }),
        supabase.from("profiles").select("id,full_name"),
      ]);
      const nm = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      return ((events as any[]) ?? []).map((e: any) => ({ ...e, actor_name: nm.get(e.actor_id) ?? "System" }));
    },
  });

  const fmtBusinessTime = (iso: string) => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "short", day: "2-digit",
        hour: "numeric", minute: "2-digit", hour12: true,
      }).format(new Date(iso));
    } catch { return iso; }
  };

  const describe = (e: any) => {
    const d = e.details ?? {};
    if (e.action === "created") return "Created the order";
    if (e.action === "status_changed") return `Changed status from ${d.from ?? "—"} to ${d.to ?? "—"}`;
    if (e.action === "verification_changed") return d.verified ? "Marked Call Center invoice verified" : "Removed Call Center invoice verification";
    if (e.action === "edited") {
      const keys = Object.keys(d);
      if (keys.length === 0) return "Edited the order";
      return `Updated ${keys.join(", ")}`;
    }
    return e.action;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> Activity timeline</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && (data?.length ?? 0) === 0 && <div className="text-sm text-muted-foreground">No activity yet.</div>}
        <ol className="space-y-3">
          {(data ?? []).map((e: any) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <div className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{describe(e)}</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{e.actor_name}</span> · {fmtBusinessTime(e.created_at)}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
