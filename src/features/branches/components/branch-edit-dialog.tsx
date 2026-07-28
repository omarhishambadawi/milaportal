import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
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
import { Switch } from "@/components/ui/switch";
import { branchUpdate } from "@/lib/branches.functions";
import { queryKeys } from "@/lib/query-keys";
import { parseDutyHours } from "../normalize";
import type { BranchView } from "../types";

/**
 * Correcting one branch without an import.
 *
 * A phone number changes, or an address was typed wrong. Until now the only
 * repair was to get hold of the master workbook, edit the row, and re-import —
 * which rewrites every branch in the file to change one field, and which nobody
 * does for a typo. So the typos stayed, and agents read them out.
 *
 * The dialog is deliberately the *branch* rather than the *row*: `branch_no` is
 * shown and not editable (it is the key `orders.branch_no` points at), and there
 * is no active/inactive switch (deactivating is what a Replace import means, and
 * it needs the history entry that only an import writes).
 *
 * Duty hours are not a field. They are computed from the working-hours string by
 * the same parser the importer uses, so a hand-edit and an import cannot
 * disagree about what "06 AM - 02 PM & 10 AM - 06 PM" adds up to.
 */

/** The editable subset, as strings — a form holds text, not numbers. */
interface FormState {
  city: string;
  phone: string;
  area_manager: string;
  area_manager_phone: string;
  email: string;
  address: string;
  maps_url: string;
  latitude: string;
  longitude: string;
  scooter: boolean;
  scooter_note: string;
  working_hours: string;
  friday_hours: string;
}

function toForm(branch: BranchView): FormState {
  return {
    city: branch.city ?? "",
    phone: branch.phone ?? "",
    area_manager: branch.area_manager ?? "",
    area_manager_phone: branch.area_manager_phone ?? "",
    email: branch.email ?? "",
    address: branch.address ?? "",
    maps_url: branch.maps_url ?? "",
    latitude: branch.latitude == null ? "" : String(branch.latitude),
    longitude: branch.longitude == null ? "" : String(branch.longitude),
    scooter: branch.scooter,
    scooter_note: branch.scooter_note ?? "",
    working_hours: branch.working_hours ?? "",
    friday_hours: branch.friday_hours ?? "",
  };
}

/** "" means "this branch has none", which the column stores as NULL. */
function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A coordinate box left empty, or filled with something that is not a number. */
function coordinate(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function BranchEditDialog({
  branch,
  onClose,
}: {
  branch: BranchView | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const update = useServerFn(branchUpdate);
  const [form, setForm] = useState<FormState | null>(null);

  // Re-seeded whenever a different branch is opened, so the dialog never shows
  // the previous card's values for a frame.
  useEffect(() => {
    setForm(branch ? toForm(branch) : null);
  }, [branch]);

  const save = useMutation({
    mutationFn: async () => {
      if (!branch || !form) throw new Error("Nothing to save");
      const workingHours = nullable(form.working_hours);
      return update({
        data: {
          branch_no: branch.branch_no,
          city: form.city.trim(),
          phone: nullable(form.phone),
          area_manager: nullable(form.area_manager),
          area_manager_phone: nullable(form.area_manager_phone),
          email: nullable(form.email),
          address: nullable(form.address),
          maps_url: nullable(form.maps_url),
          latitude: coordinate(form.latitude),
          longitude: coordinate(form.longitude),
          scooter: form.scooter,
          scooter_note: nullable(form.scooter_note),
          working_hours: workingHours,
          friday_hours: nullable(form.friday_hours),
          // Derived, never typed. Same parser the importer runs.
          duty_hours: workingHours ? parseDutyHours(workingHours) : null,
        },
      }) as Promise<{ branchNo: string; changed: number }>;
    },
    onSuccess: (result) => {
      toast.success(
        result.changed === 0
          ? "Nothing changed"
          : `${result.branchNo} updated — ${result.changed} ${
              result.changed === 1 ? "field" : "fields"
            }`,
      );
      // One invalidation under the `branches` root sweeps the directory, the
      // order form's picker AND the preview panel that form renders — which is
      // what makes a correction here show up on the card an agent sees while
      // raising an order, without any of those surfaces knowing about this one.
      queryClient.invalidateQueries({ queryKey: queryKeys.branches.all() });
      onClose();
    },
    onError: (error: Error) => toast.error("Could not save", { description: error.message }),
  });

  const open = branch != null && form != null;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Edit
            <span className="font-mono">{branch?.branch_no}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Changes are saved to this branch only and appear everywhere it is shown — the directory,
            the order form's picker, and the branch card on a new order. The branch code cannot be
            changed here: orders reference it.
          </DialogDescription>
        </DialogHeader>

        {form && (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <Field label="City">
              <Input
                value={form.city}
                onChange={(event) => set("city", event.target.value)}
                required
                dir="auto"
              />
            </Field>
            <Field label="Branch phone" hint="Any form — 0599089497, 599089497 or +966599089497.">
              <Input
                value={form.phone}
                onChange={(event) => set("phone", event.target.value)}
                dir="ltr"
                inputMode="tel"
              />
            </Field>

            <Field
              label="Address"
              wide
              hint="City / district / street, as the master sheet writes it."
            >
              <Input
                value={form.address}
                onChange={(event) => set("address", event.target.value)}
                dir="auto"
              />
            </Field>

            <Field label="Area manager">
              <Input
                value={form.area_manager}
                onChange={(event) => set("area_manager", event.target.value)}
                dir="auto"
              />
            </Field>
            <Field label="Manager phone">
              <Input
                value={form.area_manager_phone}
                onChange={(event) => set("area_manager_phone", event.target.value)}
                dir="ltr"
                inputMode="tel"
              />
            </Field>

            <Field
              label="Working hours"
              hint="e.g. 07 AM - 03 AM. Duty hours are computed from this."
            >
              <Input
                value={form.working_hours}
                onChange={(event) => set("working_hours", event.target.value)}
                dir="ltr"
              />
            </Field>
            <Field label="Friday hours">
              <Input
                value={form.friday_hours}
                onChange={(event) => set("friday_hours", event.target.value)}
                dir="ltr"
              />
            </Field>

            <Field label="Google Maps URL" wide>
              <Input
                value={form.maps_url}
                onChange={(event) => set("maps_url", event.target.value)}
                dir="ltr"
                placeholder="https://maps.app.goo.gl/…"
              />
            </Field>

            <Field label="Latitude">
              <Input
                value={form.latitude}
                onChange={(event) => set("latitude", event.target.value)}
                dir="ltr"
                inputMode="decimal"
                placeholder="24.5372826"
              />
            </Field>
            <Field label="Longitude">
              <Input
                value={form.longitude}
                onChange={(event) => set("longitude", event.target.value)}
                dir="ltr"
                inputMode="decimal"
                placeholder="46.6456098"
              />
            </Field>

            <Field label="Email">
              <Input
                value={form.email}
                onChange={(event) => set("email", event.target.value)}
                dir="ltr"
                type="email"
              />
            </Field>
            <Field label="Scooter note">
              <Input
                value={form.scooter_note}
                onChange={(event) => set("scooter_note", event.target.value)}
                dir="auto"
              />
            </Field>

            <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 sm:col-span-2">
              <Switch
                id="branch-scooter"
                checked={form.scooter}
                onCheckedChange={(checked) => set("scooter", checked)}
              />
              <Label htmlFor="branch-scooter" className="text-xs font-medium">
                Scooter delivery available from this branch
              </Label>
            </div>

            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
