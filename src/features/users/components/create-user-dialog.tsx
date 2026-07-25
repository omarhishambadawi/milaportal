import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/password-input";
import {
  DEFAULT_TEMP_PASSWORD_TTL_HOURS,
  TEMP_PASSWORD_TTL_OPTIONS,
  evaluatePassword,
  generateTemporaryPassword,
  type TempPasswordTtlHours,
} from "@/lib/password-policy";
import { ASSIGNABLE_ROLES, ROLE_OPTION_LABEL, roleHasAgentCode, type AppRole } from "@/lib/roles";
import { cn } from "@/lib/utils";

const EMPTY = {
  fullName: "",
  email: "",
  agentCode: "",
  role: "customer_care" as AppRole,
};

/**
 * Create-user form.
 *
 * The password is generated up front, for the same reason as in the reset dialog:
 * the administrator is inventing a credential for someone else, and left to a
 * blank field they will invent a weak, reused one. It defaults to temporary, so
 * the password typed here stops working the moment the new user signs in and
 * chooses their own.
 */
export function CreateUserDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: {
    email: string; password: string; fullName: string;
    agentCode?: string; role: AppRole; temporary: boolean; expiresInHours: TempPasswordTtlHours;
  }) => Promise<boolean>;
}) {
  const [form, setForm] = useState(EMPTY);
  const [password, setPassword] = useState("");
  const [temporary, setTemporary] = useState(true);
  const [ttl, setTtl] = useState<TempPasswordTtlHours>(DEFAULT_TEMP_PASSWORD_TTL_HOURS);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setPassword(generateTemporaryPassword());
    setTemporary(true);
    setTtl(DEFAULT_TEMP_PASSWORD_TTL_HOURS);
    setCopied(false);
  }, [open]);

  const { results, valid } = evaluatePassword(password);
  const canSubmit = form.fullName.trim().length > 0 && form.email.trim().length > 0 && valid && !busy;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy — select the password and copy it manually");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    const ok = await onSubmit({
      email: form.email.trim(),
      password,
      fullName: form.fullName.trim(),
      // Agent Code belongs to the agent roles only; the field is hidden for the
      // others, so send nothing rather than a stale value. The server enforces
      // the same rule independently.
      agentCode: roleHasAgentCode(form.role) ? form.agentCode.trim() || undefined : undefined,
      role: form.role,
      temporary,
      expiresInHours: ttl,
    });
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a user</DialogTitle>
          <DialogDescription>
            They sign in with this email and password, then choose their own password.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-user-name">Full name</Label>
            <Input
              id="new-user-name"
              required
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-user-email">Email</Label>
              <Input
                id="new-user-email"
                type="email"
                required
                autoComplete="off"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-user-role">Role</Label>
              <Select
                value={form.role}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    role: v as AppRole,
                    agentCode: roleHasAgentCode(v) ? form.agentCode : "",
                  })
                }
              >
                <SelectTrigger id="new-user-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>{ROLE_OPTION_LABEL[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {roleHasAgentCode(form.role) && (
            <div className="space-y-2">
              <Label htmlFor="new-user-code">Agent code</Label>
              <Input
                id="new-user-code"
                placeholder="4002"
                value={form.agentCode}
                onChange={(e) => setForm({ ...form, agentCode: e.target.value })}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="new-user-password">Password</Label>
            <div className="flex gap-2">
              <PasswordInput
                id="new-user-password"
                autoComplete="new-password"
                className="font-mono"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="new-user-password-rules"
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
                {copied ? <Check className="h-4 w-4 text-[var(--positive)]" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              </Button>
            </div>
            <ul id="new-user-password-rules" aria-live="polite" className="space-y-1 pt-1">
              {results.map((rule) => (
                <li
                  key={rule.id}
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    rule.passed ? "text-[var(--positive)]" : "text-muted-foreground",
                  )}
                >
                  {rule.passed
                    ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    : <X className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  {rule.label}
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <label className="flex cursor-pointer items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">Require a change at first sign-in</span>
                <span className="block text-xs text-muted-foreground">
                  Recommended — this password is one you both know.
                </span>
              </span>
              <Switch checked={temporary} onCheckedChange={setTemporary} aria-label="Require a change at first sign-in" />
            </label>

            {temporary && (
              <div className="flex items-center justify-between gap-3 border-t pt-3">
                <Label htmlFor="new-user-ttl" className="text-sm font-normal">Expires after</Label>
                <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v) as TempPasswordTtlHours)}>
                  <SelectTrigger id="new-user-ttl" className="h-8 w-[130px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEMP_PASSWORD_TTL_OPTIONS.map((hours) => (
                      <SelectItem key={hours} value={String(hours)}>{hours} hours</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>{busy ? "Creating…" : "Create user"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
