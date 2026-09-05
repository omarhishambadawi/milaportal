import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { telesalesLinkMisCustomer } from "@/lib/telesales.functions";
import { ArrowLeft, Loader2, Phone, PhoneOff, ShieldAlert, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { fmtSAR } from "@/lib/branches";
import { formatSaudiPhone, telHref } from "@/lib/phone";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { businessToday, describeRefill, formatBusinessDate } from "@/lib/telesales/dates";
import { familyLabel } from "@/lib/telesales/products";
import { LEAD_STATUS_LABELS, LEAD_TYPE_LABELS } from "@/lib/telesales/types";
import { LEAD_STATUS_STYLES, STALE_BADGE_STYLE } from "@/features/telesales/constants";
import { OutcomeBadge } from "@/features/telesales/components/outcome-badge";
import { RefillBadge } from "@/features/telesales/components/refill-badge";
import { MisCustomerPanel } from "@/features/telesales/components/mis-customer-panel";
import { useCustomerIntelligence } from "@/features/telesales/hooks/use-customer-intelligence";

export const Route = createFileRoute("/_app/telesales/customers/$id")({
  head: () => ({ meta: [{ title: "Customer — MilaServ Portal" }] }),
  component: CustomerProfilePage,
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

interface CustomerRow {
  id: string;
  phone: string;
  display_name: string | null;
  alternate_names: string[];
  mis_customer_id: string | null;
  mis_synced_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface CustomerLead {
  id: string;
  lead_type: string;
  status: string;
  item_name: string | null;
  product_family: string | null;
  branch_no: string | null;
  source_date: string | null;
  next_followup_on: string | null;
  total_value: number | null;
  contact_attempts: number;
  cycle_number: number;
  archived_at: string | null;
  created_at: string;
  /** Derived by `telesales_lead_lifecycle`. */
  lifecycle: "active" | "stale" | "none";
  refill_due_on: string | null;
}

interface ContactRow {
  activity_id: string;
  lead_id: string;
  lead_type: string;
  item_name: string | null;
  occurred_at: string;
  agent_name: string | null;
  outcome: string | null;
  note: string | null;
}

/**
 * One customer, every opportunity they hold.
 *
 * This is what consolidation buys. A customer who bought Ozempic, Mounjaro and a
 * FreeStyle sensor is one person here with three leads — not three unrelated
 * rows in a queue — and the leads themselves are untouched: each keeps its own
 * product, branch, dates and history, because they are three separate
 * conversations about three separate products.
 *
 * The contact history below is the Call Lookup: every call anyone on the desk
 * has logged against this number, newest first, so an agent can see that a
 * colleague spoke to them on Tuesday before dialling again on Wednesday.
 */
function CustomerProfilePage() {
  const { id } = useParams({ from: "/_app/telesales/customers/$id" });
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  const canView = hasPerm(role, perms, "view_telesales");
  const today = businessToday();

  const customer = useQuery<CustomerRow | null>({
    queryKey: [...queryKeys.telesales.all(), "customer", id],
    enabled: canView && Boolean(id),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_customers")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as CustomerRow) ?? null;
    },
  });

  const leads = useQuery<CustomerLead[]>({
    queryKey: [...queryKeys.telesales.all(), "customer-leads", id],
    enabled: canView && Boolean(id),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        /*
         * The lifecycle view, for the same reason the queue reads it: this list
         * showed "REFILL OVERDUE - 214 DAYS" against leads whose opportunity
         * expired months ago, which is the sentence this phase exists to stop
         * putting in front of an agent. Same RLS, same rule, two extra columns.
         */
        .from("telesales_lead_lifecycle")
        .select(
          "id,lead_type,status,item_name,product_family,branch_no,source_date," +
            "next_followup_on,total_value,contact_attempts,cycle_number,archived_at,created_at," +
            "lifecycle,refill_due_on",
        )
        .eq("customer_id", id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data as CustomerLead[]) ?? [];
    },
  });

  /**
   * Call Lookup, through the one RPC that knows the contact rule.
   *
   * Keyed on the canonical phone rather than on the customer id, because the
   * question is "who has called this number" and a lead can exist with the
   * number but no customer link — which is exactly the case for the three live
   * leads whose phone could not be normalised.
   */
  const contacts = useQuery<ContactRow[]>({
    queryKey: [...queryKeys.telesales.all(), "contact-history", customer.data?.phone],
    enabled: canView && Boolean(customer.data?.phone),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("telesales_contact_history", {
        _phone: customer.data!.phone,
        _limit: 50,
      });
      if (error) throw new Error(error.message);
      return (data as ContactRow[]) ?? [];
    },
  });

  /*
   * Shams MIS, loaded independently.
   *
   * The identity, leads and contact history above render as soon as Postgres
   * answers; this waits on a third-party system and must never hold the page.
   * Keyed on the phone, so a customer with three leads costs one lookup.
   */
  const intel = useCustomerIntelligence(customer.data?.phone, canView);

  /*
   * Record the MIS customer id the first time a lookup resolves one.
   *
   * One identifier, not a copy of the customer -- it is what a later phase needs
   * to reconcile invoices without asking the MIS who this number is again. The
   * ref makes it at most once per mount, and the server-side update is a no-op
   * unless the column is still null, so a re-render or a second agent opening
   * the same profile cannot produce a write loop.
   */
  const linked = useRef(false);
  const storedMisId = customer.data?.mis_customer_id ?? null;
  const resolvedMisId = intel.data?.misCustomerId ?? null;
  const customerRowId = customer.data?.id ?? null;
  useEffect(() => {
    if (linked.current || !customerRowId || !resolvedMisId || storedMisId) return;
    linked.current = true;
    void telesalesLinkMisCustomer({
      data: { customerId: customerRowId, misCustomerId: resolvedMisId },
    }).catch(() => {
      // Best effort. Failing to record the id must never disturb a profile the
      // agent is reading mid-call; the next visit tries again.
    });
  }, [customerRowId, resolvedMisId, storedMisId]);

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Telesales is restricted</p>
      </div>
    );
  }

  if (customer.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the customer…
      </div>
    );
  }

  const c = customer.data;
  if (!c) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm font-medium">No such customer</p>
        <Button asChild className="mt-4" variant="outline" size="sm">
          <Link to="/crm/cash">Back to the queue</Link>
        </Button>
      </div>
    );
  }

  const rows = leads.data ?? [];
  const open = rows.filter(
    (l) => !l.archived_at && !l.status.startsWith("closed") && l.status !== "converted",
  );
  const closed = rows.filter(
    (l) => l.archived_at || l.status.startsWith("closed") || l.status === "converted",
  );
  const tel = telHref(c.phone);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/crm/cash">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Queue
          </Link>
        </Button>
        {tel ? (
          <Button asChild size="sm">
            <a href={tel}>
              <Phone className="mr-2 h-4 w-4" />
              {formatSaudiPhone(c.phone)}
            </a>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            <PhoneOff className="mr-2 h-4 w-4" />
            No number
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-lg">{c.display_name || "Unnamed customer"}</CardTitle>
            <span className="font-mono text-sm text-muted-foreground">
              {formatSaudiPhone(c.phone)}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <Field label="Opportunities">{rows.length}</Field>
            <Field label="Open">{open.length}</Field>
            <Field label="First seen">{ts(c.first_seen_at)}</Field>
            <Field label="Last seen">{ts(c.last_seen_at)}</Field>
          </div>

          {/*
           * A disagreement is shown, never resolved.
           *
           * One live customer has two names against one number. Picking a
           * winner would hide the fact that the desk does not actually know
           * who answers this phone; showing both lets the agent ask.
           */}
          {c.alternate_names.length > 0 ? (
            <div className="rounded-md border border-dashed border-border p-3">
              <p className="text-xs font-medium">This number has answered to another name</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Also seen as {c.alternate_names.join(", ")}. Confirm who you are speaking to before
                discussing a previous order.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <MisCustomerPanel
        state={intel.state}
        data={intel.data}
        retrievedAt={intel.retrievedAt}
        isFetching={intel.isFetching}
        onRetry={intel.refetch}
        telesalesName={c.display_name}
        phone={c.phone}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Opportunities ({open.length} open of {rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {leads.isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              This customer has no leads.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {[...open, ...closed].map((l) => {
                const isStale = l.lifecycle === "stale";
                const showRefill =
                  !isStale &&
                  l.lead_type === "retention" &&
                  describeRefill(l.next_followup_on, today).severity !== "none";
                return (
                  <li
                    key={l.id}
                    className={cn(
                      "flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5",
                      l.archived_at && "opacity-60",
                    )}
                  >
                    <Link
                      to="/telesales/$id"
                      params={{ id: l.id }}
                      className="text-sm font-medium hover:underline"
                    >
                      {l.item_name ?? (l.lead_type === "wasfaty" ? "Prescription" : "—")}
                    </Link>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px]",
                        LEAD_STATUS_STYLES[l.status as keyof typeof LEAD_STATUS_STYLES],
                      )}
                    >
                      {LEAD_STATUS_LABELS[l.status as keyof typeof LEAD_STATUS_LABELS] ?? l.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {LEAD_TYPE_LABELS[l.lead_type as keyof typeof LEAD_TYPE_LABELS]}
                      {l.cycle_number > 1 ? ` · cycle ${l.cycle_number}` : ""}
                      {l.branch_no ? ` · ${l.branch_no}` : ""}
                      {l.product_family ? ` · ${familyLabel(l.product_family)}` : ""}
                      {l.total_value != null ? ` · ${fmtSAR(l.total_value)}` : ""}
                    </span>
                    {isStale ? (
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px]",
                          STALE_BADGE_STYLE,
                        )}
                      >
                        STALE
                      </span>
                    ) : null}
                    {showRefill ? <RefillBadge dueOn={l.next_followup_on} today={today} /> : null}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {formatBusinessDate(l.source_date)}
                      {l.archived_at ? " · archived" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Who has called this customer</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {contacts.isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (contacts.data ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nobody on the desk has logged a call to this number yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(contacts.data ?? []).map((r) => (
                <li
                  key={r.activity_id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                >
                  <span className="text-sm font-medium">{r.agent_name ?? "An agent"}</span>
                  <span className="text-sm text-muted-foreground">
                    {r.outcome ? <OutcomeBadge outcome={r.outcome} /> : "Call"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {LEAD_TYPE_LABELS[r.lead_type as keyof typeof LEAD_TYPE_LABELS]}
                    {r.item_name ? ` · ${r.item_name}` : ""}
                  </span>
                  {r.note ? (
                    <span className="w-full text-xs text-muted-foreground">{r.note}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {ts(r.occurred_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
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
