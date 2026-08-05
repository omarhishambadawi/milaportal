/**
 * Call Lookup matching rules.
 *
 * These two functions are the correctness boundary of the fast lookup path.
 * `numberVariants` decides what we ASK the PBX for; `matchKey` decides what we
 * ACCEPT from it. If the variant list misses a spelling the PBX uses, a real
 * call history is reported as "no calls" — the one failure this page must not
 * have — so the variants are pinned here against the forms observed on the live
 * box (see `docs/yeastar/samples/cdr-search.json`).
 */
import { describe, it, expect } from "vitest";
import {
  digitsOf,
  matchKey,
  numberVariants,
  LOOKUP_SUFFIX_DIGITS,
} from "@/lib/yeastar/lookup-match";

describe("digitsOf", () => {
  it("strips every non-digit", () => {
    expect(digitsOf("+966 50 123 4567")).toBe("966501234567");
    expect(digitsOf("(050) 123-4567")).toBe("0501234567");
    expect(digitsOf("")).toBe("");
  });
});

describe("matchKey", () => {
  it("collapses every recorded spelling of one subscriber to the same key", () => {
    const forms = ["0501234567", "501234567", "966501234567", "+966501234567", "00966501234567"];
    const keys = new Set(forms.map(matchKey));
    expect(keys).toEqual(new Set(["501234567"]));
  });

  it("passes short internal numbers through verbatim", () => {
    // An extension must stay comparable to itself — padding or prefixing it
    // would make searching for agent 4005 match nothing.
    expect(matchKey("4005")).toBe("4005");
    expect(matchKey("6400")).toBe("6400");
  });

  it("is empty for a missing number rather than throwing", () => {
    expect(matchKey(null)).toBe("");
    expect(matchKey(undefined)).toBe("");
  });
});

describe("numberVariants", () => {
  it("covers every spelling the PBX files a KSA subscriber under", () => {
    const v = numberVariants("0501234567");
    for (const form of [
      "0501234567",
      "501234567",
      "966501234567",
      "+966501234567",
      "00966501234567",
    ]) {
      expect(v).toContain(form);
    }
  });

  it("produces the same variant set whichever spelling was typed", () => {
    const fromLocal = new Set(numberVariants("0501234567"));
    const fromIntl = new Set(numberVariants("+966501234567"));
    // The typed string itself is always included, so compare the generated core.
    for (const form of ["0501234567", "501234567", "966501234567", "+966501234567"]) {
      expect(fromLocal.has(form)).toBe(true);
      expect(fromIntl.has(form)).toBe(true);
    }
  });

  it("leads with the local trunk-zero form — the one the live PBX records", () => {
    // The first variant is also the probe that decides whether the firmware
    // honours the filter, so it must be the most likely to return rows.
    expect(numberVariants("+966501234567")[0]).toBe("0501234567");
  });

  it("never prefixes a short internal number", () => {
    const v = numberVariants("4005");
    expect(v).toEqual(["4005"]);
    expect(v.some((x) => x.includes("966"))).toBe(false);
  });

  it("emits no duplicates and no empties", () => {
    for (const input of ["0501234567", "4005", "  0501234567  ", "+966501234567"]) {
      const v = numberVariants(input);
      expect(new Set(v).size).toBe(v.length);
      expect(v.every(Boolean)).toBe(true);
    }
  });

  it("keys off the trailing suffix, so formatting noise is irrelevant", () => {
    expect(new Set(numberVariants("050 123 4567"))).toEqual(
      new Set(numberVariants("0501234567").concat("050 123 4567")),
    );
  });

  it("uses exactly the documented suffix length", () => {
    expect(LOOKUP_SUFFIX_DIGITS).toBe(9);
    expect(matchKey("966501234567")).toHaveLength(LOOKUP_SUFFIX_DIGITS);
  });
});
