import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSheet } from "../parse";
import { dedupKeyForRetention } from "../dedup";
import { phoneKeyPart, toSaudiPhone } from "@/lib/phone";

/**
 * Defects found in the production-readiness pass, pinned so they stay fixed.
 *
 * Each block names what was actually wrong rather than the shape of the fix,
 * because the fix is the cheap part: these are all cases where a screen
 * reported one thing and did another, which is the failure mode that survives
 * review.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const GENERATE = "lib/telesales/generate.server.ts";
const REVIEW = "routes/_app.telesales.imports.$id.tsx";
const IMPORT_PAGE = "routes/_app.telesales.import.tsx";
const RELATIONS_HOOK = "features/telesales/hooks/use-product-relations.ts";
const RELATIONS_PAGE = "routes/_app.telesales.relations.tsx";

/* ===================================================================== */
/* 1. A retention run cannot claim a scope it did not honour             */
/* ===================================================================== */

describe("retention generation and its scope", () => {
  /*
   * The defect: the import review screen's Generate called
   * `telesalesGenerate({ leadType: "retention", filters })`. That path raises
   * retention *cycles* from due follow-ups on converted leads -- it reads no
   * source records at all -- so `fetchRetentionCandidates` took no filters and
   * the import id was silently dropped. The run was then stamped with an
   * `import_id` it had never read, while the report above it described the
   * backlog rules, which are a different question entirely.
   */

  it("refuses a filtered retention run rather than ignoring the filter", () => {
    const text = source(GENERATE);
    const branch = text.slice(
      text.indexOf("} else {"),
      text.indexOf("const { created, duplicates"),
    );
    expect(branch).toContain("cannot be filtered");
    expect(branch).toMatch(/if \(input\.filters/);
    expect(branch).toContain("throw new Error");
  });

  it("still takes no filters into the follow-up read, because there are none to take", () => {
    // A cycle has no source record -- cycle 2 has none at all -- so there is
    // nothing for an import id or a branch to narrow.
    const text = source(GENERATE);
    expect(text).toMatch(
      /fetchRetentionCandidates\(\s*supabase,\s*window\.from,\s*window\.to,?\s*\)/,
    );
  });

  it("the review screen seeds the backlog for a retention import", () => {
    /*
     * The operation the report actually describes: import-scoped, no window,
     * and idempotent through the same unique index.
     */
    const page = source(REVIEW);
    expect(page).toContain("telesalesSeedRetentionBacklog");
    expect(page).toMatch(/sourceType === "retention"[\s\S]{0,200}telesalesSeedRetentionBacklog/);
  });

  it("and offers no filters for it, rather than boxes that do nothing", () => {
    const page = source(REVIEW);
    /*
     * Asserted on the branch rather than on the sentence: the copy is prose and
     * prettier rewraps it, so matching the whole string would fail on a reflow
     * rather than on a regression.
     */
    expect(page).toMatch(/sourceType === "retention" \? \(/);
    expect(page).toContain("nothing to filter");
    expect(page).toContain("no date window");
  });
});

/* ===================================================================== */
/* 2. The backlog seeder reads live rows only                            */
/* ===================================================================== */

describe("seeding a retention backlog", () => {
  it("excludes archived source records, as the windowed read does", () => {
    /*
     * Archiving an import takes its rows and its leads out of the desk's view.
     * `fetchWindow` was corrected for this; the seeder beside it was not, and
     * one of two corrected is how the omission returns.
     */
    const text = source(GENERATE);
    const seeder = text.slice(text.indexOf("export async function runRetentionBacklog"));
    expect(seeder).toMatch(
      /\.eq\("import_id", input\.importId\)[\s\S]{0,600}\.is\("archived_at", null\)/,
    );
  });

  it("both source reads in the module filter archived", () => {
    const text = source(GENERATE);
    const reads = text.match(/\.from\("telesales_source_records"\)/g) ?? [];
    const guards = text.match(/\.is\("archived_at", null\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(reads.length);
  });
});

/* ===================================================================== */
/* 3. A bulk apply reports once                                          */
/* ===================================================================== */

describe("applying one cross-sell target to several sources", () => {
  /*
   * The defect, introduced with the bulk workflow: `save.onSuccess` fired a
   * toast and two cache invalidations per call. Six strengths therefore
   * produced six toasts, six sweeps *while the writes were still running*, and
   * then the caller's own summary -- seven messages for one action, over a list
   * refetching underneath them.
   */

  it("the mutation can be told to stay quiet", () => {
    const hook = source(RELATIONS_HOOK);
    expect(hook).toContain("silent?: boolean");
    expect(hook).toMatch(/onSuccess: \(r, vars\) => \{\s*if \(vars\.silent\) return;/);
    expect(hook).toMatch(/onError: \(err, vars\) => \{\s*if \(vars\.silent\) return;/);
  });

  it("the flag never reaches the server, which has no such field", () => {
    const hook = source(RELATIONS_HOOK);
    expect(hook).toMatch(/const \{ silent: _silent, \.\.\.payload \} = input;/);
    expect(hook).toContain("telesalesSaveProductRelation({ data: payload })");
  });

  it("the bulk path is silent and refetches once at the end", () => {
    const page = source(RELATIONS_PAGE);
    expect(page).toMatch(/mutateAsync\(\{[\s\S]{0,200}silent: true/);
    expect(page).toMatch(/mutations\.sweep\(\);[\s\S]{0,80}toast\.success/);
  });

  it("a single save still announces itself", () => {
    // The quiet path is opt-in; one pair saved from the form still reports.
    const page = source(RELATIONS_PAGE);
    const silentCalls = page.match(/silent: true/g) ?? [];
    expect(silentCalls).toHaveLength(1);
  });
});

/* ===================================================================== */
/* 4. Overriding the detected type re-reads the file                     */
/* ===================================================================== */

describe("the source-type override", () => {
  /*
   * The defect: the dropdown set a label and nothing else, so the rows kept the
   * parsing rules of the *detected* type. For Wasfaty that is a different date
   * column -- `primaryDateField` takes the next-dispense or fill date where
   * Cash takes the invoice date -- so a file detected as Cash and switched to
   * Wasfaty was imported with invoice dates standing in for dispense dates, and
   * the today-and-tomorrow window then judged them.
   */

  it("parses the same grid differently depending on the type", () => {
    // The behavioural proof that the override has to re-parse.
    // Carries both date columns and a product, so either pipeline can read it.
    const grid = [
      ["Patient ID", "Prescription No", "InvDate", "Next Dispense Date", "Itm_Cd", "Itm_Name"],
      ["1098765432", "J8952992", "2026-01-02", "2026-09-04", "10611028", "MOUNJARO 5 MG"],
    ];
    const asCash = parseSheet(grid, { sourceType: "cash" });
    const asWasfaty = parseSheet(grid, { sourceType: "wasfaty" });

    expect(asCash.records[0].sourceDate).toBe("2026-01-02");
    expect(asWasfaty.records[0].sourceDate).toBe("2026-09-04");
    // Which is why keeping the old parse would have judged the wrong date.
    expect(asCash.records[0].sourceDate).not.toBe(asWasfaty.records[0].sourceDate);
  });

  it("the import screen re-reads the file when the type is overridden", () => {
    const page = source(IMPORT_PAGE);
    expect(page).toMatch(/onValueChange=\{\(v\) => \{\s*setSourceType\(v\);\s*if \(file\)/);
    expect(page).toContain("forcedType");
  });

  it("and the forced type is not overwritten by detection on the way back", () => {
    // Otherwise the re-parse would immediately undo the operator's choice.
    const page = source(IMPORT_PAGE);
    expect(page).toContain("if (!forcedType && Object.keys(mapping).length === 0)");
  });

  it("keeps the hand-made mapping across the change", () => {
    // The mapping is keyed by field; a field the new type does not use is
    // simply not read, so there is nothing to discard.
    const page = source(IMPORT_PAGE);
    expect(page).toMatch(/readFile\(file, sheetName \|\| undefined, overrides, v\)/);
  });
});

/* ===================================================================== */
/* 5. Two suspicions that turned out not to be defects                   */
/* ===================================================================== */

describe("the retention dedup key is unaffected by an unusable phone", () => {
  /*
   * Checked because the diagnostic does not read `phone_raw` while the backlog
   * seeder passes `phone ?? phoneRaw`, which looked like it could produce two
   * different keys for one row and report an already-generated row as eligible.
   *
   * It cannot. The importer derives `phone` by normalising `phone_raw`, so a
   * row with `phone IS NULL` has a `phone_raw` the normaliser rejected --
   * live data: `9558915199` (too long), `510635393` (not mobile), `ذ` (no
   * digits). `phoneKey` returns "" for all three, so both callers take the
   * anonymous branch and produce the same key.
   */
  const unusable = ["9558915199", "510635393", "ذ", "0000", "m"];

  it("an unusable number contributes nothing to the key either way", () => {
    for (const raw of unusable) {
      expect(phoneKeyPart(toSaudiPhone(raw)), raw).toBe("");
    }
  });

  it("so the seeder's key and the diagnostic's key agree", () => {
    const base = {
      customerRef: "437812",
      customerName: "Ahmed",
      itemCode: "10611028",
      itemName: "MOUNJARO",
      cycleNumber: 1,
      documentNo: "188767",
    };
    for (const raw of unusable) {
      // The seeder passes `phone ?? phoneRaw`; the diagnostic passes phone only.
      expect(dedupKeyForRetention({ ...base, phone: raw })).toBe(
        dedupKeyForRetention({ ...base, phone: null }),
      );
    }
  });
});
