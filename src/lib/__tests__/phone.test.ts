import { describe, expect, it } from "vitest";
import {
  arabicToWesternDigits,
  extractSaudiPhones,
  formatSaudiPhone,
  isSaudiMobile,
  normalizeSaudiPhone,
  phoneKeyPart,
  telHref,
  toE164,
  toSaudiPhone,
} from "@/lib/phone";

/** The canonical number every one of these has to produce. */
const CANONICAL = "0504630565";

describe("standard formats", () => {
  it("normalises every way this number can be written", () => {
    for (const input of [
      "504630565",
      "0504630565",
      "966504630565",
      "+966504630565",
      "00966504630565",
    ]) {
      expect(toSaudiPhone(input), input).toBe(CANONICAL);
    }
  });

  it("reports which input was already canonical", () => {
    expect(normalizeSaudiPhone("0504630565").wasCanonical).toBe(true);
    expect(normalizeSaudiPhone("504630565").wasCanonical).toBe(false);
    expect(normalizeSaudiPhone("+966504630565").wasCanonical).toBe(false);
  });
});

describe("formatted variants", () => {
  it("discards separators wherever they fall", () => {
    for (const input of [
      "050-463-0565",
      "050 463 0565",
      "050,463,0565",
      "+966 50 463 0565",
      "00966 50 463 0565",
      "(050) 463 0565",
      "050.463.0565",
      "  0504630565  ",
      "0 5 0 4 6 3 0 5 6 5",
      "+966-50-463-0565",
      "00966-50-463-0565",
    ]) {
      expect(toSaudiPhone(input), input).toBe(CANONICAL);
    }
  });
});

describe("Arabic-Indic numerals", () => {
  it("converts both digit blocks", () => {
    // U+0660–0669, the Arabic-Indic set used across the Gulf.
    expect(toSaudiPhone("٠٥٠٤٦٣٠٥٦٥")).toBe(CANONICAL);
    // U+06F0–06F9, the Extended (Persian/Urdu) set — a different block that
    // looks almost identical.
    expect(toSaudiPhone("۰۵۰۴۶۳۰۵۶۵")).toBe(CANONICAL);
    // Mixed with Western digits and separators.
    expect(toSaudiPhone("٠٥٠-٤٦٣-٠٥٦٥")).toBe(CANONICAL);
    expect(toSaudiPhone("+٩٦٦٥٠٤٦٣٠٥٦٥")).toBe(CANONICAL);
  });

  it("leaves non-digits alone", () => {
    expect(arabicToWesternDigits("رقم ٠٥٠")).toBe("رقم 050");
    expect(arabicToWesternDigits("abc")).toBe("abc");
  });
});

describe("Excel's numeric cells", () => {
  it("accepts a number that lost its leading zero", () => {
    // What a numeric Mobileno column gives: 504630565 as a float.
    expect(toSaudiPhone(504630565)).toBe(CANONICAL);
  });

  it("accepts the full-precision integer behind a scientific display", () => {
    // `9.66555E+11` is what the Wasfaty Phone column *displays*; the stored
    // value is this, and it is what the importer actually reads.
    expect(toSaudiPhone(966555389897)).toBe("0555389897");
    expect(toSaudiPhone("966555389897")).toBe("0555389897");
  });

  it("refuses the rendered scientific notation, which has lost its digits", () => {
    // Number("9.66555E+11") is 966555000000 — well-formed, dialable, and
    // somebody else's number. Refusing by name is the only safe answer.
    const r = normalizeSaudiPhone("9.66555E+11");
    expect(r.phone).toBeNull();
    expect(r.rejection).toBe("scientific_notation");
    expect(normalizeSaudiPhone("5.0463E+9").rejection).toBe("scientific_notation");
  });
});

