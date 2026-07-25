import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth, isAdministrator, isOwnerRole } from "@/lib/auth";
import { adminCreateUser, adminListUsers, adminSetActive, adminSetRole, adminSetPassword, adminUpdateProfile, adminDeleteUser } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ShieldAlert, KeyRound, Pencil, Plus, Trash2, Search, MoreHorizontal, Users as UsersIcon, Check, X, Crown } from "lucide-react";
import { ALL_PERMISSIONS, defaultPermsForRole, PERMISSION_GROUPS, hasPerm } from "@/lib/permissions";
import { evaluatePassword } from "@/lib/password-policy";
import {
  ASSIGNABLE_ROLES,
  ROLE_LABEL,
  ROLE_OPTION_LABEL,
  roleHasAgentCode,
  type AppRole,
} from "@/lib/roles";
import { PasswordInput } from "@/components/password-input";
import { RoleBadge } from "@/components/role-badge";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";

export const Route = createFileRoute("/_app/admin/users")({
  head: () => ({ meta: [{ title: "Users — MilaServ Portal" }] }),
  component: AdminUsers,
});

// Role list, labels and badge tones all come from @/lib/roles so this screen
// cannot fall behind the enum again (it was missing `supervisor` entirely:
// absent from the type, both maps and both dropdowns).
type RoleKey = AppRole;

