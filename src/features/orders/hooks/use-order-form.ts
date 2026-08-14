import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isAdministrator, useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { useAgentDirectory } from "@/lib/directory";
import { useDebounced } from "@/features/shams/hooks/use-shams-data";
import { orderFormSchema } from "../schema";
import { buildOrderPayload, type PersistedOrder } from "../payload";
import { recordInvoiceVerification } from "../record-verification";
import { defaultTeam, parseInvoiceNumbers } from "../utils";
import { isAssignableAgent } from "../components/order-assignment";
import { useOrderInvoices } from "./use-order-invoices";

/**
 * All state, data and side-effects for the order create/edit form.
 *
 * Extracted verbatim from `OrderForm`: same branches/existing queries, same form
 * + invoices state, same permission derivation, same submit/delete flows
 * (validation, insert/update/delete, cache invalidation, navigation, toasts).
 * The route keeps only the JSX that consumes this.
 */
export function useOrderForm(mode: "create" | "edit") {
  const navigate = useNavigate();
  const { user, role, profile } = useAuth();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params?.id;

  const { data: branches } = useQuery({
    queryKey: queryKeys.branches.list(),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("branch_no,city")
        .order("branch_no");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: existing } = useQuery({
    queryKey: queryKeys.orders.detail(id),
    enabled: mode === "edit" && !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from("orders").select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [form, setForm] = useState({
    order_date: new Date().toISOString().slice(0, 10),
    team: defaultTeam(role) as string,
    order_type: "Cash",
    customer_name: "",
    customer_phone: "",
    branch_no: "" as string | null,
    delivery_type: "",
    invoice_value: "",
    notes: "",
    status: "Pending",
    /**
     * The assignee. Empty until an existing order loads, or until a new order's
     * creator turns out to be an agent — an Owner, Admin or Supervisor starts
     * with it empty and has to choose. See `creatorIsAgent`.
     */
    agent_id: "" as string,
    /**
     * Call Center Invoice.
     *
     * Held here so the form can *show* it, but the portal is what usually sets
     * it: a verified call-centre document ticks it through
     * `record_invoice_verification`. A manual tick is still possible for
     * whoever holds the verification permission — that path predates this and
     * is the same column the Orders list toggles.
     */
    call_center_verified: false,
  });
  const [invoices, setInvoices] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const canView = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canEditAll = hasPerm(role, profile?.permissions as any, "edit_all_orders");
  const canEditOwn = hasPerm(role, profile?.permissions as any, "edit_orders");
  const canDelete = hasPerm(role, profile?.permissions as any, "delete_orders");
  /**
   * Whether this agent may see the order's invoices in Shams.
   *
   * The same page-level key the `/shams` route and every Shams server function
   * gate on — the panel is a second window onto that data, not a new capability,
   * so it must not be reachable by anyone who cannot open the page itself. The
   * server re-checks it on every call; this only decides whether to ask.
   */
  const canViewShams = hasPerm(role, profile?.permissions as any, "view_shams_mis");
  /**
   * Who may tick the Call Center Invoice box by hand.
   *
   * The same two permissions the Orders list checks per row, so the control on
   * the form can never offer what the table refuses. The automated path is
   * governed separately, inside `record_invoice_verification`.
   */
  const canVerifyAll = hasPerm(role, profile?.permissions as any, "verify_all_orders");
  const canVerifyOwn = hasPerm(role, profile?.permissions as any, "verify_own_orders");
  /**
   * Who may move an order to another agent.
   *
   * Owner and Admin, per `isAdministrator`. Deliberately narrower than the
   * database rule — the `orders` UPDATE policy admits any `edit_all_orders`
   * holder, which includes Supervisor — so this control can never offer an
   * ability the database would refuse, and the wider rule is left as it was.
   */
  const canAssign = isAdministrator(role);
  /**
   * Whether the agent picker is live in the current mode.
   *
   * On **create** the gate is `edit_all_orders`, mirroring the INSERT policy
   * exactly: that permission is what lets a caller file an order under someone
   * else, and a Supervisor holds it. They must be able to pick, because they
   * cannot be the assignee themselves and would otherwise be unable to save at
   * all. On **edit** it is the narrower Owner/Admin rule this phase was asked
   * for. A plain agent sees their own name as text in both.
   */
  const canPickAgent = mode === "create" ? canEditAll : canAssign;
  const isOwner = !!existing && !!user && existing.agent_id === user.id;
  const canEditThis = mode === "create" ? canCreate : canEditAll || (isOwner && canEditOwn);
  const readOnly = mode === "edit" && !canEditThis;
  const canVerifyThis =
    mode === "create" ? canVerifyAll || canVerifyOwn : canVerifyAll || (isOwner && canVerifyOwn);

  /**
   * Fill the form from the order — once per order, not once per fetch.
   *
   * This used to key on `existing` alone, and React Query hands back a new
   * object identity on every refetch: opening an order runs a verification,
   * the verification invalidates `orders.all()`, the refetch lands, and the
   * whole form was rebuilt from the row *while the agent was typing in it*.
   * Anything half-entered went, and a field could be re-hydrated underneath a
   * `setForm({...form})` closure captured before it — one of the ways a
   * required field arrived at validation empty.
   *
   * Keyed on the order's id instead: the form is seeded when the order arrives
   * (or when the route moves to a different order) and is the agent's from
   * then on. The two things the *server* legitimately changes afterwards —
   * the reconciled value and the Call Center flag — are applied below by their
   * own effects, narrowly, without touching anything else.
   */
  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!existing || !id || hydratedFor.current === id) return;
    hydratedFor.current = id;
    const t =
      existing.team === "customer_care" || existing.team === "telesales"
        ? existing.team
        : "customer_care";
    setForm({
      order_date: existing.order_date,
      team: t,
      order_type: existing.order_type,
      customer_name: (existing as any).customer_name ?? "",
      customer_phone: (existing as any).customer_phone ?? "",
      branch_no: existing.branch_no ?? "",
      delivery_type: existing.delivery_type ?? "",
      invoice_value: existing.invoice_value?.toString() ?? "",
      notes: existing.notes ?? "",
      status: existing.status,
      agent_id: existing.agent_id ?? "",
      call_center_verified: !!(existing as any).call_center_verified,
    });
    const parts = parseInvoiceNumbers(existing.invoice_no);
    setInvoices(parts.length > 0 ? parts : [""]);
  }, [existing, id]);

  /**
   * The flag, once the portal has set it.
   *
   * Only ever raised here, and only to `true`: the automation cannot untick a
   * box, and an agent who has just ticked one must not see it flip back
   * because a refetch arrived carrying the older row.
   */
  useEffect(() => {
    if (!(existing as any)?.call_center_verified) return;
    setForm((f) => (f.call_center_verified ? f : { ...f, call_center_verified: true }));
  }, [existing]);

  /**
   * The status, once the server has moved it.
   *
   * Hydration runs once per order, so a form opened while an order was Pending
   * goes on holding "Pending" after the portal completes it — and `submit`
   * sends the whole row, so the next save would quietly put it back. There is
   * no status control on this page for this to fight with; the Orders list owns
   * that, and this only follows what the database now says.
   */
  useEffect(() => {
    const stored = existing?.status;
    if (!stored) return;
    setForm((f) => (f.status === stored ? f : { ...f, status: stored }));
  }, [existing]);

  useEffect(() => {
    if (mode === "create") setForm((f) => ({ ...f, team: defaultTeam(role) }));
  }, [role, mode]);

  const cityFor = useMemo(
    () => (b: string | null) => branches?.find((x) => x.branch_no === b)?.city ?? "",
    [branches],
  );

  /**
   * The shared agent directory, for the assignment control.
   *
   * The same hook and key the Orders list and the Dashboard read, so opening a
   * form costs no extra fetch. Non-administrators still load it — it is what
   * resolves the assigned agent's *name* for the read-only display.
   */
  const { data: agents } = useAgentDirectory();

  /**
   * Seed a new order's assignee — but only when the creator is an agent.
   *
   * The creator and the assignee are different concepts, and the form used to
   * collapse them: a new order was always filed under whoever typed it. For an
   * agent that is right and is what the INSERT policy expects. For an Owner,
   * Admin or Supervisor it is wrong — they are not a caseload, and putting them
   * in `agent_id` puts them into agent workload, the team split and the "My
   * orders" filter. Those roles start with the field **empty** and must choose
   * an agent — which the INSERT policy now permits, because `created_by` records
   * the author separately and `edit_all_orders` admits naming another assignee.
   */
  const creatorIsAgent = isAssignableAgent(agents?.find((a) => a.id === user?.id));
  useEffect(() => {
    if (mode !== "create" || !user?.id) return;
    setForm((f) => (f.agent_id === "" && creatorIsAgent ? { ...f, agent_id: user.id } : f));
  }, [mode, user?.id, creatorIsAgent]);

  const invoicesJoined = invoices
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");

  /**
   * The numbers being typed, once they have settled.
   *
   * Only used while **creating**, where there is no stored `invoice_no` to
   * resolve. Debounced with the same helper the Shams page search uses, so a
   * seven-digit invoice number costs one lookup rather than one per keystroke.
   */
  const draftInvoiceNo = useDebounced(invoicesJoined, 500);

  /**
   * The order's invoices in Shams: state, totals, and the automatic recording.
   *
   * Gated on `view_shams_mis`, so an agent without Shams access issues no
   * request. Which numbers are resolved depends on the mode, and the difference
   * matters:
   *
   *   * **edit** — the *stored* `invoice_no`. A half-typed number is not yet a
   *     fact about the order, and recording is live here: an unsaved edit must
   *     not be able to write a total onto the order.
   *   * **create** — what is on screen, debounced. There is no order id, so the
   *     hook records nothing (its activity query is disabled without one and
   *     the write is guarded on the id); this is a *lookup*, and it is what
   *     lets the form know the verified total before the order exists. The
   *     recording for a new order happens once, in `submit`, against the id the
   *     insert returns.
   */
  const shamsInvoices = useOrderInvoices({
    orderId: mode === "edit" ? id : undefined,
    invoiceNo: mode === "edit" ? existing?.invoice_no : draftInvoiceNo,
    branchNo: mode === "edit" ? existing?.branch_no : form.branch_no,
    // The stored figures, so the hook can tell whether the order still agrees
    // with what has been verified rather than only whether an invoice is new.
    storedValue: existing?.invoice_value,
    storedVerifiedFlag: (existing as any)?.call_center_verified,
    // Lets the hook notice an order that is fully reconciled but still open,
    // which is the only remaining reason to call the server.
    storedStatus: existing?.status,
    enabled: canViewShams && (mode === "edit" ? !!existing : !!form.branch_no),
  });

  /**
   * The verified total, put into the field the moment there is one.
   *
   * The business rule is that a verified document's total is authoritative and
   * a manually entered figure does not survive it, so the box is *shown* the
   * number that is about to be saved rather than being left to disagree with
   * it. Not a lock: the field stays editable, and `submit` is what makes the
   * rule true in the database whatever is on screen.
   *
   * Re-applied when `existing` changes as well, so an order refetched after a
   * reconciliation does not fall back to the figure it held before.
   */
  const verifiedTotal = shamsInvoices.verified.length > 0 ? shamsInvoices.verifiedTotal : null;
  useEffect(() => {
    if (verifiedTotal === null || readOnly) return;
    setForm((f) =>
      f.invoice_value !== "" && Number(f.invoice_value) === verifiedTotal
        ? f
        : { ...f, invoice_value: verifiedTotal.toFixed(2) },
    );
  }, [verifiedTotal, existing, readOnly]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!canEditThis) {
      toast.error("You don't have permission to modify this order");
      return;
    }
    // An edit cannot be built before the order it edits has arrived. Saving
    // then would submit the form's *defaults* — which is one of the ways a
    // required field reached validation empty — so it is refused outright
    // rather than half-applied.
    if (mode === "edit" && !existing) {
      toast.error("This order is still loading — try again in a moment");
      return;
    }
    setBusy(true);
    try {
      // Built by `buildOrderPayload`, which is pure and tested: every field the
      // order has is present, and a *required* field left blank by a hydration
      // failure falls back to the stored row rather than being sent empty.
      const parsed = orderFormSchema.parse(
        buildOrderPayload({
          mode,
          form,
          invoiceNo: invoicesJoined,
          persisted: existing as PersistedOrder | null | undefined,
          invoices: shamsInvoices,
          canAssign,
          canVerify: canVerifyThis,
        }),
      );
      if (mode === "create") {
        // The assignee, not the author. `created_by` defaults to `auth.uid()`
        // in the database, so the two are recorded separately and a supervisor
        // taking an order down does not become the agent who owns it.
        if (!parsed.agent_id) {
          toast.error("Assign this order to an agent before saving");
          return;
        }
        // `select("id")` without `single()`: the returned rows pass through the
        // SELECT policy, so a caller who may create an order they cannot read
        // back gets an empty array rather than a "no rows" error over an insert
        // that actually succeeded.
        const { data: created, error } = await supabase
          .from("orders")
          .insert(parsed as any)
          .select("id");
        if (error) throw error;
        toast.success("Order saved");
        /**
         * Record what was already verified, against the order that now exists.
         *
         * The gap this closes: everything about automatic verification was
         * keyed on an order id, and at creation there is none — so an order
         * taken for an invoice **already in the MIS** was saved with whatever
         * the agent typed and stayed that way until somebody happened to open
         * it again. The lookup has already run against the typed numbers; this
         * hands the same documents to the same function, which writes the
         * timeline event, reconciles the value and sets the Call Center flag.
         *
         * Not fatal. The order is saved and valid either way, and an order
         * whose invoice has not appeared yet takes this path every time and
         * sends nothing at all — reconciliation on the next open is the
         * ordinary case, not the fallback.
         */
        const createdId = (created as { id: string }[] | null)?.[0]?.id;
        if (createdId) {
          try {
            await recordInvoiceVerification(createdId, shamsInvoices.invoices);
          } catch (err: any) {
            toast.warning(
              err?.message
                ? `Order saved. The invoice could not be recorded yet: ${err.message}`
                : "Order saved. The invoice could not be recorded yet; it will be picked up when the order is next opened.",
            );
          }
        }
      } else {
        const { error } = await supabase
          .from("orders")
          .update(parsed as any)
          .eq("id", id!);
        if (error) throw error;
        toast.success("Order updated");
      }
      qc.invalidateQueries({ queryKey: queryKeys.orders.all() });
      qc.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
      // `resetScroll: false`, or the agent lands at the top of the list every
      // time they save. This is a *push* — a new history entry with a new
      // `__TSR_key` — so the router's scroll-restoration cache has no entry for
      // it and its `onRendered` subscriber falls through to
      // `window.scrollTo({top: 0})`. Opting out leaves the viewport to
      // `useOrdersScrollRestoration`, which puts the edited row back where it
      // was; without it, that hook is only ever undoing a jump the agent has
      // already seen.
      navigate({ to: "/orders", resetScroll: false });
    } catch (e: any) {
      toast.error(e.message ?? "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!id) return;
    if (!canDelete) {
      toast.error("You don't have permission to delete orders");
      return;
    }
    if (!confirm("Delete this order?")) return;
    const { error } = await supabase.from("orders").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: queryKeys.orders.all() });
    qc.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
    // Same as above. The deleted row will not be found on return, so the
    // restoration falls back to the offset the list was left at.
    navigate({ to: "/orders", resetScroll: false });
  };

  return {
    navigate,
    id,
    userId: user?.id,
    branches,
    existing,
    form,
    setForm,
    invoices,
    setInvoices,
    busy,
    open,
    setOpen,
    cityFor,
    canView,
    canCreate,
    canEditAll,
    canDelete,
    canViewShams,
    canAssign,
    canPickAgent,
    canEditThis,
    canVerifyThis,
    readOnly,
    submit,
    del,
    // assignment + Shams
    agents,
    shamsInvoices,
  };
}