describe("invalid values are refused, never repaired", () => {
  const cases: [unknown, string][] = [
    [null, "empty"],
    [undefined, "empty"],
    ["", "empty"],
    ["   ", "empty"],
    ["abc", "no_digits"],
    ["no record", "no_digits"],
    ["N/A", "no_digits"],
    ["m", "no_digits"],
    // The REFUSED TO GET MOBILE NUMBER placeholders, verbatim from the files.
    ["0", "no_digits"],
    ["0000", "no_digits"],
    ["00", "no_digits"],
    // Placeholder runs.
    ["11111", "too_short"],
    ["1234", "too_short"],
    ["05555", "too_short"],
    ["05555555", "too_short"],
    ["135", "too_short"],
    ["04", "too_short"],
    // One digit too many / too few, both real in the workbooks.
    ["05591675252", "too_long"],
    ["056311260", "too_short"],
    ["059742154325", "too_long"],
  ];

  for (const [input, rejection] of cases) {
    it(`refuses ${JSON.stringify(input)} as ${rejection}`, () => {
      const r = normalizeSaudiPhone(input);
      expect(r.phone).toBeNull();
      expect(r.rejection).toBe(rejection);
    });
  }

  it("refuses a foreign number rather than making it Saudi", () => {
    // Real: a Swedish number in the Wasfaty data.
    const r = normalizeSaudiPhone("0046727259080");
    expect(r.phone).toBeNull();
    expect(r.rejection).toBe("foreign");
  });

  it("keeps the raw value for review", () => {
    expect(normalizeSaudiPhone("0000").raw).toBe("0000");
    expect(normalizeSaudiPhone(" 0510735627 ").raw).toBe("0510735627");
  });
});

describe("the numeric identifiers that share these columns", () => {
  /*
   * The reason step 7 validates a prefix instead of prepending a zero to
   * anything nine digits long. Every value here was found in a phone column, or
   * is a field that sits beside one in the same sheet.
   */
  it("refuses item codes found in the Mobileno column", () => {
    expect(toSaudiPhone("10103514")).toBeNull();
    expect(toSaudiPhone("10611553")).toBeNull();
    // A full item code is nine digits — and starts with 1, not 5.
    expect(toSaudiPhone("106119432")).toBeNull();
  });

  it("refuses invoice, patient and prescription identifiers", () => {
    expect(toSaudiPhone("188767")).toBeNull(); // InvNo
    expect(toSaudiPhone("1001385382")).toBeNull(); // Patient ID, 10 digits
    expect(toSaudiPhone("2460043496")).toBeNull(); // Patient ID
    expect(toSaudiPhone("j8952992")).toBeNull(); // Prescription No
    expect(toSaudiPhone("509226")).toBeNull(); // customer Id
  });

  it("refuses a nine-digit identifier that does not start with a mobile prefix", () => {
    // This is the case that makes "prepend 0 to any 9 digits" dangerous.
    expect(toSaudiPhone("123456789")).toBeNull();
    expect(toSaudiPhone("100138538")).toBeNull();
  });

  it("refuses dates and times that reach a phone field", () => {
    expect(toSaudiPhone("46266")).toBeNull();
    expect(toSaudiPhone("2026-09-01")).toBeNull();
    expect(toSaudiPhone("12:15")).toBeNull();
  });
});

describe("the Saudi mobile prefix rule", () => {
  it("accepts every assigned prefix", () => {
    for (const p of ["050", "053", "054", "055", "056", "057", "058", "059"]) {
      const number = `${p}4630565`;
      expect(toSaudiPhone(number), number).toBe(number);
    }
  });

  it("refuses 051 and 052, which Saudi Arabia does not assign to mobile", () => {
    // 251 and 3 occurrences respectively across the three workbooks, against
    // more than a thousand for every assigned prefix. They are typos, and
    // `0510735627` corrected by guessing would be somebody else's number.
    expect(normalizeSaudiPhone("0510735627").rejection).toBe("not_mobile");
    expect(normalizeSaudiPhone("0522975583").rejection).toBe("not_mobile");
  });

  it("refuses landlines", () => {
    // Real: Riyadh landlines in the Mobileno column.
    expect(normalizeSaudiPhone("0114615153").rejection).toBe("not_mobile");
    expect(normalizeSaudiPhone("0111993377").rejection).toBe("not_mobile");
    expect(normalizeSaudiPhone("+966114615153").rejection).toBe("not_mobile");
  });

  it("refuses the other stray prefixes the data contains", () => {
    for (const n of ["0258147369", "0283777282", "0912395518", "0932172214"]) {
      expect(normalizeSaudiPhone(n).rejection, n).toBe("not_mobile");
    }
  });
});

