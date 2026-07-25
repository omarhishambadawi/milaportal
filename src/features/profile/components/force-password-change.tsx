import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { formatDistanceToNow } from "date-fns";
import { Check, Clock, KeyRound, LogOut, X } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/password-input";
import { changeMyPassword } from "@/lib/profile.functions";
import { evaluatePassword } from "@/lib/password-policy";
import { cn } from "@/lib/utils";

/**
 * The screen a user lands on when their password was issued by an administrator.
 *
 * Rendered by the app layout *instead of* the routed content, in the same
 * position as the "Account deactivated" screen — not as a dismissible banner or a
 * redirect to /profile. A banner would be ignored, and a redirect could be walked
 * away from by typing another URL; both leave a password two people know in
 * active use, which is the whole thing this is here to end.
 *
 * Reuses `changeMyPassword`, so the temporary password is submitted as the
 * current one and verified server-side exactly like any other change — the forced
 * flow is not a weaker path to setting a password.
 *
 * Sign out stays reachable throughout: someone who cannot produce the temporary
 * password (it was mistyped, or they are on a shared machine) must not be trapped
 * on a screen with no way off.
 */
export function ForcePasswordChange({
  name,
  deadline,
  onDone,
  onSignOut,
}: {
  name?: string | null;
  /** ISO deadline after which the temporary password is retired entirely. */
  deadline?: string | null;
  onDone: () => void | Promise<void>;
  onSignOut: () => void;
}) {
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await changePasswordFn({ data: { currentPassword, newPassword } });
      toast.success("Password updated");
      // The caller refreshes the profile; the cleared flag is what dismisses
      // this screen, so nothing here needs to unmount itself.
      await onDone();
    } catch (err: any) {
      toast.error(err?.message ?? "Could not change your password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-primary/10">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden />
            </span>
            <CardTitle className="text-lg">Choose your own password</CardTitle>
          </div>
          <CardDescription>
            {name ? `${name}, your` : "Your"} current password was set for you by an administrator.
            Replace it with one only you know to continue.
          </CardDescription>
          {deadline && (
            <p className="flex items-center gap-1.5 text-xs text-[var(--badge-amber)]">
              <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Expires {formatDistanceToNow(new Date(deadline), { addSuffix: true })} — after that
              it stops working and you will need an emailed reset link.
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="temp-password">Temporary password</Label>
              <PasswordInput
                id="temp-password"
                autoComplete="current-password"
                autoFocus
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="forced-new-password">New password</Label>
              <PasswordInput
                id="forced-new-password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                aria-describedby="forced-password-rules"
              />
              <ul id="forced-password-rules" aria-live="polite" className="space-y-1 pt-1">
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
                {isReused && (
                  <li className="flex items-center gap-1.5 text-xs text-destructive">
                    <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Must differ from the temporary password
                  </li>
                )}
              </ul>
            </div>

            <div className="space-y-2">
              <Label htmlFor="forced-confirm-password">Confirm new password</Label>
              <PasswordInput
                id="forced-confirm-password"
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

            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {busy ? "Updating…" : "Set password and continue"}
            </Button>
          </form>

          <div className="mt-4 flex justify-center border-t border-border pt-4">
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden />
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
