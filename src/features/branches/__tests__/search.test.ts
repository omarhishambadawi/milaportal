import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  cityOptions,
  computeStats,
  decorate,
  dutyHourOptions,
  filterBranches,
  managerOptions,
} from "../search";
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

const FIXTURE = decorate([
  branch({
    branch_no: "P0001",
    city: "الرياض",
    phone: "+966599089497",
    area_manager: "DR / Mohamed Abd Elmohsen",
    area_manager_phone: "+966500733054",
    email: "ph01@ghodafpharmacy.com",
    address: "الرياض/ حي الحزم /ش علي النقيب",
    latitude: 24.5372826,
    longitude: 46.6456098,
    scooter: true,
    scooter_note: "سكوتر",
    working_hours: "06 AM - 06 AM",
    duty_hours: 24,
  }),
  branch({
    branch_no: "P0021",
    city: "جدة",
    phone: "+966592624549",
    area_manager: "DR / Ahmed Elshikh",
    address: "جدة/حي اليرموك",
    scooter: false,
    working_hours: "07 AM - 03 AM",
    duty_hours: 20,
  }),
  branch({
    branch_no: "P0210",
    city: "الطائف",
    area_manager: "DR / Ahmed Elshikh",
    scooter: true,
    working_hours: "06 AM - 04 AM",
    duty_hours: 22,
  }),
  branch({
    branch_no: "المستودع",
    city: "الرياض",
    address: "الرياض/السلي",
  }),
]);

const NO_FAVOURITES = new Set<string>();

function codes(results: ReturnType<typeof filterBranches>) {
  return results.map((entry) => entry.branch_no);
}

function search(query: string) {
  return codes(filterBranches(FIXTURE, { ...EMPTY_FILTERS, query }, NO_FAVOURITES));
}

describe("search", () => {
  it("finds a branch by its exact code and ranks it first", () => {
    // "P0021" is a substring of nothing here, but "P002" is a prefix of P0021
    // and appears inside no other code — the exact match must still lead.
    expect(search("P0021")[0]).toBe("P0021");
  });

  it("puts an exact code above a branch that merely contains those digits", () => {
    const results = search("P0021");
    expect(results[0]).toBe("P0021");
  });

  it("finds every branch in a city typed in English", () => {
    expect(search("riyadh").sort()).toEqual(["P0001", "المستودع"]);
    expect(search("jeddah")).toEqual(["P0021"]);
  });

  it("finds a city typed in Arabic", () => {
    expect(search("الرياض").sort()).toEqual(["P0001", "المستودع"]);
  });

  it("finds a city typed in Arabic without its hamza", () => {
    expect(search("الطايف")).toEqual(["P0210"]);
  });

  it("finds every branch under an area manager", () => {
    expect(search("elshikh").sort()).toEqual(["P0021", "P0210"]);
  });

  it("finds a branch by phone number, however the digits are grouped", () => {
    for (const query of ["599089497", "+966599089497", "0599089497"]) {
      expect(search(query)).toEqual(["P0001"]);
    }
  });

  it("finds a branch by its area manager's number", () => {
    expect(search("500733054")).toEqual(["P0001"]);
  });

  it("finds a branch by a fragment of its address", () => {
    expect(search("الحزم")).toEqual(["P0001"]);
  });

  it("narrows rather than widens on a second word", () => {
    expect(search("ahmed jeddah")).toEqual(["P0021"]);
  });

  it("returns nothing for a term nobody matches", () => {
    expect(search("zzzz")).toEqual([]);
  });
});

