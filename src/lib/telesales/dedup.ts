import type { LeadType, SourceRecordInput } from "./types";

/**
 * Deduplication.
 *
 * The single rule that decides whether re-uploading a file doubles the desk's
 * workload. It is expressed here as a pure function producing a string, which
 * the database then enforces through `UNIQUE (lead_type, dedup_key)` — the
 * generator does not check for duplicates and then insert, it inserts and lets
 * the index refuse. That ordering matters: a check-then-insert is a race, and
 * the generator is going to be run twice at once the first time somebody presses
 * the button while the cron job is mid-flight.
 *
 * ### The key is different for each pipeline, because identity is
 *
 * There is no universal "same lead". A Cash opportunity is a customer wanting a
 * particular product from a particular branch on a particular day; a Wasfaty one
 * is a prescription; a retention one is a cycle. Using one key for all three
 * would either merge distinct work or split identical work, and the workbooks
 * contain examples of both being expensive.
 */

/**
 * Everything a key is built from is normalised first.
 *
 * The workbooks make this non-optional. `Prescription No` appears as `j8952992`
 * and `J8952992`; `Mobileno` as `0535323292`, `535323292` and `563499119`;
 * `Itm_Cd` sometimes carries a trailing space. Two spellings of one identifier
 * would otherwise be two leads, which is exactly the duplicate the module exists
 * to prevent.
 */
