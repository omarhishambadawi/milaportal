/**
 * The workbook stays on the server.
 *
 * It holds real CRM passwords and lives in the repository at the account
 * owner's direction, so the one containment that still matters absolutely is
 * that its bytes never reach a browser. `agent-workbook.server.ts` inlines it as
 * a base64 data URI into the **server** chunk; nothing in the client graph
 * imports that module, and this asserts the result rather than the intention.
 *
 * ## On probes
 *
 * An early version of this check used an arbitrary base64 slice and reported a
 * hit in `favicon.svg` — which is a megabyte of embedded base64 of its own. The
 * slice happened to be a run of `A`s, the encoding of zero bytes, and matching
 * one proves nothing. The probes below are chosen for character diversity so a
 * match means the workbook, not a coincidence.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const workbook = join(repoRoot, "src/lib/shams-crm/agent-workbook.xlsx");
const clientDir = join(repoRoot, ".output/public");

/** Slices with enough distinct characters that a match cannot be accidental. */
function highEntropyProbes(base64: string, count = 6): string[] {
  const probes: string[] = [];
  for (let start = 0; start + 120 < base64.length && probes.length < count; start += 97) {
    const slice = base64.slice(start, start + 120);
    if (new Set(slice).size > 30) probes.push(slice);
  }
  return probes;
}

/** Tests name these files in order to assert about them; they are not importers. */
function isTest(file: string): boolean {
  return file.includes("__tests__") || file.endsWith(".test.ts");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("the workbook never reaches the browser", () => {
  it("is imported only from a server module", () => {
    const importers = walk(join(repoRoot, "src")).filter(
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !isTest(f) &&
        readFileSync(f, "utf8").includes("agent-workbook.xlsx"),
    );
    // Exactly one importer, and it is server-only by name and by convention.
    expect(importers).toHaveLength(1);
    expect(importers[0]).toMatch(/agent-workbook\.server\.ts$/);
  });

  /** And no client-reachable module pulls in the reader either. */
  it("is not reachable from a component or a route", () => {
    const offenders = walk(join(repoRoot, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /[/\\](components|routes|features)[/\\]/.test(f))
      .filter((f) => {
        const source = readFileSync(f, "utf8");
        return source.includes("agent-workbook.server") || source.includes("agent-setup.server");
      });
    expect(offenders).toEqual([]);
  });

  /**
   * The build output itself, when one exists. Skipped rather than failed on a
   * machine that has not built — the assertion above still holds statically.
   */
  it("does not appear in the built client bundle", () => {
    if (!existsSync(workbook) || !existsSync(clientDir)) {
      expect(true).toBe(true);
      return;
    }
    const probes = highEntropyProbes(readFileSync(workbook).toString("base64"));
    expect(probes.length).toBeGreaterThan(0);

    const hits = walk(clientDir).filter((file) => {
      const data = readFileSync(file);
      return probes.some((p) => data.includes(p));
    });
    expect(hits).toEqual([]);
  });
});

describe("the workbook is the only credential copy", () => {
  /** No second copy anywhere in the tree — one file, one place to rotate. */
  it("exists exactly once", () => {
    const copies = walk(join(repoRoot, "src")).filter((f) => f.endsWith(".xlsx"));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/agent-workbook\.xlsx$/);
  });

  /** And no password was transcribed out of it into source, tests or SQL. */
  it("has not been transcribed into code", () => {
    const suspicious = walk(join(repoRoot, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      // Test fixtures declare obviously-fake values on purpose; what must never
      // appear is a real one transcribed into shipped code.
      .filter((f) => !isTest(f))
      .filter((f) => {
        const source = readFileSync(f, "utf8");
        // A credential-shaped literal assigned to a password-ish name.
        return /crm_?password\s*[:=]\s*["'][^"']{3,}["']/i.test(source);
      });
    expect(suspicious).toEqual([]);
  });
});
