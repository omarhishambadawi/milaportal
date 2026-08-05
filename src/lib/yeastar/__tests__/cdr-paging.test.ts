/**
 * CDR pagination.
 *
 * A multi-page window used to be fetched one blocking round-trip at a time,
 * discovering each page only after the previous one landed. Page 1 already
 * carries `total_number`, so the rest are known up front and can go together.
 *
 * The risk in doing that is ORDER: the request asks for `sort_by=time&
 * order_by=asc`, and concatenating pages out of order would silently scramble
 * the window. That is what most of these tests are about.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const yeastarFetch = vi.fn();
vi.mock("../client.server", () => ({
  yeastarFetch: (...args: unknown[]) => yeastarFetch(...args),
}));

const { fetchCdrRange } = await import("../cdr.server");

const BASE = Math.floor(Date.parse("2026-06-15T09:00:00Z") / 1000);

/** `total` rows spread over pages of `pageSize`, each row uniquely numbered. */
function paged(total: number, pageSize: number, opts: { concurrentPeak?: number[] } = {}) {
  let inFlight = 0;
  yeastarFetch.mockImplementation(async (_path: string, query: Record<string, number>) => {
    inFlight++;
    opts.concurrentPeak?.push(inFlight);
    // Yield so genuinely-parallel calls overlap before any resolves.
    await new Promise((r) => setTimeout(r, 5));
    const page = query.page;
    const start = (page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - start));
    const data = Array.from({ length: count }, (_, i) => ({
      new_id: `row-${start + i}`,
      call_id: `call-${start + i}`,
      timestamp: BASE + start + i,
      call_type: "Inbound",
    }));
    inFlight--;
    return {
      httpStatus: 200,
      json: { errcode: 0, errmsg: "SUCCESS", total_number: total, data },
      body: "",
    };
  });
}

const WINDOW = { from: "2026-06-15", to: "2026-06-15" };

beforeEach(() => {
  yeastarFetch.mockReset();
});

describe("fetchCdrRange paging", () => {
  it("returns every row across several pages", async () => {
    paged(2_500, 1_000);
    const res = await fetchCdrRange({ ...WINDOW, pageSize: 1_000 });
    expect(res.records).toHaveLength(2_500);
  });

  it("keeps pages in order, so the requested time sort survives", async () => {
    paged(2_500, 1_000);
    const res = await fetchCdrRange({ ...WINDOW, pageSize: 1_000 });
    expect(res.records.map((r) => r.new_id)).toEqual(
      Array.from({ length: 2_500 }, (_, i) => `row-${i}`),
    );
    // Timestamps ascend monotonically — the property the sort exists to give.
    const ts = res.records.map((r) => r.timestamp as number);
    expect(ts.every((t, i) => i === 0 || t >= ts[i - 1]!)).toBe(true);
  });

  it("fetches the pages after the first CONCURRENTLY", async () => {
    const peak: number[] = [];
    paged(5_000, 1_000, { concurrentPeak: peak });
    await fetchCdrRange({ ...WINDOW, pageSize: 1_000 });
    // Page 1 is the probe and is alone; pages 2..5 overlap.
    expect(Math.max(...peak)).toBeGreaterThan(1);
  });

  it("asks for each page exactly once", async () => {
    paged(5_000, 1_000);
    await fetchCdrRange({ ...WINDOW, pageSize: 1_000 });
    const pages = yeastarFetch.mock.calls.map((c) => (c[1] as { page: number }).page).sort();
    expect(pages).toEqual([1, 2, 3, 4, 5]);
  });

  it("makes a single request when everything fits on one page", async () => {
    paged(120, 1_000);
    const res = await fetchCdrRange({ ...WINDOW, pageSize: 1_000 });
    expect(yeastarFetch).toHaveBeenCalledTimes(1);
    expect(res.records).toHaveLength(120);
  });

  it("makes a single request when the total exactly fills one page", async () => {
    // The boundary the old loop got right by accident and a page-count
    // calculation can get wrong: 1000 of 1000 is not "there must be more".
    paged(1_000, 1_000);
    const res = await fetchCdrRange({ ...WINDOW, pageSize: 1_000 });
    expect(res.records).toHaveLength(1_000);
    expect(yeastarFetch).toHaveBeenCalledTimes(1);
  });

  it("still terminates when the PBX reports no total", async () => {
    // Without `total_number` there is nothing to parallelize against, so it
    // falls back to discovering pages one at a time — and must still stop.
    let page = 0;
    yeastarFetch.mockImplementation(async (_p: string, q: Record<string, number>) => {
      page = q.page;
      const count = page < 3 ? 1_000 : 10;
      return {
        httpStatus: 200,
        json: {
          errcode: 0,
          data: Array.from({ length: count }, (_, i) => ({
            new_id: `p${page}-${i}`,
            timestamp: BASE + i,
          })),
        },
        body: "",
      };
    });
    const res = await fetchCdrRange({ ...WINDOW, pageSize: 1_000 });
    expect(res.records).toHaveLength(2_010);
    expect(page).toBe(3);
  });

  it("propagates a mid-window page failure rather than returning a short window", async () => {
    // Silently returning pages 1 and 3 would understate every KPI on the page.
    paged(3_000, 1_000);
    const good = yeastarFetch.getMockImplementation()!;
    yeastarFetch.mockImplementation(async (p: string, q: Record<string, number>) => {
      if (q.page === 2) return { httpStatus: 500, json: null, body: "boom" };
      return good(p, q);
    });
    await expect(fetchCdrRange({ ...WINDOW, pageSize: 1_000 })).rejects.toThrow(/500/);
  });
});
