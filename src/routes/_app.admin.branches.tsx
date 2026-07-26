import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Pencil, Plus, ShieldAlert, Trash2, Search, Eye } from "lucide-react";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";

export const Route = createFileRoute("/_app/admin/branches")({
  head: () => ({ meta: [{ title: "Branches — MilaServ Portal" }] }),
  component: AdminBranches,
});

function AdminBranches() {
  const { role, profile } = useAuth();
  const canView =
    hasPerm(role, profile?.permissions as any, "view_branches") ||
    hasPerm(role, profile?.permissions as any, "admin_access");
  const canManage = hasPerm(role, profile?.permissions as any, "admin_access");
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{
    branch_no: string;
    city: string;
    _new?: boolean;
  } | null>(null);

  const { data } = useQuery({
    queryKey: queryKeys.branches.admin(),
    queryFn: async () => {
      const { data, error } = await supabase.from("branches").select("*").order("branch_no");
      if (error) throw error;
      return data ?? [];
    },
    enabled: canView,
  });

  if (!canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Branches.</p>
      </div>
    );
  }

  const filtered = (data ?? []).filter((b: any) => {
    const t = q.toLowerCase();
    return !t || b.branch_no.toLowerCase().includes(t) || b.city.toLowerCase().includes(t);
  });

  const save = async () => {
    if (!editing) return;
    if (!editing.branch_no || !editing.city) {
      toast.error("Branch & city required");
      return;
    }
    const payload = { branch_no: editing.branch_no, city: editing.city };
    const { error } = editing._new
      ? await supabase.from("branches").insert(payload)
      : await supabase
          .from("branches")
          .update({ city: editing.city })
          .eq("branch_no", editing.branch_no);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    setEditing(null);
    setOpen(false);
    qc.invalidateQueries({ queryKey: queryKeys.branches.all() });
  };

  const del = async (branch_no: string) => {
    if (!confirm(`Delete branch ${branch_no}?`)) return;
    const { error } = await supabase.from("branches").delete().eq("branch_no", branch_no);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: queryKeys.branches.all() });
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-150">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight">Branches</h1>
            {!canManage && (
              <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wide">
                <Eye className="h-3 w-3" />
                Read-only
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">Centralized branch → city mapping</p>
        </div>
        {canManage && (
          <Dialog
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              if (!o) setEditing(null);
            }}
          >
            <DialogTrigger asChild>
              <Button onClick={() => setEditing({ branch_no: "", city: "", _new: true })}>
                <Plus className="h-4 w-4 mr-2" />
                Add branch
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editing?._new ? "Add branch" : "Edit branch"}</DialogTitle>
              </DialogHeader>
              {editing && (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Branch No.</Label>
                    <Input
                      value={editing.branch_no}
                      disabled={!editing._new}
                      onChange={(e) => setEditing({ ...editing, branch_no: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>City</Label>
                    <Input
                      value={editing.city}
                      onChange={(e) => setEditing({ ...editing, city: e.target.value })}
                    />
                  </div>
                  <DialogFooter>
                    <Button onClick={save}>Save</Button>
                  </DialogFooter>
                </div>
              )}
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search branch / city…"
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch No.</TableHead>
                <TableHead>City</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((b: any) => (
                <TableRow key={b.branch_no}>
                  <TableCell className="font-mono">{b.branch_no}</TableCell>
                  <TableCell>{b.city}</TableCell>
                  {canManage && (
                    <TableCell className="text-right space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing({ branch_no: b.branch_no, city: b.city });
                          setOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => del(b.branch_no)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 3 : 2}
                    className="text-center text-muted-foreground py-8"
                  >
                    No branches match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
