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
import { useCallback, useEffect } from "react";
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
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  ChevronsUpDown,
  ClipboardList,
  Plus,
  ReceiptText,
  ShieldAlert,
  StickyNote,
  Trash2,
  Truck,
  User,
  UserCog,
  Wallet,
  X,
} from "lucide-react";
import { ORDER_TYPES, DELIVERY_TYPES, CURRENCY, fmtSAR, formatOrderNo } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { useOrderForm } from "@/features/orders/hooks/use-order-form";
import { requiredFieldValue } from "@/features/orders/payload";
import { invoiceKey } from "@/features/orders/invoice-verification";
import { OrderActivityTimeline } from "@/features/orders/components/order-activity-timeline";
import { OrderAssignment } from "@/features/orders/components/order-assignment";
import { StatusBadge } from "@/features/orders/components/status-badge";
import { CallCenterInvoiceField } from "@/features/orders/components/call-center-invoice-field";
import { OrderInvoicePanel, StateTag } from "@/features/orders/components/order-invoice-panel";
import { BranchPreviewPanel } from "@/features/branches/components/branch-preview-panel";
import { AlShrouqDispatchSection } from "@/features/alshrouq/components/dispatch-section";
import { AlShrouqOrderRequirements } from "@/features/alshrouq/components/order-requirements-section";
import { useAlShrouqCreateApproval } from "@/features/alshrouq/use-create-approval";
import { useAlShrouqOrder, type AlShrouqOrderFields } from "@/features/alshrouq/use-alshrouq-order";
import { resolveAlShrouqPaymentType } from "@/features/alshrouq/payment-methods";
import { AlShrouqApprovalDialog } from "@/features/alshrouq/components/approval-dialog";
import { ALSHROUQ } from "@/features/alshrouq/constants";
import { showAlShrouqSection } from "@/features/alshrouq/dispatch-selection";
import { summariseAlShrouqDispatch } from "@/features/alshrouq/dispatch-timeline";
import { alshrouqToneStyle } from "@/features/alshrouq/dispatch-presentation";
import { useOrderAlShrouqDispatch } from "@/features/alshrouq/use-order-dispatch";

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
  const approval = useAlShrouqCreateApproval();
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
  } = useOrderForm(mode, { afterCreate: approval.afterCreate });

  /**
   * The AlShrouq half of the order — location, coordinates, payment, coverage.
   *
   * Held here rather than inside the dialog, so the fields are part of taking
   * the order rather than three more questions after the agent has pressed
   * *Create order*. One object, read by the form section that fills it, the card
   * that reports coverage, and the dialog that confirms it — so the branch this
   * screen calls covered and the one the handover is offered for cannot differ.
   *
   * Its four persisted values **are** part of `orderFormSchema` and
   * `buildOrderPayload` — they are `orders.alshrouq_*` columns, and writing them
   * is what makes an AlShrouq order reopenable. They are optional there, so an
   * AlShrouq requirement still cannot fail an ordinary order's save: what an
   * agent must supply before a *handover* is enforced by `alshrouqRequirements`,
   * which gates the send and not the save. See `order-requirements.ts`.
   */
  /**
   * The AlShrouq half of the order, read from and written to the **form**.
   *
   * The hook used to own these values in its own `useState`, so they reached the
   * dispatch request and nothing else: `buildOrderPayload` could not see them,
   * the order's `alshrouq_*` columns stayed null, and reopening the order asked
   * the agent for the location, the coordinates and the payment method again.
   * They are order columns, so they are form fields — saved by the ordinary
   * insert and rehydrated by the ordinary effect, like `notes` and `branch_no`.
   */
  const alshrouqPatch = useCallback(
    (next: Partial<AlShrouqOrderFields>) => setForm((f) => ({ ...f, ...next })),
    [setForm],
  );

  /**
   * The order's delivery method — the form's copy, or the order's own when the
   * form has not got one.
   *
   * `requiredFieldValue` is the rule `buildOrderPayload` already applies when
   * this field is *saved*; this is the same rule applied when it is *shown*, and
   * the two now come from one function so they cannot disagree.
   *
   * It is used instead of `form.delivery_type` everywhere the *order's* method
   * is the question. The stored column survives every reload; the form's copy is
   * state seeded by an effect that runs once per order id, so it is blank on the
   * first render of every load and stays blank whenever hydration does not run.
   * That is why an AlShrouq order reopened for editing showed "Select a
   * method…" — and, because the same blank reached `useAlShrouqOrder`, why it
   * would have taken the order's whole AlShrouq half down with it.
   *
   * Editing still works exactly as before: the moment an agent picks a method,
   * `form.delivery_type` is non-blank and wins outright. A new order has no
   * stored value, so it starts blank and must be answered, as it always has.
   */
  const deliveryType = requiredFieldValue(
    form.delivery_type,
    (existing as { delivery_type?: string | null } | null | undefined)?.delivery_type,
  );

  /**
   * This order's AlShrouq dispatch rows.
   *
   * Read before the hook rather than after it, because the payment method below
   * needs them. Same query key as the card and the timeline, so it is still one
   * request for the page.
   */
  const { data: dispatchState } = useOrderAlShrouqDispatch(id, mode === "edit" && !!id);

  /**
   * The order's AlShrouq payment method — the form's, the order's, or the one
   * the delivery was actually created with.
   *
   * The same shape as `deliveryType` above and for a related reason, but this
   * one has a third source and it is the one that matters. Handing an order to
   * AlShrouq writes `payment_type` onto the dispatch row without writing
   * `orders.alshrouq_payment_type` — that column is only written by **Update
   * order**, which nobody presses after arranging a delivery — so production
   * carries dispatched orders whose delivery says `3` and whose order column
   * says nothing. Reopening one showed an empty Payment Method for exactly that
   * reason. See `resolveAlShrouqPaymentType`.
   */
  const alshrouqPaymentType = resolveAlShrouqPaymentType(
    form.alshrouq_payment_type,
    (existing as { alshrouq_payment_type?: number | string | null } | null | undefined)
      ?.alshrouq_payment_type,
    dispatchState?.current?.payment_type,
  );

  /**
   * Put that answer back into the form, once, so the order can keep it.
   *
   * Reading the dispatch row fixes what the agent *sees*; this is what makes the
   * order stop losing it. `buildOrderPayload` writes `alshrouq_payment_type`
   * from form state, so an order whose column is null would save null again on
   * every subsequent edit — the screen repaired and the row still wrong. With
   * the value in form state, the next ordinary save records it.
   *
   * Narrow on purpose, and it cannot overwrite a choice: it fires only while the
   * form's copy is blank, so the moment anything is on screen — hydrated or just
   * picked — this stops having an opinion. There is no path from a chosen method
   * back to blank, because the picker has no empty option.
   */
  useEffect(() => {
    if (!alshrouqPaymentType) return;
    setForm((f) =>
      f.alshrouq_payment_type.trim() ? f : { ...f, alshrouq_payment_type: alshrouqPaymentType },
    );
  }, [alshrouqPaymentType, setForm]);

  const alshrouq = useAlShrouqOrder(
    deliveryType,
    form.branch_no,
    form.customer_name,
    form.customer_phone,
    {
      alshrouq_map_url: form.alshrouq_map_url,
      alshrouq_lat: form.alshrouq_lat,
      alshrouq_lng: form.alshrouq_lng,
      alshrouq_payment_type: alshrouqPaymentType,
    },
    alshrouqPatch,
  );

  /**
   * Whether the AlShrouq card is on this page.
   *
   * Read from the *order*, not from the form. Keying it on `form.delivery_type`
   * alone is what made the card disappear when an order was reopened: that value
   * is React state seeded by an effect, so it is empty on the first render of
   * every load and stays empty whenever the hydration does not run — while the
   * activity timeline, reading the persisted dispatch rows, carried on narrating
   * the very delivery whose card had vanished.
   *
   * The dispatch rows come from the shared hook the card and the timeline
   * already read, under the same query key, so this costs no extra request and
   * the two surfaces cannot disagree about whether a delivery exists. The rule
   * is `showAlShrouqSection`, which is pure and tested.
   */
  const showsAlShrouqSection = showAlShrouqSection({
    storedDeliveryType: (existing as { delivery_type?: string | null } | null | undefined)
      ?.delivery_type,
    formDeliveryType: deliveryType,
    hasDispatchHistory: (dispatchState?.rows.length ?? 0) > 0,
  });

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

  /**
   * A new AlShrouq order asks before it saves.
   *
   * Only on create, and only for AlShrouq: an edit has nothing to approve, and
   * every other delivery method submits exactly as it always has.
   */
  const interceptsCreate = mode === "create" && form.delivery_type === ALSHROUQ;

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

  /**
   * Where the delivery stands, for the header's badge.
   *
   * The same summary the AlShrouq card renders, from the same query — so the
   * chip at the top of the page and the card in the column cannot claim two
   * different things about one delivery. Null when there is no delivery, which
   * is when the header says nothing about one.
   */
  const dispatchSummary = dispatchState?.current
    ? summariseAlShrouqDispatch(dispatchState.current)
    : null;

  /**
   * The facts an order is identified by, as one line under the title.
   *
   * The page used to open with a heading and a sentence of instructions, and
   * everything that actually identifies the order — its type, how it ships,
   * which branch, who for, when — was somewhere down the form in a field the
   * reader had to go and find. These are read far more often than they are
   * edited, so they are stated once, up here, and the fields below stay the
   * place they are changed.
   *
   * Blank entries are dropped rather than rendered as "—": a meta line of
   * placeholders is noise, and every one of these has a field of its own that
   * says it is missing.
   */
  const headerFacts: { icon: typeof ClipboardList; text: string }[] =
    mode === "create"
      ? []
      : [
          form.order_type ? { icon: ClipboardList, text: form.order_type } : null,
          deliveryType ? { icon: Truck, text: deliveryType } : null,
          form.branch_no
            ? { icon: Building2, text: `${form.branch_no} ${cityFor(form.branch_no)}`.trim() }
            : null,
          form.customer_name ? { icon: User, text: form.customer_name } : null,
          form.order_date ? { icon: CalendarDays, text: form.order_date } : null,
        ].filter((f): f is { icon: typeof ClipboardList; text: string } => f !== null);

  /** The order's value, formatted, or null when it has none yet. */
  const headerTotal = form.invoice_value.trim() !== "" ? Number(form.invoice_value) : null;

  return (
    // Wide enough for two real columns and no wider. The workflow column holds
    // the fields, the verification column holds what the portal found; below
    // `xl` there is not enough width for both and they stack, workflow first.
    <div className="mx-auto max-w-[1360px] space-y-4">
      {/* Breadcrumb and the page's own sentence. Deliberately *outside* the
          bar below and free to scroll away: it says what this screen is, which
          is worth reading once and never again. */}
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
        <p className="mt-1.5 text-xs text-muted-foreground">
          {readOnly
            ? "This order is read-only for your role."
            : mode === "create"
              ? "Create a new order and link invoices automatically."
              : "Invoices are looked up and verified automatically; fields marked * are required."}
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The order bar — who this order is, what it is worth, and the actions */}
      {/* ------------------------------------------------------------------ */}
      {/* Sticky, and this is the one thing on the page that is.

          The form is long. An agent halfway down it, reconciling an invoice
          against a delivery, previously had no way to see which order they were
          in or what it was worth without scrolling back, and no way to save
          without scrolling back either — the primary action was at the top and
          nothing followed it down.

          `top-16` clears `AppHeader`, which is `sticky top-0 z-30 h-16`; `z-20`
          keeps this under it rather than through it. It sticks to the document,
          which is the scrollport — `_app.tsx` is careful to keep it that way,
          and this bar depends on that being true.

          **The right-hand column is deliberately not sticky.** It was the
          obvious place to put this, and it does not work: that column runs from
          the invoice panel through the AlShrouq card to the activity timeline
          and is routinely taller than the viewport, so pinning it would fix its
          top on screen and put its bottom permanently out of reach — the
          timeline would become unscrollable. Making it its own scroll box is
          the other way, and gives the page a second scrollbar a few pixels from
          the first, which is exactly what that column's own comment records
          having removed. So the *summary* follows the reader instead, and the
          column keeps the page's single scroll. */}
      <div className="sticky top-16 z-20 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-border/60 bg-background/85 px-3 py-2.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
        <div className="min-w-0">
          {/* Title and state on one wrapping line. The badges answer, without
              a click or a scroll, the two questions every operations screen is
              opened to ask: has this order been verified, and has the delivery
              actually gone. */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{heading}</h1>
            {mode === "edit" && existing?.status && <StatusBadge s={existing.status} />}
            {valueIsVerified && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                <BadgeCheck className="h-3 w-3" aria-hidden="true" />
                Verified
              </span>
            )}
            {dispatchSummary && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  alshrouqToneStyle(dispatchSummary.tone).badge,
                )}
              >
                <Truck className="h-3 w-3" aria-hidden="true" />
                AlShrouq &middot; {dispatchSummary.label}
              </span>
            )}
          </div>

          {/* The order's identity, stated rather than searched for. */}
          {headerFacts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {headerFacts.map((fact) => (
                <span key={fact.text} className="inline-flex min-w-0 items-center gap-1.5">
                  <fact.icon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  <span className="truncate" dir="auto" title={fact.text}>
                    {fact.text}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* The order's value, at the size the most consequential number on
              the page deserves. It sat in a form field two cards down, in the
              same 14px as the branch code — so the one figure a supervisor
              scans for was the one they had to hunt for. Still just a readout:
              the field below remains where it is edited. */}
          {mode === "edit" && headerTotal !== null && Number.isFinite(headerTotal) && (
            <div className="text-right leading-none">
              <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Order value
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">
                {fmtSAR(headerTotal)}
              </p>
            </div>
          )}
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
            <Button
              /*
               * One primary action, two behaviours.
               *
               * A new AlShrouq order opens the approval dialog instead of
               * submitting, because "create" and "hand this to a courier" are
               * two different decisions and the agent has not made the second
               * one yet. Everything else submits exactly as it always has —
               * same button, same form, same handler.
               */
              type={interceptsCreate ? "button" : "submit"}
              form={interceptsCreate ? undefined : FORM_ID}
              onClick={interceptsCreate ? approval.open : undefined}
              title={
                interceptsCreate
                  ? "You will choose whether to send this order to AlShrouq before it is created"
                  : undefined
              }
              size="sm"
              disabled={busy}
              className="min-w-32"
            >
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

              {/* AlShrouq is the one method that hands the order to somebody
                  outside the portal, so choosing it changes what happens when
                  the order is created. Saying so here — where the choice is
                  made — is what stops the approval dialog arriving as a
                  surprise two fields later. */}
              <Field
                id="order-delivery"
                label="Delivery & pickup"
                required
                hint={
                  deliveryType === ALSHROUQ ? (
                    <span className="flex items-start gap-1.5">
                      <Truck
                        className="mt-px h-3.5 w-3.5 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <span>
                        {mode === "create"
                          ? "AlShrouq delivers this order. When you create it you can choose to save it only, or to hand the delivery to AlShrouq."
                          : "AlShrouq delivers this order. The delivery panel on the right shows where it stands."}
                      </span>
                    </span>
                  ) : undefined
                }
              >
                <Select
                  value={deliveryType}
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

              {/* Optional for every other method, required for AlShrouq: a
                  courier has to know who to call. Marked, not enforced by the
                  schema — an ordinary save must never be blocked by an AlShrouq
                  rule, which is the outage the reverted integration caused. What
                  the requirement actually gates is the handover. */}
              <Field
                id="customer-name"
                label="Customer name"
                required={alshrouq.active}
                optional={!alshrouq.active}
              >
                <Input
                  id="customer-name"
                  value={form.customer_name}
                  onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                  placeholder="As given on the call"
                />
              </Field>

              <Field
                id="customer-phone"
                label="Customer phone"
                required={alshrouq.active}
                optional={!alshrouq.active}
              >
                <Input
                  id="customer-phone"
                  value={form.customer_phone}
                  onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
                  placeholder="05XXXXXXXX"
                  dir="ltr"
                  inputMode="tel"
                />
              </Field>

              {/* The three things a courier needs that no order column holds.
                  Inside this card rather than in one of its own, because they
                  are part of the same question — who is this for and where does
                  it go — and a fifth card would push the invoicing section below
                  the fold on a laptop. */}
              {alshrouq.active && (
                <AlShrouqOrderRequirements
                  state={alshrouq}
                  invoiceValue={form.invoice_value}
                  readOnly={readOnly}
                />
              )}
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

          {/* AlShrouq before the branch panel, deliberately.

              Both are contextual, but only one is acted on: the dispatch card
              carries the delivery's status, its scheduled slot and its tracking
              link, while the branch panel is reference an agent glances at. On a
              narrow screen the column stacks in document order, so whichever is
              first is the one visible without scrolling — and the higher-priority
              delivery integration should not be below a phone number.

              Appears the moment the delivery method is AlShrouq, on a draft as
              well as a saved order — and goes on appearing for a saved order
              whose delivery method or dispatch history says AlShrouq, whatever
              the form state happens to hold. See `showsAlShrouqSection`.
              Read-only: it reflects the state above and takes no part in
              validation or submit. */}
          {showsAlShrouqSection && (
            <AlShrouqDispatchSection
              mode={mode}
              orderId={id}
              customerName={form.customer_name}
              customerPhone={form.customer_phone}
              branchNo={form.branch_no}
              invoiceValue={form.invoice_value}
              alshrouq={alshrouq}
            />
          )}

          {/* Appears the moment a branch is chosen, so the questions a customer
              asks next are answered without leaving a half-typed order. */}
          {form.branch_no && <BranchPreviewPanel branchNo={form.branch_no} />}

          {mode === "edit" && id && <OrderActivityTimeline orderId={id} />}
        </aside>
      </div>

      {/* The dialog collects its own delivery note and this form knows nothing
          about it. The two are separate facts: the Notes card above is internal,
          for whoever opens this order next, while the dialog's note is an
          instruction handed to a driver and belongs to the delivery — it is
          persisted on the dispatch row as `details`, which is the key AlShrouq's
          create endpoint reads. Pressing **Create order only** therefore leaves
          no delivery note anywhere, which is correct: there is no delivery. */}
      {interceptsCreate && (
        <AlShrouqApprovalDialog
          mode="create"
          open={approval.isOpen}
          onOpenChange={approval.setOpen}
          alshrouq={alshrouq}
          customerName={form.customer_name}
          customerPhone={form.customer_phone}
          branchNo={form.branch_no}
          invoiceValue={form.invoice_value}
          dispatchAvailable={alshrouq.dispatchAvailable}
          busy={busy}
          onApprove={(plan) =>
            approval.approve(plan, () =>
              (document.getElementById(FORM_ID) as HTMLFormElement | null)?.requestSubmit(),
            )
          }
        />
      )}
    </div>
  );
}
