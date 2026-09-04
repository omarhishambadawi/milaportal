import type { Field } from "./parse";
import type { SourceType } from "./types";

/**
 * The MilaPortal Telesales import templates.
 *
 * ===========================================================================
 * Why a template rather than better guessing
 * ===========================================================================
 * The importer maps a spreadsheet by matching header text against
 * `HEADER_ALIASES`, and it is good at the three workbooks it was written
 * against. What it cannot do is tell the operator, *before* they upload, which
 * columns it needs — so a file that omits `Prescription No`, or spells the
 * dispense date a fourth way, imports cleanly and then generates nothing, and
 * nobody finds out until they count the leads.
 *
 * The live Wasfaty file is precisely that case. It carries `raw fill date` and
 * no next-dispense column at all, so the importer fell back to the fill date —
 * a *past* event — and then applied a *forward* today-and-tomorrow window to it.
 * The window is correct and the column is the wrong one to point it at. A
 * template with an explicit `Next Dispense Date` removes the ambiguity at the
 * only point where it can be removed: before the file is written.
 *
 * ===========================================================================
 * The headers are the parser's own
 * ===========================================================================
 * Every `header` below is a string that appears in `HEADER_ALIASES`, and a test
 * asserts it — so a template cannot drift into naming a column the importer
 * does not recognise. That is the whole reliability claim: a file built from
 * these headers maps deterministically, with no guessing and no manual step.
 *
 * They are also ordinary business words. Nothing here exposes a database column
 * name, because the person filling the sheet is a pharmacy operator, not a
 * developer.
 *
 * ===========================================================================
 * A convenience, never a requirement
 * ===========================================================================
 * External files keep working exactly as they do now. The template is the
 * reliable path, not the only one — the importer still accepts any spreadsheet
 * whose headers it recognises, and the mapping report says what it found.
 */

/* ------------------------------------------------------------------------- */
/* The shape of a template                                                   */
/* ------------------------------------------------------------------------- */

export type TemplateFieldType = "text" | "number" | "date" | "time" | "phone";

export interface TemplateColumn {
  /** The header text written into the sheet. Must be a `HEADER_ALIASES` key. */
  header: string;
  /** The field it maps to, so the UI can show the mapping without parsing. */
  field: Field;
  required: boolean;
  type: TemplateFieldType;
  /** What this column is for, in the operator's terms. */
  description: string;
  /** A realistic value, written into the example row. */
  example: string;
}

export interface ImportTemplate {
  sourceType: SourceType;
  title: string;
  /** What this pipeline calls about, and when. */
  purpose: string;
  /** The rule that decides which rows become leads, stated plainly. */
  eligibility: string;
  fileName: string;
  columns: TemplateColumn[];
}

/** Dates are unambiguous only if the format is stated. ISO, and the importer
 *  also accepts Excel's own date cells. */
export const TEMPLATE_DATE_FORMAT = "YYYY-MM-DD";

/** The canonical Saudi mobile format the phone module produces. */
export const TEMPLATE_PHONE_FORMAT = "05XXXXXXXX";

/* ------------------------------------------------------------------------- */
/* Cash                                                                      */
/* ------------------------------------------------------------------------- */

const CASH: ImportTemplate = {
  sourceType: "cash",
  title: "Cash",
  purpose:
    "Walk-in and cash invoices. The desk calls the customer while the branch is still holding the item.",
  eligibility:
    "A row becomes a lead when its invoice date falls in the Cash window (the last 3 days, ending 1 day before today), the product is one the desk works, and the row identifies a customer.",
  fileName: "MilaPortal-Telesales-Cash-Template.xlsx",
  columns: [
    {
      header: "Invoice Date",
      field: "sourceDate",
      required: true,
      type: "date",
      description: "The date on the invoice. This is what the Cash window is measured against.",
      example: "2026-09-02",
    },
    {
      header: "Item Code",
      field: "itemCode",
      required: true,
      type: "text",
      description:
        "The pharmacy's catalogue code for the product. Used to decide whether the desk works this product.",
      example: "10611028",
    },
    {
      header: "Item Name",
      field: "itemName",
      required: true,
      type: "text",
      description:
        "The product name, exactly as the catalogue spells it. Used when the item code is one the catalogue does not carry.",
      example: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
    },
    {
      header: "Customer ID",
      field: "customerRef",
      required: false,
      type: "text",
      description:
        "The pharmacy's own customer reference. One of Customer ID, Customer Name or Phone must be present.",
      example: "437812",
    },
    {
      header: "Customer Name",
      field: "customerName",
      required: false,
      type: "text",
      description: "The customer's name, for the agent to greet them by.",
      example: "Ahmed Al-Otaibi",
    },
    {
      header: "Phone",
      field: "phone",
      required: false,
      type: "phone",
      description: `The customer's mobile number, ${TEMPLATE_PHONE_FORMAT}. A row with no number is still a lead; the branch usually holds the details.`,
      example: "0504630565",
    },
    {
      header: "Branch",
      field: "branchNo",
      required: false,
      type: "text",
      description:
        "The branch holding the reservation. The same product for one customer at two branches is two leads.",
      example: "P0001",
    },
    {
      header: "City",
      field: "city",
      required: false,
      type: "text",
      description: "The branch city, for filtering the queue.",
      example: "Riyadh",
    },
    {
      header: "Invoice No",
      field: "documentNo",
      required: false,
      type: "text",
      description: "The invoice number, used to reconcile the lead against the invoice later.",
      example: "188767",
    },
    {
      header: "Quantity",
      field: "quantity",
      required: false,
      type: "number",
      description: "How many units were sold.",
      example: "1",
    },
    {
      header: "Total Value",
      field: "totalValue",
      required: false,
      type: "number",
      description: "The line total in SAR.",
      example: "1050.00",
    },
  ],
};

