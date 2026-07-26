import { foldText } from "./normalize";

/**
 * Marking the part of a card that answered the search.
 *
 * The directory searches a folded haystack (see `decorate`) but the card renders
 * the original text, so the two cannot simply share an offset. Rather than keep
 * a per-character index map — which every field of every visible card would have
 * to rebuild on every keystroke — this exploits a property of `foldText`: it only
 * ever *removes* characters (harakat, tatweel, collapsed whitespace) or
 * substitutes one for exactly one (أ→ا, ة→ه, Arabic-Indic digits). So when the
 * folded string has the same length as the original, nothing was removed, every
 * remaining transformation was 1:1, and folded offsets address the original
 * string exactly.
 *
 * When the lengths differ the offsets are untrustworthy, and highlighting the
 * wrong slice of an address is worse than not highlighting at all — so that case
 * falls back to a literal case-insensitive scan. The practical cost is that
 * typing "مكه" still finds the branch in "مكة" (the search is folded) but does
 * not underline it. A missing highlight is invisible; a misplaced one is a bug.
 */

/** Half-open `[start, end)` offsets into the original string. */
export type MatchRange = readonly [number, number];

/**
 * Where each query token appears in `text`, merged and in order.
 *
 * @param tokens Already folded and lowercased — the same tokens the filter used.
 */
export function matchRanges(text: string, tokens: readonly string[]): MatchRange[] {
  if (!text || tokens.length === 0) return [];

  const folded = foldText(text);
  const aligned = folded.length === text.length;
  const haystack = aligned ? folded : text.toLowerCase();

  const found: [number, number][] = [];
  for (const token of tokens) {
    if (!token) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(token, from);
      if (at < 0) break;
      found.push([at, at + token.length]);
      from = at + token.length;
    }
  }
  if (found.length === 0) return [];

  // Tokens overlap constantly in practice — "ri riyadh" is two tokens over one
  // span — and nested <mark>s render as a double-tinted box.
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [found[0]];
  for (const range of found.slice(1)) {
    const last = merged[merged.length - 1];
    if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/**
 * `text` with every query match wrapped in a `<mark>`.
 *
 * Renders a bare fragment when nothing matches, so a card with no match costs
 * one extra function call and no extra DOM.
 */
export function Highlight({ text, tokens }: { text: string; tokens: readonly string[] }) {
  const ranges = matchRanges(text, tokens);
  if (ranges.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={index}
        className="rounded-[3px] bg-[var(--attention)]/25 px-px font-semibold text-foreground"
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <>{parts}</>;
}
