import { ArrowRight, Link2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeadCrossSellResult } from "@/features/telesales/hooks/use-lead-cross-sell";

/**
 * What else this customer could be told about.
 *
 * ===========================================================================
 * On the lead, because that is where the call happens
 * ===========================================================================
 * The configuration was reachable only through the customer profile or the
 * management screen, so an agent mid-call had to leave the lead to find out
 * whether the desk had configured a companion for the product in front of them.
 * By the time they got back the moment had passed.
 *
 * ===========================================================================
 * Configuration, shown as configuration
 * ===========================================================================
 * Every pair here was typed by somebody with `manage_telesales`. Nothing is
 * inferred, nothing is ranked, and no relationship can be created from this
 * panel — it renders `telesales_product_relations` and nothing else. The desk's
 * own note travels with each pair, verbatim, so the justification reaches the
 * agent rather than being asserted by the software.
 *
 * That is also why the empty state says "none configured" rather than "no
 * cross-sell available": the difference between a decision nobody has made and
 * a decision made against is the whole reason this data is hand-entered.
 */

export interface LeadCrossSellPanelProps extends LeadCrossSellResult {
  /** The lead's own product name, for the source line when nothing resolved. */
  fallbackName: string | null;
}

export function LeadCrossSellPanel({
  relations,
  sourceName,
  isLoading,
  isError,
  fallbackName,
}: LeadCrossSellPanelProps) {
  const source = sourceName ?? fallbackName;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          Cross-sell
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading configured products…
          </p>
        ) : isError ? (
          /*
           * Said plainly rather than shown as an empty list. "Nothing is
           * configured" and "we could not read the configuration" are different
           * facts, and an agent acting on the first when the second is true is
           * the failure worth preventing.
           */
          <p className="text-sm text-muted-foreground">
            The cross-sell configuration could not be loaded, so this is not a statement that none
            exists.
          </p>
        ) : relations.length === 0 ? (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              No cross-sell configured for {source ? <strong>{source}</strong> : "this product"}.
            </p>
            <p className="text-xs text-muted-foreground">
              Pairs are set up by a team lead on the Cross-sell configuration screen. Nothing is
              suggested automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/*
             * The direction, stated. A -> B does not mean B -> A, and the panel
             * would be ambiguous without naming which end the lead is.
             */}
            <p className="text-xs text-muted-foreground">
              Customer is buying <span className="font-medium text-foreground">{source}</span>
              {" · "}
              {relations.length} configured companion{relations.length === 1 ? "" : "s"}
            </p>

            <ul className="divide-y divide-border rounded-md border border-border">
              {relations.map((r) => (
                <li key={r.toItemCode} className="flex items-start gap-3 p-3">
                  <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{r.toItemName}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">{r.toItemCode}</p>
                    {/* The desk's own words for why the pair exists. */}
                    {r.note ? <p className="mt-1 text-xs text-muted-foreground">{r.note}</p> : null}
                  </div>
                </li>
              ))}
            </ul>

            <p className="text-xs text-muted-foreground">
              Configured by a team lead, not inferred. Mention it only if it fits the conversation.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
