import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowLeft,
  ClipboardList,
  Loader2,
  Phone,
  PhoneCall,
  PhoneOff,
  ShieldAlert,
  UserPlus,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { fmtSAR } from "@/lib/branches";
import { PHONE_REJECTION_LABELS, normalizeSaudiPhone, toSaudiPhone } from "@/lib/phone";
import { LeadCallLookup } from "@/features/telesales/components/lead-call-lookup";
import { hasPerm } from "@/lib/permissions";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { businessToday, describeDue, formatBusinessDate } from "@/lib/telesales/dates";
import { familyLabel } from "@/lib/telesales/products";
import {
  ACTIVITY_LABELS,
  LEAD_STATUS_LABELS,
  LEAD_TYPE_LABELS,
  OUTCOME_BY_KEY,
  type ActivityType,
} from "@/lib/telesales/types";
import { LeadStockPanel } from "@/features/telesales/components/lead-stock-panel";
import { MisCustomerPanel } from "@/features/telesales/components/mis-customer-panel";
import { OutcomeDialog } from "@/features/telesales/components/outcome-dialog";
import { useCustomerIntelligence } from "@/features/telesales/hooks/use-customer-intelligence";
import { useLeadStock } from "@/features/telesales/hooks/use-lead-verification";
import {
  DUE_TONE_STYLES,
  LEAD_STATUS_STYLES,
  formatPhone,
  telHref,
} from "@/features/telesales/constants";
import {
  useLeadActivity,
  useLeadDetail,
  useLeadFollowups,
  useLeadMutations,
  usePatientContacts,
} from "@/features/telesales/hooks/use-lead-detail";

export const Route = createFileRoute("/_app/telesales/$id")({
  head: () => ({ meta: [{ title: "Lead — MilaServ Portal" }] }),
  component: LeadDetailPage,
});

