import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/password-input";
import { evaluatePassword } from "@/lib/password-policy";
import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  component: ResetPage,
});

function ResetPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // Same rules the server enforces everywhere else a password is set.
  const { results, valid } = evaluatePassword(password);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    // This flow is reached from a recovery link, so there is no current password
    // to confirm — possession of the emailed token is the proof of identity.
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Password updated");
    navigate({ to: "/dashboard", replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>Set a new password</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pw">New password</Label>
              <PasswordInput id="pw" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="reset-password-rules" />
              <ul id="reset-password-rules" aria-live="polite" className="space-y-1 pt-1">
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
            <Button type="submit" className="w-full" disabled={busy || !valid}>{busy ? "Saving…" : "Update password"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
