import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Link2, Loader2, ShieldAlert } from "lucide-react";
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
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import {
  RELATION_REJECTION_LABELS,
  buildRelationCatalog,
  validateRelation,
} from "@/lib/telesales/relations";
import {
  useProductRelations,
  useRelationMutations,
  useRelationProducts,
} from "@/features/telesales/hooks/use-product-relations";

export const Route = createFileRoute("/_app/telesales/relations")({
  head: () => ({ meta: [{ title: "Cross-sell configuration — MilaServ Portal" }] }),
  component: ProductRelationsPage,
});

/**
 * Cross-sell configuration.
 *
 * The whole screen exists to make one sentence enterable by a person:
 * *a customer who bought A is worth telling about B*. Nothing derives these
 * pairs — Phase 3 measured the co-purchase data and found nothing strong enough
 * to infer from — so this is the only way one can come into existence.
 *
 * Deliberately small. It is a list and a two-field form inside the Telesales
 * module, not an admin application: the desk configures a handful of pairs and
 * then leaves them alone for months.
 */
function ProductRelationsPage() {
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  const canView = hasPerm(role, perms, "view_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const relations = useProductRelations(canView);
  const products = useRelationProducts(canView);
  const mutations = useRelationMutations();

  const [fromCode, setFromCode] = useState("");
  const [toCode, setToCode] = useState("");
  const [note, setNote] = useState("");

  const catalog = useMemo(() => buildRelationCatalog(products.data ?? []), [products.data]);

  /*
   * The same validator the server runs.
   *
   * Shared rather than reimplemented, so the message a supervisor sees while
   * typing is the message the server would have given them. The server still
   * validates — this is a courtesy, not the boundary.
   */
  const verdict = useMemo(
    () => validateRelation({ fromItemCode: fromCode, toItemCode: toCode, note }, catalog),
    [fromCode, toCode, note, catalog],
  );

  /** Who created or changed each row, from one roster read. */
  const roster = useQuery<Map<string, string>>({
    queryKey: queryKeys.lookups.ordersDirectory(),
    enabled: canView,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id,full_name").eq("active", true);
      return new Map(
        ((data as { id: string; full_name: string }[]) ?? []).map((p) => [p.id, p.full_name]),
      );
    },
  });

  const nameOf = (code: string) => catalog.get(code.trim())?.itemName ?? code;
  const personOf = (id: string | null) => (id ? (roster.data?.get(id) ?? "—") : "—");
  const day = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Telesales is restricted</p>
      </div>
    );
  }

  const rows = relations.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Cross-sell configuration</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Pairs an authorized team lead has configured. Recommended Leads uses these; it never
            invents them.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/telesales">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to the queue
          </Link>
        </Button>
      </div>

      {canManage ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add a cross-sell</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/*
             * The direction is the point, so it is spelled out rather than
             * implied by column order. A -> B does not mean B -> A, and a
             * supervisor configuring one should not have to guess that.
             */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1">
                <Label className="text-xs">When the customer has bought</Label>
                <Select value={fromCode} onValueChange={setFromCode}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Choose a product…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(products.data ?? []).map((p) => (
                      <SelectItem key={p.itemCode} value={p.itemCode}>
                        {p.itemName}
                        {p.active ? "" : " (inactive)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <ArrowRight className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />

              <div className="min-w-[240px] flex-1">
                <Label className="text-xs">Recommend</Label>
                <Select value={toCode} onValueChange={setToCode}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Choose a product…" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Only products the desk still sells: recommending a
                        switched-off product is offering something that cannot
                        be fulfilled. */}
                    {(products.data ?? [])
                      .filter((p) => p.active)
                      .map((p) => (
                        <SelectItem key={p.itemCode} value={p.itemCode}>
                          {p.itemName}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs" htmlFor="relation-note">
                Why (shown to the agent)
              </Label>
              <Input
                id="relation-note"
                className="mt-1"
                value={note}
                maxLength={300}
                placeholder="Optional — the desk's own reason for the pair"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={!verdict.ok || mutations.busy}
                onClick={() => {
                  if (!verdict.ok) return;
                  mutations.save.mutate(
                    {
                      fromItemCode: verdict.value.fromItemCode,
                      toItemCode: verdict.value.toItemCode,
                      note: verdict.value.note,
                    },
                    {
                      onSuccess: () => {
                        setFromCode("");
                        setToCode("");
                        setNote("");
                      },
                    },
                  );
                }}
              >
                {mutations.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
              {/* Only once both ends are chosen — telling somebody to "choose a
                  product" before they have touched the form is noise. */}
              {!verdict.ok && fromCode && toCode ? (
                <p className="text-xs text-[#B45309] dark:text-amber-300">
                  {RELATION_REJECTION_LABELS[verdict.reason]}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {relations.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : rows.length === 0 ? (
            /*
             * The honest empty state. No sample pairs, no suggestions drawn
             * from co-purchase data — that data was measured and does not
             * support them, and a plausible-looking example would be indis-
             * tinguishable from a real configuration once somebody saved it.
             */
            <div className="space-y-2 py-14 text-center">
              <p className="text-sm font-medium">No cross-sell relationships configured yet.</p>
              <p className="mx-auto max-w-lg text-xs text-muted-foreground">
                Recommended Leads will show no cross-sell recommendations until a team lead
                configures a pair here. Nothing is inferred from purchase history.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3",
                    !r.active && "opacity-60",
                  )}
                >
                  <div className="min-w-[280px] flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium">{nameOf(r.from_item_code)}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{r.to_item_name}</span>
                    </p>
                    {r.note ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.note}</p>
                    ) : null}
                  </div>

                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      r.active
                        ? "border-[#10B981]/40 bg-[#10B981]/15 text-[#047857] dark:text-emerald-200"
                        : "border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {r.active ? "Active" : "Off"}
                  </span>

                  <p className="text-xs text-muted-foreground">
                    Added by {personOf(r.created_by)} · {day(r.created_at)}
                    {r.updated_by && r.updated_by !== r.created_by
                      ? ` · changed by ${personOf(r.updated_by)} · ${day(r.updated_at)}`
                      : ""}
                  </p>

                  {canManage ? (
                    /*
                     * Switched off, never deleted. The row records a commercial
                     * decision somebody made, and "why were we offering this in
                     * March" should stay answerable.
                     */
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutations.busy}
                      onClick={() => mutations.setActive.mutate({ id: r.id, active: !r.active })}
                    >
                      {r.active ? "Switch off" : "Switch on"}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">
        A cross-sell is business configuration, not a clinical suggestion. It never outranks a
        refill, and it only reaches an agent when the customer has actually bought the first product
        and has not already bought the second.
      </p>
    </div>
  );
}
