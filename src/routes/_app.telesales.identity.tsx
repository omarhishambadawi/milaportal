import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Fingerprint, Loader2, ShieldAlert } from "lucide-react";
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
  ALIAS_CANDIDATE_LABELS,
  ALIAS_REJECTION_LABELS,
  buildAliasCatalog,
  describeAliasEffect,
  validateAlias,
} from "@/lib/telesales/aliases";
import {
  useAliasCandidates,
  useAliasMutations,
  useAliasProducts,
  useIdentityIndex,
  useProductAliases,
  useSourceProductTallies,
} from "@/features/telesales/hooks/use-product-aliases";

export const Route = createFileRoute("/_app/telesales/identity")({
  head: () => ({ meta: [{ title: "Product identity — MilaServ Portal" }] }),
  component: ProductIdentityPage,
});

/**
 * Product identity mapping.
 *
 * The whole screen exists to make one sentence enterable by a person: *these two
 * item codes are the same medicine*. The retention source uses two numbering
 * systems — 652 rows with the pharmacy's catalogue codes and 88 with a five- or
 * six-digit number for products the catalogue already holds — and until a code
 * is mapped, a customer who bought under the other system does not read as a
 * repeat buyer.
 *
 * Deliberately not the cross-sell screen. Identity says two codes are one
 * product; a cross-sell says one product is worth mentioning alongside another.
 * Merging the two screens would merge the two ideas, and the second is a
 * commercial judgement while the first is a fact about a catalogue.
 */
