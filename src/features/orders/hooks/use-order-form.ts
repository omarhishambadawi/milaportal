import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { orderFormSchema } from "../schema";
import { defaultTeam, parseInvoiceNumbers } from "../utils";

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
    team: defaultTeam(role),
    order_type: "Cash",
    customer_name: "",
    customer_phone: "",
    branch_no: "" as string | null,
    delivery_type: "",
    invoice_value: "",
    notes: "",
    status: "Pending",
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
      });
      if (mode === "create") {
        const { error } = await supabase
          .from("orders")
          .insert({ ...parsed, agent_id: user.id } as any);
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
    canEditThis,
    readOnly,
    submit,
    del,
  };
}
