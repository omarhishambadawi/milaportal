import { describe, expect, it } from "vitest";
import {
  cityAliases,
  cityEnglish,
  cleanCell,
  foldText,
  formatE164,
  formatLocal,
  isNumberedBranch,
  referenceKind,
  mapsLink,
  navLink,
  parseCoordinate,
  parseDutyHours,
  parsePhone,
  parseScooter,
  phoneSearchForms,
} from "../normalize";

/**
 * These cases are transcribed from the live "Shams File master location"
 * workbook, not invented. Each one is a shape the sheet actually contains, and
 * several of them (the "=" prefix, the mistyped country codes, the overlapping
 * shift notation) are the reason the parsing code is shaped the way it is.
 */

describe("cleanCell", () => {
  it("treats the sheet's several spellings of nothing as null", () => {
    for (const blank of ["", "  ", "-", "—", "N/A", "n/a", "NA", "null"]) {
      expect(cleanCell(blank)).toBeNull();
    }
  });

  it("strips the leading = Excel adds to text starting with a plus", () => {
    expect(cleanCell("=+966 50 073 3054")).toBe("+966 50 073 3054");
  });

  it("collapses internal whitespace, including the newline inside the Scooter header", () => {
    expect(cleanCell("Scooter\n")).toBe("Scooter");
    expect(cleanCell("  توصيل   مجاني ")).toBe("توصيل مجاني");
  });
});

describe("foldText", () => {
  it("folds the Arabic variants a hurried typist drops", () => {
    expect(foldText("مكة")).toBe(foldText("مكه"));
    expect(foldText("الطائف")).toBe(foldText("الطايف"));
    expect(foldText("أحمد")).toBe(foldText("احمد"));
  });

  it("normalizes Arabic-Indic digits so ٠٥٩ finds 059", () => {
    expect(foldText("٠٥٩٩٠٨٩٤٩٧")).toBe("0599089497");
  });
});

describe("parsePhone", () => {
  it("reads the sheet's bare 9-digit branch numbers", () => {
    const parsed = parsePhone("599089497");
    expect(parsed.e164).toBe("+966599089497");
    expect(parsed.suspicious).toBe(false);
  });

  it("accepts 05…, +966… and 00966… as the same number", () => {
    for (const input of ["0599089497", "+966 59 908 9497", "00966599089497", "966599089497"]) {
      expect(parsePhone(input).e164).toBe("+966599089497");
    }
  });

  it("reads an area manager number through the Excel = prefix", () => {
    expect(parsePhone("=+966 50 073 3054").e164).toBe("+966500733054");
  });

  it("flags the two mistyped country codes rather than guessing at them", () => {
    // "968 50 726 2291" and "969 …" appear in the sheet where 966 was meant.
    // Silently rewriting them would hand an agent an unverified number to dial.
    for (const input of ["968 50 726 2291", "969 50 726 2291"]) {
      const parsed = parsePhone(input);
      expect(parsed.e164).toBeNull();
      expect(parsed.suspicious).toBe(true);
    }
  });

  it("is not suspicious about an empty cell", () => {
    expect(parsePhone("-")).toEqual({
      digits: "",
      nsn: null,
      e164: null,
      display: null,
      suspicious: false,
    });
  });

  it("indexes the national, trunk-zero and E.164 forms of one number", () => {
    // An agent reading a number off a customer's screen types the 05… form; the
    // sheet stores the bare 9 digits. Neither contains the other.
    expect(phoneSearchForms(parsePhone("599089497")).sort()).toEqual([
      "+966599089497",
      "0599089497",
      "599089497",
    ]);
  });

  it("formats for display in dialable groups", () => {
    expect(formatE164("+966599089497")).toBe("+966 59 908 9497");
  });

  it("displays the local form, which is the one anybody actually says", () => {
    expect(formatLocal("+966599089497")).toBe("0599089497");
    // Landlines take the trunk zero too — Riyadh's 011, Jeddah's 012.
    expect(formatLocal("+966112345678")).toBe("0112345678");
  });

  it("leaves a number it cannot read as a Saudi one untouched", () => {
    expect(formatLocal("+4915112345678")).toBe("+4915112345678");
  });
});

describe("parseScooter", () => {
  it("reads the affirmative wordings used in the sheet", () => {
    for (const input of [
      "سكوتر",
      "دباب",
      "توصيل مجاني",
      "سكوتر العامل",
      "دباب العامل",
      "مع فرع 8",
    ]) {
      expect(parseScooter(input).available).toBe(true);
    }
  });

  it("reads a refusal that happens to contain the word for delivery", () => {
    // "غير متاح ليه توصيل" — a positive-only match would read this as a yes.
    expect(parseScooter("غير متاح ليه توصيل").available).toBe(false);
  });

  it("treats N/A and an empty cell as no scooter", () => {
    expect(parseScooter("N/A").available).toBe(false);
    expect(parseScooter("").available).toBe(false);
    expect(parseScooter("-").available).toBe(false);
  });

  it("keeps the original wording for the card", () => {
    expect(parseScooter("سكوتر العامل").note).toBe("سكوتر العامل");
    expect(parseScooter("-").note).toBeNull();
  });
});

