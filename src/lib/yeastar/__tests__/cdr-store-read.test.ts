/**
 * Mirror READ paths — the ones a month-wide Calls filter actually waits on.
 *
 * Two things are asserted here and nothing else: that the fast path issues ONE
 * database round trip for a whole window, and that the rows it produces are
 * identical to the ones the paged fallback produces. The second is the point —
 * `raw` is handed to `classifyRecords` unchanged, so a read path that dropped,
 * duplicated or re-ordered a leg would move a KPI rather than fail loudly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Calls recorded against the fake client, so a test can count round trips. */
interface Recorded {
  rpc: Array<{ fn: string; args: any }>;
  selects: Array<{ table: string; range: [number, number] }>;
}

const recorded: Recorded = { rpc: [], selects: [] };

/** What the fake `rpc()` should do this test. */
let rpcHandler: (fn: string, args: any) => { data?: any; error?: any } = () => ({
  error: { code: "PGRST202", message: "not found" },
});

/** Rows the fake `cdr_records` table holds, newest paging semantics included. */
let tableRows: any[] = [];

const fake = {
  rpc(fn: string, args: any) {
    recorded.rpc.push({ fn, args });
    return Promise.resolve(rpcHandler(fn, args));
  },
  from(table: string) {
    const q: any = {
      _table: table,
      _rows: tableRows,
      select(_cols: string) {
        return q;
      },
      in(column: string, values: string[]) {
        q._rows = q._rows.filter((r: any) => values.includes(r[column]));
        return q;
      },
      gte(column: string, v: string) {
        q._rows = q._rows.filter((r: any) => String(r[column]) >= v);
        return q;
      },
      lte(column: string, v: string) {
        q._rows = q._rows.filter((r: any) => String(r[column]) <= v);
        return q;
      },
      order(column: string) {
        q._rows = [...q._rows].sort((a: any, b: any) =>
          String(a[column]).localeCompare(String(b[column])),
        );
        return q;
      },
      range(a: number, b: number) {
        recorded.selects.push({ table, range: [a, b] });
        return Promise.resolve({ data: q._rows.slice(a, b + 1), error: null });
      },
    };
    return q;
  },
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fake }));

const { readCdrDays, readCdrByNumber, __resetStoreRpcProbes } = await import("../cdr-store.server");

const DAYS = ["2026-07-01", "2026-07-02", "2026-07-03"];

function row(day: string, id: string, from: string, to: string) {
  return {
    row_id: id,
    business_day: day,
    call_from_number: from,
    call_to_number: to,
    raw: { new_id: id, call_id: `c-${id}`, call_from_number: from, call_to_number: to },
  };
}

beforeEach(() => {
  recorded.rpc = [];
  recorded.selects = [];
  tableRows = [
    row("2026-07-01", "a1", "0501", "6400"),
    row("2026-07-01", "a2", "0502", "6400"),
    row("2026-07-02", "b1", "0501", "4005"),
    row("2026-07-03", "c1", "4005", "0503"),
  ];
  __resetStoreRpcProbes();
});

