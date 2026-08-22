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
import { invoiceNoSignature } from "../invoice-verification";
import { recordInvoiceVerification } from "../record-verification";
import { defaultTeam, parseInvoiceNumbers } from "../utils";
import { isAssignableAgent } from "../components/order-assignment";
import { useOrderInvoices } from "./use-order-invoices";
import { armOrderReturn } from "./use-orders-scroll-restoration";

/**
 * All state, data and side-effects for the order create/edit form.
 *
 * Extracted verbatim from `OrderForm`: same branches/existing queries, same form
 * + invoices state, same permission derivation, same submit/delete flows
 * (validation, insert/update/delete, cache invalidation, navigation, toasts).
 * The route keeps only the JSX that consumes this.
 */
/** Optional hooks a caller can attach without changing how an order is saved. */
export interface OrderFormOptions {
  /**
   * Runs once, after a new order has been successfully inserted.
   *
   * The same shape and the same guarantees as the invoice recording below it:
   * the order is already saved and valid, the hook is best-effort, and anything
   * it throws is the caller's to report rather than a reason the save failed.
   * That boundary is what keeps "create the order" and "approve a courier" two
   * separate outcomes — a dispatch that cannot be established leaves an ordinary
   * saved order behind, which is a state the Portal already understands.
   */
  afterCreate?: (orderId: string) => Promise<void>;
}

/**
 * A persisted column as the form holds it: text, and "" for absent.
 *
 * `numeric` columns come back as strings from PostgREST and `integer` ones as
 * numbers; both are the same thing to a text input, and normalising once here is
 * what keeps `0` from being read as empty.
 */
function text(value: unknown): string {
  return value == null ? "" : String(value);
}