describe("parseDutyHours", () => {
  it("measures a plain overnight range", () => {
    expect(parseDutyHours("07 AM - 03 AM")).toBe(20);
    expect(parseDutyHours("06 AM - 04 AM")).toBe(22);
  });

  it("treats equal open and close as around the clock", () => {
    expect(parseDutyHours("06 AM - 06 AM")).toBe(24);
    expect(parseDutyHours("05 AM - 05 AM")).toBe(24);
  });

  it("unions overlapping staff shifts into one opening", () => {
    // Three shifts covering 06:00 -> 04:00. Reading only the first would say 8.
    expect(parseDutyHours("06 AM - 02 PM & 10 AM - 06 PM & 06 PM - 04 AM")).toBe(22);
    expect(parseDutyHours("06 AM - 02 PM & 10 AM - 08 PM & 08 PM - 06 AM")).toBe(24);
  });

  it("does not count a midday closure as open time", () => {
    // Open 09:00-14:00 and 16:00-24:00 = 13 hours. Earliest-to-latest would say 15.
    expect(parseDutyHours("09 AM - 02 PM THEN 04 PM - 12 AM")).toBe(13);
  });

  it("reads the dotted and colon minute notations the sheet mixes", () => {
    expect(parseDutyHours("10.30 AM - 01.30 AM")).toBe(15);
    expect(parseDutyHours("8 AM - 02 AM")).toBe(18);
    expect(parseDutyHours("09 AM - 2.30 PM & 4.30 PM - 01 AM")).toBe(14);
  });

  it("returns null for cells that are not hours", () => {
    expect(parseDutyHours("-")).toBeNull();
    expect(parseDutyHours("")).toBeNull();
    expect(parseDutyHours("new")).toBeNull();
  });
});

describe("parseCoordinate", () => {
  it("reads the sheet's decimal degrees and rounds to the column's precision", () => {
    const parsed = parseCoordinate("24.53728256", "46.64560984");
    expect(parsed.latitude).toBe(24.5372826);
    expect(parsed.longitude).toBe(46.6456098);
    expect(parsed.outOfRange).toBe(false);
  });

  it("rejects a swapped pair rather than putting the branch in the ocean", () => {
    const parsed = parseCoordinate("46.6456", "24.5372");
    expect(parsed.latitude).toBeNull();
    expect(parsed.outOfRange).toBe(true);
  });

  it("returns nothing, and no complaint, for an empty pair", () => {
    expect(parseCoordinate("", "")).toEqual({
      latitude: null,
      longitude: null,
      outOfRange: false,
    });
  });
});

describe("cities", () => {
  it("resolves the Arabic city names in the sheet to English", () => {
    expect(cityEnglish("الرياض")).toBe("Riyadh");
    expect(cityEnglish("جدة")).toBe("Jeddah");
    expect(cityEnglish("الطائف")).toBe("Taif");
    expect(cityEnglish("الشرقية")).toBe("Eastern Province");
  });

  it("resolves a city typed without its hamza", () => {
    expect(cityEnglish("الطايف")).toBe("Taif");
  });

  it("returns null rather than inventing a name for an unknown city", () => {
    expect(cityEnglish("مدينة غير معروفة")).toBeNull();
    expect(cityEnglish(null)).toBeNull();
  });

  it("indexes every alias, original included", () => {
    expect(cityAliases("مكة")).toContain("مكة");
    expect(cityAliases("مكة")).toContain("mecca");
  });
});

describe("links", () => {
  it("prefers the sheet's own maps link over a coordinate search", () => {
    expect(
      mapsLink({
        maps_url: "https://maps.app.goo.gl/oy8ZPVd5tX9nEh4W7",
        latitude: 24.5,
        longitude: 46.6,
      }),
    ).toBe("https://maps.app.goo.gl/oy8ZPVd5tX9nEh4W7");
  });

  it("builds a coordinate link when the sheet has no URL", () => {
    expect(
      decodeURIComponent(mapsLink({ maps_url: null, latitude: 24.5, longitude: 46.6 }) ?? ""),
    ).toContain("query=24.5,46.6");
  });

  it("has no link at all without coordinates or a URL", () => {
    expect(mapsLink({ maps_url: "-", latitude: null, longitude: null })).toBeNull();
    expect(navLink({ latitude: null, longitude: null })).toBeNull();
  });
});

describe("isNumberedBranch", () => {
  it("separates pharmacies from the facility rows", () => {
    expect(isNumberedBranch("P0001")).toBe(true);
    expect(isNumberedBranch("P0701")).toBe(true);
    expect(isNumberedBranch("المستودع")).toBe(false);
    expect(isNumberedBranch("الادارة العامة")).toBe(false);
  });
});

describe("referenceKind", () => {
  it("names the three facility rows the sheet carries", () => {
    expect(referenceKind("الادارة العامة")).toBe("head-office");
    expect(referenceKind("الإدارة الفرعية")).toBe("regional-office");
    expect(referenceKind("المستودع")).toBe("warehouse");
  });

  it("reads through the sheet's spelling drift and the importer's suffix", () => {
    // ة/ه and أ/إ/ا vary row to row; "المستودع-2" is the second warehouse.
    expect(referenceKind("الاداره العامه")).toBe("head-office");
    expect(referenceKind("المستودع-2")).toBe("warehouse");
    expect(referenceKind("المستودع 2")).toBe("warehouse");
  });

  it("says nothing about a numbered pharmacy, which needs no badge", () => {
    expect(referenceKind("P0001")).toBeNull();
    expect(referenceKind("p0701")).toBeNull();
  });

  it("still flags an unrecognised non-pharmacy code rather than passing it off as a branch", () => {
    expect(referenceKind("مبنى التدريب")).toBe("other");
  });
});
