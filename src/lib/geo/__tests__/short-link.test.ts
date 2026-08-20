import { describe, expect, it, vi } from "vitest";
import { resolveMapLink, ShortLinkError } from "../short-link.server";

/** A real branch coordinate from the master workbook. */
const HAZM = { lat: 24.5372826, lng: 46.6456098 };

/** A fetch that answers each URL with a redirect, or with a dead end. */
function redirector(chain: Record<string, string>) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    const location = chain[href];
    return {
      headers: { get: (name: string) => (name === "location" ? (location ?? null) : null) },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const PLACE_URL =
  `https://www.google.com/maps/place/Ghodaf+Pharmacy/@${HAZM.lat},${HAZM.lng},17z/` +
  `data=!3m1!4b1!4m6!3m5!8m2!3d${HAZM.lat}!4d${HAZM.lng}`;

describe("resolveMapLink", () => {
  it("follows a shortener to the coordinates behind it", async () => {
    const fetchImpl = redirector({ "https://maps.app.goo.gl/aBcDeF": PLACE_URL });
    const result = await resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchImpl);

    expect(result.point).toEqual(HAZM);
    expect(result.url).toBe(PLACE_URL);
  });

  it("follows more than one hop", async () => {
    const fetchImpl = redirector({
      "https://goo.gl/maps/aBcDeF": "https://maps.app.goo.gl/xYz",
      "https://maps.app.goo.gl/xYz": PLACE_URL,
    });
    const result = await resolveMapLink("https://goo.gl/maps/aBcDeF", fetchImpl);
    expect(result.point).toEqual(HAZM);
  });

  it("does not fetch at all when the link already carries a location", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await resolveMapLink(PLACE_URL, fetchImpl);

    expect(result.point).toEqual(HAZM);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the final URL when the chain ends without coordinates", async () => {
    const named = "https://www.google.com/maps/place/Ghodaf+Pharmacy";
    const fetchImpl = redirector({ "https://maps.app.goo.gl/aBcDeF": named });
    const result = await resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchImpl);

    expect(result.point).toBeNull();
    expect(result.url).toBe(named);
  });

  it("reports a swapped pair rather than storing it", async () => {
    const swapped = `https://www.google.com/maps/@${HAZM.lng},${HAZM.lat},15z`;
    const fetchImpl = redirector({ "https://maps.app.goo.gl/aBcDeF": swapped });
    const result = await resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchImpl);

    expect(result.point).toBeNull();
    expect(result.outOfRange).toBe(true);
  });

  /* ---- the SSRF surface ---- */

  it("refuses a host that is not Google, without fetching it", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const url of [
      "https://evil.example.com/",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/",
      "https://goo.gl.evil.example.com/",
    ]) {
      await expect(resolveMapLink(url, fetchImpl)).rejects.toMatchObject({
        kind: "not_allowed",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a non-https scheme", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const url of ["http://maps.app.goo.gl/aBcDeF", "file:///etc/passwd"]) {
      await expect(resolveMapLink(url, fetchImpl)).rejects.toMatchObject({
        kind: "not_allowed",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a redirect that leaves the allow-list", async () => {
    // The important case: the *first* host is fine, and the hop is what tries
    // to walk us somewhere else.
    const fetchImpl = redirector({
      "https://maps.app.goo.gl/aBcDeF": "https://169.254.169.254/latest/meta-data/",
    });
    await expect(resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchImpl)).rejects.toMatchObject(
      { kind: "not_allowed" },
    );
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    const fetchImpl = redirector({
      "https://maps.app.goo.gl/a": "https://maps.app.goo.gl/b",
      "https://maps.app.goo.gl/b": "https://maps.app.goo.gl/a",
    });
    await expect(resolveMapLink("https://maps.app.goo.gl/a", fetchImpl)).rejects.toBeInstanceOf(
      ShortLinkError,
    );
  });

  it("never reads the response body", async () => {
    // A body that is never read cannot be parsed, logged, or reflected.
    const text = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      headers: { get: () => PLACE_URL },
      text,
      json: text,
    })) as unknown as typeof fetch;

    await resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchImpl);
    expect(text).not.toHaveBeenCalled();
  });
});
