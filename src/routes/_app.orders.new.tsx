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
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ArrowLeft,
  Check,
  ChevronsUpDown,
  ClipboardList,
  Plus,
  ReceiptText,
  ShieldAlert,
  Store,
  Trash2,
  User,
  X,
} from "lucide-react";
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
 * One group of fields, with a heading that can actually be found.
 *
 * The four groups themselves are not new — the form was once a flat grid of
 * eleven controls where "Date" and "Invoice No." carried identical weight, and
 * splitting it into when-and-who, who-is-calling, where-it-goes and
 * what-it-is-worth is what gave an agent filling it in mid-call somewhere to
 * aim. What was missing was making the headings *visible*: 11px uppercase in
 * muted grey is the same treatment this codebase uses for field labels, so the
 * group headings and the things they grouped were indistinguishable at a glance,
 * and the structure only existed if you already knew it was there.
 *
 * So each heading now gets a tinted icon tile, body-sized semibold text and a
 * line of context, and each section owns its own padded band separated by a
 * hairline. Deliberately not larger than `text-sm`: these organize a form, they
 * are not page titles, and an oversized heading in a five-section form reads as
 * five pages stacked. The icon does the work that size would otherwise have to.
 */
function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof ClipboardList;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/60 px-4 py-5 first:border-t-0 sm:px-6 sm:py-6">
      <header className="mb-4 flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/15"
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-sm font-semibold leading-none tracking-tight text-foreground">
            {title}
          </h2>
          <p className="mt-1 text-[11.5px] leading-tight text-muted-foreground">{hint}</p>
        </div>
      </header>
      <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * One labelled control.
 *
 * Exists so that every field in the form aligns and sizes identically rather
 * than each `div.space-y-2` being reinvented at its call site — which is how the
 * old form ended up with three different ways of saying "optional" and a
 * required marker that appeared in two different type sizes.
 *
 * `htmlFor` is threaded through because none of these labels were associated
 * with their control at all: clicking "Customer phone" did nothing, and a screen
 * reader read the inputs unlabelled.
 */
