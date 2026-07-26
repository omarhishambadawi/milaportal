/**
 * The import contract.
 *
 * `TEMPLATE_COLUMNS` is the single definition of the upload format: the
 * downloadable template is generated from it, the parser resolves the uploaded
 * file's headers against it, and the preview lists missing columns from it.
 * Adding a field to the directory means adding one entry here, not editing
 * three files that have to agree.
 */

export interface TemplateColumn {
  /** Header text written into the generated template. */
  header: string;
  /**
   * Other spellings accepted from an uploaded file. These are not speculative:
   * the current master sheet writes the hours column as "Start - End" and puts
   * a trailing newline inside "Scooter\n", and older copies of the same sheet
   * label the maps link "Location".
   */
  aliases?: string[];
  required?: boolean;
  width: number;
  note: string;
}

export const TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    header: "Branch Code",
    aliases: ["branch no", "branch id", "branch", "code"],
    required: true,
    width: 14,
    note: "Unique. Pharmacies use P0001…P9999; facility rows may use a name.",
  },
  {
    header: "Phone No",
    aliases: ["phone", "branch phone", "telephone", "mobile"],
    width: 16,
    note: "Saudi number. 9 digits (599089497), 05… or +966… all accepted.",
  },
  {
    header: "City",
    aliases: ["city name", "region"],
    required: true,
    width: 14,
    note: "Arabic or English. Used for the city filter chips.",
  },
  {
    header: "Scooter",
    aliases: ["scooter availability", "delivery"],
    width: 18,
    note: "Free text. Anything naming a سكوتر / دباب / توصيل counts as available.",
  },
  {
    header: "Area Manager",
    aliases: ["manager", "area mgr"],
    width: 26,
    note: "Full name as it should appear on the card.",
  },
  {
    header: "Area Manager Contact Number",
    aliases: ["area manager phone", "manager contact", "manager phone"],
    width: 24,
    note: "Same phone formats as the branch number.",
  },
  { header: "Email", aliases: ["e-mail", "branch email"], width: 30, note: "Branch mailbox." },
  {
    header: "Address",
    aliases: ["adress", "full address", "street"],
    width: 44,
    note: "Written address, shown on the card and searched.",
  },
  {
    header: "Location",
    aliases: ["google maps", "maps url", "map link", "google maps link"],
    width: 40,
    note: "Google Maps link. Optional — a link is built from the coordinates when absent.",
  },
  {
    header: "Latitude",
    aliases: ["lat"],
    width: 14,
    note: "Decimal degrees, e.g. 24.5372826. Required to appear on the map.",
  },
  {
    header: "Longitude",
    aliases: ["longitude", "long", "lng", "lon", "log"],
    width: 14,
    note: "Decimal degrees, e.g. 46.6456098.",
  },
  {
    header: "Duty Hours",
    aliases: ["duty", "open hours", "hours per day"],
    width: 12,
    note: "Optional. Leave blank and it is calculated from Start - End.",
  },
  {
    header: "Start - End",
    aliases: ["working hours", "start-end", "duty time", "opening hours"],
    width: 34,
    note: 'Daily opening, e.g. "07 AM - 03 AM". Join split shifts with "&" or "THEN".',
  },
  {
    header: "Friday Duty",
    aliases: ["friday", "friday hours"],
    width: 26,
    note: 'Friday opening, e.g. "01 PM - 01 AM".',
  },
];

/** Header spellings → canonical template header, all pre-normalized. */
export const HEADER_LOOKUP: Map<string, string> = (() => {
  const lookup = new Map<string, string>();
  for (const column of TEMPLATE_COLUMNS) {
    lookup.set(normalizeHeader(column.header), column.header);
    for (const alias of column.aliases ?? []) lookup.set(normalizeHeader(alias), column.header);
  }
  return lookup;
})();

/**
 * Fold a header cell so cosmetic differences stop mattering.
 *
 * The live master sheet's Scooter header is literally "Scooter\n" — a trailing
 * newline from someone pressing Alt+Enter in the cell. Matching headers by
 * exact string would drop that entire column and silently import every branch
 * as having no scooter.
 */
export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const REQUIRED_COLUMNS = TEMPLATE_COLUMNS.filter((c) => c.required).map((c) => c.header);

/** Sheet the parser prefers when a workbook holds several. */
export const PREFERRED_SHEET_NAME = "Branches";

/** File name of the generated template. */
export const TEMPLATE_FILE_NAME = "milaserv-branch-directory-template.xlsx";

/** localStorage keys for the per-user, per-device conveniences. */
export const FAVOURITES_KEY = "milaserv.branches.favourites";
export const RECENT_SEARCHES_KEY = "milaserv.branches.recent";
export const RECENT_BRANCHES_KEY = "milaserv.branches.recent-branches";
/** Remembered map width, as a percentage of the split. */
export const MAP_WIDTH_KEY = "milaserv.branches.map-width";
export const MAP_VISIBLE_KEY = "milaserv.branches.map";
export const MAX_RECENT_SEARCHES = 6;
/**
 * Branches kept in the "recently viewed" row.
 *
 * Six, to match the recent searches and because the row has to survive on one
 * line of a laptop screen. It is a shortcut back to the call you just took, not
 * a history feature.
 */
export const MAX_RECENT_BRANCHES = 6;

/** Default share of the split the map takes, as a percentage. */
export const MAP_DEFAULT_WIDTH = 28;
export const MAP_MIN_WIDTH = 18;
export const MAP_MAX_WIDTH = 55;
