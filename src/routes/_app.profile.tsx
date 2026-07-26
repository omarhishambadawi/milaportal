import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { updateMyProfile } from "@/lib/profile.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { UserAvatar } from "@/components/user-avatar";
import { ChangePasswordCard } from "@/features/profile/components/change-password-card";
import { RoleBadge } from "@/components/role-badge";
import { AVATAR_BUCKET, avatarObjectPath } from "@/lib/avatar";
import {
  LogOut,
  Mail,
  IdCard,
  Phone,
  ShieldCheck,
  Calendar,
  Camera,
  Trash2,
  Save,
  Pencil,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/profile")({
  component: ProfilePage,
  head: () => ({ meta: [{ title: "My Profile — MilaServ Portal" }] }),
});

function ProfilePage() {
  const { session, profile, role, signOut, refresh } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const updateFn = useServerFn(updateMyProfile);

  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(profile?.full_name ?? "");
  const [savingName, setSavingName] = useState(false);

  const [avatarDialog, setAvatarDialog] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const created = profile?.created_at ? new Date(profile.created_at) : null;
  const perms = profile?.permissions ?? [];

  const saveName = async () => {
    if (!name.trim() || name.trim() === profile?.full_name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await updateFn({ data: { fullName: name.trim() } });
      await refresh();
      toast.success("Name updated");
      setEditingName(false);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update");
    } finally {
      setSavingName(false);
    }
  };

  // Kept in step with the avatars bucket's allowed_mime_types / file_size_limit
  // (20260721002100), which is what actually enforces this server-side. These
  // checks exist for a good error message, not for security.
  const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
  const EXT_FOR_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (!ALLOWED_IMAGE_TYPES.includes(f.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
      toast.error("Please choose a PNG, JPEG, WebP or GIF image");
      return;
    }
    if (f.size > 4 * 1024 * 1024) {
      toast.error("Image must be under 4 MB");
      return;
    }
    setFile(f);
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(f);
  };

  const uploadAvatar = async () => {
    if (!file || !session?.user?.id) return;
    setUploading(true);
    try {
      // Derive the extension from the validated MIME type rather than the
      // user-supplied filename, so nothing attacker-controlled reaches the
      // object key.
      const ext = EXT_FOR_TYPE[file.type] ?? "png";
      const path = `${session.user.id}/avatar-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type,
      });
      if (upErr) throw upErr;
      // Store only the object path — signed URLs are minted on demand at display.
      const previousPath = avatarObjectPath(profile?.avatar_url);
      await updateFn({ data: { avatarPath: path } });
      // Delete the object we just replaced (best-effort; own-folder delete).
      if (previousPath && previousPath !== path) {
        await supabase.storage
          .from(AVATAR_BUCKET)
          .remove([previousPath])
          .catch(() => {});
      }
      await refresh();
      qc.invalidateQueries();
      toast.success("Profile picture updated");
      setAvatarDialog(false);
      setFile(null);
      setPreview(null);
    } catch (e: any) {
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const removeAvatar = async () => {
    if (!profile?.avatar_url) return;
    setUploading(true);
    try {
      const previousPath = avatarObjectPath(profile?.avatar_url);
      await updateFn({ data: { avatarPath: null } });
      // Delete the underlying object, not just the pointer.
      if (previousPath) {
        await supabase.storage
          .from(AVATAR_BUCKET)
          .remove([previousPath])
          .catch(() => {});
      }
      await refresh();
      qc.invalidateQueries();
      toast.success("Profile picture removed");
      setAvatarDialog(false);
      setFile(null);
      setPreview(null);
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-in fade-in duration-150">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">Your account details and access.</p>
      </div>

      {/* Minimalist header — no banner */}
      <Card>
        <CardContent className="pt-6 space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
            <div className="relative group">
              <UserAvatar
                name={profile?.full_name ?? session?.user?.email}
                url={profile?.avatar_url}
                size="xl"
                className="ring-4 ring-background shadow-md"
              />
              <button
                type="button"
                onClick={() => setAvatarDialog(true)}
                className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-150 grid place-items-center text-white text-xs font-medium"
                aria-label="Change profile picture"
              >
                <Camera className="h-5 w-5" />
              </button>
            </div>

            <div className="min-w-0 flex-1 space-y-2">
              {editingName ? (
                <div className="flex items-center gap-2 max-w-sm">
                  <Input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-9"
                  />
                  <Button size="sm" onClick={saveName} disabled={savingName}>
                    <Save className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setName(profile?.full_name ?? "");
                      setEditingName(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold truncate">{profile?.full_name ?? "—"}</h2>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => {
                      setName(profile?.full_name ?? "");
                      setEditingName(true);
                    }}
                    aria-label="Edit name"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {/* Shared badge: the Owner is visually distinct here too, rather
                    than rendering as a generic grey chip like every other role. */}
                {role && <RoleBadge role={role} />}
                {profile?.active ? (
                  <Badge className="bg-success text-success-foreground hover:bg-success">
                    Active
                  </Badge>
                ) : (
                  <Badge variant="destructive">Inactive</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{session?.user?.email}</p>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2 pt-4 border-t border-border">
            <InfoRow icon={Mail} label="Email" value={session?.user?.email ?? "—"} />
            <InfoRow icon={IdCard} label="Agent code" value={profile?.agent_code ?? "—"} mono />
            <InfoRow
              icon={Phone}
              label="Yeastar extension"
              value={profile?.yeastar_ext ?? "—"}
              mono
            />
            <InfoRow
              icon={Calendar}
              label="Member since"
              value={created ? format(created, "PP") : "—"}
            />
          </dl>
        </CardContent>
      </Card>

      {/* Permissions */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Permissions</CardTitle>
        </CardHeader>
        <CardContent>
          {perms.length === 0 ? (
            <p className="text-sm text-muted-foreground">Using role defaults.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {perms.map((p) => (
                <Badge key={p} variant="outline" className="font-normal">
                  {p.replace(/_/g, " ")}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Password — self-service change, current password required */}
      <ChangePasswordCard />

      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sign out
        </Button>
      </div>

      {/* Avatar dialog */}
      <Dialog
        open={avatarDialog}
        onOpenChange={(o) => {
          setAvatarDialog(o);
          if (!o) {
            setFile(null);
            setPreview(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Profile picture</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex justify-center">
              <UserAvatar
                name={profile?.full_name}
                url={preview ?? profile?.avatar_url ?? undefined}
                size="xl"
                className="!h-32 !w-32"
              />
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            <div className="flex flex-wrap gap-2 justify-center">
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <Camera className="h-4 w-4 mr-2" />
                Choose image
              </Button>
              {profile?.avatar_url && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={removeAvatar}
                  disabled={uploading}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground text-center">PNG or JPG, up to 4 MB.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAvatarDialog(false)}>
              Cancel
            </Button>
            <Button onClick={uploadAvatar} disabled={!file || uploading}>
              {uploading ? "Uploading…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 h-8 w-8 rounded-md bg-muted grid place-items-center shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          {label}
        </dt>
        <dd className={"text-sm text-foreground truncate " + (mono ? "font-mono" : "")}>{value}</dd>
      </div>
    </div>
  );
}