function ProductIdentityPage() {
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  const canView = hasPerm(role, perms, "view_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const aliases = useProductAliases(canView);
  const products = useAliasProducts(canView);
  const tallies = useSourceProductTallies(canView);
  const mutations = useAliasMutations();

  const index = useIdentityIndex(products.data, aliases.data);
  const candidates = useAliasCandidates(tallies.data, index, aliases.data);

  const [aliasCode, setAliasCode] = useState("");
  const [aliasName, setAliasName] = useState("");
  const [canonicalCode, setCanonicalCode] = useState("");
  const [note, setNote] = useState("");

  const catalog = useMemo(() => buildAliasCatalog(products.data ?? []), [products.data]);

  /*
   * The same validator the server runs.
   *
   * Shared rather than reimplemented, so the message a supervisor sees while
   * typing is the message the server would have given them. The server still
   * validates and the database still constrains — this is a courtesy, not the
   * boundary.
   */
  const verdict = useMemo(
    () =>
      validateAlias(
        {
          aliasItemCode: aliasCode,
          canonicalItemCode: canonicalCode,
          aliasNameSnapshot: aliasName,
          note,
        },
        catalog,
      ),
    [aliasCode, canonicalCode, aliasName, note, catalog],
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

  const startFromCandidate = (code: string, name: string | null, canonical: string | null) => {
    setAliasCode(code);
    setAliasName(name ?? "");
    setCanonicalCode(canonical ?? "");
    setNote("");
  };

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Telesales is restricted</p>
      </div>
    );
  }

  const rows = aliases.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Product identity</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Source item codes that mean a product the catalogue already carries. Nothing is merged
            or rewritten — this changes how purchases are matched, and switching a mapping off
            reverses it.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/telesales/relations">Cross-sell</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/telesales">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to the queue
            </Link>
          </Button>
        </div>
      </div>

      {canManage ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Map an item code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[180px]">
                <Label className="text-xs" htmlFor="alias-code">
                  Source item code
                </Label>
                <Input
                  id="alias-code"
                  className="mt-1"
                  value={aliasCode}
                  maxLength={64}
                  placeholder="519914"
                  onChange={(e) => setAliasCode(e.target.value)}
                />
              </div>

              <div className="min-w-[220px] flex-1">
                <Label className="text-xs" htmlFor="alias-name">
                  Its name in the source (recorded as evidence)
                </Label>
                <Input
                  id="alias-name"
                  className="mt-1"
                  value={aliasName}
                  maxLength={300}
                  placeholder="MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA"
                  onChange={(e) => setAliasName(e.target.value)}
                />
              </div>

              <ArrowRight className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />

              <div className="min-w-[240px] flex-1">
                <Label className="text-xs">Is the same product as</Label>
                {/*
                 * Catalogue-backed, never free text. A typed canonical code
                 * would let somebody point live leads at a product the pharmacy
                 * does not sell, and every refill date and repeat-purchase
                 * count for those leads would follow it.
                 */}
                <Select value={canonicalCode} onValueChange={setCanonicalCode}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Choose a catalogue product…" />
                  </SelectTrigger>
                  <SelectContent>
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
              <Label className="text-xs" htmlFor="alias-note">
                Why (kept with the mapping)
              </Label>
              <Input
                id="alias-note"
                className="mt-1"
                value={note}
                maxLength={300}
                placeholder="Optional — the desk's own reason for the mapping"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {/*
             * The business effect, spelled out before saving.
             *
             * Two dropdowns and an arrow do not say that every purchase, refill
             * date and recommendation for these codes will change — and equally
             * that nothing stored is being altered. The sentence says both.
             */}
            {verdict.ok ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {describeAliasEffect(verdict.value, aliasName)}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={!verdict.ok || mutations.busy}
                onClick={() => {
                  if (!verdict.ok) return;
                  mutations.save.mutate(
                    {
                      aliasItemCode: verdict.value.aliasItemCode,
                      canonicalItemCode: verdict.value.canonicalItemCode,
                      aliasNameSnapshot: verdict.value.aliasNameSnapshot,
                      note: verdict.value.note,
                    },
                    {
                      onSuccess: () => {
                        setAliasCode("");
                        setAliasName("");
                        setCanonicalCode("");
                        setNote("");
                      },
                    },
                  );
                }}
              >
                {mutations.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save mapping
              </Button>
              {/* Only once both ends are entered — telling somebody to "enter a
                  code" before they have touched the form is noise. */}
              {!verdict.ok && aliasCode && canonicalCode ? (
                <p className="text-xs text-[#B45309] dark:text-amber-300">
                  {ALIAS_REJECTION_LABELS[verdict.reason]}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Codes still waiting on a decision                                   */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Unmapped source codes
            {candidates.length ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {candidates.length}
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {tallies.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning the source…
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Every source item code is either a catalogue product or already mapped.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {candidates.slice(0, 100).map((c) => (
                <div
                  key={c.sourceItemCode}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
                >
                  <div className="min-w-[280px] flex-1">
                    <p className="text-sm">
                      <span className="font-mono text-xs">{c.sourceItemCode}</span>
                      <span className="ml-2">{c.sourceItemName ?? "—"}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {ALIAS_CANDIDATE_LABELS[c.status]}
                      {c.canonicalItemName ? ` — ${c.canonicalItemName}` : ""}
                      {` · ${c.occurrences} source row${c.occurrences === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        startFromCandidate(c.sourceItemCode, c.sourceItemName, c.canonicalItemCode)
                      }
                    >
                      Review
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Configured mappings                                                 */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Configured mappings</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {aliases.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="space-y-2 py-14 text-center">
              <p className="text-sm font-medium">No product identity mappings configured.</p>
              <p className="mx-auto max-w-lg text-xs text-muted-foreground">
                Purchases are matched by item code alone, falling back to an exact product name.
                Nothing is inferred from similar names.
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
                      <span className="font-mono text-xs">{r.alias_item_code}</span>
                      <span className="text-muted-foreground">{r.alias_name_snapshot ?? ""}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{nameOf(r.canonical_item_code)}</span>
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
                     * Switched off, never deleted. The row records a decision
                     * about what two codes mean, and "why did this count as a
                     * repeat purchase in September" should stay answerable.
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
        A mapping is an interpretation, not a merge. Source records, leads, the product catalogue
        and every Shams MIS identifier keep the values they arrived with; only the CRM's answer to
        "is this the same product" changes. Similar names are never enough — the five Mounjaro
        strengths are five products and stay that way.
      </p>
    </div>
  );
}
