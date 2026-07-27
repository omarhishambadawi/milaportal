import { describe, expect, it } from "vitest";
import { extractDistrict } from "../district";

/**
 * The bar for this function is not "extracts a district as often as possible" —
 * it is "never reports something that is not one". An agent reads this value out
 * to a customer looking for the shop.
 */
describe("extractDistrict", () => {
  it("takes the segment that names itself a حي", () => {
    expect(extractDistrict("الرياض/ حي الحزم /ش علي النقيب", "الرياض")).toBe("حي الحزم");
    expect(extractDistrict("جدة/حي اليرموك", "جدة")).toBe("حي اليرموك");
  });

  it("finds the حي wherever it sits in the address", () => {
    expect(extractDistrict("حي رقم 4 / شارع الملك عبد العزيز، جدة", "جدة")).toBe("حي رقم 4");
    expect(extractDistrict("مكة المكرمة / حي العزيزية / طريق الملك", "مكة")).toBe("حي العزيزية");
  });

  it("takes the segment after the city when nothing names itself", () => {
    // Real second segments from the master sheet: an area and a market, neither
    // of which carries the حي prefix.
    expect(extractDistrict("الرياض/السلي", "الرياض")).toBe("السلي");
    expect(extractDistrict("جدة/حراج الصواريخ", "جدة")).toBe("حراج الصواريخ");
  });

  it("matches the city when the address spells it more fully", () => {
    expect(extractDistrict("مكة المكرمة / العزيزية", "مكة")).toBe("العزيزية");
  });

  it("does not mistake a leading street for a district", () => {
    // The positional rule only applies to addresses that lead with the city.
    expect(extractDistrict("King Fahd Road, Riyadh", "الرياض")).toBeNull();
    expect(extractDistrict("شارع علي النقيب", "الرياض")).toBeNull();
  });

  it("returns null when there is nothing but the city", () => {
    expect(extractDistrict("الرياض", "الرياض")).toBeNull();
    expect(extractDistrict("جدة/", "جدة")).toBeNull();
  });

  it("returns null for a missing address", () => {
    expect(extractDistrict(null, "الرياض")).toBeNull();
    expect(extractDistrict("", "الرياض")).toBeNull();
    expect(extractDistrict("   ", "الرياض")).toBeNull();
  });

  it("refuses a candidate long enough to be directions rather than a place", () => {
    const sentence = "الرياض/ بجوار محطة الوقود مقابل مسجد الملك فهد بعد الإشارة الثانية يمينا";
    expect(extractDistrict(sentence, "الرياض")).toBeNull();
  });

  it("does not match a word merely starting with the letters of حي", () => {
    // حراج begins ح-ر, not ح-ي; the guard is about the ي, but the boundary rule
    // is what keeps "الحي" and similar out of the named path.
    expect(extractDistrict("جدة/حراج الصواريخ", "جدة")).toBe("حراج الصواريخ");
  });

  it("tolerates an unknown city by falling back to the named segment only", () => {
    expect(extractDistrict("مدينة جديدة/حي النرجس", "مدينة جديدة")).toBe("حي النرجس");
    // Unknown city, no حي: the first segment cannot be confirmed as the city, so
    // nothing is reported.
    expect(extractDistrict("مدينة جديدة/النرجس", "مدينة أخرى")).toBeNull();
  });
});