export function useOrderForm(mode: "create" | "edit", options: OrderFormOptions = {}) {
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
    /**
     * The AlShrouq half of the order.
     *
     * Held here rather than inside `useAlShrouqOrder` because these are order
     * columns — `orders.alshrouq_map_url`, `_lat`, `_lng`, `_payment_type` —
     * and everything in this object is saved by `buildOrderPayload` and
     * rehydrated by the effect below. While they lived in the hook's own
     * `useState` they were written nowhere and reloaded as nothing, so an agent
     * who reopened an AlShrouq order was asked for the location, the
     * coordinates and the payment method a second time.
     */
    alshrouq_map_url: "",
    alshrouq_lat: "",
    alshrouq_lng: "",
    alshrouq_payment_type: "",
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
      /*
       * The AlShrouq configuration, read back from the order's own columns.
       *
       * `numeric` and `integer` arrive as numbers (or as strings for `numeric`,
       * depending on the driver), and the form holds text — so everything is
       * stringified once, here, rather than in four places that could disagree.
       * A null column becomes "", which is what an untouched field holds.
       */
      alshrouq_map_url: text((existing as any).alshrouq_map_url),
      alshrouq_lat: text((existing as any).alshrouq_lat),
      alshrouq_lng: text((existing as any).alshrouq_lng),
      alshrouq_payment_type: text((existing as any).alshrouq_payment_type),
    });
    const parts = parseInvoiceNumbers(existing.invoice_no);
    setInvoices(parts.length > 0 ? parts : [""]);
  }, [existing, id]);

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

  /**
   * The agent has actually reached the order page.
   *
   * This is what lets the Orders list tell "we came back" from "we re-rendered
   * on the way out" — see `armOrderReturn`. Edit only: arriving at the *create*
   * form is not a return trip, and nothing was parked for it.
   */
  useEffect(() => {
    if (mode === "edit") armOrderReturn();
  }, [mode]);

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
   * Which numbers the lookup should resolve, and whether it may be recorded.
   *
   * The edit form used to resolve `existing.invoice_no` — the *stored* value —
   * so changing the number in the box loaded nothing until the order had been
   * saved, closed and reopened. The reason was sound: the hook records what it
   * finds against the order, and an unsaved number must not be able to write a
   * total onto it. The two concerns are separated instead of traded off.
   *
   *   * **which numbers** — whatever is on screen, once it differs from the
   *     stored value. Until then the stored value is used directly, so opening
   *     an order still resolves immediately and pays no debounce.
   *   * **may it be written** — only while the numbers on screen are the numbers
   *     in the database. Save, and the two agree again and recording resumes.
   *
   * `settling` covers the gap between the two: the typed number has changed but
   * the debounce has not fired, so the invoices in hand still describe the
   * previous number and must not be shown against this one.
   */
  const typedSignature = useMemo(() => invoiceNoSignature(invoicesJoined), [invoicesJoined]);
  const storedSignature = useMemo(
    () => invoiceNoSignature(existing?.invoice_no),
    [existing?.invoice_no],
  );
  const draftDiffers = mode === "edit" && typedSignature !== storedSignature;
  const lookupInvoiceNo =
    mode === "create" ? draftInvoiceNo : draftDiffers ? draftInvoiceNo : existing?.invoice_no;
  /** The branch to ask: the one on the form, which is what the agent can change. */
  const lookupBranchNo = mode === "create" ? form.branch_no : form.branch_no || existing?.branch_no;
  const settling = invoiceNoSignature(lookupInvoiceNo) !== typedSignature;
  /**
   * A draft may be resolved but never recorded. Both the numbers and the branch
   * have to match the stored row: the same number at a different branch is a
   * different document, so a changed branch is as much an unsaved edit as a
   * changed number.
   */
  const recordEnabled =
    mode === "edit" &&
    !draftDiffers &&
    (form.branch_no || "") === ((existing?.branch_no as string | null) || "");

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
    invoiceNo: lookupInvoiceNo,
    branchNo: lookupBranchNo,
    // The stored figures, so the hook can tell whether the order still agrees
    // with what has been verified rather than only whether an invoice is new.
    storedValue: existing?.invoice_value,
    storedVerifiedFlag: (existing as any)?.call_center_verified,
    // Lets the hook notice an order that is fully reconciled but still open,
    // which is the only remaining reason to call the server.
    storedStatus: existing?.status,
    enabled: canViewShams && (mode === "edit" ? !!existing : !!form.branch_no),
    recordEnabled,
    settling,
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
    // The total in hand belongs to the number the lookup last resolved, which is
    // not the one in the box. Writing it now would put the old invoice's money
    // against the new invoice number.
    if (settling) return;
    setForm((f) =>
      f.invoice_value !== "" && Number(f.invoice_value) === verifiedTotal
        ? f
        : { ...f, invoice_value: verifiedTotal.toFixed(2) },
    );
  }, [verifiedTotal, existing, readOnly, settling]);

  /**
   * The flag, in step with what the portal has derived.
   *
   * Raised whenever the stored row says so. Lowered only when the *documents*
   * say so — a verified invoice that is not a call-centre one, which is what
   * the server now derives `false` from. That asymmetry is deliberate: without
   * it a form left open while an invoice was replaced would keep showing a
   * verification the order no longer has, and save it back on the next edit;
   * with a blunt mirror instead, an agent's manual tick on an order whose
   * invoice has not landed yet would be wiped the moment any refetch arrived.
   */
  useEffect(() => {
    if ((existing as any)?.call_center_verified && !draftDiffers) {
      setForm((f) => (f.call_center_verified ? f : { ...f, call_center_verified: true }));
      return;
    }
    // Lowering follows the *documents*, so it must wait until the documents in
    // hand are the ones the typed number names — otherwise replacing a
    // call-centre number with one that has not resolved yet would clear the box
    // on the strength of the invoice being replaced.
    if (settling) return;
    if (shamsInvoices.verified.length > 0 && !shamsInvoices.callCentreVerified) {
      setForm((f) => (f.call_center_verified ? { ...f, call_center_verified: false } : f));
    }
  }, [
    existing,
    draftDiffers,
    settling,
    shamsInvoices.verified.length,
    shamsInvoices.callCentreVerified,
  ]);

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
    let createdOrderId: string | null = null;
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
        createdOrderId = createdId ?? null;
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
        /**
         * Record what is on screen against the order that now names it.
         *
         * The same call `create` makes above, for the same reason, and its
         * absence here is what let the Orders list contradict the order page.
         *
         * An invoice number does not identify a document on its own — the
         * **branch** identifies it too. `0064714` is a March walk-in worth 18.40
         * at P0127 and today's Call Centre document worth 110.00 at P0217. An
         * order raised against the wrong branch therefore records a real but
         * wrong document, and correcting the branch is as much a change of
         * document as correcting the number.
         *
         * Nothing re-recorded it. `trg_sync_order_invoice_flags` fires on
         * `invoice_no` alone and re-derives from the activity log, which still
         * held the old branch's answer; and the page's own reconciliation is
         * withheld while the form disagrees with the stored row, precisely so an
         * unsaved edit cannot write to the order. So the correction waited for
         * whoever next opened the order — which in the reported case was 17
         * seconds after the agent had already gone back to the list and seen it
         * still saying Non Call Centre.
         *
         * Saving is the moment the edit stops being a draft, so it is the moment
         * to record: the documents have already been resolved on screen, they
         * are the ones the order now names, and the server reconciles the value,
         * the flag and the status from them before the navigation below.
         *
         * Not fatal, exactly as on create. The order is saved either way and the
         * next open still reconciles it.
         */
        try {
          await recordInvoiceVerification(id!, shamsInvoices.invoices);
        } catch (err: any) {
          toast.warning(
            err?.message
              ? `Order updated. The invoice could not be recorded yet: ${err.message}`
              : "Order updated. The invoice could not be recorded yet; it will be picked up when the order is next opened.",
          );
        }
      }
      /**
       * Whatever the caller wanted done with the order that now exists.
       *
       * Deliberately after the insert and before the navigation: it needs the
       * id, and an agent must not be moved off the page while a courier is
       * being approved. Its failures are its own to surface — the order is
       * saved either way, and reporting a save as failed because a follow-up
       * did would be the more damaging lie.
       */
      if (createdOrderId && options.afterCreate) {
        try {
          await options.afterCreate(createdOrderId);
        } catch {
          // Reported by the caller, which knows what it was attempting.
        }
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
