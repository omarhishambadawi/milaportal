import { useQuery } from "@tanstack/react-query";
import {
  Bike,
  Clock,
  Copy,
  ExternalLink,
  Mail,
  MapPin,
  Navigation,
  Phone,
  UserRound,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { copyText } from "../clipboard";
import { decorate } from "../search";
import type { Branch, BranchView } from "../types";
import { contactBlock } from "./branch-card";

/**
 * Everything about a branch, inline, wherever a branch has just been chosen.
 *
 * Built for one moment: an agent is on the phone, has picked a branch on the
 * order form, and the customer immediately asks something the form does not
 * show — is it open, does it deliver, what is the address, who do I call. Every
 * one of those answers used to be a navigation away from a half-typed order.
 *
 * Deliberately a *reusable* component rather than part of the order form: the
 * complaint form, the future Smart Branch Finder and the AI assistant all need
 * the same panel, and the Branch Directory is the single source of this data.
 */

/** Columns the panel renders. Explicitly listed to avoid pulling the geography blob. */
const PREVIEW_COLUMNS =
  "branch_no,city,phone,area_manager,area_manager_phone,email,address,maps_url,latitude,longitude,scooter,scooter_note,working_hours,friday_hours,duty_hours,active,created_at,updated_at";

function Row({
  icon: Icon,
  label,
  value,
  onCopy,
  href,
  copyLabel,
}: {
  icon: typeof MapPin;
  label: string;
  value: string | null;
  onCopy?: () => void;
  href?: string | null;
  copyLabel?: string;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-xs text-primary hover:underline"
            dir="auto"
          >
            {value}
          </a>
        ) : (
          <p className="text-xs text-foreground/90" dir="auto">
            {value}
          </p>
        )}
      </div>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${copyLabel ?? label}`}
          title={`Copy ${copyLabel ?? label}`}
          className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Copy className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function BranchPreviewPanel({
  branchNo,
  className,
}: {
  branchNo: string | null | undefined;
  className?: string;
}) {
  const code = branchNo?.trim() || null;

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.branches.preview(code),
    queryFn: async (): Promise<BranchView | null> => {
      if (!code) return null;
      const { data: row, error } = await supabase
        .from("branches")
        .select(PREVIEW_COLUMNS)
        .eq("branch_no", code)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) return null;
      // Reuses the directory's own decoration, so the phone formatting and map
      // links here are identical to the ones on the branch card by construction.
      return decorate([row as unknown as Branch])[0] ?? null;
    },
    enabled: Boolean(code),
    // Branch details change only on import. Holding them for the length of a
    // call means switching between branches on the form is instant.
    staleTime: 5 * 60 * 1000,
  });

  if (!code) return null;

  if (isLoading) {
    return (
      <div
        className={cn(
          "animate-pulse space-y-2 rounded-xl border border-border/60 bg-card p-3",
          className,
        )}
      >
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted/70" />
        <div className="h-3 w-3/4 rounded bg-muted/70" />
      </div>
    );
  }

  if (!data) {
    return (
      <div
        className={cn(
          "rounded-xl border border-dashed border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground",
          className,
        )}
      >
        No directory entry for <span className="font-mono">{code}</span>. The order can still be
        saved — the branch may simply not be in the directory yet.
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-border/60 bg-card p-3 shadow-sm", className)}>
      <div className="flex items-start justify-between gap-2 border-b border-border/50 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold">{data.branch_no}</span>
            {data.scooter ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--positive)]/12 px-2 py-0.5 text-[10px] font-semibold text-[var(--positive)]">
                <Bike className="h-3 w-3" />
                Scooter
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                No scooter
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground" dir="auto">
            {data.city}
            {data.cityEnglish && ` · ${data.cityEnglish}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => copyText(contactBlock(data), "Branch details")}
          className="shrink-0 rounded-md border border-border/70 px-2 py-1 text-[10px] font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Copy all
        </button>
      </div>

      <div className="divide-y divide-border/40 py-1">
        <Row
          icon={MapPin}
          label="Address"
          value={data.address}
          onCopy={() => copyText(data.address ?? "", "Address")}
        />
        <Row
          icon={Phone}
          label="Branch phone"
          value={data.phoneDisplay}
          href={data.phoneE164 ? `tel:${data.phoneE164}` : null}
          onCopy={() => copyText(data.phoneE164 ?? data.phoneDisplay ?? "", "Branch phone")}
        />
        <Row icon={Clock} label="Working hours" value={data.working_hours} />
        <Row icon={Clock} label="Friday hours" value={data.friday_hours} />
        <Row icon={UserRound} label="Area manager" value={data.area_manager} />
        <Row
          icon={Phone}
          label="Manager phone"
          value={data.managerPhoneDisplay}
          href={data.managerPhoneE164 ? `tel:${data.managerPhoneE164}` : null}
          onCopy={() =>
            copyText(data.managerPhoneE164 ?? data.managerPhoneDisplay ?? "", "Manager phone")
          }
        />
        <Row
          icon={Mail}
          label="Email"
          value={data.email}
          href={data.email ? `mailto:${data.email}` : null}
          onCopy={() => copyText(data.email ?? "", "Email")}
        />
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-border/50 pt-2">
        {data.mapsLink && (
          <>
            <a
              href={data.mapsLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Open map
            </a>
            <button
              type="button"
              onClick={() => copyText(data.mapsLink ?? "", "Maps link")}
              className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Copy className="h-3 w-3" />
              Copy map link
            </button>
          </>
        )}
        {data.navLink && (
          <a
            href={data.navLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Navigation className="h-3 w-3" />
            Navigate
          </a>
        )}
      </div>
    </div>
  );
}
