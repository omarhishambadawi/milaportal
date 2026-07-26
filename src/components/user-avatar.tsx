import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { AVATAR_BUCKET, AVATAR_SIGNED_TTL, isStoragePath } from "@/lib/avatar";

interface UserAvatarProps {
  name?: string | null;
  url?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeMap = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-16 w-16 text-lg",
  xl: "h-24 w-24 text-2xl",
} as const;

function initialsOf(name?: string | null) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Resolve a stored avatar value to a displayable URL. A storage object path is
 * signed on demand with a short-lived URL (cached per path, shared across every
 * avatar that renders the same path). Ready-to-use values — full http(s) URLs
 * (e.g. admin-list rows signed server-side, or legacy data) and local
 * `data:`/`blob:` previews — pass through unchanged.
 */
function useSignedAvatarUrl(value?: string | null): string | null {
  const path = isStoragePath(value) ? value! : null;
  const { data } = useQuery({
    queryKey: ["avatar-signed", path],
    enabled: !!path,
    // Refresh a little before the URL expires so images never 403 mid-view.
    staleTime: (AVATAR_SIGNED_TTL - 300) * 1000,
    gcTime: AVATAR_SIGNED_TTL * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(AVATAR_BUCKET)
        .createSignedUrl(path!, AVATAR_SIGNED_TTL);
      if (error) return null;
      return data?.signedUrl ?? null;
    },
  });
  return path ? (data ?? null) : (value ?? null);
}

export function UserAvatar({ name, url, size = "md", className }: UserAvatarProps) {
  const cls = sizeMap[size];
  const resolved = useSignedAvatarUrl(url);
  if (resolved) {
    return (
      <img
        src={resolved}
        alt={name ?? "avatar"}
        className={cn("rounded-full object-cover ring-1 ring-border shrink-0", cls, className)}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className={cn(
        "rounded-full grid place-items-center bg-gradient-to-br from-primary to-secondary text-primary-foreground font-semibold shrink-0",
        cls,
        className,
      )}
      aria-label={name ?? "avatar"}
    >
      {initialsOf(name)}
    </div>
  );
}
