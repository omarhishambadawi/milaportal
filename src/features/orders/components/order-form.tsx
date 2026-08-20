/**
 * The Orders form, shared by `/orders/new` and `/orders/$id`.
 *
 * It lived in `_app.orders.new.tsx` and was exported from there for the edit
 * route to reuse. That put it in the route *shell* rather than the route
 * component: the TanStack splitter only moves a route's own `component` into the
 * split chunk, and `routeTree.gen.ts` imports every shell eagerly — so this form,
 * together with cmdk, zod, the invoice panel and the branch picker, was in the
 * entry bundle of every page, Dashboard included. It was also emitted twice,
 * once in the shell and once in the split chunk that referenced it.
 *
 * As its own module both routes reach it through their split components, so it
 * is fetched when an Orders form is actually opened. Moved verbatim — no markup,
 * behaviour or permission check is changed.
 */
import { Link } from "@tanstack/react-router";
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
  BadgeCheck,
  Check,
  ChevronRight,
  ChevronsUpDown,
  ClipboardList,
  Plus,
  ReceiptText,
  ShieldAlert,
  StickyNote,
  Trash2,
  UserCog,
  X,
} from "lucide-react";
import { ORDER_TYPES, DELIVERY_TYPES, CURRENCY, formatOrderNo } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { useOrderForm } from "@/features/orders/hooks/use-order-form";
import { invoiceKey } from "@/features/orders/invoice-verification";
import { OrderActivityTimeline } from "@/features/orders/components/order-activity-timeline";
import { AlShrouqDispatchPanel } from "@/features/orders/components/alshrouq-dispatch-panel";
import { OrderAssignment } from "@/features/orders/components/order-assignment";
import { CallCenterInvoiceField } from "@/features/orders/components/call-center-invoice-field";
import { OrderInvoicePanel, StateTag } from "@/features/orders/components/order-invoice-panel";
import { BranchPreviewPanel } from "@/features/branches/components/branch-preview-panel";

/** The id the header's submit button reaches the form by, across the layout. */
const FORM_ID = "order-form";

/**
 * One card of the workflow column.
 *
 * The form used to be a single tall card of five banded sections, which is what
 * made the page read as one long scroll with a metre of empty space to its
 * right. Each group is its own card now — same headings, same 8px icon tile,
 * same 11.5px line of context — so the workflow column can sit beside the
 * verification column instead of under it, and a group can be skipped by eye
 * rather than by scrolling past its fields.
 *
 * Deliberately still not larger than `text-sm`: these organize a form, they are
 * not page titles, and four oversized headings in a column read as four pages
 * stacked. The icon does the work that size would otherwise have to.
 */
