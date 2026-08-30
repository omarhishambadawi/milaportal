/**
 * The Orders search box — what a typed string is actually asked of the database.
 *
 * Two rules carry most of the value, and both exist because the string an agent
 * types is not the string a column stores:
 *
 *   * `display_no` holds `3258`; the screen, the invoice and the WhatsApp
 *     message all say `CC-3258`. Pasting back what the app itself printed found
 *     nothing, which made the single most common search on this page the one
 *     that did not work.
 *   * `agent_name` is joined from `profiles`. There is no column on `orders` to
 *     match a colleague's name against, so it is resolved to ids by the caller.
 *
 * Everything else is pinned here for a duller reason: the disjunction is only
 * indexable while **every** branch has a trigram index behind it
 * (`20260818120000_search_trigram_indexes.sql`), so a column added to this list
 * without one silently turns the whole search into a sequential scan.
 */

import { describe, expect, it } from "vitest";

import { buildSearchOr, normalizeSearchTerm, orderNumberTerm } from "../utils";
import { formatOrderNo } from "@/lib/branches";

describe("orderNumberTerm", () => {
  it("recovers the digits from every spelling of an order number", () => {
    // The bare number, and the two prefixes the app itself prints.
    expect(orderNumberTerm("3258")).toBe("3258");
    expect(orderNumberTerm("CC-3258")).toBe("3258");
    expect(orderNumberTerm("TS-3258")).toBe("3258");
    // What people actually type: one letter, lower case, a hash, a space.
    expect(orderNumberTerm("c-3258")).toBe("3258");
    expect(orderNumberTerm("cc 3258")).toBe("3258");
    expect(orderNumberTerm("#3258")).toBe("3258");
    expect(orderNumberTerm("  ts-3258  ")).toBe("3258");
  });

  it("round-trips whatever formatOrderNo prints", () => {
    // The contract worth stating: anything the app shows as an order number can
    // be pasted straight back into the search box.
    for (const team of ["customer_care", "telesales"]) {
      expect(orderNumberTerm(formatOrderNo(team, "3258"))).toBe("3258");
    }
  });

  it("keeps leading zeros, because the clause is a substring match", () => {
    // Stripping them would stop `03258` matching a display_no of `03258`.
    expect(orderNumberTerm("cc-03258")).toBe("03258");
  });

  it("does not fire for anything that is not only an order number", () => {
    // The narrowness is the point: this adds a `display_no` branch, and an
    // ordinary word must not be turned into one.
    expect(orderNumberTerm("Ahmed")).toBeNull();
    expect(orderNumberTerm("Ahmed 3258")).toBeNull();
    expect(orderNumberTerm("0551234567 extra")).toBeNull();
    expect(orderNumberTerm("")).toBeNull();
    // A four-letter prefix is a word, not a team code.
    expect(orderNumberTerm("часть-3258")).toBeNull();
    expect(orderNumberTerm("abcd-3258")).toBeNull();
  });

  it("survives the normalisation the search box applies first", () => {
    // `normalizeSearchTerm` strips `.`, `,`, `%`, `*`, `(`, `)` — none of which
    // appear in an order number, but the search box runs it unconditionally.
    expect(orderNumberTerm(normalizeSearchTerm(" cc-3258 "))).toBe("3258");
  });
});

describe("buildSearchOr", () => {
  const branches = (term: string, agentIds: string[] = []) =>
    buildSearchOr(term, agentIds).split(",");

  it("searches every indexed text column on the order", () => {
    // One branch per trigram index, and no more: an unindexed column here would
    // cost the planner the BitmapOr and make the whole search a seq scan.
    expect(branches("ahmed")).toEqual([
      "customer_name.ilike.%ahmed%",
      "customer_phone.ilike.%ahmed%",
      "invoice_no.ilike.%ahmed%",
      "display_no.ilike.%ahmed%",
      "branch_no.ilike.%ahmed%",
      "notes.ilike.%ahmed%",
    ]);
  });

  it("adds the stripped order number when the prefix changed the string", () => {
    expect(branches("c-3258")).toContain("display_no.ilike.%3258%");
    expect(branches("CC-3258")).toContain("display_no.ilike.%3258%");
  });

  it("does not add a duplicate branch for a bare number", () => {
    // `3258` is already covered by the plain `display_no` branch; a second
    // identical clause is a second index scan for the same rows.
    const parts = branches("3258");
    expect(parts.filter((p) => p.startsWith("display_no."))).toEqual(["display_no.ilike.%3258%"]);
  });

  it("matches the same order from either spelling", () => {
    // The requirement in one assertion: `3258` and `c-3258` both reach a row
    // whose display_no is `3258`.
    const matches = (term: string, displayNo: string) =>
      branches(term)
        .filter((p) => p.startsWith("display_no.ilike."))
        .some((p) => displayNo.includes(p.slice("display_no.ilike.%".length, -1)));
    expect(matches("3258", "3258")).toBe(true);
    expect(matches("c-3258", "3258")).toBe(true);
    expect(matches("CC-3258", "3258")).toBe(true);
    // And a partial still matches, because every branch is a substring test.
    expect(matches("325", "3258")).toBe(true);
  });

  it("searches by agent through resolved ids, not a join", () => {
    const withAgents = branches("sara", ["11111111-1111-1111-1111-111111111111"]);
    expect(withAgents).toContain("agent_id.in.(11111111-1111-1111-1111-111111111111)");
    // And leaves the clause out entirely when no name matched, rather than
    // emitting an empty `in.()` that matches nothing but still costs a branch.
    expect(branches("sara").some((p) => p.startsWith("agent_id."))).toBe(false);
  });
});