function Field({
  id,
  label,
  required,
  optional,
  hint,
  className,
  children,
}: {
  id?: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium">
        <span>{label}</span>
        {required && (
          <span className="text-destructive" title="Required">
            *
          </span>
        )}
        {optional && <span className="font-normal text-muted-foreground/80">&mdash; optional</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] leading-tight text-muted-foreground">{hint}</p>}
    </div>
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

  const orderNo = formatOrderNo(existing?.team, existing?.display_no);
  const heading =
    mode === "create" ? "New order" : `${readOnly ? "View" : "Edit"} order ${orderNo}`;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* Page header. The title was inside the card, competing with the section
          headings for the same job; out here it is unambiguously the page. */}
      <div>
        <Link
          to="/orders"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to orders
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{heading}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {readOnly
                ? "This order is read-only for your role."
                : "Fields marked with an asterisk are required."}
            </p>
          </div>
          {mode === "edit" && canDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={del}
              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* `overflow-hidden` so the section bands and the footer's tint stop at the
          card's rounded corners instead of squaring them off. */}
      <Card className="overflow-hidden shadow-sm">
        <form onSubmit={submit}>
          <fieldset disabled={readOnly} className="contents">
            <Section
              icon={ClipboardList}
              title="Order"
              hint="When it came in, which team took it, and how it is being fulfilled."
            >
              <Field id="order-date" label="Date" required>
                <Input
                  id="order-date"
                  type="date"
                  value={form.order_date}
                  onChange={(e) => setForm({ ...form, order_date: e.target.value })}
                  required
                />
              </Field>

              <Field id="order-team" label="Team">
                <Select
                  value={form.team}
                  onValueChange={(v) =>
                    setForm({ ...form, team: v as (typeof TEAMS)[number]["value"] })
                  }
                  disabled={readOnly || (mode === "edit" && !canEditAll)}
                >
                  <SelectTrigger id="order-team">
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
              </Field>

              <Field id="order-type" label="Order type" required>
                <Select
                  value={form.order_type}
                  onValueChange={(v) => setForm({ ...form, order_type: v })}
                  disabled={readOnly}
                >
                  <SelectTrigger id="order-type">
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
              </Field>

              <Field id="order-delivery" label="Delivery & pickup" required>
                <Select
                  value={form.delivery_type}
                  onValueChange={(v) => setForm({ ...form, delivery_type: v })}
                  disabled={readOnly}
                >
                  <SelectTrigger id="order-delivery">
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
              </Field>
            </Section>

            <Section
              icon={User}
              title="Customer"
              hint="Not required to save, but it is what makes an order traceable later."
            >
              <Field id="customer-name" label="Customer name" optional>
                <Input
                  id="customer-name"
                  value={form.customer_name}
                  onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                  placeholder="As given on the call"
                />
              </Field>

              <Field id="customer-phone" label="Customer phone" optional>
                <Input
                  id="customer-phone"
                  value={form.customer_phone}
                  onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
                  placeholder="05XXXXXXXX"
                  dir="ltr"
                  inputMode="tel"
                />
              </Field>
            </Section>

            {/* BRANCH — one control, then the answer.
                The read-only "City (auto)" box beside it is gone. It restated
                the second half of the label already inside the picker's own
                trigger, and once a branch is chosen the panel below states the
                city in both scripts along with everything else a customer asks
                next. A disabled input whose only job is to echo another
                control is a field an agent's eye has to skip on every order. */}
            <Section
              icon={Store}
              title="Branch"
              hint="Everything the customer asks next is answered below, without leaving the form."
            >
              <Field id="order-branch" label="Branch No." required className="md:col-span-2">
                <Popover open={open} onOpenChange={setOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="order-branch"
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
                      <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
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
              </Field>

              {/* Appears the moment a branch is chosen, so the questions a
                  customer asks next — is it open, does it deliver, what is the
                  address — are answered without leaving a half-typed order. */}
              {form.branch_no && (
                <div className="md:col-span-2">
                  <BranchPreviewPanel branchNo={form.branch_no} />
                </div>
              )}
            </Section>

            <Section
              icon={ReceiptText}
              title="Invoicing"
              hint="What the order is worth, the invoices it covers, and anything worth recording."
            >
              <Field id="order-value" label={`Order value (${CURRENCY})`}>
                <Input
                  id="order-value"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.invoice_value}
                  onChange={(e) => setForm({ ...form, invoice_value: e.target.value })}
                  placeholder="0.00"
                  className="tabular-nums"
                />
              </Field>

              <div className="min-w-0 space-y-1.5 md:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <Label
                    htmlFor="invoice-0"
                    className="flex items-center gap-1.5 text-xs font-medium"
                  >
                    <span>Invoice No.</span>
                    <span className="font-normal text-muted-foreground/80">
                      &mdash; one or many
                    </span>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-primary hover:bg-primary/10 hover:text-primary"
                    disabled={readOnly}
                    onClick={() => setInvoices((arr) => [...arr, ""])}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add invoice
                  </Button>
                </div>
                <div className="space-y-2">
                  {invoices.map((val, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {/* A row number rather than a placeholder that says
                          "Invoice 2": the placeholder vanished the moment
                          anything was typed, which is exactly when a list of
                          four identical boxes needs the index. */}
                      <span
                        aria-hidden
                        className="w-4 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground"
                      >
                        {i + 1}
                      </span>
                      <Input
                        id={`invoice-${i}`}
                        value={val}
                        onChange={(e) =>
                          setInvoices((arr) => arr.map((v, j) => (j === i ? e.target.value : v)))
                        }
                        placeholder="Invoice number"
                        aria-label={`Invoice number ${i + 1}`}
                        className="font-mono"
                        dir="ltr"
                      />
                      {invoices.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          disabled={readOnly}
                          onClick={() => setInvoices((arr) => arr.filter((_, j) => j !== i))}
                          aria-label={`Remove invoice ${i + 1}`}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <Field
                id="order-notes"
                label="Notes"
                optional
                className="md:col-span-2"
                hint="Anything the next person opening this order should know."
              >
                <Textarea
                  id="order-notes"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="resize-y"
                />
              </Field>
            </Section>
          </fieldset>

          {/* Action bar. Tinted and separated so it reads as the end of the form
              rather than as another field, and stacked on a phone so neither
              button ends up a thumb-width wide. */}
          <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/25 px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6 dark:bg-muted/15">
            <Button
              type="button"
              variant="outline"
              // `resetScroll: false` for the same reason as the save path:
              // backing out of an order must return the agent to the row they
              // opened, not to the top of the list.
              onClick={() => navigate({ to: "/orders", resetScroll: false })}
              className="w-full sm:w-auto"
            >
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={busy} className="w-full sm:w-auto sm:min-w-32">
                {busy ? "Saving…" : mode === "create" ? "Save order" : "Update order"}
              </Button>
            )}
          </div>
        </form>
      </Card>

      {mode === "edit" && id && <OrderActivityTimeline orderId={id} />}
    </div>
  );
}
