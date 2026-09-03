import { useMemo } from "react";
import { applicableCrossSell } from "@/lib/telesales/relations";
import { groupRelationsByItem, type ProductRelation } from "@/lib/telesales/recommendations";
import {
  useAliasProducts,
  useIdentityIndex,
  useProductAliases,
} from "@/features/telesales/hooks/use-product-aliases";
import { useProductRelations } from "@/features/telesales/hooks/use-product-relations";

/**
 * The configured cross-sells that apply to one lead's product.
 *
 * ===========================================================================
 * Three bounded reads, all of them already cached
 * ===========================================================================
 * Nothing new is queried. The catalogue, the identity mappings and the
 * configured relations are the same three reads the Product Identity and
 * Cross-sell management screens make, under the same query keys and the same
 * `queryKeys.telesales.products()` prefix — so opening a lead after visiting
 * either screen costs nothing, and opening five leads in a row costs one set of
 * reads, not five.
 *
 * They are also tiny and fixed: 28 catalogue rows, 88 mappings, and however
 * many pairs the desk has configured (one, today). The cost does not grow with
 * the number of cross-sells, which is what "no N+1" means here — there is no
 * per-relation and no per-product request anywhere in this path.
 *
 * ===========================================================================
 * No stock
 * ===========================================================================
 * Deliberately. Stock is per product *per branch* and comes from the Shams MIS,
 * so showing it beside each companion would be one upstream request per
 * cross-sell on every lead open. Recommended Leads fetches it for the products
 * on the visible page precisely because that set is bounded; a lead's companion
 * list is not the same guarantee, and the brief rules it out.
 *
 * ===========================================================================
 * It resolves identity, it does not decide anything
 * ===========================================================================
 * `applicableCrossSell` is the whole rule and it is pure. This hook only
 * gathers what that function needs. The recommendation engine's own
 * `findRelation` — which picks one companion and excludes what the customer
 * already owns — is untouched and answers a different question.
 */

export interface LeadCrossSellResult {
  /** The configured companions, deduplicated by target and deterministically ordered. */
  relations: ProductRelation[];
  /** The catalogue product the lead resolved to, for the "source product" line. */
  sourceName: string | null;
  isLoading: boolean;
  /** True when a read failed. The panel says so rather than showing an empty list. */
  isError: boolean;
}

export function useLeadCrossSell(
  product: { itemCode: string | null; itemName: string | null } | null,
  enabled: boolean,
): LeadCrossSellResult {
  const products = useAliasProducts(enabled);
  const aliases = useProductAliases(enabled);
  const relations = useProductRelations(enabled);

  const identity = useIdentityIndex(products.data, aliases.data);

  const relationsByItem = useMemo(
    () =>
      groupRelationsByItem(
        /*
         * Active only, matching what the recommendation engine loads. The
         * management screen reads both so it can render a switched-off row;
         * a lead must show only what is actually in force.
         */
        (relations.data ?? [])
          .filter((r) => r.active)
          .map((r) => ({
            fromItemCode: r.from_item_code,
            toItemCode: r.to_item_code,
            toItemName: r.to_item_name,
            note: r.note,
          })),
      ),
    [relations.data],
  );

  return useMemo(() => {
    const isLoading = products.isPending || aliases.isPending || relations.isPending;
    const isError = products.isError || aliases.isError || relations.isError;

    if (!product || isLoading || isError) {
      return { relations: [], sourceName: null, isLoading, isError };
    }

    return {
      relations: applicableCrossSell({ product, identity, relationsByItem }),
      /*
       * The catalogue's name for what the lead resolved to, not the lead's own.
       * A lead carrying an alias code spells the product the way the source
       * workbook did; the panel is describing a configured relationship, and
       * the configuration is against the catalogue.
       */
      sourceName: resolveSourceName(product, identity),
      isLoading,
      isError,
    };
  }, [
    product,
    identity,
    relationsByItem,
    products.isPending,
    products.isError,
    aliases.isPending,
    aliases.isError,
    relations.isPending,
    relations.isError,
  ]);
}

/** The catalogue name for a lead's product, falling back to what the lead says. */
function resolveSourceName(
  product: { itemCode: string | null; itemName: string | null },
  identity: ReturnType<typeof useIdentityIndex>,
): string | null {
  const canonical = identity.byCode.get(product.itemCode?.trim() ?? "");
  if (canonical?.itemName) return canonical.itemName;
  const viaAlias = identity.aliasToCanonical.get(product.itemCode?.trim() ?? "");
  if (viaAlias) return identity.byCode.get(viaAlias)?.itemName ?? product.itemName;
  return product.itemName;
}
