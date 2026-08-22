/**
 * Reading a customer's Google Maps link.
 *
 * Every request is mocked. Nothing here contacts Google, a shortener, or any
 * real customer link — the fetch seam exists precisely so this stays true.
 *
 * The tests that matter most are the refusals. This function takes a URL from an
 * untrusted paste and fetches it, which is the shape of every server-side
 * request forgery ever written; the allow-list, the per-hop re-check and the
 * unread body are the things that stop it being one.
 */

import { describe, expect, it, vi } from "vitest";
import { parseMapsUrl } from "@/lib/geo/maps-url";
import { resolveMapLink, ShortLinkError } from "@/lib/geo/short-link.server";

/** A `Location`-bearing redirect, as the shortener sends. */
function redirect(to: string) {
  return { headers: new Headers({ location: to }) } as unknown as Response;
}
/** The end of a chain. */
function terminal() {
  return { headers: new Headers() } as unknown as Response;
}

const RIYADH = "https://www.google.com/maps/place/X/@24.7136,46.6753,17z/data=!3d24.7136!4d46.6753";

describe("parseMapsUrl", () => {
  it("reads the dropped pin from a /data= blob", () => {
    const r = parseMapsUrl(RIYADH);
    expect(r.point).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it("reads a coordinate-bearing query parameter", () => {
    const r = parseMapsUrl("https://www.google.com/maps?q=24.7136,46.6753");
    expect(r.point).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it("falls back to the camera when there is no pin", () => {
    const r = parseMapsUrl("https://www.google.com/maps/@24.7136,46.6753,15z");
    expect(r.point).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it("reads a geo: link from a phone's share sheet", () => {
    expect(parseMapsUrl("geo:24.7136,46.6753").point).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it("accepts a bare pasted pair", () => {
    expect(parseMapsUrl("24.7136, 46.6753").point).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it("flags a short link as needing resolution rather than as empty", () => {
    const r = parseMapsUrl("https://maps.app.goo.gl/aBcDeF");
    expect(r).toMatchObject({ point: null, needsResolution: true });
  });

  it("returns nothing for a non-Google host", () => {
    expect(parseMapsUrl("https://example.com/maps?q=24.7,46.6")).toMatchObject({
      point: null,
      needsResolution: false,
    });
  });

  it("reports a swapped pair as out of range rather than as a location", () => {
    // 46.6 N, 24.7 E is in Europe, not Riyadh.
    const r = parseMapsUrl("https://www.google.com/maps?q=46.6753,24.7136");
    expect(r.point).toBeNull();
    expect(r.outOfRange).toBe(true);
  });

  it("invents nothing for a link that only names a place", () => {
    const r = parseMapsUrl("https://www.google.com/maps/place/Some+Pharmacy");
    expect(r.point).toBeNull();
    expect(r.outOfRange).toBe(false);
  });
});

/**
 * The shapes an agent actually pastes.
 *
 * Every case below was observed failing before this suite existed: a full Maps
 * URL and a `maps.app.goo.gl` link both reported "carries no coordinates", and
 * the reason was never the coordinates — it was that the text arrived without a
 * scheme, or carried its pair in a form the pair matcher did not know.
 */
describe("parseMapsUrl — the shapes a customer sends", () => {
  const RIYADH_POINT = { lat: 24.53728, lng: 46.64561 };

  it.each([
    [
      "place with a camera and a dropped pin",
      "https://www.google.com/maps/place/Pharmacy/@24.8060249,46.7752332,17z/data=!3m1!4b1!4m6!3m5!1s0x3e2ee:0xabc!8m2!3d24.53728!4d46.64561!16s%2Fg%2F11abc?entry=ttu",
    ],
    [
      "place with a camera only",
      "https://www.google.com/maps/place/Pharmacy/@24.53728,46.64561,17z",
    ],
    [
      "the documented search URL",
      "https://www.google.com/maps/search/?api=1&query=24.53728,46.64561",
    ],
    ["a bare ?q= pair", "https://www.google.com/maps?q=24.53728,46.64561"],
    [
      "a !3d!4d pin with no place",
      "https://www.google.com/maps/@/data=!3m1!4b1!4m2!3d24.53728!4d46.64561",
    ],
    ["a country domain", "https://www.google.com.sa/maps/place/X/@24.53728,46.64561,17z"],
    [
      "a percent-encoded comma",
      "https://www.google.com/maps/search/?api=1&query=24.53728%2C46.64561",
    ],
  ])("reads %s", (_name, url) => {
    expect(parseMapsUrl(url).point).toEqual(RIYADH_POINT);
  });

  it("reads a geo: share", () => {
    expect(parseMapsUrl("geo:24.53728,46.64561").point).toEqual(RIYADH_POINT);
  });

  /**
   * The defect that made "full Google Maps URLs" look broken.
   *
   * A link pasted out of WhatsApp very often arrives with no scheme, because
   * that is how the message renders it. `new URL` refuses such a string, so the
   * whole link fell through to "not a map link" and no coordinate ever appeared.
   */
  it("reads a URL pasted without its scheme", () => {
    expect(parseMapsUrl("www.google.com/maps?q=24.53728,46.64561").point).toEqual(RIYADH_POINT);
    expect(parseMapsUrl("google.com/maps/place/X/@24.53728,46.64561,17z").point).toEqual(
      RIYADH_POINT,
    );
    expect(parseMapsUrl("maps.app.goo.gl/aBcDeF")).toMatchObject({
      needsResolution: true,
      normalizedUrl: "https://maps.app.goo.gl/aBcDeF",
    });
  });

  /** Android's share sheet prefixes the pair with `loc:`. */
  it("reads a loc: prefixed pair", () => {
    expect(parseMapsUrl("https://maps.google.com/maps?q=loc:24.53728,46.64561").point).toEqual(
      RIYADH_POINT,
    );
  });

  /** A `+`-encoded separator decodes to a space, not a comma. */
  it("reads a space-separated pair", () => {
    expect(
      parseMapsUrl("https://www.google.com/maps/search/?api=1&query=24.53728+46.64561").point,
    ).toEqual(RIYADH_POINT);
  });

  /**
   * The absolute form, for the one caller that goes on to fetch it. The resolver
   * takes absolute HTTPS only, so a scheme-less short link had to be normalised
   * before it could be followed at all.
   */
  it("hands back an absolute https URL for anything a resolver could follow", () => {
    expect(parseMapsUrl("maps.app.goo.gl/aBcDeF").normalizedUrl).toBe(
      "https://maps.app.goo.gl/aBcDeF",
    );
    expect(parseMapsUrl("https://maps.app.goo.gl/aBcDeF").normalizedUrl).toBe(
      "https://maps.app.goo.gl/aBcDeF",
    );
    // Never for a host the resolver would refuse anyway.
    expect(parseMapsUrl("https://example.com/x").normalizedUrl).toBeNull();
    // And never an http link, which the resolver refuses by scheme.
    expect(parseMapsUrl("http://maps.app.goo.gl/aBcDeF")).toMatchObject({
      needsResolution: false,
      normalizedUrl: null,
    });
  });

  /**
   * Widening what can be *typed* must not widen what can be *reached*. A bare
   * host is only ever retried as `https://`, and the result is held to the same
   * Google-host check as everything else.
   */
  it("normalises nothing onto a host it would not already accept", () => {
    for (const hostile of [
      "localhost:8080/maps?q=24.5,46.6",
      "169.254.169.254/latest/meta-data",
      "127.0.0.1/maps?q=24.5,46.6",
      "evil.example.com/maps?q=24.5,46.6",
      "google.com.evil.example/maps?q=24.5,46.6",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      const parsed = parseMapsUrl(hostile);
      expect(parsed.point).toBeNull();
      expect(parsed.needsResolution).toBe(false);
      expect(parsed.normalizedUrl).toBeNull();
    }
  });

  /** A pasted novel is refused before it is parsed. */
  it("refuses an absurdly long string", () => {
    const long = `https://www.google.com/maps?q=24.5,46.6&x=${"a".repeat(4000)}`;
    expect(parseMapsUrl(long).point).toBeNull();
  });

  /** A genuine failure stays a failure: nothing is invented to fill the gap. */
  it("invents nothing for a link with no location in it", () => {
    for (const url of [
      "https://www.google.com/maps/place/Some+Pharmacy",
      "https://www.google.com/maps/place/?q=place_id:ChIJ123",
      "https://example.com/not-maps",
      "not a url at all",
    ]) {
      const parsed = parseMapsUrl(url);
      expect(parsed.point).toBeNull();
      expect(parsed.needsResolution).toBe(false);
    }
  });
});

describe("resolveMapLink — following the redirect", () => {
  it("follows a short link and reads the point it lands on", async () => {
    const fetchMock = vi.fn(async () => redirect(RIYADH));
    const r = await resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchMock as any);

    expect(r.point).toEqual({ lat: 24.7136, lng: 46.6753 });
    expect(r.url).toBe(RIYADH);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never reads the response body", async () => {
    const text = vi.fn();
    const json = vi.fn();
    const fetchMock = vi.fn(async () => ({
      headers: new Headers({ location: RIYADH }),
      text,
      json,
    }));
    await resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchMock as any);

    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("spends no request when the link already carries coordinates", async () => {
    const fetchMock = vi.fn();
    const r = await resolveMapLink(RIYADH, fetchMock as any);

    expect(r.point).toEqual({ lat: 24.7136, lng: 46.6753 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the resolved URL even when the chain carries no point", async () => {
    const named = "https://www.google.com/maps/place/Some+Pharmacy";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect(named))
      .mockResolvedValueOnce(terminal());
    const r = await resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchMock as any);

    // A link that names a place still opens for a driver — but it is not a
    // point, and nothing pretends otherwise.
    expect(r.point).toBeNull();
    expect(r.url).toBe(named);
  });
});

describe("resolveMapLink — refusals", () => {
  const denied = [
    ["a non-Google host", "https://evil.example.com/x"],
    ["plain http", "http://maps.app.goo.gl/aBcDeF"],
    ["localhost", "https://localhost/latest/meta-data"],
    ["loopback by IP", "https://127.0.0.1/"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["a private range", "https://10.0.0.1/"],
    ["another private range", "https://192.168.1.1/"],
    ["file scheme", "file:///etc/passwd"],
    ["not a URL at all", "just some text"],
  ] as const;

  it.each(denied)("refuses %s without fetching", async (_label, url) => {
    const fetchMock = vi.fn();
    await expect(resolveMapLink(url, fetchMock as any)).rejects.toBeInstanceOf(ShortLinkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an absurdly long input before parsing it", async () => {
    const fetchMock = vi.fn();
    const long = `https://maps.app.goo.gl/${"a".repeat(4000)}`;
    await expect(resolveMapLink(long, fetchMock as any)).rejects.toMatchObject({
      kind: "not_allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The one that matters most: a permitted host redirecting somewhere it should
   * not. The allow-list is re-checked on every hop, so the chain stops here.
   */
  it("refuses a redirect that walks off the allow-list", async () => {
    const fetchMock = vi.fn(async () => redirect("https://169.254.169.254/latest/meta-data/"));
    await expect(
      resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchMock as any),
    ).rejects.toMatchObject({ kind: "not_allowed" });
    // It made the first, permitted request and then stopped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a relative redirect that escapes to another host", async () => {
    const fetchMock = vi.fn(async () => redirect("//evil.example.com/x"));
    await expect(
      resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchMock as any),
    ).rejects.toMatchObject({ kind: "not_allowed" });
  });

  it("stops a redirect loop rather than spending every hop on it", async () => {
    const a = "https://maps.app.goo.gl/aBcDeF";
    const fetchMock = vi.fn(async () => redirect(a));
    await expect(resolveMapLink(a, fetchMock as any)).rejects.toMatchObject({
      kind: "redirect_loop",
    });
  });

  it("gives up after too many hops", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => redirect(`https://maps.app.goo.gl/hop${n++}`));
    await expect(
      resolveMapLink("https://maps.app.goo.gl/start", fetchMock as any),
    ).rejects.toMatchObject({ kind: "too_many_hops" });
    // Bounded, not unbounded.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("reports a timeout as a timeout", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    await expect(
      resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchMock as any),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports an unreachable shortener without inventing a location", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    await expect(
      resolveMapLink("https://maps.app.goo.gl/aBcDeF", fetchMock as any),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
