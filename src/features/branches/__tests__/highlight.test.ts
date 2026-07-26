import { describe, expect, it } from "vitest";
import { matchRanges } from "../highlight";
import { tokenize } from "../search";

/**
 * The contract these tests defend is narrow but load-bearing: a returned range
 * must always be a slice of the *original* string that the user's query actually
 * matched. A wrong offset does not throw — it silently underlines the wrong three
 * characters of an address, in front of an agent reading it to a customer.
 */

/** What the UI does: fold the query the same way the filter does, then mark. */
function marked(text: string, query: string): string[] {
  return matchRanges(text, tokenize(query)).map(([start, end]) => text.slice(start, end));
}

describe("matchRanges", () => {
  it("returns nothing for an empty query or empty text", () => {
    expect(matchRanges("P0021", [])).toEqual([]);
    expect(matchRanges("", ["p0021"])).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(marked("P0021", "p0021")).toEqual(["P0021"]);
    expect(marked("Ahmed Al Qahtani", "AHMED")).toEqual(["Ahmed"]);
  });

  it("marks every occurrence, not just the first", () => {
    expect(marked("Riyadh · East Riyadh", "riyadh")).toEqual(["Riyadh", "Riyadh"]);
  });

  it("marks each token of a multi-word query", () => {
    expect(marked("King Fahd Road, Riyadh", "king riyadh")).toEqual(["King", "Riyadh"]);
  });

  it("merges overlapping token matches rather than nesting them", () => {
    // "ri" and "riy" both hit the same span; two <mark>s there would double-tint.
    expect(marked("Riyadh", "ri riy")).toEqual(["Riy"]);
  });

  it("marks Arabic text at the right offset", () => {
    expect(marked("حي النخيل، الرياض", "الرياض")).toEqual(["الرياض"]);
  });

  it("marks the Arabic portion of a mixed-script string", () => {
    const text = "P0021 — الرياض";
    const [range] = matchRanges(text, tokenize("الرياض"));
    expect(text.slice(range[0], range[1])).toBe("الرياض");
  });

  it("declines to guess when folding changed the string's length", () => {
    // The query finds this branch (the haystack is folded) but the offsets into
    // the original are no longer trustworthy, so nothing is marked.
    expect(matchRanges("مكّة", tokenize("مكه"))).toEqual([]);
  });

  it("never returns a range outside the text", () => {
    const text = "Al Malqa, Riyadh";
    for (const [start, end] of matchRanges(text, tokenize("riyadh malqa"))) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(text.length);
      expect(end).toBeGreaterThan(start);
    }
  });
});
