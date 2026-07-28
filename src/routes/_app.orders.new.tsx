import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ArrowLeft, Check, ChevronsUpDown, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { ORDER_TYPES, DELIVERY_TYPES, TEAMS, CURRENCY, formatOrderNo } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { useOrderForm } from "@/features/orders/hooks/use-order-form";
import { OrderActivityTimeline } from "@/features/orders/components/order-activity-timeline";
import { BranchPreviewPanel } from "@/features/branches/components/branch-preview-panel";

export const Route = createFileRoute("/_app/orders/new")({
  head: () => ({ meta: [{ title: "New Order" }] }),
  component: () => <OrderForm mode="create" />,
});

/**
 * A quiet heading over a group of fields.
 *
 * The form was a flat two-column grid of eleven controls with no structure at
 * all, so "Date" and "Invoice No." carried the same weight and an agent filling
 * it in mid-call had to read every label to find the next one. Four groups in
 * the order the call actually goes: when and who, then who is calling, then
 * where it is going, then what it is worth.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

export function OrderForm({ mode }: { mode: "create" | "edit" }) {
  const {
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
    readOnly,
    submit,
    del,
  } = useOrderForm(mode);

  if (mode === "create" && !canCreate) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have permission to create orders.
        </p>
      </div>
    );
  }

  if (mode === "edit" && existing && !canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to this order.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <Link
          to="/orders"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to orders
        </Link>
        {mode === "edit" && canDelete && (
          <Button variant="outline" size="sm" onClick={del}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "create"
              ? "New order"
              : `${readOnly ? "View" : "Edit"} order ${formatOrderNo(existing?.team, existing?.display_no)}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-6">
            <fieldset disabled={readOnly} className="contents">
              <Section title="Order">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Input
                    type="date"
                    value={form.order_date}
                    onChange={(e) => setForm({ ...form, order_date: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Team</Label>
                  <Select
                    value={form.team}
                    onValueChange={(v) =>
                      setForm({ ...form, team: v as (typeof TEAMS)[number]["value"] })
                    }
                    disabled={readOnly || (mode === "edit" && !canEditAll)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEAMS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>
                    Order type <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={form.order_type}
                    onValueChange={(v) => setForm({ ...form, order_type: v })}
                    disabled={readOnly}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORDER_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>
                    Delivery &amp; Pickup <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={form.delivery_type}
                    onValueChange={(v) => setForm({ ...form, delivery_type: v })}
                    disabled={readOnly}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a method…" />
                    </SelectTrigger>
                    <SelectContent>
                      {DELIVERY_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </Section>

              <Section title="Customer">
                <div className="space-y-2">
                  <Label>
                    Customer name <span className="text-xs text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    value={form.customer_name}
                    onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                    placeholder="Optional"
                  />
                </div>
                <div className="space-y-2">
                  <Label>
                    Customer phone <span className="text-xs text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    value={form.customer_phone}
                    onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
                    placeholder="Optional"
                    dir="ltr"
                    inputMode="tel"
                  />
                </div>
              </Section>

              {/* BRANCH — one control, then the answer.
                  The read-only "City (auto)" box beside it is gone. It restated
                  the second half of the label already inside the picker's own
                  trigger, and once a branch is chosen the panel below states the
                  city in both scripts along with everything else a customer asks
                  next. A disabled input whose only job is to echo another
                  control is a field an agent's eye has to skip on every order. */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Branch
                </h3>
                <div className="space-y-2">
                  <Label>
                    Branch No. <span className="text-destructive">*</span>
                  </Label>
                  <Popover open={open} onOpenChange={setOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className="w-full justify-between font-normal"
                        disabled={readOnly}
                      >
                        {form.branch_no ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="font-mono font-medium">{form.branch_no}</span>
                            <span className="truncate text-muted-foreground" dir="auto">
                              {cityFor(form.branch_no)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Select a branch…</span>
                        )}
                        <ChevronsUpDown className="h-4 w-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      className="w-[var(--radix-popover-trigger-width)] p-0"
                    >
                      <Command>
                        <CommandInput placeholder="Search a branch code or city…" />
                        <CommandList>
                          <CommandEmpty>No branch.</CommandEmpty>
                          <CommandGroup>
                            {(branches ?? []).map((b) => (
                              <CommandItem
                                key={b.branch_no}
                                value={`${b.branch_no} ${b.city}`}
                                onSelect={() => {
                                  setForm({ ...form, branch_no: b.branch_no });
                                  setOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    form.branch_no === b.branch_no ? "opacity-100" : "opacity-0",
                                  )}
                                />
                                <span className="mr-2 font-mono">{b.branch_no}</span>
                                <span className="truncate text-xs text-muted-foreground" dir="auto">
                                  {b.city}
                                </span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Appears the moment a branch is chosen, so the questions a
                    customer asks next — is it open, does it deliver, what is the
                    address — are answered without leaving a half-typed order. */}
                {form.branch_no && <BranchPreviewPanel branchNo={form.branch_no} />}
              </section>

              <Section title="Invoicing">
                <div className="space-y-2">
                  <Label>Order value ({CURRENCY})</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.invoice_value}
                    onChange={(e) => setForm({ ...form, invoice_value: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label>
                      Invoice No.{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        (one or many)
                      </span>
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      disabled={readOnly}
                      onClick={() => setInvoices((arr) => [...arr, ""])}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add invoice
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {invoices.map((val, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={val}
                          onChange={(e) =>
                            setInvoices((arr) => arr.map((v, j) => (j === i ? e.target.value : v)))
                          }
                          placeholder={`Invoice ${i + 1}`}
                        />
                        {invoices.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                            disabled={readOnly}
                            onClick={() => setInvoices((arr) => arr.filter((_, j) => j !== i))}
                            aria-label="Remove invoice"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Notes</Label>
                  <Textarea
                    rows={2}
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </div>
              </Section>
            </fieldset>

            <div className="flex justify-end gap-2 border-t border-border/60 pt-4">
              <Button type="button" variant="outline" onClick={() => navigate({ to: "/orders" })}>
                {readOnly ? "Close" : "Cancel"}
              </Button>
              {!readOnly && (
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : mode === "create" ? "Save order" : "Update order"}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {mode === "edit" && id && <OrderActivityTimeline orderId={id} />}
    </div>
  );
}
