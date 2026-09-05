import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { businessToday } from "@/lib/telesales/dates";
import { proposeFollowup } from "@/lib/telesales/status";
import { OUTCOME_BY_KEY, outcomesForLeadType, type LeadType } from "@/lib/telesales/types";

/**
 * Recording what happened on a call.
 *
 * This dialog is the module's hot path — an agent opens it once per call, all
 * day — so it is built around one rule: **the common case is two clicks.** Pick
 * an outcome, press Save. Everything else appears only when the chosen outcome
 * requires it.
 *
 * That is why the outcomes are a grid of buttons rather than a select: a select
 * costs a click to open, a click to choose, and a scan of a list that is mostly
 * irrelevant. Nine buttons the agent can hit by position are faster by the third
 * call and much faster by the fiftieth.
 *
 * The follow-up date appears only for the outcomes that mean nothing without one
 * — `Reschedule call` and `Interested` — and is pre-filled from
 * `proposeFollowup`, which knows the product's refill interval. The agent can
 * always change it; they usually will not have to.
 */

export interface OutcomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadType: LeadType;
  /** The product's nominal refill interval, when it has one. Drives the
   *  proposed date after a conversion. */
  refillDays: number | null;
  customerLabel: string;
  submitting: boolean;
  onSubmit: (input: {
    outcomeKey: string;
    note?: string;
    followupDueOn?: string | null;
    followupTime?: string | null;
    orderValue?: number | null;
  }) => void;
}

export function OutcomeDialog({
  open,
  onOpenChange,
  leadType,
  refillDays,
  customerLabel,
  submitting,
  onSubmit,
}: OutcomeDialogProps) {
  const outcomes = useMemo(() => outcomesForLeadType(leadType), [leadType]);
  const [outcomeKey, setOutcomeKey] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [orderValue, setOrderValue] = useState("");

  const today = businessToday();
  const def = outcomeKey ? OUTCOME_BY_KEY.get(outcomeKey) : undefined;
  const needsFollowup = def?.requiresFollowup ?? false;
  const isConversion = def?.status === "converted";
  /*
   * Order Created carries no Order Value on the Wasfaty desk.
   *
   * A Wasfaty order is placed in the Wasfaty portal and priced there; the figure
   * typed here was a second, unverified copy of a number the desk does not own,
   * and the row already shows the prescription's own value. The field is gone
   * from this presentation, not from the schema — `converted_value` still holds
   * what Cash conversions record, and the server function still accepts it.
   */
  const showOrderValue = isConversion && leadType !== "wasfaty";

  // Reset when the dialog closes, so the next call does not inherit the last
  // one's note. An agent who reopens the dialog after a misclick expects a
  // blank form, not somebody else's answer.
  useEffect(() => {
    if (open) return;
    setOutcomeKey(null);
    setNote("");
    setDueOn("");
    setDueTime("");
    setOrderValue("");
  }, [open]);

  /**
   * Propose a date the moment an outcome is chosen.
   *
   * A conversion proposes one refill interval out; a reschedule proposes
   * tomorrow. Both are overwritable, and the proposal is recomputed rather than
   * remembered so switching outcome switches the suggestion.
   */
  function chooseOutcome(key: string) {
    setOutcomeKey(key);
    const outcome = OUTCOME_BY_KEY.get(key);
    if (outcome?.requiresFollowup || outcome?.status === "converted") {
      setDueOn(proposeFollowup(today, { outcomeKey: key, refillDays, leadType }).dueOn);
    } else {
      setDueOn("");
    }
  }

  const canSubmit = Boolean(outcomeKey) && (!needsFollowup || Boolean(dueOn)) && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record outcome</DialogTitle>
          <DialogDescription>{customerLabel}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {outcomes.map((o) => (
              <Button
                key={o.key}
                type="button"
                variant={outcomeKey === o.key ? "default" : "outline"}
                size="sm"
                className={cn("h-auto whitespace-normal py-2 text-xs leading-tight")}
                onClick={() => chooseOutcome(o.key)}
              >
                {o.label}
              </Button>
            ))}
          </div>

          {needsFollowup ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ts-due-on">
                  Call back on <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ts-due-on"
                  type="date"
                  value={dueOn}
                  min={today}
                  onChange={(e) => setDueOn(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ts-due-time">Time (optional)</Label>
                <Input
                  id="ts-due-time"
                  type="time"
                  value={dueTime}
                  onChange={(e) => setDueTime(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          {isConversion ? (
            <div className={showOrderValue ? "grid grid-cols-2 gap-3" : "grid gap-3"}>
              {showOrderValue ? (
                <div className="space-y-1.5">
                  <Label htmlFor="ts-order-value">Order value (SAR)</Label>
                  <Input
                    id="ts-order-value"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={orderValue}
                    onChange={(e) => setOrderValue(e.target.value)}
                  />
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="ts-next-refill">Next refill</Label>
                <Input
                  id="ts-next-refill"
                  type="date"
                  value={dueOn}
                  min={today}
                  onChange={(e) => setDueOn(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {refillDays
                    ? `Proposed from this product's ${refillDays}-day cycle.`
                    : "No refill interval is configured for this product."}
                </p>
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="ts-note">Note</Label>
            <Textarea
              id="ts-note"
              rows={3}
              value={note}
              placeholder="What the customer said."
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                outcomeKey: outcomeKey!,
                note: note.trim() || undefined,
                followupDueOn: dueOn || null,
                followupTime: dueTime || null,
                orderValue: showOrderValue && orderValue ? Number(orderValue) : null,
              })
            }
          >
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
