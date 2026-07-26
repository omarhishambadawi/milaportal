import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, KeyRound, X } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/password-input";
import { changeMyPassword } from "@/lib/profile.functions";
import { evaluatePassword } from "@/lib/password-policy";
import { cn } from "@/lib/utils";

/**
 * Self-service password change, available to every signed-in user.
 *
 * The rules shown in the live checklist come from `password-policy.ts`, the same
 * module the server validates against, so this form cannot accept something the
 * server will reject. The current-password field is required and is verified
 * server-side — see `changeMyPassword`.
 */
export function ChangePasswordCard() {
  const changePasswordFn = useServerFn(changeMyPassword);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const { results, valid } = evaluatePassword(newPassword);
  const confirmTouched = confirmPassword.length > 0;
  const matches = newPassword === confirmPassword;
  const isReused = newPassword.length > 0 && newPassword === currentPassword;

  const canSubmit =
    currentPassword.length > 0 && valid && matches && confirmTouched && !isReused && !busy;

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await changePasswordFn({ data: { currentPassword, newPassword } });
      toast.success("Password updated");
      reset();
    } catch (err: any) {
      toast.error(err?.message ?? "Could not change your password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <KeyRound className="h-4 w-4 text-primary" />
        <CardTitle className="text-base">Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <PasswordInput
              id="current-password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              aria-describedby="password-rules"
            />
            {/* Live requirement checklist. `aria-live` so a screen reader hears
                rules flip to satisfied as the user types. */}
            <ul id="password-rules" aria-live="polite" className="space-y-1 pt-1">
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
              {isReused && (
                <li className="flex items-center gap-1.5 text-xs text-destructive">
                  <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Must differ from your current password
                </li>
              )}
            </ul>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <PasswordInput
              id="confirm-password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              aria-invalid={confirmTouched && !matches}
            />
            {confirmTouched && !matches && (
              <p className="text-xs text-destructive">Passwords do not match</p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={reset}
              disabled={busy || (!currentPassword && !newPassword && !confirmPassword)}
            >
              Clear
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? "Updating…" : "Update password"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