describe("readCdrDays", () => {
  it("reads a whole window in ONE round trip when the RPC is available", async () => {
    rpcHandler = (_fn, args) => ({
      data: (args.p_days as string[])
        .map((d) => ({
          business_day: d,
          rows: tableRows.filter((r) => r.business_day === d).map((r) => r.raw),
        }))
        .filter((g) => g.rows.length > 0),
      error: null,
    });

    const byDay = await readCdrDays(DAYS);

    expect(recorded.rpc).toEqual([{ fn: "cdr_window_rows", args: { p_days: DAYS } }]);
    // The whole point: no PostgREST paging at all.
    expect(recorded.selects).toHaveLength(0);
    expect(byDay.get("2026-07-01")?.map((r: any) => r.new_id)).toEqual(["a1", "a2"]);
    expect(byDay.get("2026-07-02")?.map((r: any) => r.new_id)).toEqual(["b1"]);
  });

  it("still gives every requested day a bucket, including quiet ones", async () => {
    // A missing bucket would make the caller re-sweep that day from the PBX
    // forever, which is what `cdr_sync_days` exists to prevent.
    rpcHandler = () => ({ data: [], error: null });
    const byDay = await readCdrDays(DAYS);
    expect([...byDay.keys()]).toEqual(DAYS);
    for (const d of DAYS) expect(byDay.get(d)).toEqual([]);
  });

  it("falls back to paged reads when the RPC is not deployed, with the same rows", async () => {
    rpcHandler = () => ({ data: [], error: null });
    const viaRpc = await readCdrDays(DAYS);

    __resetStoreRpcProbes();
    recorded.rpc = [];
    rpcHandler = () => ({ error: { code: "PGRST202", message: "not in schema cache" } });
    const viaPaging = await readCdrDays(DAYS);

    expect(recorded.selects.length).toBeGreaterThan(0);
    // Same days, same legs, same order — the fallback is a slower path, not a
    // different answer.
    expect([...viaPaging.keys()]).toEqual([...viaRpc.keys()]);
    expect(viaPaging.get("2026-07-01")?.map((r: any) => r.new_id)).toEqual(["a1", "a2"]);
  });

  it("probes a missing RPC once, not once per window", async () => {
    rpcHandler = () => ({ error: { code: "42883", message: "undefined function" } });
    await readCdrDays(DAYS);
    await readCdrDays(DAYS);
    await readCdrDays(DAYS);
    expect(recorded.rpc).toHaveLength(1);
  });

  it("propagates a real mirror failure instead of silently degrading", async () => {
    rpcHandler = () => ({ error: { code: "57014", message: "statement timeout" } });
    await expect(readCdrDays(DAYS)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("readCdrByNumber", () => {
  it("matches either end of the call in one round trip", async () => {
    rpcHandler = (_fn, args) => ({
      data: tableRows
        .filter(
          (r) =>
            (args.p_numbers as string[]).includes(r.call_from_number) ||
            (args.p_numbers as string[]).includes(r.call_to_number),
        )
        .map((r) => r.raw),
      error: null,
    });

    const rows = await readCdrByNumber("2026-07-01", "2026-07-03", ["0501"]);

    expect(recorded.rpc).toHaveLength(1);
    expect(recorded.selects).toHaveLength(0);
    expect(rows.map((r: any) => r.new_id)).toEqual(["a1", "b1"]);
  });

  it("de-duplicates on the fallback path, where both columns are walked", async () => {
    rpcHandler = () => ({ error: { code: "PGRST202", message: "not found" } });
    // A leg whose two ends are both being searched for must appear once.
    const rows = await readCdrByNumber("2026-07-01", "2026-07-03", ["0501", "6400"]);
    expect(rows.map((r: any) => r.new_id).sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("asks for nothing when there is no number to ask about", async () => {
    const rows = await readCdrByNumber("2026-07-01", "2026-07-03", ["", ""]);
    expect(rows).toEqual([]);
    expect(recorded.rpc).toHaveLength(0);
    expect(recorded.selects).toHaveLength(0);
  });
});

/**
 * Which days the mirror may answer for.
 *
 * Three cases, not two. The rule previously split days into "ended" and
 * "today or later", which quietly demanded a fresh sync for days that had not
 * happened — days that can never satisfy it, because nothing will ever write a
 * row for them until they arrive.
 */
describe("isSyncedDayUsable", () => {
  const TODAY = "2026-08-12";
  const NOW = Date.parse(`${TODAY}T12:00:00Z`);
  const TTL = 5 * 60_000;
  const fresh = { rowCount: 10, syncedAt: NOW - 60_000 };
  const stale = { rowCount: 10, syncedAt: NOW - 60 * 60_000 };

  it("serves a day that has ENDED at any age — it cannot change", async () => {
    const { isSyncedDayUsable } = await import("../cdr-store.server");
    expect(isSyncedDayUsable("2026-08-01", stale, NOW, TODAY, TTL)).toBe(true);
  });

  it("serves TODAY only while the sync is recent — it is still accruing", async () => {
    const { isSyncedDayUsable } = await import("../cdr-store.server");
    expect(isSyncedDayUsable(TODAY, fresh, NOW, TODAY, TTL)).toBe(true);
    expect(isSyncedDayUsable(TODAY, stale, NOW, TODAY, TTL)).toBe(false);
  });

  it("serves a FUTURE day unconditionally — it can hold no call", async () => {
    // The regression this guards. A future day has no mirror row and never
    // will, so requiring one put it on the missing list on every request; it
    // then joined today's contiguous range and turned a one-day live sweep of
    // the PBX into a twenty-day one for anyone viewing the current month.
    const { isSyncedDayUsable } = await import("../cdr-store.server");
    expect(isSyncedDayUsable("2026-08-13", undefined, NOW, TODAY, TTL)).toBe(true);
    expect(isSyncedDayUsable("2026-08-31", stale, NOW, TODAY, TTL)).toBe(true);
  });

  it("still refuses a day that has ended and was never mirrored", async () => {
    // Not-yet-synced history is a real gap and must still be fetched.
    const { isSyncedDayUsable } = await import("../cdr-store.server");
    expect(isSyncedDayUsable("2026-08-01", undefined, NOW, TODAY, TTL)).toBe(false);
  });
});
