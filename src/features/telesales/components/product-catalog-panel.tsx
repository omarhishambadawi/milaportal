import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, Package, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { familyLabel } from "@/lib/telesales/products";
import {
  telesalesAddCatalogProduct,
  telesalesSearchCatalogSource,
  telesalesSetProductEligibility,
} from "@/lib/telesales.functions";
import { ALIAS_REJECTION_LABELS, buildAliasCatalog, validateAlias } from "@/lib/telesales/aliases";
import { useDebounced } from "@/features/shams/hooks/use-shams-data";
import {
  useAliasMutations,
  useAliasProducts,
  useProductAliases,
} from "@/features/telesales/hooks/use-product-aliases";

/**
 * The Telesales product catalogue, and where it comes from.
 *
 * ===========================================================================
 * Branch Stock is the identity; this table is the configuration
 * ===========================================================================
 * A product's item code and name are the pharmacy's, read from Shams MIS Branch
 * Stock and never typed by a supervisor. What lives here is everything the MIS
 * has no opinion about: whether this desk sells the product by phone, whether
 * it has a refill cycle, and how long that cycle is.
 *
 * That split is also why adding a product cannot be a form with a name field.
 * Two people typing "Mounjaro 5mg" produce two rows; one person picking it out
 * of Branch Stock produces the code the imports will actually carry, which is
 * the whole reason imported item codes resolve without anybody mapping them.
 *
 * ===========================================================================
 * Duplicates are impossible rather than prevented
 * ===========================================================================
 * `item_code` is the primary key. Adding the same product twice updates the row
 * that is already there — there is no path that produces a second row for one
 * SKU, and nothing here has to check for one.
 */

interface CatalogRow {
  item_code: string;
  item_name: string;
  family: string;
  strength: string | null;
  eligible_cash: boolean;
  eligible_retention: boolean;
  refill_days: number | null;
  active: boolean;
  source: string;
}

/** Families the desk already uses, so the picker offers what exists. */
const KNOWN_FAMILIES = [
  "mounjaro",
  "ozempic",
  "wegovy",
  "rybelsus",
  "freestyle_libre",
  "dexcom",
  "insulin",
  "other",
];

/**
 * A family proposed from the product's name.
 *
 * Deliberately crude and deliberately only a *proposal*: it fills the select so
 * the common case is one fewer decision, and the supervisor can change it. The
 * real classifier is `telesales_product_patterns`, which is what generation
 * uses; duplicating its ordering here would create a second answer to the same
 * question. Anything unrecognised proposes nothing and the operator chooses.
 */
export function proposeFamily(itemName: string): string {
  const n = itemName.toUpperCase();
  if (n.includes("MOUNJARO")) return "mounjaro";
  if (n.includes("OZEMPIC")) return "ozempic";
  if (n.includes("WEGOVY")) return "wegovy";
  if (n.includes("RYBELSUS")) return "rybelsus";
  // "FREESTYLE" alone is wrong: FreeStyle Optium is a fingerstick product and
  // FreeStyle Libre is a continuous monitor. The name has to say Libre.
  if (n.includes("LIBRE")) return "freestyle_libre";
  if (n.includes("DEXCOM")) return "dexcom";
  return "other";
}

