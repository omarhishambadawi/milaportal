import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isAdministrator, useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { useAgentDirectory } from "@/lib/directory";
import { orderFormSchema } from "../schema";
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

  useEffect(() => {
    if (existing) {
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
      });
      const parts = parseInvoiceNumbers(existing.invoice_no);
      setInvoices(parts.length > 0 ? parts : [""]);
    }
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

  /**
   * The order's invoices in Shams: state, totals, and the automatic recording.
   *
   * Edit mode only and gated on `view_shams_mis`, so an agent without Shams
   * access issues no request. Driven by the **stored** `invoice_no` rather than
   * the inputs, because a half-typed number is not yet a fact about the order.
   */
  const shamsInvoices = useOrderInvoices({
    orderId: id,
    invoiceNo: existing?.invoice_no,
    branchNo: existing?.branch_no,
    // The stored figures, so the hook can tell whether the order still agrees
    // with what has been verified rather than only whether an invoice is new.
    storedValue: existing?.invoice_value,
    storedVerifiedFlag: (existing as any)?.call_center_verified,
    enabled: mode === "edit" && canViewShams && !!existing,
  });

  const invoicesJoined = invoices
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!canEditThis) {
      toast.error("You don't have permission to modify this order");
      return;
    }
    setBusy(true);
    try {
      const parsed = orderFormSchema.parse({
        ...form,
        customer_name: form.customer_name || null,
        customer_phone: form.customer_phone || null,
        branch_no: form.branch_no || "",
        invoice_no: invoicesJoined || null,
        notes: form.notes || null,
        status: mode === "create" ? "Pending" : form.status,
        // Sent on create (the order needs an owner) and on edit only when this
        // caller may reassign; everyone else's update leaves `agent_id` out
        // rather than writing back the value it happens to be holding.
        agent_id:
          mode === "create"
            ? form.agent_id || undefined
            : canAssign && form.agent_id
              ? form.agent_id
              : undefined,
      });
      if (mode === "create") {
        // The assignee, not the author. `created_by` defaults to `auth.uid()`
        // in the database, so the two are recorded separately and a supervisor
        // taking an order down does not become the agent who owns it.
        if (!parsed.agent_id) {
          toast.error("Assign this order to an agent before saving");
          return;
        }
        const { error } = await supabase.from("orders").insert(parsed as any);
        if (error) throw error;
        toast.success("Order saved");
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
    readOnly,
    submit,
    del,
    // assignment + Shams
    agents,
    shamsInvoices,
  };
}
