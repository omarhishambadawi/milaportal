/**
 * An in-memory stand-in for `shams_product_catalog`, for tests.
 *
 * Search now runs in two halves — Postgres narrows 8,484 rows to candidates with
 * a `LIKE` pattern, TypeScript matches and ranks them — and a unit test has no
 * Postgres. The obvious shortcut is to stub `fetchCatalogCandidates` into
 * "return every product" and let the TypeScript half do all the work, but that
 * would test the half that did not change and skip the half that did: whether
 * the patterns `candidateQuery` builds actually retrieve the rows the matcher
 * expects to see.
 *
 * So this implements `LIKE` instead. `evaluateLike` is a faithful reading of
 * Postgres' operator — `%` any run, `_` any one character, `\` escaping all
 * three, anchored at both ends — which makes the fake wrong in the same ways the
 * database would be. A pattern that fails to retrieve a product here fails
 * against the real table too, and a test asserting that a search finds something
 * is then genuinely asserting it end to end.
 *
 * What it does not reproduce is index behaviour, collation or the row cap. Those
 * are properties of the deployment, not of the search's meaning.
 */

import { vi } from "vitest";
import type { ShamsProduct } from "@/lib/shams/types";

/**
 * Postgres `LIKE`, as a regular expression.
 *
 * The escape character is `\`, so the scan is character by character rather than
 * a chain of replaces: a `\%` must become a literal `%` without the `%` that
 * follows being read as syntax, which a naive replace order gets wrong.
 */
function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[++i];
      out += next === undefined ? "\\\\" : next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function evaluateLike(value: string, pattern: string): boolean {
  return likeToRegExp(pattern).test(value);
}

/** The same transformation the real table stores in `search_name`. */
function searchName(itemName: string): string {
  return itemName.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Rows the database would hand back for one candidate query.
 *
 * Exactly `shams_search_product_catalog`: the OR of the two patterns, ordered by
 * item code so a truncated read is deterministic.
 */
export function selectCandidates(
  catalog: readonly ShamsProduct[],
  namePattern: string | null,
  codePattern: string | null,
  maxRows = 2000,
): ShamsProduct[] {
  if (!namePattern && !codePattern) return [];
  return catalog
    .filter(
      (product) =>
        (namePattern !== null && evaluateLike(searchName(product.itemName), namePattern)) ||
        (codePattern !== null && evaluateLike(product.itemCode, codePattern)),
    )
    .sort((a, b) => a.itemCode.localeCompare(b.itemCode))
    .slice(0, maxRows);
}

/**
 * A mock factory for `@/lib/shams/catalog-store.server`.
 *
 * `escapeLikePattern` and the error class come from the real module — the
 * escaping is part of what is under test, and a fake `ShamsCatalogError` would
 * fail every `instanceof` the production code does. Only the database read is
 * replaced.
 *
 * Usage, at the top of a test file:
 *
 *   const catalog = { rows: [] as ShamsProduct[], calls: 0, fail: false };
 *   vi.mock("@/lib/shams/catalog-store.server", () => fakeCatalogStore(catalog));
 */
export function fakeCatalogStore(state: {
  rows: readonly ShamsProduct[];
  /** Incremented per retrieval, so a test can assert the cache did its job. */
  calls?: number;
  /** When set, the read throws as an unreachable catalogue would. */
  fail?: boolean;
  /** The last signal the search passed down, for cancellation assertions. */
  lastSignal?: AbortSignal | undefined;
}) {
  return async () => {
    const actual = await vi.importActual<typeof import("@/lib/shams/catalog-store.server")>(
      "@/lib/shams/catalog-store.server",
    );

    return {
      ...actual,
      fetchCatalogCandidates: vi.fn(
        async (
          query: { namePattern: string | null; codePattern: string | null },
          options: { signal?: AbortSignal; maxRows?: number } = {},
        ) => {
          state.lastSignal = options.signal;
          // Counted after the abort check, so `calls` means "read the
          // catalogue" rather than "was asked to" — which is the thing a
          // cancellation test needs to be able to assert.
          if (options.signal?.aborted) return [];
          state.calls = (state.calls ?? 0) + 1;
          if (state.fail) {
            throw new actual.ShamsCatalogError(
              "catalog_unavailable",
              "The local Shams product catalogue could not be read.",
            );
          }
          return selectCandidates(
            state.rows,
            query.namePattern,
            query.codePattern,
            options.maxRows,
          );
        },
      ),
    };
  };
}