export function ProductCatalogPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [filter, setFilter] = useState("");

  const catalog = useQuery<CatalogRow[]>({
    queryKey: [...queryKeys.telesales.products(), "catalog-rows"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_products")
        .select(
          "item_code,item_name,family,strength,eligible_cash,eligible_retention,refill_days,active,source",
        )
        .order("family", { ascending: true })
        .order("item_name", { ascending: true })
        .limit(2000);
      if (error) throw new Error(error.message);
      return (data as CatalogRow[]) ?? [];
    },
  });

  /*
   * The alias codes, shown against the product they mean.
   *
   * There is no Product Identity screen any more — imported item codes resolve
   * against this catalogue on their own, which is what the brief asks for. What
   * could not simply be deleted is the historical mapping: the retention source
   * carries 88 rows under a second, older numbering system, and without those
   * mappings a customer who bought under the old code stops reading as a repeat
   * buyer. They are shown here, against the product, as what they are — other
   * codes that mean this — rather than as a screen of their own.
   */
  const aliases = useProductAliases(true);
  const aliasesByCanonical = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of aliases.data ?? []) {
      if (!a.active) continue;
      const list = map.get(a.canonical_item_code) ?? [];
      list.push(a.alias_item_code);
      map.set(a.canonical_item_code, list);
    }
    return map;
  }, [aliases.data]);

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const all = catalog.data ?? [];
    if (!term) return all;
    return all.filter(
      (r) =>
        r.item_name.toLowerCase().includes(term) ||
        r.item_code.toLowerCase().includes(term) ||
        r.family.toLowerCase().includes(term),
    );
  }, [catalog.data, filter]);

  const sweep = () => qc.invalidateQueries({ queryKey: queryKeys.telesales.products() });

  const setEligibility = useMutation({
    mutationFn: (input: {
      itemCode: string;
      eligibleCash: boolean;
      eligibleRetention: boolean;
      refillDays: number | null;
      active: boolean;
    }) => telesalesSetProductEligibility({ data: input }),
    onSuccess: () => {
      sweep();
      toast.success("Catalogue updated");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "That change could not be saved."),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter the catalogue by name, item code or family"
            className="pl-8"
            aria-label="Filter the catalogue"
          />
        </div>
        {canManage ? (
          <>
            {/*
             * The remnant of the Product Identity screen, reduced to what is
             * still needed.
             *
             * Imported codes resolve on their own — a Cash or Retention row
             * carries the pharmacy's item code and it matches this catalogue's.
             * What does not resolve is the older numbering system a slice of
             * the retention source still uses, and that is a *fact about a
             * product* rather than a screen's worth of work, so it sits here
             * beside the product it concerns.
             */}
            <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
              Link an item code
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Product
            </Button>
          </>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-0">
          {catalog.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading the catalogue…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-14 text-center">
              <Package className="mx-auto h-9 w-9 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium">
                {filter ? "No product matches that" : "The catalogue is empty"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {filter
                  ? "Try the item code instead."
                  : "Add a product from Shams Branch Stock to start."}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((p) => {
                const alsoKnownAs = aliasesByCanonical.get(p.item_code) ?? [];
                return (
                  <li
                    key={p.item_code}
                    className={cn("px-4 py-3", !p.active && "bg-muted/30 opacity-70")}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-sm font-medium">{p.item_name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {p.item_code}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {familyLabel(p.family)}
                        {p.refill_days ? ` · ${p.refill_days}-day cycle` : ""}
                        {p.source === "branch_stock" ? " · from Branch Stock" : ""}
                      </span>
                      {alsoKnownAs.length > 0 ? (
                        <span
                          className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          title="Other item codes in the source files that mean this product"
                        >
                          also {alsoKnownAs.join(", ")}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-4">
                      {/*
                       * The three decisions that are this desk's rather than
                       * the MIS's. Eligibility is per pipeline because they are
                       * different questions: a FreeStyle reader is a legitimate
                       * Cash lead and a meaningless retention one.
                       */}
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={p.eligible_cash}
                          disabled={!canManage || setEligibility.isPending}
                          onCheckedChange={(v) =>
                            setEligibility.mutate({
                              itemCode: p.item_code,
                              eligibleCash: v === true,
                              eligibleRetention: p.eligible_retention,
                              refillDays: p.refill_days,
                              active: p.active,
                            })
                          }
                        />
                        Cash
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={p.eligible_retention}
                          disabled={!canManage || setEligibility.isPending}
                          onCheckedChange={(v) =>
                            setEligibility.mutate({
                              itemCode: p.item_code,
                              eligibleCash: p.eligible_cash,
                              eligibleRetention: v === true,
                              refillDays: p.refill_days,
                              active: p.active,
                            })
                          }
                        />
                        Retention
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={p.active}
                          disabled={!canManage || setEligibility.isPending}
                          onCheckedChange={(v) =>
                            setEligibility.mutate({
                              itemCode: p.item_code,
                              eligibleCash: p.eligible_cash,
                              eligibleRetention: p.eligible_retention,
                              refillDays: p.refill_days,
                              active: v === true,
                            })
                          }
                        />
                        In the catalogue
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">
        Imported item codes resolve against this list automatically. Nothing has to be mapped by
        hand: a Cash or Retention row carries the pharmacy&rsquo;s own item code, and it is matched
        to the same code here.
      </p>

      {canManage ? (
        <>
          <AddProductDialog open={adding} onOpenChange={setAdding} onAdded={sweep} />
          <LinkCodeDialog open={linking} onOpenChange={setLinking} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Add Product: search Branch Stock, pick, then say how the desk sells it.
 *
 * The two halves are deliberate. Above the line is identity, which is read and
 * never typed; below it is configuration, which cannot be read from anywhere
 * and has to be decided.
 */
function AddProductDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [term, setTerm] = useState("");
  const settled = useDebounced(term);
  const [picked, setPicked] = useState<{ itemCode: string; itemName: string } | null>(null);
  const [family, setFamily] = useState("other");
  const [cash, setCash] = useState(true);
  const [retention, setRetention] = useState(false);
  const [refillDays, setRefillDays] = useState("");

  const searchFn = useServerFn(telesalesSearchCatalogSource);
  const results = useQuery({
    queryKey: [...queryKeys.telesales.products(), "branch-stock-search", settled.trim()],
    // Two characters is the MIS's own floor; one letter matches most of the
    // catalogue and the request is wasted.
    enabled: open && settled.trim().length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => searchFn({ data: { q: settled.trim() }, signal }),
  });

  const add = useMutation({
    mutationFn: (input: {
      itemCode: string;
      family: string;
      eligibleCash: boolean;
      eligibleRetention: boolean;
      refillDays: number | null;
    }) => telesalesAddCatalogProduct({ data: input }),
    onSuccess: (r) => {
      onAdded();
      toast.success(`${r.itemName} added to the catalogue`);
      reset();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "The product could not be added."),
  });

  function reset() {
    setTerm("");
    setPicked(null);
    setFamily("other");
    setCash(true);
    setRetention(false);
    setRefillDays("");
  }

  function choose(p: { itemCode: string; itemName: string }) {
    setPicked(p);
    setFamily(proposeFamily(p.itemName));
  }

  const days = refillDays.trim() === "" ? null : Number(refillDays);
  const daysValid = days === null || (Number.isInteger(days) && days > 0 && days <= 365);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a product</DialogTitle>
          <DialogDescription>
            The item code and name come from Shams MIS Branch Stock and are not edited here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs" htmlFor="branch-stock-search">
              Search Branch Stock
            </Label>
            <div className="relative mt-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="branch-stock-search"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Product name or item code — at least two characters"
                className="pl-8"
              />
            </div>

            {results.isFetching ? (
              <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Searching Branch Stock…
              </p>
            ) : results.isError ? (
              <p className="mt-2 text-xs text-destructive">
                {(results.error as Error)?.message ?? "Branch Stock could not be reached."}
              </p>
            ) : results.data && !results.data.configured ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Shams MIS is not configured in this environment, so Branch Stock cannot be searched.
              </p>
            ) : results.data && results.data.products.length === 0 && settled.trim().length >= 2 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Nothing in Branch Stock matches that.
              </p>
            ) : null}

            {results.data && results.data.products.length > 0 ? (
              <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border">
                {results.data.products.map((p) => (
                  <button
                    key={p.itemCode}
                    type="button"
                    onClick={() => choose(p)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                      picked?.itemCode === p.itemCode ? "bg-primary/10" : "hover:bg-accent/60",
                    )}
                  >
                    {picked?.itemCode === p.itemCode ? (
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <span className="h-4 w-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{p.itemName}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {p.itemCode}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {picked ? (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-sm">
                <span className="font-medium">{picked.itemName}</span>{" "}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {picked.itemCode}
                </span>
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs" htmlFor="new-product-family">
                    Family
                  </Label>
                  <Select value={family} onValueChange={setFamily}>
                    <SelectTrigger id="new-product-family" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KNOWN_FAMILIES.map((f) => (
                        <SelectItem key={f} value={f}>
                          {familyLabel(f)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs" htmlFor="new-product-refill">
                    Refill cycle (days)
                  </Label>
                  <Input
                    id="new-product-refill"
                    className="mt-1"
                    inputMode="numeric"
                    value={refillDays}
                    onChange={(e) => setRefillDays(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="Leave blank if the agent decides"
                  />
                  {!daysValid ? (
                    <p className="mt-1 text-xs text-destructive">
                      A cycle is between 1 and 365 days.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={cash} onCheckedChange={(v) => setCash(v === true)} />
                  Sold on the Cash desk
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={retention} onCheckedChange={(v) => setRetention(v === true)} />
                  Has a retention cycle
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Neither is a property of the product in the MIS — they are decisions about how this
                desk works, so there is nothing to look up.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!picked || !daysValid || add.isPending}
            onClick={() =>
              picked &&
              add.mutate({
                itemCode: picked.itemCode,
                family,
                eligibleCash: cash,
                eligibleRetention: retention,
                refillDays: days,
              })
            }
          >
            {add.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Add to catalogue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Map a second item code onto a catalogue product.
 *
 * All that survives of the Product Identity screen, and only because the data
 * is still load-bearing: the retention source carries rows under an older
 * numbering system, and without the mapping a customer who bought under the old
 * code does not read as a repeat buyer. The screen is gone; the fact is not.
 *
 * What it asserts is that two item codes are **the same medicine**, which is
 * why the validator is the server's own and why the canonical end is chosen
 * from the catalogue rather than typed. Fuzzy similarity is not evidence and is
 * not offered here: Mounjaro 5 MG and 7.5 MG are different products and no
 * amount of name resemblance makes them one.
 */
function LinkCodeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const products = useAliasProducts(open);
  const mutations = useAliasMutations();
  const [aliasCode, setAliasCode] = useState("");
  const [canonical, setCanonical] = useState("");
  const [note, setNote] = useState("");

  const catalog = useMemo(() => buildAliasCatalog(products.data ?? []), [products.data]);

  // The same validator the server runs, shared rather than reimplemented, so
  // the message here is the message the server would have given. The server
  // still validates and the database still constrains; this is a courtesy.
  const verdict = useMemo(
    () => validateAlias({ aliasItemCode: aliasCode, canonicalItemCode: canonical, note }, catalog),
    [aliasCode, canonical, note, catalog],
  );

  function reset() {
    setAliasCode("");
    setCanonical("");
    setNote("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link an item code</DialogTitle>
          <DialogDescription>
            For source files that carry a second code for a product already in the catalogue. Both
            codes then count as the same purchase.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs" htmlFor="alias-code">
              The code that appears in the file
            </Label>
            <Input
              id="alias-code"
              className="mt-1 font-mono"
              value={aliasCode}
              maxLength={64}
              placeholder="e.g. 519914"
              onChange={(e) => setAliasCode(e.target.value)}
            />
          </div>

          <div>
            <Label className="text-xs" htmlFor="alias-canonical">
              means this catalogue product
            </Label>
            <Select value={canonical} onValueChange={setCanonical}>
              <SelectTrigger id="alias-canonical" className="mt-1">
                <SelectValue placeholder="Choose a product" />
              </SelectTrigger>
              <SelectContent>
                {(products.data ?? [])
                  .filter((p) => p.active)
                  .map((p) => (
                    <SelectItem key={p.itemCode} value={p.itemCode}>
                      {p.itemName} · {p.itemCode}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs" htmlFor="alias-note">
              Why (optional)
            </Label>
            <Input
              id="alias-note"
              className="mt-1"
              value={note}
              maxLength={300}
              placeholder="What evidence says these are the same product"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {aliasCode && canonical && !verdict.ok ? (
            <p className="text-xs text-destructive">{ALIAS_REJECTION_LABELS[verdict.reason]}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!verdict.ok || mutations.busy}
            onClick={() =>
              mutations.save.mutate(
                {
                  aliasItemCode: aliasCode.trim(),
                  canonicalItemCode: canonical,
                  note: note || null,
                },
                {
                  onSuccess: () => {
                    reset();
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            {mutations.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Link the code
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