describe("deduplication", () => {
  it("collapses every representation to one comparison value", () => {
    const forms = [
      "504630565",
      "0504630565",
      "966504630565",
      "+966504630565",
      "00966504630565",
      "050-463-0565",
      "050 463 0565",
      "050,463,0565",
      "+966 50 463 0565",
      "00966 50 463 0565",
      "٠٥٠٤٦٣٠٥٦٥",
      504630565,
      966504630565,
    ];
    const canonical = new Set(forms.map((f) => toSaudiPhone(f)));
    expect(canonical.size).toBe(1);
    expect([...canonical][0]).toBe(CANONICAL);

    const keys = new Set(forms.map((f) => phoneKeyPart(toSaudiPhone(f))));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("504630565");
  });

  it("gives an unusable value an empty key, so nothing merges on it", () => {
    // The crucial one: 88,096 rows in the July extract have no usable number.
    // They must not all share a key.
    expect(phoneKeyPart(toSaudiPhone("0000"))).toBe("");
    expect(phoneKeyPart(toSaudiPhone("0"))).toBe("");
    expect(phoneKeyPart(null)).toBe("");
  });

  it("does not collapse two different subscribers", () => {
    expect(toSaudiPhone("0504630565")).not.toBe(toSaudiPhone("0504630566"));
  });
});

describe("several numbers in one cell", () => {
  it("keeps a single spaced number whole", () => {
    const r = extractSaudiPhones("050 463 0565");
    expect(r.phone).toBe(CANONICAL);
    expect(r.alternates).toEqual([]);
  });

  it("separates two numbers", () => {
    const r = extractSaudiPhones("0504630565 / 0533007995");
    expect(r.phone).toBe("0504630565");
    expect(r.alternates).toEqual(["0533007995"]);
  });

  it("pulls a number out of Arabic prose without promoting it silently", () => {
    // Real, from the Retention sheet: "the number of the customer's wife, who
    // uses the injections". The caller decides what to do with it; this only
    // finds it.
    const r = extractSaudiPhones("0509736898 رقم زوجه العميل اللي تستخدم الابر");
    expect(r.phone).toBe("0509736898");
  });

  it("pulls a number out of a Wasfaty note", () => {
    // Real, from `Wasfaty Aug`.
    expect(extractSaudiPhones("538659783 في انتظار الموقع ").phone).toBe("0538659783");
    expect(extractSaudiPhones("533007995").phone).toBe("0533007995");
  });

  it("de-duplicates one number written twice", () => {
    const r = extractSaudiPhones("0504630565, +966504630565");
    expect(r.phone).toBe(CANONICAL);
    expect(r.alternates).toEqual([]);
  });

  it("finds nothing in a note that holds no number", () => {
    const r = extractSaudiPhones("تم الاتصال مرتين");
    expect(r.phone).toBeNull();
    expect(r.alternates).toEqual([]);
  });

  it("ignores a time or a value that is not a number", () => {
    expect(extractSaudiPhones("15:43").phone).toBeNull();
    expect(extractSaudiPhones("0.540277778").phone).toBeNull();
    expect(extractSaudiPhones("").rejection).toBe("empty");
  });
});

describe("presentation", () => {
  it("displays the canonical form and nothing else", () => {
    expect(formatSaudiPhone(CANONICAL)).toBe(CANONICAL);
    expect(formatSaudiPhone(null)).toBe("—");
    expect(formatSaudiPhone("+966504630565")).toBe("—");
  });

  it("dials in E.164, which is a protocol value rather than a stored one", () => {
    expect(telHref(CANONICAL)).toBe("tel:+966504630565");
    expect(telHref(null)).toBeNull();
    expect(toE164(CANONICAL)).toBe("+966504630565");
    expect(toE164("0000")).toBeNull();
  });

  it("recognises its own canonical form", () => {
    expect(isSaudiMobile(CANONICAL)).toBe(true);
    expect(isSaudiMobile("504630565")).toBe(false);
    expect(isSaudiMobile("+966504630565")).toBe(false);
    expect(isSaudiMobile("0510735627")).toBe(false);
    expect(isSaudiMobile(null)).toBe(false);
  });
});

describe("idempotence", () => {
  it("normalising a canonical number changes nothing", () => {
    const once = toSaudiPhone("+966 50 463 0565")!;
    expect(toSaudiPhone(once)).toBe(once);
    expect(toSaudiPhone(toSaudiPhone(once))).toBe(once);
  });
});
