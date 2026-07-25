import { forwardRef, useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<ComponentProps<typeof Input>, "type">;

/**
 * Password field with a show / hide toggle.
 *
 * One component so every password field in the app behaves identically — the
 * sign-in form, the self-service change-password form and the reset-password
 * page all use it.
 *
 * Accessibility: the toggle is a real `<button>`, so it is reachable and
 * operable by keyboard for free. It carries `aria-pressed` (screen readers
 * announce the on/off state) and an `aria-label` that flips with the state. The
 * icons are `aria-hidden` — the label is the accessible name. The button is
 * `tabIndex`-ordered right after the field, and never becomes a submit button.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...props }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className={cn(
            "absolute inset-y-0 right-0 flex items-center justify-center px-3 rounded-r-md",
            "text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    );
  },
);
