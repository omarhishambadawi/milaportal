import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import {
  RELATION_KIND_HINTS,
  RELATION_KIND_LABELS,
  buildRelationCatalog,
  type RelationKind,
} from "@/lib/telesales/relations";
import {
  buildSearchIndex,
  groupBySource,
  planBulkAssign,
  queuedSources,
} from "@/lib/telesales/relation-search";
import { ProductPicker } from "@/features/telesales/components/product-picker";
import {
  useProductRelations,
  useRelationMutations,
  useRelationProducts,
  type ProductRelationRow,
} from "@/features/telesales/hooks/use-product-relations";
import { useProductAliases } from "@/features/telesales/hooks/use-product-aliases";

/**
 * Configuring one kind of recommendation.
 *
 * Cross-sell and up-sell are the same operation on the same table, differing in
 * one stored value and in the sentence an agent reads. So this is one component
 * rendered twice rather than two screens: the form, the bulk plan, the grouped
 * list and the switch-off behaviour are identical, and a second copy would be a
 * second place to fix the next time any of them changes.
 *
 * The rows are filtered by kind at the render rather than at the read, because
 * both tabs are open in the same page and one bounded read of a table with tens
 * of rows serves both.
 *
 * Nothing here infers a pair. The engine that reads these never invents one
 * either — that was measured in Phase 3 and the data did not support it — so a
 * relationship exists because somebody with `manage_telesales` typed it.
 */