function norm(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Saudi mobile numbers, reduced to a comparable form.
 *
 * The extracts carry `0535323292`, `535323292`, `9.66555E+11` (Excel having
 * decided a phone number was a float) and `0`. This keeps digits only, strips a
 * `966` country prefix and a leading `0`, and returns `""` for anything that
 * cannot be a subscriber number — which then makes the caller fall back to a
 * different discriminator rather than keying thousands of leads on the empty
 * string.
 *
 * `REFUSED TO GET MOBILE NUMBER` rows carry `0`, `0000` or `m`, all of which
 * land here as `""`. They are real leads with no number, and they must not
 * collapse into one another.
 */
export function normalizePhone(value: string | number | null | undefined): string {
  if (value == null) return "";
  let digits = String(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.startsWith("966")) digits = digits.slice(3);
  digits = digits.replace(/^0+/, "");
  // A Saudi mobile is 9 digits beginning 5. Anything shorter is a placeholder,
  // anything much longer is Excel's scientific notation having lost precision.
  if (digits.length < 9 || digits.length > 12) return "";
  return digits;
}

/** `+9665XXXXXXXX`, or null. The stored form; `normalizePhone` is the compared
 *  form. Separate because a display number and a key have different jobs. */
export function toE164(value: string | number | null | undefined): string | null {
  const digits = normalizePhone(value);
  if (!digits) return null;
  return `+966${digits}`;
}

/**
 * The Cash key: **customer + product + branch + invoice date**.
 *
 * All four are load-bearing, and the workbooks show why:
 *
 *   - **customer** — the identity being called. `Id` where the extract has one,
 *     otherwise the phone, otherwise the name. The fallback chain matters:
 *     the `13` sheet uses `Id`, sheets `3-4` and `5-6` do not have that column
 *     at all, and 36 rows across the workbook are `REFUSED TO GET MOBILE NUMBER`
 *     with no usable number.
 *
 *   - **product** — one customer buying Mounjaro and FreeStyle Libre on one
 *     invoice is two conversations with two prices. The July working sheets
 *     carry both rows, separately, and so does the queue.
 *
 *   - **branch** — the same product for the same customer at two branches is two
 *     reservations, each held for three days by a different pharmacy. Merging
 *     them would silently drop one branch's stock commitment.
 *
 *   - **invoice date** — this is what makes a *repeat* purchase a new lead. A
 *     customer who bought Mounjaro on 3 July and again on 29 July is two
 *     opportunities; keying without the date would make the second invisible.
 *
 * The invoice number is deliberately **not** in the key — for a customer who can
 * actually be telephoned. It is what an operator would reach for first, and for
 * them it is wrong: it makes the key unstable across extracts (the same purchase
 * can be re-issued under a corrected document number) while adding nothing the
 * other four do not already separate. Verified on the real extract: customer
 * 69732 bought Mounjaro 12.5 MG at P0202 on 30 July under invoices 271460 and
 * 271474, has the phone 0508626771, and is one call.
 *
 * ### The anonymous customer, which is half the file
 *
 * `Id` is not a person. In the July extract, **83,634 of 173,008 rows share the
 * single id 437745**, named `REFUSED TO GET MOBILE NUMBER` and phoned `0000` —
 * the walk-in placeholder. Across the whole file 88,096 rows have no usable
 * number and they carry just 139 distinct ids between them.
 *
 * Keying those on the customer would merge every anonymous walk-in who bought
 * the same product at the same branch on the same day into one lead, and the
 * queue would then disagree with the pharmacy's own sales figures for reasons
 * nobody could reconstruct.
 *
 * So the discriminator is **the usable phone number**, not the id: a row that
 * cannot be dialled has no telesales identity to merge on, and its transaction
 * is identified by its document number instead. The instability that argument
 * rejected above does not apply to it — an uncallable lead re-keyed by a
 * corrected invoice number costs one duplicate row that nobody was going to
 * ring, which is a great deal cheaper than silently collapsing 83,634 rows.
 */
function cashKey(record: SourceRecordInput): string {
  const phone = normalizePhone(record.phoneE164 ?? record.phoneRaw);
  if (phone) {
    return [
      "cash",
      phone,
      norm(record.itemCode) || norm(record.itemName),
      norm(record.branchNo),
      record.sourceDate ?? "nodate",
    ].join("|");
  }

  /*
   * No number. The document is the identity of the transaction, and
   * `contentHash` is the last resort for a row that has neither — which keeps
   * two such rows apart rather than collapsing them onto one another.
   */
  return [
    "cash",
    "anon",
    norm(record.customerRef) || norm(record.customerName) || "unknown",
    norm(record.itemCode) || norm(record.itemName),
    norm(record.branchNo),
    record.sourceDate ?? "nodate",
    norm(record.documentNo) || record.contentHash,
  ].join("|");
}

/**
 * The Wasfaty key: **patient + prescription**.
 *
 * The operationally used pair, and the data supports it. Across the eight sheets
 * the pair is near-unique where the row is real: `Riyadh` has 3,617 distinct
 * pairs in 3,650 rows, `Wasfaty Aug` 3,910 in 3,952. Patient alone is not a key
 * — 333 patients in `Riyadh` hold more than one prescription, which is the
 * ordinary case of somebody on two medications.
 *
 * The remaining duplicates are the point: 165 repeated pairs in `Wasfaty Sep`,
 * 184 in `Taif`. Those are the same prescription listed twice, which under the
 * spreadsheet became two rows and, often enough, two calls. Here the second
 * insert collides with the unique index and is counted rather than queued.
 *
 * The *medication* is not in the key. One prescription can carry several items,
 * and it is dispensed as one visit and sold in one call — keying by item would
 * turn one conversation into three.
 *
 * The date is not in the key either, which is the deliberate difference from
 * Cash: a prescription's next-dispense date moves as it is refilled, and a lead
 * whose key changed when the date shifted would reappear as a new lead every
 * time the source file was refreshed. Re-importing next month's file for the
 * same prescription is the *same* lead until it is closed; a genuinely new cycle
 * arrives as a retention lead with its own cycle number.
 */
function wasfatyKey(record: SourceRecordInput): string {
  const patient = norm(record.patientId);
  const prescription = norm(record.prescriptionNo);
  if (patient && prescription) return ["wasfaty", patient, prescription].join("|");
  /*
   * A row missing one half of the pair.
   *
   * It still has to get a key, and that key must not collide with another such
   * row. Falling back to the content hash makes each one distinct — so the row
   * becomes a lead an agent can look at and fix, rather than being silently
   * merged into whichever other broken row shared its blanks.
   */
  return ["wasfaty", "partial", patient || "-", prescription || "-", record.contentHash].join("|");
}

/**
 * The Retention key: **customer + product + cycle**.
 *
 * A retention lead is a refill cycle, so the cycle number is what distinguishes
 * the third repeat from the second. Without it, generating cycle 3 for a
 * customer would collide with cycle 2 and the desk would stop following up
 * anybody who had already been followed up once — which is precisely the failure
 * mode of a spreadsheet where a row is edited in place.
 *
 * The branch is not in the key. A retention conversation is about the customer's
 * next dose, and by the time it happens they may well collect from a different
 * pharmacy; treating that as a second lead would double-call them.
 *
 * The phone is the identity here for the same reason it is in `cashKey`: a
 * retention lead that cannot be dialled is not a refill conversation, and the
 * anonymous walk-in placeholder would otherwise collapse every such row for one
 * product into a single cycle. A cycle raised from a *conversion* always has a
 * number — somebody spoke to them — so this fallback only ever fires for the
 * one-time workbook backlog.
 */
function retentionKey(input: {
  customerRef: string | null;
  phone: string | null;
  customerName: string | null;
  itemCode: string | null;
  itemName: string | null;
  cycleNumber: number;
  /** The originating invoice, used only when there is no usable number. */
  documentNo?: string | null;
}): string {
  const cycle = `c${Math.max(1, Math.trunc(input.cycleNumber))}`;
  const product = norm(input.itemCode) || norm(input.itemName);
  const phone = normalizePhone(input.phone);
  if (phone) return ["retention", phone, product, cycle].join("|");

  return [
    "retention",
    "anon",
    norm(input.customerRef) || norm(input.customerName) || "unknown",
    product,
    cycle,
    norm(input.documentNo) || "-",
  ].join("|");
}

/** The key for a lead generated from an imported source row. */
export function dedupKeyForSource(leadType: LeadType, record: SourceRecordInput): string {
  return leadType === "wasfaty" ? wasfatyKey(record) : cashKey(record);
}

/** The key for the next retention cycle of an existing lead. */
export function dedupKeyForRetention(input: {
  customerRef: string | null;
  phone: string | null;
  customerName: string | null;
  itemCode: string | null;
  itemName: string | null;
  cycleNumber: number;
  documentNo?: string | null;
}): string {
  return retentionKey(input);
}

/**
 * Identity of a *source row*, independent of which file carried it.
 *
 * Distinct from the lead key and used for a different question. The lead key
 * asks "is this the same opportunity"; this asks "is this literally the same row
 * again", which is what an overlapping re-upload produces and what the import
 * summary reports as `rows_duplicate`.
 *
 * The hash is a plain FNV-1a over the identifying fields. It is not a security
 * primitive and is not used as one — it never has to resist an adversary, only
 * to be stable across imports and cheap enough to run 173,008 times. A
 * cryptographic digest here would mean either a Node-only import in a module the
 * browser parses, or an async call in a tight loop.
 */
export function contentHash(fields: readonly (string | number | null | undefined)[]): string {
  const text = fields.map((f) => norm(f)).join("");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // FNV prime, via shifts because `h * 16777619` loses precision past 2^53.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Length is appended so two different strings that collide in 32 bits still
  // differ here more often than not. Cheap, and this is a dedup hint rather
  // than a uniqueness guarantee — the database index is the guarantee.
  return `${h.toString(36)}${text.length.toString(36)}`;
}

/** The digest of a whole parsed workbook, for "you have already uploaded this". */
export function workbookDigest(hashes: readonly string[]): string {
  return contentHash([hashes.length, ...[...hashes].sort()]);
}