function SectionCard({
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
    <Card className="overflow-hidden shadow-sm">
      <header className="flex items-start gap-3 border-b border-border/60 bg-muted/25 px-4 py-3 dark:bg-muted/10">
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-inset ring-primary/15"
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-none tracking-tight text-foreground">
            {title}
          </h2>
          <p className="mt-1 text-[11.5px] leading-tight text-muted-foreground">{hint}</p>
        </div>
      </header>
      <div className="grid gap-x-4 gap-y-3.5 p-4 sm:grid-cols-2">{children}</div>
    </Card>
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
  hint?: React.ReactNode;
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
      {hint && <div className="text-[11px] leading-tight text-muted-foreground">{hint}</div>}
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
    canDelete,
    canViewShams,
    canPickAgent,
    canVerifyThis,
    userId,
    agents,
    shamsInvoices,
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

  /**
   * Whether the value in the box is the one Shams verified.
   *
   * Compared against the field rather than assumed from the presence of a
   * verified invoice: an agent who has since typed over it should not be told
   * the number on screen is verified when it is not.
   */
  const valueIsVerified =
    shamsInvoices.verified.length > 0 && Number(form.invoice_value) === shamsInvoices.verifiedTotal;

  /** The state of each typed number, so a row can say where its lookup got to. */
  const stateOf = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return shamsInvoices.invoices.find((i) => i.key === invoiceKey(trimmed)) ?? null;
  };

  /** The call-centre documents behind an automated tick, for the caption. */
  const callCentreNos = shamsInvoices.verified
    .filter((i) => i.isCallCentre)
    .map((i) => i.invoiceNo);
  const callCenterChecked = form.call_center_verified || shamsInvoices.callCentreVerified;

  const orderNo = formatOrderNo(existing?.team, existing?.display_no);
  const heading =
    mode === "create" ? "New order" : `${readOnly ? "View" : "Edit"} order ${orderNo}`;

  return (
    // Wide enough for two real columns and no wider. The workflow column holds
    // the fields, the verification column holds what the portal found; below
    // `xl` there is not enough width for both and they stack, workflow first.
    <div className="mx-auto max-w-[1360px] space-y-4">
      {/* Page header. Breadcrumb, what this page is, and the two actions —
          out here rather than inside the card, where the title competed with
          the section headings for the same job and the buttons sat at the end
          of a scroll. */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Link to="/orders" className="font-medium transition-colors hover:text-foreground">
              Orders
            </Link>
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
            <span className="text-foreground">{mode === "create" ? "New order" : orderNo}</span>
          </nav>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl">{heading}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {readOnly
              ? "This order is read-only for your role."
              : mode === "create"
                ? "Create a new order and link invoices automatically."
                : "Invoices are looked up and verified automatically; fields marked * are required."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mode === "edit" && canDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={del}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            // `resetScroll: false` for the same reason as the save path: backing
            // out of an order must return the agent to the row they opened, not
            // to the top of the list.
            onClick={() => navigate({ to: "/orders", resetScroll: false })}
          >
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            // Outside the `form` element, so it reaches it by id. Keeping the
            // primary action in the header is what lets the form itself end
            // with a field rather than with a band of buttons.
            <Button type="submit" form={FORM_ID} size="sm" disabled={busy} className="min-w-32">
              {busy ? "Saving…" : mode === "create" ? "Create order" : "Update order"}
            </Button>
          )}
        </div>
      </div>

      {/* 60/40, as fractions rather than a fixed right-hand width.
          `minmax(0,26rem)` made the verification column a sidebar: on a 1360px
          page it took under 30%, which left the form's two-up fields swimming in
          whitespace on the left while an invoice's customer, channel and item
          lines fought over 380px on the right. The invoice panel is not a
          sidebar — it is the half of this page an agent reconciles against — so
          the space is split in proportion and both halves get a usable measure.
          `minmax(0,…)` on both tracks is what stops a long Arabic customer name
          widening the page instead of wrapping. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------------------ */}
        {/* Workflow — what the agent fills in                                  */}
        {/* ------------------------------------------------------------------ */}
        <form id={FORM_ID} onSubmit={submit} className="min-w-0 space-y-4">
          <fieldset disabled={readOnly} className="contents">
            <SectionCard
              icon={ClipboardList}
              title="Order details"
              hint="When it came in, how it is fulfilled, and who it is for."
            >
              <Field id="order-date" label="Date" required>
                <Input
                  id="order-date"
                  type="date"
                  value={form.order_date}
                  onChange={(e) => setForm((f) => ({ ...f, order_date: e.target.value }))}
                  required
                />
              </Field>

              {/* The Team selector that stood here is gone. It asked the
                  question backwards: an order belongs to a person, and the team
                  is a fact about that person — so picking a team and then an
                  agent from another one was possible, and filed the order under
                  a team its agent is not in. The Assignment section below reads
                  the team off the assigned agent instead. */}

              <Field id="order-type" label="Order type" required>
                <Select
                  value={form.order_type}
                  onValueChange={(v) => setForm((f) => ({ ...f, order_type: v }))}
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
                  onValueChange={(v) => setForm((f) => ({ ...f, delivery_type: v }))}
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

              {/* The branch. Everything the customer asks next — is it open,
                  does it deliver, what is the address — is answered by the
                  panel in the verification column, without leaving the form. */}
              <Field id="order-branch" label="Branch No." required>
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
                                setForm((f) => ({ ...f, branch_no: b.branch_no }));
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

              <Field id="customer-name" label="Customer name" optional>
                <Input
                  id="customer-name"
                  value={form.customer_name}
                  onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                  placeholder="As given on the call"
                />
              </Field>

              <Field id="customer-phone" label="Customer phone" optional>
                <Input
                  id="customer-phone"
                  value={form.customer_phone}
                  onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
                  placeholder="05XXXXXXXX"
                  dir="ltr"
                  inputMode="tel"
                />
              </Field>
            </SectionCard>

            <SectionCard
              icon={ReceiptText}
              title="Invoicing"
              hint="What the order is worth, and the invoices it covers."
            >
              {/* Order value. Typed by the agent until Shams returns a
                  document, from which point the verified total is authoritative:
                  it is put into the box on arrival and written to the order on
                  save, whatever the box holds. The field stays editable — a
                  correction before anything is verified is a legitimate act —
                  but it says where the number came from, so nobody believes a
                  typed figure survived a verification. */}
              <Field
                id="order-value"
                label={`Order value (${CURRENCY})`}
                hint={
                  valueIsVerified ? (
                    <span className="inline-flex items-center gap-1 font-medium text-success">
                      <BadgeCheck className="h-3 w-3" aria-hidden="true" />
                      {shamsInvoices.isMulti
                        ? `Auto-filled from ${shamsInvoices.verified.length} verified invoices`
                        : "Auto-filled from the verified invoice"}
                    </span>
                  ) : (
                    "Updated automatically when the invoices are verified."
                  )
                }
              >
                <div className="relative">
                  <Input
                    id="order-value"
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.invoice_value}
                    onChange={(e) => setForm((f) => ({ ...f, invoice_value: e.target.value }))}
                    placeholder="0.00"
                    className={cn(
                      "text-base font-semibold tabular-nums",
                      valueIsVerified && "border-success/40 pr-24",
                    )}
                  />
                  {valueIsVerified && (
                    <span className="pointer-events-none absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                      <BadgeCheck className="h-3 w-3" aria-hidden="true" />
                      Verified
                    </span>
                  )}
                </div>
              </Field>

              <div className="min-w-0 space-y-1.5 sm:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <Label
                    htmlFor="invoice-0"
                    className="flex items-center gap-1.5 text-xs font-medium"
                  >
                    <span>Invoice No.</span>
                    <span className="font-normal text-muted-foreground/80">
                      &mdash; add one or more invoice numbers
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
                <div className="space-y-1.5">
                  {invoices.map((val, i) => {
                    const state = canViewShams ? stateOf(val) : null;
                    return (
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
                        <div className="relative min-w-0 flex-1">
                          <Input
                            id={`invoice-${i}`}
                            value={val}
                            onChange={(e) =>
                              setInvoices((arr) =>
                                arr.map((v, j) => (j === i ? e.target.value : v)),
                              )
                            }
                            placeholder="Invoice number"
                            aria-label={`Invoice number ${i + 1}`}
                            className={cn("font-mono", state && "pr-24")}
                            dir="ltr"
                          />
                          {/* Where this number's lookup got to, on the row that
                              carries it — the panel opposite has the document,
                              this only has to say whether there is one. */}
                          {state && (
                            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                              <StateTag state={state.state} />
                            </span>
                          )}
                        </div>
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
                    );
                  })}
                </div>
              </div>
            </SectionCard>

            {/* ASSIGNMENT — who owns the order, and therefore which team it is
                filed under. Agent first: the team is derived, never asked for
                separately, so the two cannot disagree. The Call Center flag
                sits here because it is the same kind of fact — an operational
                classification of the order, not a field describing it. */}
            <SectionCard
              icon={UserCog}
              title="Assignment"
              hint={
                canPickAgent
                  ? "Choose the agent; the team follows from who they are. Whoever enters the order is recorded separately."
                  : "Who this order belongs to, and the team that follows from it."
              }
            >
              <div className="sm:col-span-2">
                <OrderAssignment
                  agents={agents}
                  // The assignee — never seeded from whoever is looking at the
                  // page. An Owner or Supervisor creating an order starts here
                  // empty and must choose an agent.
                  agentId={form.agent_id || null}
                  createdById={mode === "create" ? userId : ((existing as any)?.created_by ?? null)}
                  team={form.team}
                  canAssign={canPickAgent}
                  disabled={readOnly}
                  onAssign={({ agentId, team }) =>
                    setForm((f) => ({ ...f, agent_id: agentId, team: team ?? f.team }))
                  }
                />
              </div>
              <div className="sm:col-span-2">
                <CallCenterInvoiceField
                  checked={callCenterChecked}
                  automated={shamsInvoices.callCentreVerified}
                  invoiceNos={callCentreNos}
                  hasVerified={shamsInvoices.verified.length > 0}
                  canVerify={canVerifyThis}
                  disabled={readOnly}
                  onChange={(next) => setForm((f) => ({ ...f, call_center_verified: next }))}
                />
              </div>
            </SectionCard>

            <SectionCard
              icon={StickyNote}
              title="Notes"
              hint="Anything the next person opening this order should know."
            >
              <div className="min-w-0 sm:col-span-2">
                <Textarea
                  id="order-notes"
                  aria-label="Notes"
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional"
                  className="resize-y"
                />
              </div>
            </SectionCard>
          </fieldset>
        </form>

        {/* ------------------------------------------------------------------ */}
        {/* Verification — what the portal found                                */}
        {/* ------------------------------------------------------------------ */}
        {/* Read-only findings, and deliberately outside the `form` element: a
            `fieldset` that gets disabled for a read-only role would hide them
            from exactly the people reviewing the order.

            **No scroll container of its own.** This column was `sticky` with a
            capped height and `overflow-y: auto`, which gave the page a second
            scrollbar: an agent reading an invoice's items had to work out which
            of two scrolling regions the pointer was over, and a wheel gesture
            did different things a few pixels apart. An order form is not a
            dashboard — the two columns are one document, read top to bottom —
            so both now sit in the page's own scroll and there is exactly one
            scrollbar. `items-start` on the grid keeps them top-aligned rather
            than stretching the shorter one. */}
        <aside className="min-w-0 space-y-4">
          {canViewShams && <OrderInvoicePanel invoices={shamsInvoices} />}

          {/* Appears the moment a branch is chosen, so the questions a customer
              asks next are answered without leaving a half-typed order. */}
          {form.branch_no && <BranchPreviewPanel branchNo={form.branch_no} />}

          {/* Only for a saved order whose delivery method is actually AlShrouq:
              a courier cannot be sent an order that does not exist yet, and a
              dispatch button on a store pickup is an invitation to a mistake. */}
          {mode === "edit" && id && form.delivery_type === "AlShrouq" && (
            <AlShrouqDispatchPanel orderId={id} />
          )}

          {mode === "edit" && id && <OrderActivityTimeline orderId={id} />}
        </aside>
      </div>
    </div>
  );
}