export function RelationManager({ kind, canManage }: { kind: RelationKind; canManage: boolean }) {
  const relations = useProductRelations(true);
  const products = useRelationProducts(true);
  const aliases = useProductAliases(true);
  const mutations = useRelationMutations();

  /*
   * Sources are a list, targets are one.
   *
   * The supervisor's real task is "Mounjaro, all six strengths, offer the Libre
   * sensor". One target against many sources is the shape that removes work;
   * the reverse is already served by saving twice, and the pairs are
   * directional so the two are not symmetrical.
   */
  const [fromCodes, setFromCodes] = useState<string[]>([]);
  const [toCode, setToCode] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const catalog = useMemo(() => buildRelationCatalog(products.data ?? []), [products.data]);

  /** The searchable catalogue: products, plus the codes that also mean them. */
  const searchIndex = useMemo(
    () => buildSearchIndex(products.data ?? [], aliases.data ?? []),
    [products.data, aliases.data],
  );

  const target = toCode[0] ?? "";

  /** Only this kind's pairs. */
  const rows = useMemo(
    () =>
      (relations.data ?? []).filter((r) =>
        kind === "cross_sell" ? r.kind !== "up_sell" : r.kind === "up_sell",
      ),
    [relations.data, kind],
  );

  /*
   * What the button is about to do, computed before it is pressed.
   *
   * The existing-pair check runs against *every* configured pair, not just this
   * kind's: the unique key is on the pair alone, so configuring an up-sell for
   * a pair already saved as a cross-sell changes the existing row rather than
   * adding one, and the plan should say so rather than the toast afterwards.
   */
  const plan = useMemo(
    () =>
      target ? planBulkAssign({ sources: fromCodes, target, existing: relations.data ?? [] }) : [],
    [fromCodes, target, relations.data],
  );
  const queued = useMemo(() => queuedSources(plan), [plan]);
  const refused = plan.filter((p) => p.status !== "queued");

  /** The configured pairs, gathered under the product they start from. */
  const groups = useMemo(() => groupBySource(rows, catalog), [rows, catalog]);

  /** Who created or changed each row, from one roster read. */
  const roster = useQuery<Map<string, string>>({
    queryKey: queryKeys.lookups.ordersDirectory(),
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

  const label = RELATION_KIND_LABELS[kind];

  /**
   * Apply the target to every queued source.
   *
   * One call per pair through `telesalesSaveProductRelation`, because a pair is
   * what that function configures and each carries its own validation and its
   * own `planSave` verdict. Sequential rather than parallel: several writes
   * against one unique index, and a supervisor reading the result wants a
   * total, not a race.
   */
  async function applyBulk() {
    if (!target || queued.length === 0) return;
    let created = 0;
    let reactivated = 0;
    let failed = 0;
    for (const source of queued) {
      try {
        const res = await mutations.save.mutateAsync({
          fromItemCode: source,
          toItemCode: target,
          kind,
          note: note.trim() || null,
          // One summary at the end, not one message per pair.
          silent: true,
        });
        const outcome = (res as { plan?: string }).plan;
        if (outcome === "reactivated") reactivated++;
        else if (outcome !== "unchanged") created++;
      } catch {
        // Counted, not thrown: one refused pair must not abandon the rest.
        failed++;
      }
    }
    mutations.sweep();
    toast.success(
      [
        created ? `${created} added` : null,
        reactivated ? `${reactivated} switched back on` : null,
        failed ? `${failed} could not be saved` : null,
      ]
        .filter(Boolean)
        .join(", ") || "Nothing to change",
    );
    setFromCodes([]);
    setToCode([]);
    setNote("");
  }

  return (
    <div className="space-y-4">
      {canManage ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add {label.toLowerCase()}</CardTitle>
            <p className="text-xs text-muted-foreground">{RELATION_KIND_HINTS[kind]}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {/*
             * The direction is the point, so it is spelled out rather than
             * implied by column order. A -> B does not mean B -> A, and a
             * supervisor configuring one should not have to guess that.
             */}
            <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr]">
              <div>
                <Label className="text-xs" htmlFor={`${kind}-source`}>
                  When the customer has bought
                  <span className="ml-1 font-normal text-muted-foreground">
                    (choose one or more)
                  </span>
                </Label>
                <div className="mt-1.5">
                  <ProductPicker
                    id={`${kind}-source`}
                    index={searchIndex}
                    selected={fromCodes}
                    onChange={setFromCodes}
                    multiple
                    /* A customer may well have bought something the desk has
                       since stopped selling, and that purchase is still a real
                       fact to recommend from. */
                    includeInactive
                    disabled={mutations.busy}
                    placeholder="Search sources by name or item code…"
                    emptyHint="Nothing selected — search above, then pick one or more products."
                  />
                </div>
              </div>

              <div className="flex items-center justify-center lg:pt-8">
                <ArrowRight className="h-5 w-5 text-muted-foreground" />
              </div>

              <div>
                <Label className="text-xs" htmlFor={`${kind}-target`}>
                  Recommend
                </Label>
                <div className="mt-1.5">
                  <ProductPicker
                    id={`${kind}-target`}
                    index={searchIndex}
                    selected={toCode}
                    onChange={setToCode}
                    /* Only products the desk still sells: recommending a
                       switched-off product is offering something that cannot be
                       fulfilled. */
                    disabled={mutations.busy}
                    placeholder="Search the product to offer…"
                    emptyHint="Nothing selected — one product is recommended to every source chosen."
                  />
                </div>
              </div>
            </div>

            <div>
              <Label className="text-xs" htmlFor={`${kind}-note`}>
                Why (shown to the agent)
              </Label>
              <Input
                id={`${kind}-note`}
                className="mt-1"
                value={note}
                maxLength={300}
                placeholder="Optional — the desk's own reason for the pair"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {/*
             * What the button will do, before it is pressed.
             *
             * With six sources selected the alternative is six toasts after the
             * click, by which point the supervisor cannot tell which pair was
             * refused or why.
             */}
            {target && fromCodes.length > 0 ? (
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs font-medium">
                  {queued.length === 0
                    ? "Nothing to add"
                    : `Will configure ${queued.length} ${label.toLowerCase()}${
                        queued.length === 1 ? "" : "s"
                      }`}
                  {" → "}
                  {nameOf(target)}
                </p>
                {queued.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {queued.map((code) => (
                      <li key={code}>{nameOf(code)}</li>
                    ))}
                  </ul>
                ) : null}
                {refused.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5 text-xs text-muted-foreground">
                    {refused.map((r) => (
                      <li key={r.source}>
                        {nameOf(r.source)} — {"reason" in r ? r.reason : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                disabled={mutations.busy || queued.length === 0}
                onClick={() => void applyBulk()}
              >
                {mutations.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {queued.length > 1
                  ? `Apply to ${queued.length} products`
                  : `Save ${label.toLowerCase()}`}
              </Button>
              <p className="text-xs text-muted-foreground">
                Existing pairs are left alone. A pair that was switched off is switched back on
                rather than duplicated.
              </p>
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
             * support them, and a plausible-looking example would be
             * indistinguishable from a real configuration once somebody saved
             * it.
             */
            <div className="space-y-2 py-14 text-center">
              <p className="text-sm font-medium">No {label.toLowerCase()} configured yet.</p>
              <p className="mx-auto max-w-lg text-xs text-muted-foreground">
                Recommended Leads shows nothing of this kind until a team lead configures a pair
                here. Nothing is inferred from purchase history.
              </p>
            </div>
          ) : (
            /*
             * Grouped by source.
             *
             * A flat list answered "what pairs exist"; a supervisor asks "what
             * does Mounjaro 5 mg offer", and with six strengths carrying two or
             * three companions each that was a scan rather than a glance.
             */
            <div className="divide-y divide-border">
              {groups.map((group) => (
                <div key={group.fromItemCode} className="px-4 py-3">
                  <p className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{group.fromItemName}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {group.fromItemCode}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {group.activeCount} active
                      {group.targets.length > group.activeCount
                        ? ` · ${group.targets.length - group.activeCount} off`
                        : ""}
                    </span>
                  </p>

                  <ul className="mt-2 space-y-1.5">
                    {group.targets.map((r: ProductRelationRow) => (
                      <li
                        key={r.id}
                        className={cn(
                          "flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/60 px-3 py-2",
                          !r.active && "opacity-60",
                        )}
                      >
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-[200px] flex-1">
                          <span className="block text-sm font-medium">{r.to_item_name}</span>
                          {r.note ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {r.note}
                            </span>
                          ) : null}
                        </span>

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

                        <span className="text-xs text-muted-foreground">
                          Added by {personOf(r.created_by)} · {day(r.created_at)}
                          {r.updated_by && r.updated_by !== r.created_by
                            ? ` · changed by ${personOf(r.updated_by)} · ${day(r.updated_at)}`
                            : ""}
                        </span>

                        {canManage ? (
                          /*
                           * Switched off, never deleted. The row records a
                           * commercial decision somebody made, and "why were we
                           * offering this in March" should stay answerable.
                           */
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={mutations.busy}
                            onClick={() =>
                              mutations.setActive.mutate({ id: r.id, active: !r.active })
                            }
                          >
                            {r.active ? "Switch off" : "Switch on"}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