function ts(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: BUSINESS_TIMEZONE,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * One lead, everything about it, and everything that can be done to it.
 *
 * The layout answers three questions in order, because that is the order an
 * agent asks them: **who am I calling and about what**, **what happened last
 * time**, and **what do I do now**.
 */
function LeadDetailPage() {
  const { id } = useParams({ from: "/_app/telesales/$id" });
  const { profile, role, session } = useAuth();
  const userId = session?.user?.id;
  const perms = profile?.permissions as string[] | null | undefined;

  const canView = hasPerm(role, perms, "view_telesales");
  const canWork = hasPerm(role, perms, "work_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const lead = useLeadDetail(canView ? id : undefined);
  const activity = useLeadActivity(canView ? id : undefined);
  const followups = useLeadFollowups(canView ? id : undefined);
  const contacts = usePatientContacts(lead.data?.patient_id);
  const mutations = useLeadMutations(id);

  /*
   * Shams MIS for this lead’s customer.
   *
   * Keyed on the phone rather than the lead, so the three leads one customer
   * holds share a single lookup and a single cache entry -- opening the second
   * and third costs no upstream request at all.
   *
   * The lead renders without waiting for it.
   */
  const intel = useCustomerIntelligence(lead.data?.phone, canView);

  /*
   * Branch stock — can this still be fulfilled?
   *
   * One request, on this page only, under the Shams module's own query key, so
   * it shares a cache with the /shams Stock tab. The queue issues none.
   *
   * Invoice verification used to sit beside this and no longer does. It
   * answered "did this lead convert", which is a reporting question the desk
   * reads on the recommendation board, not something an agent needs while a
   * customer is on the line — and it cost a second MIS request on every lead
   * open to render a badge nobody acted on. `telesales_leads.invoice_match_status`
   * and the reconciler behind it are untouched; see the note on the removal in
   * docs/project.md.
   */
  const stockCheck = useLeadStock(
    {
      itemCode: lead.data?.item_code ?? null,
      itemName: lead.data?.item_name ?? null,
      branchNo: lead.data?.branch_no ?? null,
    },
    canView,
  );

  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState("");
  const [phone, setPhone] = useState("");
  const today = businessToday();

  /**
   * The product's refill interval, for the outcome dialog's proposed next date.
   *
   * Read here rather than denormalised onto the lead: a lead is a snapshot of an
   * opportunity, but the refill cycle is current configuration — if the desk
   * changes a sensor from 14 days to 10, the next conversion should propose 10.
   */
  const product = useQuery<number | null>({
    queryKey: ["telesales", "product-refill", lead.data?.item_code],
    enabled: canView && Boolean(lead.data?.item_code),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("telesales_products")
        .select("refill_days")
        .eq("item_code", lead.data!.item_code)
        .maybeSingle();
      return (data as { refill_days: number | null } | null)?.refill_days ?? null;
    },
  });

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Telesales is restricted</p>
      </div>
    );
  }

  if (lead.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the lead…
      </div>
    );
  }

  const l = lead.data;
  if (!l) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm font-medium">This lead no longer exists</p>
        <Button asChild className="mt-4" variant="outline" size="sm">
          <Link to="/telesales">Back to the queue</Link>
        </Button>
      </div>
    );
  }

  const isMine = Boolean(userId && l.assigned_to === userId);
  const isClosed = l.status.startsWith("closed") || l.status === "converted";
  const canAct = canWork && (canManage || isMine || !l.assigned_to);
  const openFollowup = (followups.data ?? []).find((f) => f.status === "scheduled");
  const due = describeDue(openFollowup?.due_on ?? null, today);
  const tel = telHref(l.phone);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/telesales">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Queue
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          {canWork && !l.assigned_to ? (
            <Button
              size="sm"
              variant="outline"
              disabled={mutations.assign.isPending}
              onClick={() => mutations.assign.mutate({ leadId: l.id, assigneeId: userId ?? null })}
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Claim
            </Button>
          ) : null}
          {canManage && l.assigned_to ? (
            <Button
              size="sm"
              variant="outline"
              disabled={mutations.assign.isPending}
              onClick={() => mutations.assign.mutate({ leadId: l.id, assigneeId: null })}
            >
              Unassign
            </Button>
          ) : null}
          {canManage && isClosed ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                mutations.reopen.mutate({ leadId: l.id, reason: "Reopened by a team lead" })
              }
            >
              Reopen
            </Button>
          ) : null}
          {canAct && !isClosed ? (
            <Button size="sm" onClick={() => setRecording(true)}>
              Record outcome
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Who and what */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-lg">
                {l.customer_name || (l.lead_type === "wasfaty" ? "Wasfaty patient" : "No name")}
              </CardTitle>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  LEAD_STATUS_STYLES[l.status],
                )}
              >
                {LEAD_STATUS_LABELS[l.status]}
              </span>
              <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
                {LEAD_TYPE_LABELS[l.lead_type]}
                {l.cycle_number > 1 ? ` · cycle ${l.cycle_number}` : ""}
              </span>
            </div>
            {/*
             * Why this lead exists, in the lead's own words.
             *
             * The single most-requested thing the spreadsheets could not answer:
             * an agent looking at a row had no way to know which filter put it
             * there, and neither did the person who built the sheet.
             */}
            {l.generation_reason ? (
              <p className="text-sm text-muted-foreground">{l.generation_reason}</p>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Field label="Phone">
                {tel ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <a href={tel} className="inline-flex items-center gap-1.5 hover:underline">
                      <Phone className="h-3.5 w-3.5" />
                      {formatPhone(l.phone)}
                    </a>
                    {/*
                     * The call action, made a button rather than left as the
                     * number itself.
                     *
                     * Same `tel:` href and therefore the same mechanism the rest
                     * of the platform uses -- `telHref` is the one place that
                     * builds one, and it emits E.164 because that is what dials
                     * correctly from a softphone or a roaming handset. The
                     * button exists because getting an agent onto a call is what
                     * this page is for, and an underlined number is not an
                     * obvious control.
                     */}
                    <Button asChild size="sm" className="h-7 px-2.5">
                      <a href={tel} aria-label={`Call ${formatPhone(l.phone)}`}>
                        <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                        Call
                      </a>
                    </Button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <PhoneOff className="h-3.5 w-3.5" />
                    Not on file
                  </span>
                )}
              </Field>
              <Field label="Customer">
                {/* The consolidated identity. One customer, several
                    opportunities -- the leads stay separate.

                    A button rather than the text link it was: it is the one
                    navigation an agent makes from this page, and it read as
                    prose beside four static fields. */}
                {l.customer_id ? (
                  <Button asChild size="sm" variant="outline" className="h-7 px-2.5">
                    <Link to="/telesales/customers/$id" params={{ id: l.customer_id }}>
                      <UserRound className="mr-1.5 h-3.5 w-3.5" />
                      View profile
                    </Link>
                  </Button>
                ) : (
                  <span className="text-muted-foreground">Not linked</span>
                )}
              </Field>
              <Field label="Branch">{l.branch_no ?? "—"}</Field>
              <Field label="City">{l.city ?? "—"}</Field>
              <Field label="Product">{l.item_name ?? "—"}</Field>
              <Field label="Family">{familyLabel(l.product_family)}</Field>
              <Field label="Strength">{l.product_strength ?? "—"}</Field>
              <Field label="Source date">{formatBusinessDate(l.source_date)}</Field>
              <Field label="Created">{ts(l.created_at)}</Field>
              <Field label="Value">{l.total_value != null ? fmtSAR(l.total_value) : "—"}</Field>
              {l.lead_type === "wasfaty" ? (
                <>
                  <Field label="Patient ID">
                    <span className="font-mono text-xs">{l.patient_id ?? "—"}</span>
                  </Field>
                  <Field label="Prescription No">
                    <span className="font-mono text-xs">{l.prescription_no ?? "—"}</span>
                  </Field>
                  <Field label="Facility">{l.facility ?? "—"}</Field>
                </>
              ) : (
                <>
                  <Field label="Invoice">{l.document_no ?? "—"}</Field>
                  <Field label="Channel">{l.channel ?? "—"}</Field>
                  <Field label="Quantity">{l.quantity ?? "—"}</Field>
                </>
              )}
            </div>

            {/*
             * The Wasfaty phone workflow.
             *
             * 2,774 of 3,952 rows in the August file have no number, and the
             * agent gets it by looking the patient up in the Wasfaty portal with
             * the two identifiers above. There is no Wasfaty API here and none is
             * assumed — this is that manual lookup, recorded once, so the next
             * prescription for this patient arrives dialable.
             */}
            {l.lead_type === "wasfaty" && !l.phone && canWork ? (
              <div className="rounded-md border border-dashed border-border p-3">
                <p className="text-sm font-medium">Add the phone number</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Look the patient up in the Wasfaty system using the Patient ID and Prescription No
                  above. The number is saved against the patient, so every other prescription for
                  them gets it too.
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-[200px] flex-1 space-y-1.5">
                    <Label htmlFor="ts-phone" className="sr-only">
                      Phone number
                    </Label>
                    <Input
                      id="ts-phone"
                      value={phone}
                      inputMode="tel"
                      placeholder="05XXXXXXXX"
                      onChange={(e) => setPhone(e.target.value)}
                      /*
                       * Normalise on blur, so the agent sees what will be stored
                       * before they commit to it. Pasting `+966 50 463 0565`
                       * from the Wasfaty portal leaves `0504630565` in the box.
                       *
                       * Cosmetic only — the server normalises again and is the
                       * source of truth. This exists so the agent is never
                       * surprised by what the CRM saved.
                       */
                      onBlur={() => setPhone((v) => toSaudiPhone(v) ?? v)}
                    />
                    {phone.trim() && !toSaudiPhone(phone) ? (
                      <p className="text-[11px] text-destructive">
                        {
                          PHONE_REJECTION_LABELS[
                            normalizeSaudiPhone(phone).rejection ?? "no_digits"
                          ]
                        }
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    disabled={!toSaudiPhone(phone) || !l.patient_id || mutations.setPhone.isPending}
                    onClick={() =>
                      mutations.setPhone.mutate(
                        {
                          patientId: l.patient_id!,
                          phone: phone.trim(),
                          leadId: l.id,
                          prescriptionNo: l.prescription_no,
                        },
                        { onSuccess: () => setPhone("") },
                      )
                    }
                  >
                    Save number
                  </Button>
                </div>
              </div>
            ) : null}

            {/*
             * Numbers the source row carried but that are not the customer's.
             *
             * 448 of these exist across the three workbooks — mostly on the four
             * per-city Wasfaty sheets, which have no phone column at all, so
             * agents wrote the number into the note. Before this they were
             * discarded on import.
             *
             * They are shown, never adopted. The Retention sheet's single
             * example is a customer's wife's number, so "found on the row" and
             * "is the customer" are different claims and only a person can turn
             * the first into the second.
             */}
            {(l.phone_alternates ?? []).length > 0 ? (
              <div className="rounded-md border border-dashed border-border p-3">
                <p className="text-sm font-medium">
                  Other number{(l.phone_alternates ?? []).length === 1 ? "" : "s"} on the source row
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Found in the imported file, not confirmed as this customer&apos;s number.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {(l.phone_alternates ?? []).map((alt) => (
                    <li key={alt} className="flex flex-wrap items-center gap-2">
                      <a
                        href={telHref(alt) ?? undefined}
                        className="font-mono text-sm hover:underline"
                      >
                        {formatPhone(alt)}
                      </a>
                      {canWork && l.patient_id ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={mutations.setPhone.isPending}
                          onClick={() =>
                            mutations.setPhone.mutate({
                              patientId: l.patient_id!,
                              phone: alt,
                              leadId: l.id,
                              prescriptionNo: l.prescription_no,
                            })
                          }
                        >
                          Use as the number
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {(contacts.data ?? []).length > 1 ? (
              <div className="rounded-md border border-border p-3">
                <p className="text-xs font-medium">Number history for this patient</p>
                <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
                  {(contacts.data ?? []).map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <span className={cn("font-mono", c.superseded_at && "line-through")}>
                        {formatPhone(c.phone)}
                      </span>
                      <span>· {c.source === "agent" ? "found by an agent" : "from the file"}</span>
                      <span>· {ts(c.added_at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {canWork ? (
              <div className="space-y-2">
                <Label htmlFor="ts-note">Add a note</Label>
                <Textarea
                  id="ts-note"
                  rows={2}
                  value={note}
                  placeholder="Anything the next person on this lead should know."
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!note.trim() || mutations.addNote.isPending}
                  onClick={() =>
                    mutations.addNote.mutate(
                      { leadId: l.id, note: note.trim() },
                      { onSuccess: () => setNote("") },
                    )
                  }
                >
                  Add note
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Ownership and the next step */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Next step</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className={cn(DUE_TONE_STYLES[due.tone])}>{due.label}</p>
              {openFollowup ? (
                <p className="text-xs text-muted-foreground">
                  {formatBusinessDate(openFollowup.due_on)}
                  {openFollowup.due_time ? ` at ${openFollowup.due_time.slice(0, 5)}` : ""}
                  {openFollowup.reason ? ` — ${openFollowup.reason}` : ""}
                </p>
              ) : null}
              <div className="pt-1 text-xs text-muted-foreground">
                <p>Owner: {l.assigned_to ? (isMine ? "you" : "another agent") : "unassigned"}</p>
                <p>
                  Attempts: {l.contact_attempts}
                  {l.last_contacted_at ? ` · last ${ts(l.last_contacted_at)}` : ""}
                </p>
                {l.last_outcome ? (
                  <p>Last outcome: {OUTCOME_BY_KEY.get(l.last_outcome)?.label ?? l.last_outcome}</p>
                ) : null}
                {l.converted_at ? (
                  <p>
                    Converted {ts(l.converted_at)}
                    {l.converted_value != null ? ` · ${fmtSAR(l.converted_value)}` : ""}
                  </p>
                ) : null}
                {l.closed_at ? (
                  <p>
                    Closed {ts(l.closed_at)} — {l.closed_reason}
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Provenance. Manager-only, because it names the import. */}
          {canManage ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Provenance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs text-muted-foreground">
                <p className="break-all">
                  <span className="font-medium text-foreground">Dedup key: </span>
                  <span className="font-mono">{l.dedup_key}</span>
                </p>
                <p>
                  <span className="font-medium text-foreground">Source row: </span>
                  {l.source_record_id ? (
                    <span className="font-mono">{l.source_record_id.slice(0, 8)}…</span>
                  ) : (
                    "generated from a previous lead"
                  )}
                </p>
                {l.parent_lead_id ? (
                  <p>
                    <span className="font-medium text-foreground">Previous cycle: </span>
                    <Link
                      to="/telesales/$id"
                      params={{ id: l.parent_lead_id }}
                      className="hover:underline"
                    >
                      open cycle {l.cycle_number - 1}
                    </Link>
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/*
       * Customer intelligence — the lead page's primary customer section.
       *
       * Promoted above stock and call history because it is what an agent reads
       * while the phone is ringing: who this is, what they have bought, and
       * when. `historyLimit` gives the recent lines rather than the ledger,
       * which remains the customer profile's job.
       *
       * The same `useCustomerIntelligence` query as before — one request,
       * keyed on the phone, shared by every lead this customer holds. Nothing
       * here added an MIS call; removing invoice verification took one away.
       */}
      <MisCustomerPanel
        state={intel.state}
        data={intel.data}
        retrievedAt={intel.retrievedAt}
        isFetching={intel.isFetching}
        onRetry={intel.refetch}
        telesalesName={l.customer_name}
        phone={l.phone}
        compact
        historyLimit={5}
        action={
          l.customer_id ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/telesales/customers/$id" params={{ id: l.customer_id }}>
                <UserRound className="mr-1.5 h-4 w-4" />
                View profile
              </Link>
            </Button>
          ) : null
        }
      />

      {/* Can this still be fulfilled? */}
      <LeadStockPanel
        state={stockCheck.state}
        stock={stockCheck.stock}
        onRetry={stockCheck.refetch}
      />

      {/*
       * Who has already spoken to this number.
       *
       * The Calls module's own lookup, called with this lead's phone and a
       * From/To window defaulted to the last month. It runs only here, on an
       * opened lead -- never from the queue, where one lookup per row would be
       * one PBX request per row.
       *
       * It renders nothing for somebody without call access, and a failure
       * inside it is contained: the PBX being unreachable must not stop an
       * agent reading the customer, the product or the follow-up above.
       */}
      <LeadCallLookup phone={l.phone} />

      {/* History */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClipboardList className="h-4 w-4" />
            History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activity.isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (activity.data ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing has happened on this lead yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(activity.data ?? []).map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5"
                >
                  <span className="text-sm font-medium">
                    {ACTIVITY_LABELS[a.activity_type as ActivityType] ?? a.activity_type}
                  </span>
                  {a.outcome ? (
                    <span className="text-sm text-muted-foreground">
                      — {OUTCOME_BY_KEY.get(a.outcome)?.label ?? a.outcome}
                    </span>
                  ) : null}
                  {a.note ? (
                    <span className="w-full text-sm text-muted-foreground">{a.note}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {a.actor_name ?? "System"} · {ts(a.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <OutcomeDialog
        open={recording}
        onOpenChange={setRecording}
        leadType={l.lead_type}
        refillDays={product.data ?? null}
        customerLabel={[l.customer_name, l.item_name].filter(Boolean).join(" · ") || "This lead"}
        submitting={mutations.recordOutcome.isPending}
        onSubmit={(input) =>
          mutations.recordOutcome.mutate(
            { leadId: l.id, ...input },
            { onSuccess: () => setRecording(false) },
          )
        }
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
