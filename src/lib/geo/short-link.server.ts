import { MAPS_HOSTS, parseMapsUrl } from "./maps-url";
import type { LatLng } from "./types";

/**
 * Following a Google Maps short link to the location behind it.
 *
 * `maps.app.goo.gl/aBcDeF` is what the Maps share sheet produces on a phone, so
 * it is what a customer sends over WhatsApp and what an agent pastes. It holds
 * no coordinates — only a redirect to a link that does. The browser cannot
 * follow it, because the shortener serves no CORS headers, so the work happens
 * here.
 *
 * ## Why this is not a generic URL fetcher
 *
 * A server that fetches a URL a user supplies is a server-side request forgery
 * waiting to happen: the interesting targets are not on the public internet but
 * on the loopback and link-local addresses only the server can reach — a cloud
 * instance metadata endpoint being the classic one. Two rules contain that, and
 * both are enforced on **every hop**, not just the one the caller passed:
 *
 *   1. The host must be on {@link ALLOWED_HOSTS}. Not "not a private address" —
 *      an allow-list, because a deny-list of private ranges is a list of the
 *      ones somebody thought of, and DNS can point a permitted name at any
 *      address it likes.
 *   2. The scheme must be HTTPS.
 *
 * The response body is never read. Only the `Location` header is, which is all
 * a redirect carries and removes any question of what the fetched content could
 * do.
 *
 * ## Provenance
 *
 * Restored unchanged in substance from the reverted integration (`3917274`).
 * It went out with the wholesale AlShrouq revert, not for any defect: the
 * allow-list, the per-hop re-check, the unread body and the hop cap were right
 * then and are right now. Two things were added on the way back — a length cap
 * before `new URL`, and a redirect-loop check — and are marked below.
 */

/**
 * Hosts this resolver will talk to.
 *
 * The shorteners, plus the Google Maps hosts they redirect *to* — a
 * `maps.app.goo.gl` link lands on `www.google.com/maps/place/...`, sometimes via
 * a country domain (`google.com.sa`, `google.co.uk`) when the sharer's Maps app
 * is set to one.
 */
const ALLOWED_HOSTS = MAPS_HOSTS;

/**
 * Redirect hops followed before giving up.
 *
 * A shortener normally takes one or two. The cap is what stops a redirect loop
 * from becoming an open request pump.
 */
const MAX_HOPS = 5;

/** Long enough for a redirect, short enough not to hold an agent's form. */
const TIMEOUT_MS = 8_000;

export interface ResolvedMapLink {
  /** The location, when the chain ended somewhere carrying coordinates. */
  point: LatLng | null;
  /** The final URL, worth storing because it names the place rather than a code. */
  url: string;
  /** Both numbers read but outside the country — a swapped pair, not a location. */
  outOfRange: boolean;
}

export type ShortLinkErrorKind =
  | "not_allowed"
  | "timeout"
  | "unavailable"
  | "too_many_hops"
  | "redirect_loop";

export class ShortLinkError extends Error {
  readonly kind: ShortLinkErrorKind;
  constructor(kind: ShortLinkErrorKind, message: string) {
    super(message);
    this.name = "ShortLinkError";
    this.kind = kind;
  }
}

/**
 * Longer than any real Maps link, short enough that a pasted novel is refused
 * before it is parsed. Added on restore: `new URL` on unbounded input is work
 * an untrusted caller gets to choose the size of.
 */
const MAX_URL_LENGTH = 2048;

function assertAllowed(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) {
    throw new ShortLinkError("not_allowed", "That link is too long to be a map link.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ShortLinkError("not_allowed", "That is not a link.");
  }
  if (url.protocol !== "https:") {
    throw new ShortLinkError("not_allowed", "Only https links can be resolved.");
  }
  if (!ALLOWED_HOSTS.test(url.hostname)) {
    throw new ShortLinkError("not_allowed", "Only Google Maps links can be resolved.");
  }
  return url;
}

/**
 * Follow a Google Maps short link and read the location out of where it lands.
 *
 * Returns the resolved URL even when no coordinates are found: a link that
 * names a place is still worth storing and still opens correctly for a driver,
 * which is the same reasoning `resolveMapUrl` applies to the branch workbook's
 * links.
 *
 * `fetchImpl` is a test seam. Nothing in production passes it.
 */
export async function resolveMapLink(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedMapLink> {
  let current = assertAllowed(input.trim());
  /*
   * Added on restore. The hop cap alone bounds a loop, but it spends every hop
   * doing it; noticing a URL we have already fetched ends it on the second
   * request and reports a loop rather than a generic "too many redirects".
   */
  const seen = new Set<string>([current.href]);

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // A link that already carries coordinates needs no further hop — the
    // shortener may well have redirected straight to one.
    const parsed = parseMapsUrl(current.href);
    if (parsed.point || parsed.outOfRange) {
      return { point: parsed.point, url: current.href, outOfRange: parsed.outOfRange };
    }

    const location = await hopOnce(current, fetchImpl);
    if (!location) {
      // The chain ended without coordinates. The URL is still the best link we
      // have, so it is returned rather than discarded.
      return { point: null, url: current.href, outOfRange: false };
    }
    // Relative `Location` headers are legal; resolving against the current URL
    // and re-checking is what stops a redirect walking us off the allow-list.
    current = assertAllowed(new URL(location, current).href);
    if (seen.has(current.href)) {
      throw new ShortLinkError("redirect_loop", "That link redirects back to itself.");
    }
    seen.add(current.href);
  }

  throw new ShortLinkError("too_many_hops", "That link redirects too many times.");
}

/** One request. Returns the `Location` header, or null at the end of the chain. */
async function hopOnce(url: URL, fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        // Google serves the coordinate-bearing desktop URL to a desktop agent;
        // a bare fetch can be answered with a consent interstitial instead.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html",
      },
    });
    // The body is deliberately not read.
    return res.headers.get("location");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ShortLinkError("timeout", "Google Maps took too long to answer.");
    }
    throw new ShortLinkError("unavailable", "Could not reach Google Maps.");
  } finally {
    clearTimeout(timer);
  }
}
