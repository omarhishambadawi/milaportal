/**
 * Targeted per-number CDR retrieval.
 *
 * `fetchCdrByNumber` is what turns Call Lookup from a full-window sweep into a
 * point query, so what matters here is that it (a) actually pushes the number to
 * the PBX, (b) asks both ends of the call, (c) keeps every LEG of a matching
 * call so the normalizer can still see who answered, and (d) notices when the
 * firmware ignores the filter instead of fanning out N full sweeps.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const yeastarFetch = vi.fn();
vi.mock("../client.server", () => ({
  yeastarFetch: (...args: unknown[]) => yeastarFetch(...args),
}));

const { fetchCdrByNumber } = await import("../cdr.server");

/** 2026-08-01 12:00 UTC — comfortably inside the window used below. */
const T = Math.floor(Date.UTC(2026, 7, 1, 12, 0, 0) / 1000);

function row(over: Record<string, unknown> = {}) {
  return {
    new_id: String(Math.random()),
    call_id: "call-1",
    timestamp: T,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0501234567",
    call_to_number: "6400",
    ...over,
  };
}

/** Answer every query with `rows`, recording the query params seen. */
function respond(rows: unknown[]) {
  yeastarFetch.mockImplementation(async () => ({
    httpStatus: 200,
    json: { errcode: 0, errmsg: "SUCCESS", total_number: rows.length, data: rows },
    body: "",
  }));
}

const WINDOW = { from: "2026-08-01", to: "2026-08-01" };

beforeEach(() => {
  yeastarFetch.mockReset();
});

describe("fetchCdrByNumber", () => {
  it("pushes the number to the PBX on both call_from and call_to", async () => {
    respond([row()]);
    await fetchCdrByNumber({ ...WINDOW, variants: ["0501234567"] });

    const params = yeastarFetch.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(params.some((p) => p.call_from === "0501234567")).toBe(true);
    expect(params.some((p) => p.call_to === "0501234567")).toBe(true);
    // The window is still pushed down too — never a full-history query.
    expect(params.every((p) => typeof p.start_time === "number")).toBe(true);
    expect(params.every((p) => typeof p.end_time === "number")).toBe(true);
    expect(yeastarFetch.mock.calls.every((c) => c[0] === "/openapi/v1.0/cdr/search")).toBe(true);
  });

  it("asks for every spelling it is given", async () => {
    respond([row()]);
    await fetchCdrByNumber({ ...WINDOW, variants: ["0501234567", "+966501234567"] });

    const asked = new Set(
      yeastarFetch.mock.calls.flatMap((c) => {
        const p = c[1] as Record<string, unknown>;
        return [p.call_from, p.call_to].filter(Boolean) as string[];
      }),
    );
    expect(asked).toEqual(new Set(["0501234567", "+966501234567"]));
  });

  it("keeps every leg of a call — de-dup is per ROW, not per call", async () => {
    // One six-leg inbound call, exactly as the live samples record it: every leg
    // shares call_id AND call_from. De-duplicating on call_id here would drop
    // the agent leg and the lookup would report that nobody answered.
    const legs = ["6200", "6201", "6203", "6400", "4005", "Satisfaction Survey"].map((to, i) =>
      row({ new_id: `leg-${i}`, call_to_number: to }),
    );
    respond(legs);

    const res = await fetchCdrByNumber({ ...WINDOW, variants: ["0501234567"] });

    expect(res.records).toHaveLength(6);
    expect(res.records.map((r) => r.call_to_number)).toContain("4005");
    expect(new Set(res.records.map((r) => r.call_id))).toEqual(new Set(["call-1"]));
  });

  it("de-duplicates the same row arriving from two queries", async () => {
    // call_from and call_to queries can both return the same leg.
    respond([row({ new_id: "same-leg" })]);
    const res = await fetchCdrByNumber({ ...WINDOW, variants: ["0501234567"] });
    expect(res.records).toHaveLength(1);
  });

  it("drops rows outside the window even if the PBX returns them", async () => {
    respond([row({ new_id: "in" }), row({ new_id: "out", timestamp: T - 86_400 * 30 })]);
    const res = await fetchCdrByNumber({ ...WINDOW, variants: ["0501234567"] });
    expect(res.records.map((r) => r.new_id)).toEqual(["in"]);
  });

  it("stops after the probe when the firmware ignores the number filter", async () => {
    // A full page back for one subscriber means the filter was not applied.
    // Fanning out would then cost one full sweep per variant.
    respond(Array.from({ length: 5 }, (_, i) => row({ new_id: `r${i}` })));
    const res = await fetchCdrByNumber({
      ...WINDOW,
      variants: ["0501234567", "+966501234567", "966501234567"],
      pageSize: 5,
    });

    expect(res.filterEffective).toBe(false);
    expect(res.queriesIssued).toBe(1);
  });

  it("reports the filter as effective for a normal, small answer", async () => {
    respond([row()]);
    const res = await fetchCdrByNumber({ ...WINDOW, variants: ["0501234567"] });
    expect(res.filterEffective).toBe(true);
    expect(res.queriesIssued).toBe(2); // call_from + call_to
  });

  it("issues nothing when there is no variant to search for", async () => {
    respond([row()]);
    const res = await fetchCdrByNumber({ ...WINDOW, variants: [] });
    expect(res.queriesIssued).toBe(0);
    expect(res.records).toEqual([]);
    expect(yeastarFetch).not.toHaveBeenCalled();
  });
});
