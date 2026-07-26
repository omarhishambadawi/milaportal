import { useEffect, useState } from "react";
import { Check, Copy, Mail, RefreshCw, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/password-input";
import {
  DEFAULT_TEMP_PASSWORD_TTL_HOURS,
  TEMP_PASSWORD_TTL_OPTIONS,
  evaluatePassword,
  generateTemporaryPassword,
  type TempPasswordTtlHours,
} from "@/lib/password-policy";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

import type { AdminUserRow } from "../types";

/**
 * Administrator password management for one account.
 *
 * Two ways out, presented in the order they should be preferred:
 *
 *   1. Email a reset link. Nothing changes, nothing is dictated over the phone,
 *      and the new password is known only to the user. This is the default path
 *      and is offered first.
 *   2. Set a temporary password. For the cases (1) cannot serve — a dead or
 *      mistyped mailbox, or a handover that has to happen live. Pre-filled with
 *      a generated one rather than an empty box, because the alternative is an
 *      administrator inventing "Welcome123" for the fourth time this month.
 *
 * "Require a change at next sign-in" is on by default and can be turned off, with
 * the consequence spelled out rather than implied: leaving it off means two people
 * know the account's password indefinitely.
 */
export function PasswordDialog({
  user,
  open,
  onOpenChange,
  onSubmit,
  onSendEmail,
}: {
  user: AdminUserRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    password: string,
    temporary: boolean,
    expiresInHours: TempPasswordTtlHours,
  ) => Promise<boolean>;
  onSendEmail: () => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [temporary, setTemporary] = useState(true);
  const [ttl, setTtl] = useState<TempPasswordTtlHours>(DEFAULT_TEMP_PASSWORD_TTL_HOURS);
  const [busy, setBusy] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Fresh suggestion per account the dialog is opened for — never reuse the
  // previous one, which would silently hand two people the same credential.
  useEffect(() => {
    if (!open) return;
    setPassword(generateTemporaryPassword());
    setTemporary(true);
    setTtl(DEFAULT_TEMP_PASSWORD_TTL_HOURS);
    setCopied(false);
    setConfirming(false);
  }, [open, user?.id]);

  const { results, valid } = evaluatePassword(password);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is denied in some browser configurations; the value is
      // visible in the field, so this is an inconvenience rather than a failure.
      toast.error("Could not copy — select the password and copy it manually");
    }
  };

  // Submitting the form only *asks*; the confirmation below commits. Setting a
  // password is immediate and unrecoverable — the account's existing password is
  // gone the moment it runs — and it sits one keystroke away from a form the
  // administrator opened to do something else entirely (send an email).
  const requestSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setConfirming(true);
  };

  const confirmSubmit = async () => {
    setConfirming(false);
    setBusy(true);
    const ok = await onSubmit(password, temporary, ttl);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  const sendEmail = async () => {
    setEmailing(true);
    const ok = await onSendEmail();
    setEmailing(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Password for {user?.full_name}</DialogTitle>
          <DialogDescription>
            Send them a reset link, or hand over a temporary password they must replace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-start gap-3">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Email a reset link</p>
                <p className="truncate text-xs text-muted-foreground">
                  {user?.email
                    ? `Sends ${user.email} the standard recovery email. Their current password keeps working until they use it.`
                    : "This account has no email address on file."}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              disabled={!user?.email || emailing || busy}
              onClick={sendEmail}
            >
              {emailing ? "Sending…" : "Send reset link"}
            </Button>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden>
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-background px-2 text-xs uppercase tracking-wide text-muted-foreground">
                or
              </span>
            </div>
          </div>

          <form onSubmit={requestSubmit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="admin-new-password">Set a password directly</Label>
              <div className="flex gap-2">
                <PasswordInput
                  id="admin-new-password"
                  autoComplete="new-password"
                  className="font-mono"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby="admin-password-rules"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setPassword(generateTemporaryPassword())}
                  aria-label="Generate a new password"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={copy}
                  disabled={!password}
                  aria-label="Copy password"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-[var(--positive)]" aria-hidden />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              </div>
              <ul id="admin-password-rules" aria-live="polite" className="space-y-1 pt-1">
                {results.map((rule) => (
                  <li
                    key={rule.id}
                    className={cn(
                      "flex items-center gap-1.5 text-xs",
                      rule.passed ? "text-[var(--positive)]" : "text-muted-foreground",
                    )}
                  >
                    {rule.passed ? (
                      <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    ) : (
                      <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                    {rule.label}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-3 rounded-lg border p-3">
              <label className="flex cursor-pointer items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    Require a change at next sign-in
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {temporary
                      ? "They cannot use the app until they replace this password."
                      : "Leaving this off means you and they both know this password indefinitely."}
                  </span>
                </span>
                <Switch
                  checked={temporary}
                  onCheckedChange={setTemporary}
                  aria-label="Require a change at next sign-in"
                />
              </label>

              {/* Only meaningful for a temporary password — a permanent one has
                  nothing to expire. */}
              {temporary && (
                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <Label htmlFor="temp-password-ttl" className="text-sm font-normal">
                    Expires after
                  </Label>
                  <Select
                    value={String(ttl)}
                    onValueChange={(v) => setTtl(Number(v) as TempPasswordTtlHours)}
                  >
                    <SelectTrigger id="temp-password-ttl" className="h-8 w-[130px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEMP_PASSWORD_TTL_OPTIONS.map((hours) => (
                        <SelectItem key={hours} value={String(hours)}>
                          {hours} hours
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || busy || emailing}>
                {busy ? "Setting…" : "Set password"}
              </Button>
            </DialogFooter>
          </form>
        </div>

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {temporary ? "Issue a temporary password" : "Replace this password"} for{" "}
                {user?.full_name}?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>
                    Their current password stops working immediately. Make sure you have copied the
                    new one — it cannot be read back afterwards.
                  </p>
                  {temporary ? (
                    <p>
                      They must replace it at next sign-in, and it expires in {ttl} hours. After
                      that the account is reachable only through an emailed reset link.
                    </p>
                  ) : (
                    <p>
                      This password is permanent and known to you both — nothing will prompt them to
                      change it.
                    </p>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmSubmit}>
                {temporary ? "Issue password" : "Set password"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