function AdminUsers() {
  const { role, profile } = useAuth();
  // Permission-only, deliberately: the previous `isAdministrator(role) && …`
  // conjunct made this page unreachable for any non-administrator, which now
  // includes Supervisor — a role that holds manage_users. The conjunct was also
  // redundant for administrators, since hasPerm() short-circuits to true for
  // owner/admin. This mirrors the server gate (assertCanManageUsers), so UI
  // visibility and API authorization are derived from the same permission.
  const canManageUsers = hasPerm(role, profile?.permissions as any, "manage_users");
  // Deleting users stays administrator-only (see adminDeleteUser). Supervisor
  // must not see delete affordances it cannot use.
  const canDeleteUsers = isAdministrator(role);
  const qc = useQueryClient();
  const listFn = useServerFn(adminListUsers);
  const createFn = useServerFn(adminCreateUser);
  const setActiveFn = useServerFn(adminSetActive);
  const setRoleFn = useServerFn(adminSetRole);
  const setPwFn = useServerFn(adminSetPassword);
  const updFn = useServerFn(adminUpdateProfile);
  const delFn = useServerFn(adminDeleteUser);

  // Granting Owner. This ADDS an Owner -- it is not a transfer: the acting Owner
  // keeps their own role, and the platform supports any number of Owners, all with
  // identical privileges and protections.
  //
  // Kept off the role dropdown on purpose: it is not a routine edit, and an Owner
  // cannot afterwards be demoted, deactivated or deleted. Only an existing Owner
  // sees this action, and it requires their password.
  const callerIsOwner = isOwnerRole(role);
  const [grantOwnerTo, setGrantOwnerTo] = useState<any>(null);
  const [grantOwnerPw, setGrantOwnerPw] = useState("");
  const [grantOwnerBusy, setGrantOwnerBusy] = useState(false);

  const confirmGrantOwner = async () => {
    if (!grantOwnerTo || !grantOwnerPw) return;
    setGrantOwnerBusy(true);
    try {
      await setRoleFn({ data: { userId: grantOwnerTo.id, role: "owner", confirmPassword: grantOwnerPw } });
      toast.success(`${grantOwnerTo.full_name} is now an Owner`);
      setGrantOwnerTo(null);
      setGrantOwnerPw("");
      reload();
    } catch (e: any) {
      toast.error(e.message ?? "Could not grant the Owner role");
    } finally {
      setGrantOwnerBusy(false);
    }
  };

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.adminUsers.list(),
    queryFn: () => listFn(),
    enabled: canManageUsers,
  });

  const [openNew, setOpenNew] = useState(false);
  const [nf, setNf] = useState({ email: "", password: "", fullName: "", agentCode: "", role: "customer_care" as RoleKey });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [pwUser, setPwUser] = useState<any | null>(null);
  const [newPw, setNewPw] = useState("");

  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    const users = (data as any[]) ?? [];
    const term = q.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== "all" && (u.role ?? "") !== roleFilter) return false;
      if (statusFilter === "active" && !u.active) return false;
      if (statusFilter === "inactive" && u.active) return false;
      if (!term) return true;
      return (
        (u.full_name ?? "").toLowerCase().includes(term) ||
        (u.email ?? "").toLowerCase().includes(term) ||
        (u.agent_code ?? "").toLowerCase().includes(term)
      );
    });
  }, [data, q, roleFilter, statusFilter]);

  if (!canManageUsers) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have access to user management.</p></div>;
  }

  const reload = () => qc.invalidateQueries({ queryKey: queryKeys.adminUsers.all() });

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await createFn({ data: nf });
      toast.success("User created");
      setOpenNew(false);
      setNf({ email: "", password: "", fullName: "", agentCode: "", role: "customer_care" });
      reload();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const permsEqual = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    return b.every((k) => sa.has(k));
  };

  const openEdit = (u: any) => {
    const stored: string[] = Array.isArray(u.permissions) ? u.permissions : [];
    const usingDefaults = stored.length === 0;
    const roleKey = (u.role ?? "customer_care") as any;
    const effective = usingDefaults ? defaultPermsForRole(roleKey) : stored;
    setEditing({ ...u, permissions: effective, _usingDefaults: usingDefaults, _originalStored: stored });
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const roleKey = (editing.role ?? "customer_care") as any;
      const currentPerms: string[] = editing.permissions ?? [];
      const toStore = editing._usingDefaults || permsEqual(currentPerms, defaultPermsForRole(roleKey))
        ? []
        : currentPerms;
      await updFn({ data: { userId: editing.id, fullName: editing.full_name, agentCode: editing.agent_code ?? "", yeastarExt: editing.yeastar_ext ?? "", permissions: toStore } });
      if (editing._roleChange) await setRoleFn({ data: { userId: editing.id, role: editing.role } });
      toast.success("Saved");
      setEditing(null);
      reload();
    } catch (e: any) { toast.error(e.message); }
  };

  const togglePerm = (key: string, on: boolean) => {
    if (!editing) return;
    const cur: string[] = editing.permissions ?? [];
    const next = on ? Array.from(new Set([...cur, key])) : cur.filter((p: string) => p !== key);
    setEditing({ ...editing, permissions: next, _usingDefaults: false });
  };

  const savePw = async () => {
    if (!pwUser) return;
    try {
      await setPwFn({ data: { userId: pwUser.id, password: newPw } });
      toast.success("Password reset");
      setPwUser(null); setNewPw("");
    } catch (e: any) { toast.error(e.message); }
  };

  const totalCount = (data as any[])?.length ?? 0;
  const activeCount = (data as any[])?.filter((u) => u.active).length ?? 0;

  return (
    <div className="space-y-4 animate-in fade-in duration-150">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <UsersIcon className="h-6 w-6 text-primary" /> Users
          </h1>
          <p className="text-sm text-muted-foreground">
            {totalCount} total · {activeCount} active
          </p>
        </div>
        <Dialog open={openNew} onOpenChange={setOpenNew}>
          <DialogTrigger asChild><Button className="shadow-sm"><Plus className="h-4 w-4 mr-2" />Invite user</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create user</DialogTitle></DialogHeader>
            <form onSubmit={onCreate} className="space-y-3">
              <div className="space-y-2"><Label>Full name</Label><Input required value={nf.fullName} onChange={(e) => setNf({ ...nf, fullName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>Email</Label><Input type="email" required value={nf.email} onChange={(e) => setNf({ ...nf, email: e.target.value })} /></div>
                {/* Agent Code applies to agent roles only — Owner, Admin,
                    Supervisor and Auditor take no orders, so the field is hidden
                    rather than shown and ignored. The server enforces the same rule. */}
                {roleHasAgentCode(nf.role) && (
                  <div className="space-y-2"><Label>Agent code</Label><Input value={nf.agentCode} onChange={(e) => setNf({ ...nf, agentCode: e.target.value })} placeholder="4002" /></div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>Password</Label><PasswordInput required value={nf.password} onChange={(e) => setNf({ ...nf, password: e.target.value })} /></div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  {/* Clear any typed agent code when moving to a non-agent role,
                      so a hidden field cannot submit a stale value. */}
                  <Select value={nf.role} onValueChange={(v) => setNf({ ...nf, role: v as RoleKey, agentCode: roleHasAgentCode(v) ? nf.agentCode : "" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_OPTION_LABEL[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Toolbar */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, code…" className="pl-9 h-9" />
          </div>
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-[180px] h-9"><SelectValue placeholder="All roles" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {Object.entries(ROLE_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground ml-auto">
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="hidden md:table-cell">Code</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-10">Loading…</TableCell></TableRow>}
              {error && <TableRow><TableCell colSpan={6} className="text-center text-destructive py-10">{(error as Error).message}</TableCell></TableRow>}
              {!isLoading && filtered.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-10">No users match your filters.</TableCell></TableRow>
              )}
              {filtered.map((u: any) => {
                // Owner rows are protected. Deletion and deactivation are
                // refused for everyone; edits and password resets are limited to
                // another Owner. The server enforces all of this independently
                // (admin.functions.ts) -- this only keeps the UI honest.
                const rowIsOwner = isOwnerRole(u.role);
                const mayActOnRow = !rowIsOwner || isOwnerRole(role);
                return (
                <TableRow key={u.id} className="group">
                  <TableCell>
                    <div className="flex items-center gap-3 min-w-0">
                      <UserAvatar name={u.full_name} url={u.avatar_url} size="sm" />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{u.full_name}</div>
                        <div className="text-xs text-muted-foreground truncate md:hidden">{u.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{u.email}</TableCell>
                  <TableCell className="hidden md:table-cell font-mono text-xs">{u.agent_code ?? "—"}</TableCell>
                  <TableCell>
                    <RoleBadge role={u.role} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className={cn("h-2 w-2 rounded-full", u.active ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                      <span className="text-xs">{u.active ? "Active" : "Inactive"}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-70 group-hover:opacity-100"><MoreHorizontal className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => openEdit(u)} disabled={!mayActOnRow}>
                          <Pencil className="h-4 w-4 mr-2" />Edit & permissions
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setPwUser(u)} disabled={!mayActOnRow}>
                          <KeyRound className="h-4 w-4 mr-2" />Reset password
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={(e) => e.preventDefault()} asChild>
                          <label className="flex items-center px-2 py-1.5 text-sm cursor-pointer">
                            <span className="mr-auto">Active</span>
                            <Switch
                              checked={u.active}
                              disabled={rowIsOwner}
                              onCheckedChange={async (v) => { try { await setActiveFn({ data: { userId: u.id, active: v } }); reload(); } catch (e: any) { toast.error(e.message); } }}
                            />
                          </label>
                        </DropdownMenuItem>
                        {rowIsOwner && (
                          <div className="px-2 pb-1 text-[10px] text-muted-foreground">
                            Owner accounts are protected
                          </div>
                        )}
                        {/* Owner-only, and never for an account that is already
                            an Owner. Opens a password-confirmed dialog. */}
                        {callerIsOwner && !rowIsOwner && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => { setGrantOwnerTo(u); setGrantOwnerPw(""); }}>
                              <Crown className="h-4 w-4 mr-2" />Grant Owner…
                            </DropdownMenuItem>
                          </>
                        )}
                        {/* Administrator-only: Supervisor holds manage_users but
                            may never delete a user, so it must not see the action
                            at all. adminDeleteUser enforces the same server-side. */}
                        {canDeleteUsers && (
                          <>
                            <DropdownMenuSeparator />
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <DropdownMenuItem onSelect={(e) => e.preventDefault()} disabled={rowIsOwner} className="text-destructive focus:text-destructive">
                                  <Trash2 className="h-4 w-4 mr-2" />Delete user
                                </DropdownMenuItem>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete {u.full_name}?</AlertDialogTitle>
                                  <AlertDialogDescription>This permanently removes the account and signs them out. Their existing orders are kept for records. This cannot be undone.</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={async () => { try { await delFn({ data: { userId: u.id } }); toast.success("User deleted"); reload(); } catch (e: any) { toast.error(e.message); } }}>Delete</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit user &amp; permissions</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-5">
              <div className="flex items-center gap-3 pb-3 border-b border-border">
                <UserAvatar name={editing.full_name} url={editing.avatar_url} size="md" />
                <div className="min-w-0">
                  <div className="font-medium truncate">{editing.full_name}</div>
                  <div className="text-xs text-muted-foreground truncate">{editing.email}</div>
                </div>
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                <div className={roleHasAgentCode(editing.role) ? "space-y-2 sm:col-span-2" : "space-y-2 sm:col-span-3"}><Label>Full name</Label><Input value={editing.full_name} onChange={(e) => setEditing({ ...editing, full_name: e.target.value })} /></div>
                {/* Agent roles only — see the create dialog. */}
                {roleHasAgentCode(editing.role) && (
                  <div className="space-y-2"><Label>Agent code</Label><Input value={editing.agent_code ?? ""} onChange={(e) => setEditing({ ...editing, agent_code: e.target.value })} /></div>
                )}
                <div className="space-y-2 sm:col-span-3"><Label>Yeastar extension</Label><Input value={editing.yeastar_ext ?? ""} onChange={(e) => setEditing({ ...editing, yeastar_ext: e.target.value })} placeholder="e.g. 1001" /><p className="text-xs text-muted-foreground">PBX extension number used to attribute calls to this agent.</p></div>
                <div className="space-y-2 sm:col-span-3">
                  <Label>Role</Label>
                  <Select value={editing.role ?? "customer_care"} onValueChange={(v) => {
                    const next: any = { ...editing, role: v, _roleChange: true };
                    if (editing._usingDefaults) next.permissions = defaultPermsForRole(v as any);
                    setEditing(next);
                  }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_OPTION_LABEL[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Label>Permissions</Label>
                    <Badge variant={editing._usingDefaults ? "secondary" : "outline"} className="text-[10px]">
                      {editing._usingDefaults ? "Using role defaults" : "Custom"}
                    </Badge>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing({ ...editing, permissions: defaultPermsForRole((editing.role ?? "customer_care")), _usingDefaults: true })}>Reset to defaults</Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {PERMISSION_GROUPS.map((group) => {
                    const perms = ALL_PERMISSIONS.filter((p) => p.group === group);
                    if (perms.length === 0) return null;
                    return (
                      <div key={group} className="rounded-lg border bg-card/40 p-3 space-y-2">
                        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1.5">{group}</div>
                        <div className="space-y-1">
                          {perms.map((p) => {
                            const checked = (editing.permissions ?? []).includes(p.key);
                            return (
                              <label key={p.key} className="flex items-center justify-between gap-2 text-sm cursor-pointer rounded px-1 py-1 hover:bg-accent/40 transition-colors duration-150">
                                <span className="flex-1 min-w-0 truncate">{p.label}</span>
                                <Switch checked={checked} onCheckedChange={(v) => togglePerm(p.key, !!v)} />
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {editing._usingDefaults
                    ? "This user auto-tracks role defaults. Any change pins an exact custom set."
                    : "Custom permission set. Click \"Reset to defaults\" to return to auto-updating defaults."}
                </p>
              </div>
              <DialogFooter><Button onClick={saveEdit}>Save changes</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Password dialog */}
      <Dialog open={!!pwUser} onOpenChange={(o) => { if (!o) { setPwUser(null); setNewPw(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reset password</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Set a new password for {pwUser?.full_name}.</p>
            <PasswordInput placeholder="New password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            <ul className="space-y-1">
              {evaluatePassword(newPw).results.map((rule) => (
                <li key={rule.id} className={cn("flex items-center gap-1.5 text-xs", rule.passed ? "text-[var(--positive)]" : "text-muted-foreground")}>
                  {rule.passed ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <X className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  {rule.label}
                </li>
              ))}
            </ul>
            <DialogFooter><Button onClick={savePw} disabled={!evaluatePassword(newPw).valid}>Update password</Button></DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Grant Owner — password-confirmed. Adds an Owner; does not transfer. */}
      <Dialog open={!!grantOwnerTo} onOpenChange={(o) => { if (!o) { setGrantOwnerTo(null); setGrantOwnerPw(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-primary" />Grant Owner role
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{grantOwnerTo?.full_name}</span> will gain
              unrestricted access to every feature, with the same privileges and protections as
              every other Owner. You keep your own Owner role — this adds an Owner rather than
              handing yours over.
            </p>
            <p className="text-sm text-muted-foreground">
              An Owner cannot afterwards be demoted, deactivated or deleted.
            </p>
            <div className="space-y-2">
              <Label htmlFor="grant-owner-confirm">Confirm your password to continue</Label>
              <PasswordInput
                id="grant-owner-confirm"
                autoComplete="current-password"
                value={grantOwnerPw}
                onChange={(e) => setGrantOwnerPw(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setGrantOwnerTo(null); setGrantOwnerPw(""); }}>Cancel</Button>
            <Button onClick={confirmGrantOwner} disabled={!grantOwnerPw || grantOwnerBusy}>
              {grantOwnerBusy ? "Confirming…" : "Grant Owner role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
