/**
 * The admin design system: the small set of pieces every administration page is
 * built from.
 *
 * These exist so the admin pages stop being individually-styled screens. Before
 * adding a new visual pattern to an admin page, add it here — the value is in
 * there being one status badge, not three that nearly agree.
 *
 * ## The rules these encode
 *
 * **Colour carries state, never decoration.** `tone` is the only colour input,
 * and its five values map to the five things an operator needs to tell apart:
 * healthy, working, needs-attention, broken, and nothing-to-say. A card does not
 * get a colour because it is important.
 *
 * **Every surface is the same surface.** One border, one radius, one shadow.
 * Depth is used to separate content from page, not to rank cards against each
 * other.
 *
 * Built on the project's existing tokens — `--primary` is MilaPortal's
 * turquoise, not a new brand colour — and on the existing shadcn primitives,
 * so nothing here introduces a second UI library.
 */

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Info, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Tone                                                                        */
/* -------------------------------------------------------------------------- */

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/**
 * The one place a state becomes a colour.
 *
 * Deliberately muted: these sit on a white operational page in quantity, and a
 * saturated badge repeated forty times down a history table stops meaning
 * anything. Contrast is carried by the text, not the fill.
 */
const TONE_STYLES: Record<Tone, { badge: string; dot: string; text: string; ring: string }> = {
  success: {
    badge:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
    ring: "ring-emerald-500/20",
  },
  warning: {
    badge:
      "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
    ring: "ring-amber-500/20",
  },
  danger: {
    badge:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
    dot: "bg-red-500",
    text: "text-red-700 dark:text-red-400",
    ring: "ring-red-500/20",
  },
  info: {
    badge:
      "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
    dot: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-400",
    ring: "ring-sky-500/20",
  },
  neutral: {
    badge: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    ring: "ring-border",
  },
};

export function toneClasses(tone: Tone) {
  return TONE_STYLES[tone];
}

/**
 * The vocabulary of run and scheduler states, mapped once.
 *
 * Every admin surface that renders a status reads it from here, so `running`
 * cannot be blue on one page and grey on another. An unrecognised value falls
 * to `neutral` rather than to a guess.
 */
export const STATUS_TONE: Record<string, Tone> = {
  success: "success",
  completed: "success",
  ok: "success",
  active: "success",
  healthy: "success",
  running: "info",
  triggered: "info",
  poked: "info",
  queued: "info",
  idle: "neutral",
  skipped: "neutral",
  disabled: "neutral",
  indeterminate: "warning",
  unconfigured: "warning",
  degraded: "warning",
  failed: "danger",
  error: "danger",
};

export function statusTone(value: string | null | undefined): Tone {
  if (!value) return "neutral";
  return STATUS_TONE[value.toLowerCase()] ?? "neutral";
}

/* -------------------------------------------------------------------------- */
/* Badges and indicators                                                       */
/* -------------------------------------------------------------------------- */

export function StatusBadge({
  status,
  tone,
  label,
  className,
}: {
  status?: string | null;
  tone?: Tone;
  label?: string;
  className?: string;
}) {
  const resolved = tone ?? statusTone(status);
  const s = TONE_STYLES[resolved];
  const text = label ?? status ?? "—";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium capitalize",
        s.badge,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * A larger, quieter state line for the top of a status card.
 *
 * `pulse` is the only motion in the admin system, and it is reserved for work
 * that is genuinely in progress. A monitoring page that animates while nothing
 * is happening teaches operators to ignore movement.
 */
export function HealthIndicator({
  tone,
  label,
  detail,
  pulse = false,
}: {
  tone: Tone;
  label: string;
  detail?: string;
  pulse?: boolean;
}) {
  const s = TONE_STYLES[tone];
  return (
    <div className="flex items-start gap-2.5">
      <span className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0">
        {pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping",
              s.dot,
            )}
            aria-hidden="true"
          />
        )}
        <span
          className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", s.dot)}
          aria-hidden="true"
        />
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className={cn("text-sm font-semibold leading-tight", s.text)}>{label}</div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

/** The one card. Everything on an admin page sits in one of these. */
export function AdminCard({
  children,
  className,
  emphasis = false,
}: {
  children: ReactNode;
  className?: string;
  /** Reserved for a page's single primary status card. */
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm",
        emphasis &&
          "border-primary/25 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_hsl(var(--primary)/0.06)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AdminCardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A titled region of a page.
 *
 * Numbered sections were considered and rejected: these are parallel areas of
 * one console, not a sequence, and numbering them would imply an order of
 * operations that does not exist.
 */
export function AdminSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Key/value rows and metrics                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One labelled fact.
 *
 * `tabular-nums` throughout: these columns are read by scanning down, and
 * proportional digits make a changing number look like a moving one.
 */
export function DataRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <span className="shrink-0 text-sm text-muted-foreground">
        {label}
        {hint && <span className="ml-1 text-xs text-muted-foreground/70">{hint}</span>}
      </span>
      <span className="min-w-0 text-right text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

export function AdminStatCard({
  label,
  value,
  detail,
  tone = "neutral",
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const s = TONE_STYLES[tone];
  return (
    <AdminCard className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className={cn("text-xl font-semibold tabular-nums", tone !== "neutral" && s.text)}>
            {value}
          </div>
          {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
        </div>
        {Icon && (
          <span className={cn("rounded-md border p-1.5", s.badge)}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
      </div>
    </AdminCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty, error and loading                                                    */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = CircleDashed,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon className="h-7 w-7 text-muted-foreground/60" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

/**
 * A failure an operator can act on.
 *
 * Takes a message the caller has already made safe. Admin surfaces read
 * third-party systems, and an upstream body must never be piped in here.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  action,
}: {
  title?: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950/40">
      <XCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-red-800 dark:text-red-300">{title}</p>
        <p className="text-sm text-red-700 dark:text-red-400">{message}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function NoticeState({ tone = "info", message }: { tone?: Tone; message: ReactNode }) {
  const s = TONE_STYLES[tone];
  const Icon = tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : Info;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm", s.badge)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{message}</div>
    </div>
  );
}

/** Skeletons, so a monitoring page never flashes empty while it loads. */
export function SkeletonLine({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-3 rounded bg-muted motion-safe:animate-pulse", className)}
      aria-hidden="true"
    />
  );
}

export function CardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <AdminCard className="space-y-3 p-4">
      <SkeletonLine className="h-4 w-1/3" />
      <div className="space-y-2 pt-1">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex justify-between gap-6">
            <SkeletonLine className="w-1/3" />
            <SkeletonLine className="w-1/4" />
          </div>
        ))}
      </div>
    </AdminCard>
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonLine key={c} className={cn("flex-1", c === 0 && "flex-[1.5]")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function InlineSpinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {label}
    </span>
  );
}