/* ------------------------------------------------------------------------- */
/* Retention                                                                 */
/* ------------------------------------------------------------------------- */

const RETENTION: ImportTemplate = {
  sourceType: "retention",
  title: "Retention",
  purpose:
    "Customers due another dose. Imported as a backlog: every row becomes a lead immediately, carrying the callback the desk already promised.",
  eligibility:
    "Every row with a product the desk refills and something identifying the customer becomes a lead. No date window applies — the backlog is taken as it stands, including the overdue part.",
  fileName: "MilaPortal-Telesales-Retention-Template.xlsx",
  columns: [
    {
      header: "Item Code",
      field: "itemCode",
      required: true,
      type: "text",
      description:
        "The pharmacy's catalogue code. Decides the refill cycle and whether the product is refillable at all.",
      example: "10611028",
    },
    {
      header: "Item Name",
      field: "itemName",
      required: true,
      type: "text",
      description:
        "The product name as the catalogue spells it. Used when the item code is not one the catalogue carries.",
      example: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
    },
    {
      header: "Phone",
      field: "phone",
      required: false,
      type: "phone",
      description: `The customer's mobile, ${TEMPLATE_PHONE_FORMAT}. One of Phone, Customer ID or Customer Name must be present.`,
      example: "0504630565",
    },
    {
      header: "Customer ID",
      field: "customerRef",
      required: false,
      type: "text",
      description: "The pharmacy's own customer reference.",
      example: "437812",
    },
    {
      header: "Customer Name",
      field: "customerName",
      required: false,
      type: "text",
      description: "The customer's name.",
      example: "Ahmed Al-Otaibi",
    },
    {
      header: "Date to be called",
      field: "callbackDate",
      required: false,
      type: "date",
      description:
        "A callback the desk has already promised. Becomes a real scheduled follow-up on the lead. Leave blank if none was agreed.",
      example: "2026-09-15",
    },
    {
      header: "Invoice Date",
      field: "sourceDate",
      required: false,
      type: "date",
      description: "The date of the purchase this refill follows.",
      example: "2026-08-05",
    },
    {
      header: "Branch",
      field: "branchNo",
      required: false,
      type: "text",
      description: "The branch the customer buys from.",
      example: "P0001",
    },
    {
      header: "City",
      field: "city",
      required: false,
      type: "text",
      description: "The branch city.",
      example: "Riyadh",
    },
    {
      header: "Invoice No",
      field: "documentNo",
      required: false,
      type: "text",
      description:
        "The invoice number. Only used to tell two anonymous walk-ins apart when there is no usable phone.",
      example: "188767",
    },
    {
      header: "Action",
      field: "actionLabel",
      required: false,
      type: "text",
      description:
        "The outcome the desk already recorded for this row, if any. Imported as history, never as an instruction.",
      example: "Answered - Order Created",
    },
    {
      header: "Notes",
      field: "notes",
      required: false,
      type: "text",
      description: "Anything the agent wrote about this customer.",
      example: "Prefers a call after 6pm",
    },
  ],
};

/* ------------------------------------------------------------------------- */
/* Wasfaty                                                                   */
/* ------------------------------------------------------------------------- */