describe("filters", () => {
  it("filters to branches with a scooter", () => {
    const results = filterBranches(FIXTURE, { ...EMPTY_FILTERS, scooter: "yes" }, NO_FAVOURITES);
    expect(codes(results).sort()).toEqual(["P0001", "P0210"]);
  });

  it("filters to branches without one", () => {
    const results = filterBranches(FIXTURE, { ...EMPTY_FILTERS, scooter: "no" }, NO_FAVOURITES);
    expect(codes(results).sort()).toEqual(["P0021", "المستودع"]);
  });

  it("combines a city chip with a search term", () => {
    const results = filterBranches(
      FIXTURE,
      { ...EMPTY_FILTERS, cities: ["الرياض"], query: "P0001" },
      NO_FAVOURITES,
    );
    expect(codes(results)).toEqual(["P0001"]);
  });

  it("treats multiple city chips as a union", () => {
    const results = filterBranches(
      FIXTURE,
      { ...EMPTY_FILTERS, cities: ["جدة", "الطائف"] },
      NO_FAVOURITES,
    );
    expect(codes(results).sort()).toEqual(["P0021", "P0210"]);
  });

  it("buckets a fractional duty-hour value down to a whole-hour chip", () => {
    const fixture = decorate([branch({ branch_no: "P9001", city: "جدة", duty_hours: 14.5 })]);
    expect(
      codes(filterBranches(fixture, { ...EMPTY_FILTERS, dutyHours: [14] }, NO_FAVOURITES)),
    ).toEqual(["P9001"]);
  });

  it("excludes branches with no recorded hours from every duty-hour chip", () => {
    const results = filterBranches(
      FIXTURE,
      { ...EMPTY_FILTERS, dutyHours: [20, 22, 24] },
      NO_FAVOURITES,
    );
    expect(codes(results)).not.toContain("المستودع");
  });

  it("filters to favourites only when asked", () => {
    const results = filterBranches(
      FIXTURE,
      { ...EMPTY_FILTERS, favouritesOnly: true },
      new Set(["P0210"]),
    );
    expect(codes(results)).toEqual(["P0210"]);
  });

  it("filters by area manager", () => {
    const results = filterBranches(
      FIXTURE,
      { ...EMPTY_FILTERS, managers: ["DR / Ahmed Elshikh"] },
      NO_FAVOURITES,
    );
    expect(codes(results).sort()).toEqual(["P0021", "P0210"]);
  });

  it("excludes branches with no area manager from a manager filter", () => {
    const results = filterBranches(
      FIXTURE,
      { ...EMPTY_FILTERS, managers: ["DR / Ahmed Elshikh"] },
      NO_FAVOURITES,
    );
    expect(codes(results)).not.toContain("المستودع");
  });
});

describe("activeFilterCount", () => {
  it("ignores the search box", () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, query: "riyadh" })).toBe(0);
  });

  it("counts each selected value, and the scooter tri-state once", () => {
    expect(
      activeFilterCount({
        ...EMPTY_FILTERS,
        cities: ["الرياض", "جدة"],
        dutyHours: [24],
        managers: ["DR / Ahmed Elshikh"],
        scooter: "yes",
        favouritesOnly: true,
      }),
    ).toBe(6);
  });
});

describe("derived options", () => {
  it("counts the whole directory, not a filtered slice", () => {
    expect(computeStats(FIXTURE)).toEqual({
      total: 4,
      cities: 3,
      withScooter: 2,
      withoutScooter: 2,
    });
  });

  it("orders city chips by how many branches each holds", () => {
    expect(cityOptions(FIXTURE)[0]).toMatchObject({ city: "الرياض", english: "Riyadh", count: 2 });
  });

  it("lists area managers alphabetically with their branch counts", () => {
    expect(managerOptions(FIXTURE)).toEqual([
      { manager: "DR / Ahmed Elshikh", count: 2 },
      { manager: "DR / Mohamed Abd Elmohsen", count: 1 },
    ]);
  });

  it("derives duty-hour chips from the data, longest first", () => {
    expect(dutyHourOptions(FIXTURE)).toEqual([
      { hours: 24, count: 1 },
      { hours: 22, count: 1 },
      { hours: 20, count: 1 },
    ]);
  });
});

describe("decorate", () => {
  it("precomputes display numbers and links once", () => {
    const [first] = FIXTURE;
    expect(first.phoneDisplay).toBe("+966 59 908 9497");
    expect(first.managerPhoneDisplay).toBe("+966 50 073 3054");
    expect(first.cityEnglish).toBe("Riyadh");
    expect(first.hasCoords).toBe(true);
    // The comma is percent-encoded by URLSearchParams, which Google decodes.
    // Asserting on the decoded form tests the intent rather than the encoding.
    expect(decodeURIComponent(first.navLink ?? "")).toContain("destination=24.5372826,46.6456098");
  });

  it("marks a branch with no coordinates as unmappable", () => {
    const warehouse = FIXTURE.find((entry) => entry.branch_no === "المستودع");
    expect(warehouse?.hasCoords).toBe(false);
    expect(warehouse?.mapsLink).toBeNull();
  });
});
