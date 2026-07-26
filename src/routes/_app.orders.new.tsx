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

export const Route = createFileRoute("/_app/orders/new")({
  head: () => ({ meta: [{ title: "New Order" }] }),
  component: () => <OrderForm mode="create" />,
});

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
    canEditThis,
    readOnly,
    submit,
    del,
  } = useOrderForm(mode);

  if (mode === "create" && !canCreate) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have permission to create orders.
        </p>
      </div>
    );
  }

  if (mode === "edit" && existing && !canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to this order.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Link
          to="/orders"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to orders
        </Link>
        {mode === "edit" && canDelete && (
          <Button variant="outline" size="sm" onClick={del}>
            <Trash2 className="h-4 w-4 mr-2" />
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
          <form onSubmit={submit} className="grid md:grid-cols-2 gap-4">
            <fieldset disabled={readOnly} className="contents">
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
                  onValueChange={(v) => setForm({ ...form, team: v as any })}
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
                />
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
                  Delivery & Pickup <span className="text-destructive">*</span>
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
                      {form.branch_no
                        ? `${form.branch_no} — ${cityFor(form.branch_no)}`
                        : "Select branch…"}
                      <ChevronsUpDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-0 w-[280px]">
                    <Command>
                      <CommandInput placeholder="Search branch…" />
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
                              <span className="font-mono mr-2">{b.branch_no}</span>
                              <span className="text-muted-foreground text-xs">{b.city}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label>City (auto)</Label>
                <Input
                  value={cityFor(form.branch_no) || ""}
                  readOnly
                  className="h-10 bg-muted/60 leading-normal py-2"
                  placeholder="—"
                />
              </div>
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
                    <span className="text-xs text-muted-foreground font-normal">(one or many)</span>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    disabled={readOnly}
                    onClick={() => setInvoices((arr) => [...arr, ""])}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add invoice
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
            </fieldset>
            <div className="md:col-span-2 flex justify-end gap-2">
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
