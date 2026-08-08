import { describe, expect, it, vi } from "vitest";
import {
  buildLocationIndex,
  editDistance,
  normalizePlace,
  resolvePlace,
  searchLocations,
  splitCityQualifier,
} from "../location-index";
import { resolveOrigin } from "../locator";
import { decorate } from "../search";
import type { Branch } from "../types";

function branch(overrides: Partial<Branch> & Pick<Branch, "branch_no" | "city">): Branch {
  return {
    phone: null,
    area_manager: null,
    area_manager_phone: null,
    email: null,
    address: null,
    maps_url: null,
    latitude: null,
    longitude: null,
    scooter: false,
    scooter_note: null,
    working_hours: null,
    friday_hours: null,
    duty_hours: null,
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Shaped after the real sheet: `city / district / street`, Arabic only, with
 * the same district name reused across cities — which is the case the whole
 * disambiguation path exists for.
 */
const INDEX = buildLocationIndex(
  decorate([
    branch({
      branch_no: "P0001",
      city: "الرياض",
      address: "الرياض/ حي الحزم /ش علي النقيب",
      latitude: 24.5372826,
      longitude: 46.6456098,
    }),
    branch({
      branch_no: "P0002",
      city: "الرياض",
      address: "الرياض/ حي الروضة",
      latitude: 24.7,
      longitude: 46.78,
    }),
    branch({
      branch_no: "P0003",
      city: "الرياض",
      address: "الرياض/ حي الروضة /شارع خالد",
      latitude: 24.72,
      longitude: 46.8,
    }),
    branch({
      branch_no: "P0021",
      city: "جدة",
      address: "جدة/حي الروضة",
      latitude: 21.55,
      longitude: 39.16,
    }),
    branch({
      branch_no: "P0022",
      city: "جدة",
      address: "جدة/حراج الصواريخ",
      latitude: 21.4858,
      longitude: 39.1925,
    }),
    // No coordinates: must contribute to no centroid at all.
    branch({ branch_no: "المستودع", city: "الرياض", address: "الرياض/السلي" }),
  ]),
);

const find = (query: string) => searchLocations(INDEX, query, 8).map((match) => match.entry);

describe("normalizePlace", () => {
  it("drops the words that classify a place instead of naming it", () => {
    // The whole point: an agent types either form and both must land together.
    expect(normalizePlace("حي الحزم")).toBe(normalizePlace("الحزم"));
    expect(normalizePlace("شارع علي النقيب")).toBe(normalizePlace("علي النقيب"));
    expect(normalizePlace("مدينة الرياض")).toBe(normalizePlace("الرياض"));
    expect(normalizePlace("محافظة جدة")).toBe(normalizePlace("جدة"));
  });

  it("strips the country, however it is written", () => {
    expect(normalizePlace("المملكة العربية السعودية الرياض")).toBe(normalizePlace("الرياض"));
    expect(normalizePlace("Riyadh, Saudi Arabia")).toBe(normalizePlace("riyadh"));
  });

  it("folds Arabic orthography and case through foldText", () => {
    expect(normalizePlace("الطائف")).toBe(normalizePlace("الطايف"));
    expect(normalizePlace("مكة")).toBe(normalizePlace("مكه"));
    expect(normalizePlace("JEDDAH")).toBe(normalizePlace("jeddah"));
  });

  it("returns nothing for a string that is only classifiers", () => {
    expect(normalizePlace("حي")).toBe("");
    expect(normalizePlace("  شارع  ")).toBe("");
  });
});

describe("editDistance", () => {
  it("measures small typos", () => {
    expect(editDistance("riyadh", "riyadh", 2)).toBe(0);
    expect(editDistance("riyad", "riyadh", 2)).toBe(1);
    expect(editDistance("ryiadh", "riyadh", 2)).toBe(2);
  });

  it("abandons anything past the budget rather than measuring it", () => {
    // The early exit is what keeps a per-keystroke scan cheap; all it has to
    // promise is "greater than max".
    expect(editDistance("jeddah", "riyadh", 2)).toBeGreaterThan(2);
    expect(editDistance("a", "aaaaaaaaaa", 2)).toBeGreaterThan(2);
  });
});

describe("buildLocationIndex", () => {
  it("indexes cities, districts, streets and the branches themselves", () => {
    // No landmark in this fixture: its only market address ("جدة/حراج الصواريخ")
    // has two segments, so `extractDistrict`'s positional rule claims it as the
    // district. Landmark classification is covered on its own below.
    const kinds = new Set(INDEX.entries.map((entry) => entry.kind));
    expect(kinds).toEqual(new Set(["city", "district", "street", "branch"]));
  });

  it("tells a street from a landmark by the classifier the sheet wrote", () => {
    // Both are third segments, so both used to be one undifferentiated "area"
    // kind — which cannot express the city > district > street > landmark
    // priority. The distinction is the classifier: "ش"/"طريق"/"street" name a
    // street, and a market does not.
    const mixed = buildLocationIndex(
      decorate([
        branch({
          branch_no: "S1",
          city: "الرياض",
          address: "الرياض/ حي الحزم /طريق الملك فهد",
          latitude: 24.7,
          longitude: 46.68,
        }),
        branch({
          branch_no: "S2",
          city: "الرياض",
          address: "الرياض/ حي الحزم /حراج الصواريخ",
          latitude: 24.71,
          longitude: 46.69,
        }),
      ]),
    );
    const kindOf = (name: string) =>
      searchLocations(mixed, name, 8).find((match) => match.entry.name.includes(name.slice(0, 4)))
        ?.entry.kind;

    expect(kindOf("الملك فهد")).toBe("street");
    expect(kindOf("حراج الصواريخ")).toBe("landmark");
  });

  it("resolves a branch by its code, at that branch's exact position", () => {
    const [hit] = find("P0021");
    expect(hit.kind).toBe("branch");
    expect(hit.branchNo).toBe("P0021");
    // Not a centroid — the branch's own recorded coordinate.
    expect(hit.point.lat).toBeCloseTo(21.55, 5);
    expect(hit.point.lng).toBeCloseTo(39.16, 5);
  });

  it("resolves a branch by a chunk of its full written address", () => {
    const [hit] = find("ش علي النقيب");
    // The street is also indexed as an area; either is a correct answer for
    // this query, and both point at the same branch.
    expect(hit.point.lat).toBeCloseTo(24.5372826, 4);
  });

  it("does not match a branch on fields that are not a location", () => {
    // The crude fallback this engine replaced matched the whole search
    // haystack, so a district query could hit a branch because of its area
    // manager's name or its phone number.
    const withManager = buildLocationIndex(
      decorate([
        branch({
          branch_no: "P9",
          city: "الرياض",
          address: "الرياض/ حي النخيل",
          area_manager: "DR / Hazem Ali",
          phone: "+966599089497",
          latitude: 24.6,
          longitude: 46.7,
        }),
      ]),
    );
    expect(searchLocations(withManager, "Hazem")).toHaveLength(0);
    expect(searchLocations(withManager, "599089497")).toHaveLength(0);
  });

  it("takes a city's point from the centroid of its located branches", () => {
    const [riyadh] = find("الرياض").filter((entry) => entry.kind === "city");
    // Mean of the three located Riyadh branches. The warehouse has no
    // coordinates and must not drag the centre toward zero.
    expect(riyadh.point.lat).toBeCloseTo((24.5372826 + 24.7 + 24.72) / 3, 5);
    expect(riyadh.branchCount).toBe(3);
  });

  it("takes a district's point from the centroid of the branches inside it", () => {
    const [rawdah] = find("الروضة").filter(
      (entry) => entry.kind === "district" && entry.city === "الرياض",
    );
    expect(rawdah.branchCount).toBe(2);
    expect(rawdah.point.lat).toBeCloseTo((24.7 + 24.72) / 2, 5);
    expect(rawdah.point.lng).toBeCloseTo((46.78 + 46.8) / 2, 5);
  });

  it("gives cities their English name and aliases", () => {
    const [jeddah] = find("jeddah");
    expect(jeddah.kind).toBe("city");
    expect(jeddah.english).toBe("Jeddah");
    // The alias table is the existing one the directory search already uses.
    expect(find("jiddah")[0]?.name).toBe("جدة");
  });

  it("indexes a third address segment as a street when it names itself one", () => {
    // "الرياض/ حي الحزم /ش علي النقيب" — neither the city nor the district, and
    // the "ش" classifier makes it a street rather than a landmark. That
    // classifier is stripped for *matching*, which is why the query below has to
    // work without it — the kind is decided on the raw segment before folding.
    const [street] = find("علي النقيب");
    expect(street.kind).toBe("street");
    expect(street.city).toBe("الرياض");
  });

  it("follows extractDistrict on the second segment, whatever it names", () => {
    // "جدة/حراج الصواريخ" is a market, not a حي — but the sheet's convention is
    // `city / area / street`, so the positional rule in `extractDistrict` calls
    // it the district and the index agrees rather than inventing a second
    // opinion about what an address part is.
    const [market] = find("حراج الصواريخ");
    expect(market.kind).toBe("district");
    expect(market.city).toBe("جدة");
  });

  it("never indexes a place backed only by branches with no coordinates", () => {
    // "السلي" appears once, on the warehouse, which has no location — so it
    // could only ever resolve to nowhere.
    expect(find("السلي")).toHaveLength(0);
  });
});

describe("searchLocations", () => {
  it("matches exactly, ignoring the classifier prefix", () => {
    expect(find("حي الحزم")[0].name).toContain("الحزم");
    expect(find("الحزم")[0].name).toContain("الحزم");
  });

  it("matches on a prefix, which is what drives autocomplete", () => {
    expect(find("الحز").some((entry) => entry.name.includes("الحزم"))).toBe(true);
  });

  it("tolerates a typo", () => {
    // One transposition in a six-letter name.
    expect(find("جده")[0].name).toBe("جدة");
    expect(find("riyad").some((entry) => entry.english === "Riyadh")).toBe(true);
  });

  it("matches Arabic written without the definite article", () => {
    expect(find("روضة").some((entry) => entry.name.includes("الروضة"))).toBe(true);
  });

  it("ranks cities above districts and areas when scores tie", () => {
    const [first] = find("الرياض");
    expect(first.kind).toBe("city");
  });

  it("returns nothing for a query that is only noise words", () => {
    expect(find("حي شارع")).toHaveLength(0);
  });

  it("can find every indexed place by its own name", () => {
    // The completeness invariant for the bigram postings lists. Scoring now
    // runs only over candidates the postings hand it, so a gap in those lists
    // would silently make places unfindable — and nothing else in this suite
    // would notice, because each other test names one specific place.
    for (const entry of INDEX.entries) {
      const found = searchLocations(INDEX, entry.name, 50);
      expect(
        found.some((match) => match.entry.id === entry.id),
        `"${entry.name}" (${entry.kind}) is indexed but not findable by its own name`,
      ).toBe(true);
    }
  });
});

describe("resolvePlace", () => {
  it("asks which city when one name belongs to several", () => {
    // "الروضة" is a district in both Riyadh and Jeddah. Silently taking the one
    // with more branches would send the customer to the wrong city.
    const resolution = resolvePlace(INDEX, "الروضة");
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status !== "ambiguous") return;
    expect(resolution.choices).toHaveLength(2);
    expect(new Set(resolution.choices.map((entry) => entry.city))).toEqual(
      new Set(["الرياض", "جدة"]),
    );
  });

  it("does not ask when the name is unique", () => {
    const resolution = resolvePlace(INDEX, "الحزم");
    expect(resolution.status).toBe("found");
  });

  it("does not ask when the tie is only a weak fuzzy match", () => {
    // Ambiguity is worth a question when several places match *well*; two
    // near-misses are just a weak result, and prompting on them would turn
    // every typo into a dialog.
    const resolution = resolvePlace(INDEX, "زقاق مجهول تماما");
    expect(resolution.status).toBe("none");
  });

  it("stops asking once a city has been chosen", () => {
    // The whole purpose of the city dropdown: the agent has already answered
    // "which الروضة", so prompting again would be asking them to repeat
    // themselves.
    const resolution = resolvePlace(INDEX, "الروضة", { city: "جدة" });
    expect(resolution.status).toBe("found");
    if (resolution.status !== "found") return;
    expect(resolution.entry.city).toBe("جدة");
  });

  it("still answers when the chosen city has no match for the name", () => {
    // A scope is a preference, not a filter. An agent who has Jeddah selected and
    // types a Riyadh-only district gets the Riyadh one — labelled with its city —
    // rather than being told nothing matches a name that was correct all along.
    const resolution = resolvePlace(INDEX, "الحزم", { city: "جدة" });
    expect(resolution.status).toBe("found");
    if (resolution.status !== "found") return;
    expect(resolution.entry.city).toBe("الرياض");
  });
});

describe("searchLocations with a city scope", () => {
  it("floats the chosen city's entries to the top", () => {
    const scoped = searchLocations(INDEX, "الروضة", 8, { city: "جدة" });
    expect(scoped[0].entry.city).toBe("جدة");
    expect(scoped[0].inScope).toBe(true);
    // The other city is demoted, not dropped.
    expect(scoped.some((match) => match.entry.city === "الرياض" && !match.inScope)).toBe(true);
  });

  it("reports everything in scope when no city is set", () => {
    const open = searchLocations(INDEX, "الروضة", 8);
    expect(open.length).toBeGreaterThan(1);
    expect(open.every((match) => match.inScope)).toBe(true);
  });
});

describe("resolveOrigin over the index", () => {
  it("surfaces the ambiguity to the caller rather than choosing", async () => {
    const { origin, choices, error } = await resolveOrigin("الروضة", INDEX);
    expect(origin).toBeNull();
    expect(error).toBeNull();
    expect(choices).toHaveLength(2);
  });

  it("builds, resolves and ranks with the network torn out", async () => {
    // The brief's hard requirement, enforced rather than asserted in prose:
    // `fetch` and `XMLHttpRequest` are replaced with throwing stubs, so a future
    // edit that reaches for a geocoding call fails here rather than on a
    // call-floor machine that has lost its connection.
    const boom = vi.fn(() => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", boom);
    vi.stubGlobal("XMLHttpRequest", boom);

    try {
      const offline = buildLocationIndex(
        decorate([
          branch({
            branch_no: "P1",
            city: "تبوك",
            address: "تبوك/ حي المروج",
            latitude: 28.3838,
            longitude: 36.5662,
          }),
        ]),
      );

      expect(searchLocations(offline, "tabuk")[0].entry.name).toBe("تبوك");
      const { origin } = await resolveOrigin("المروج", offline);
      expect(origin?.point.lat).toBeCloseTo(28.3838, 4);
      expect(boom).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("splitCityQualifier", () => {
  it("reads a city off the end of a dictated address", () => {
    // The shape an agent types verbatim from a phone call.
    expect(splitCityQualifier(INDEX, "حي الروضة، الرياض")).toEqual({
      text: "الروضه",
      city: "الرياض",
    });
  });

  it("reads a city off the front, which is how the sheet writes addresses", () => {
    expect(splitCityQualifier(INDEX, "الرياض/ حي الروضة")).toEqual({
      text: "الروضه",
      city: "الرياض",
    });
  });

  it("reads a city from its English alias", () => {
    expect(splitCityQualifier(INDEX, "Al Rawdah Riyadh")).toEqual({
      text: "rawdah",
      city: "الرياض",
    });
  });

  it("leaves a query that is only a city alone", () => {
    // The remainder would be empty, and "الرياض" has always meant the city.
    expect(splitCityQualifier(INDEX, "الرياض")).toEqual({ text: "الرياض", city: null });
  });

  it("leaves a query naming no city alone", () => {
    expect(splitCityQualifier(INDEX, "حي الحزم")).toEqual({ text: "الحزم", city: null });
  });
});

describe("a city named inside the query", () => {
  it("resolves a district that is ambiguous without it", () => {
    // The regression this exists for. "الروضة" is a district in both Riyadh and
    // Jeddah, so it asks; naming the city answers, and must not ask again.
    const bare = resolvePlace(INDEX, "حي الروضة");
    expect(bare.status).toBe("ambiguous");

    const qualified = resolvePlace(INDEX, "حي الروضة، الرياض");
    expect(qualified.status).toBe("found");
    if (qualified.status === "found") expect(qualified.entry.city).toBe("الرياض");
  });

  it("filters the other city out rather than merely demoting it", () => {
    // Stronger than the dropdown's behaviour, and deliberately so: a city typed
    // into this query is this query's answer to "which one".
    const scoped = searchLocations(INDEX, "الروضة الرياض", 8);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((match) => match.entry.city === "الرياض")).toBe(true);
  });

  it("still finds the place when the city is written in English", () => {
    const scoped = searchLocations(INDEX, "الروضة riyadh", 8);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((match) => match.entry.city === "الرياض")).toBe(true);
  });

  it("beats the dropdown when the two disagree", () => {
    // The agent left Jeddah selected and then typed Riyadh. The text is the more
    // recent, more specific instruction.
    const scoped = searchLocations(INDEX, "الروضة الرياض", 8, { city: "جدة" });
    expect(scoped.every((match) => match.entry.city === "الرياض")).toBe(true);
  });
});