const WASFATY: ImportTemplate = {
  sourceType: "wasfaty",
  title: "Wasfaty",
  purpose:
    "Wasfaty prescriptions becoming collectable. The desk calls ahead of the date so the patient knows it is ready.",
  eligibility:
    "A row becomes a lead when its Next Dispense Date is today or tomorrow and it carries a Patient ID or a Prescription No. Rows dated further ahead become eligible on their own date; rows dated in the past do not become leads.",
  fileName: "MilaPortal-Telesales-Wasfaty-Template.xlsx",
  columns: [
    {
      /*
       * The column this template exists for.
       *
       * The live file carried `raw fill date` and no next-dispense column, so
       * the importer fell back to the fill date and the forward window was
       * applied to a backward-looking field. 3,721 of 3,937 rows landed in the
       * past as a result. Naming this column explicitly is the fix.
       */
      header: "Next Dispense Date",
      field: "nextDispenseDate",
      required: true,
      type: "date",
      description:
        "The date the prescription becomes collectable — NOT the date it was last filled. This is what the today-and-tomorrow window is measured against, so a fill date here will produce no leads.",
      example: "2026-09-04",
    },
    {
      header: "Patient ID",
      field: "patientId",
      required: true,
      type: "text",
      description:
        "The Wasfaty patient identifier. Used to look the patient's number up and to carry a found number forward to their next prescription.",
      example: "1098765432",
    },
    {
      header: "Prescription No",
      field: "prescriptionNo",
      required: true,
      type: "text",
      description:
        "The prescription number, starting with a lowercase letter (a123456). This is the lead's identity — the same prescription never becomes two leads. Case matters: it is not corrected on import, because A123456 may not be the same prescription as a123456.",
      example: "a8952992",
    },
    {
      header: "Patient Name",
      field: "customerName",
      required: false,
      type: "text",
      description: "The patient's name, for the agent to greet them by.",
      example: "Ahmed Al-Otaibi",
    },
    {
      header: "Phone",
      field: "phone",
      required: false,
      type: "phone",
      description: `The patient's mobile, ${TEMPLATE_PHONE_FORMAT}. Usually blank — finding the number is the agent's job, and a row without one is still a lead.`,
      example: "0504630565",
    },
    {
      header: "Branch",
      field: "branchNo",
      required: false,
      type: "text",
      description: "The pharmacy the prescription is assigned to.",
      example: "P0001",
    },
    {
      header: "City",
      field: "city",
      required: false,
      type: "text",
      description: "The pharmacy's city.",
      example: "Riyadh",
    },
    {
      header: "Fill Date",
      field: "fillDate",
      required: false,
      type: "date",
      description:
        "When the prescription was last dispensed. Recorded for reference; it is never used to decide eligibility.",
      example: "2026-08-07",
    },
    {
      header: "Dispense Time",
      field: "dispenseTime",
      required: false,
      type: "time",
      description: "The time of day the prescription opens, if the portal gives one.",
      example: "09:30",
    },
    {
      header: "Total Value",
      field: "totalValue",
      required: false,
      type: "number",
      description: "The prescription value in SAR.",
      example: "1050.00",
    },
  ],
};

/* ------------------------------------------------------------------------- */
/* The registry                                                              */
/* ------------------------------------------------------------------------- */

export const IMPORT_TEMPLATES: Record<SourceType, ImportTemplate> = {
  cash: CASH,
  retention: RETENTION,
  wasfaty: WASFATY,
};

export const TEMPLATE_ORDER: SourceType[] = ["cash", "retention", "wasfaty"];

export function templateFor(sourceType: SourceType): ImportTemplate {
  return IMPORT_TEMPLATES[sourceType];
}

/** The headers a template writes, in order. */
export function templateHeaders(template: ImportTemplate): string[] {
  return template.columns.map((c) => c.header);
}

/** The example row, in the same order as the headers. */
export function templateExampleRow(template: ImportTemplate): string[] {
  return template.columns.map((c) => c.example);
}

export function requiredColumns(template: ImportTemplate): TemplateColumn[] {
  return template.columns.filter((c) => c.required);
}

/* ------------------------------------------------------------------------- */
/* Validating a mapping against a template                                   */
/* ------------------------------------------------------------------------- */

export interface MappingCheck {
  /** Template columns the uploaded file supplied. */
  matched: TemplateColumn[];
  /** Required template columns the file did not supply. */
  missingRequired: TemplateColumn[];
  /** Optional template columns the file did not supply. Not a problem. */
  missingOptional: TemplateColumn[];
  /** True when every required column is present. */
  ok: boolean;
}

/**
 * Which template columns a parsed file actually provided.
 *
 * Takes the `Field` set the parser resolved rather than the raw headers, so an
 * external file that spells a column differently but maps to the same field
 * counts as supplying it. The template is a reliability aid; it must not refuse
 * a file that the importer understands perfectly well.
 */
export function checkMapping(
  template: ImportTemplate,
  presentFields: ReadonlySet<Field>,
): MappingCheck {
  const matched: TemplateColumn[] = [];
  const missingRequired: TemplateColumn[] = [];
  const missingOptional: TemplateColumn[] = [];

  for (const column of template.columns) {
    if (presentFields.has(column.field)) matched.push(column);
    else if (column.required) missingRequired.push(column);
    else missingOptional.push(column);
  }

  return { matched, missingRequired, missingOptional, ok: missingRequired.length === 0 };
}

/**
 * The Wasfaty date trap, detected rather than described.
 *
 * A Wasfaty file that supplies a fill date and no next-dispense date parses
 * cleanly and then generates almost nothing, because the forward window is
 * being applied to a backward-looking column. It is the single most expensive
 * mapping mistake this module has actually seen, so it is worth its own warning
 * rather than being left to the missing-column list.
 */
export function wasfatyUsesFillDateFallback(presentFields: ReadonlySet<Field>): boolean {
  return presentFields.has("fillDate") && !presentFields.has("nextDispenseDate");
}
