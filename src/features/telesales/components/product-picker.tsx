import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { searchProducts, type SearchableProduct } from "@/lib/telesales/relation-search";

/**
 * Choosing a catalogue product by typing.
 *
 * ===========================================================================
 * The Stock tab's interaction, over the Telesales catalogue
 * ===========================================================================
 * The dropdown listed 28 products by name, which is workable until a supervisor
 * is holding an item code, or knows the strength but not where it sorts. This
 * is the same box the `/shams` Stock tab uses — type, arrow through, Enter to
 * pick, Escape to clear — so there is one search interaction in the product,
 * not two.
 *
 * What it searches is different, and deliberately: `validateRelation` accepts
 * nothing but a `telesales_products` code, so offering MIS results would fill
 * the list with products the server would then refuse. The matching itself is
 * the Shams module's own string functions, unchanged.
 *
 * ===========================================================================
 * One picker, two modes
 * ===========================================================================
 * `multiple` is what makes the bulk workflow possible without a second
 * component: the source side selects six Mounjaro strengths, the target side
 * selects one companion, and both are the same list with the same keyboard.
 */

export interface ProductPickerProps {
  index: readonly SearchableProduct[];
  /** Selected item codes. One entry unless `multiple`. */
  selected: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  /** Offer products the desk has switched off. Sources may be; targets not. */
  includeInactive?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Rendered under the box when nothing is selected. */
  emptyHint?: string;
  id?: string;
}

/** How many rows the list shows before it scrolls. */
const VISIBLE = 8;

export function ProductPicker({
  index,
  selected,
  onChange,
  multiple = false,
  includeInactive = false,
  placeholder = "Search by name or item code…",
  disabled,
  emptyHint,
  id,
}: ProductPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  /*
   * Not debounced, unlike the Stock tab's.
   *
   * That one debounces because each keystroke would otherwise be a request to
   * the MIS. This filters 28 rows already in memory, so waiting would add
   * latency to buy nothing.
   */
  const matches = useMemo(
    () => searchProducts(index, query, { includeInactive, limit: 50 }),
    [index, query, includeInactive],
  );

  // A new result set invalidates the old highlight; without this, Enter after
  // re-typing picks whatever now sits at a stale index.
  useEffect(() => {
    setActiveIndex(0);
  }, [matches]);

  const chosen = useMemo(() => new Set(selected), [selected]);

  const toggle = (itemCode: string) => {
    if (!multiple) {
      onChange(chosen.has(itemCode) ? [] : [itemCode]);
      return;
    }
    const next = new Set(chosen);
    if (next.has(itemCode)) next.delete(itemCode);
    else next.add(itemCode);
    onChange([...next]);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setQuery("");
      return;
    }
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = matches[activeIndex] ?? matches[0];
      if (picked) toggle(picked.product.itemCode);
    }
  };

  // Keep the highlighted row in view while arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const selectedProducts = index.filter((p) => chosen.has(p.itemCode));

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          className="pl-8"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      {/* What is chosen, and how to un-choose it. Above the list, because with
          six strengths selected the list scrolls and the chips must not. */}
      {selectedProducts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedProducts.map((p) => (
            <span
              key={p.itemCode}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground"
            >
              {p.itemName}
              <button
                type="button"
                aria-label={`Remove ${p.itemName}`}
                className="rounded-full hover:bg-muted"
                disabled={disabled}
                onClick={() => toggle(p.itemCode)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {multiple && selectedProducts.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={disabled}
              onClick={() => onChange([])}
            >
              Clear {selectedProducts.length}
            </Button>
          ) : null}
        </div>
      ) : emptyHint ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : null}

      <div
        ref={listRef}
        className="max-h-[280px] overflow-y-auto rounded-md border border-border"
        style={{ scrollbarGutter: "stable" }}
        role="listbox"
        aria-multiselectable={multiple}
      >
        {matches.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No catalogue product matches “{query}”.
          </p>
        ) : (
          matches.slice(0, Math.max(VISIBLE, matches.length)).map((m, i) => {
            const isChosen = chosen.has(m.product.itemCode);
            return (
              <button
                key={m.product.itemCode}
                type="button"
                data-index={i}
                role="option"
                aria-selected={isChosen}
                disabled={disabled}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => toggle(m.product.itemCode)}
                className={cn(
                  "flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left last:border-0",
                  i === activeIndex && "bg-accent/50",
                  isChosen && "bg-primary/5",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    isChosen
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border",
                  )}
                >
                  {isChosen ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {m.product.itemName}
                    {m.product.active ? "" : " (switched off)"}
                  </span>
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    {m.product.itemCode}
                    {/* Why an alias-code search found this row. Without it the
                        result looks unrelated to what was typed. */}
                    {m.viaAlias ? ` · also known as ${m.viaAlias}` : ""}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
