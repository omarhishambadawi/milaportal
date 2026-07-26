import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  ShieldAlert,
  Pencil,
  Eye,
  Download,
} from "lucide-react";
import { COMPLAINT_STATUSES, STATUS_STYLES } from "@/lib/branches";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { useAgentDirectory } from "@/lib/directory";
import { toast } from "sonner";
// xlsx is lazy-loaded inside the export handler to keep it out of this route's
// initial chunk; it is only fetched when the user clicks Export.

export const Route = createFileRoute("/_app/complaints/")({
  head: () => ({ meta: [{ title: "Complaints" }] }),
  component: ComplaintsList,
});

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_STORAGE_KEY = "complaints.pageSize";
const normalizeSearchTerm = (value: string) =>
  value
    .replace(/[,%.*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** Build an .or() filter string across the searchable complaint columns.
 *  agent_name is a derived field (joined from profiles), so agent search is
 *  expressed as agent_id.in.(…) using ids resolved from the small, already
 *  loaded agent directory rather than a server-side join. */
function buildSearchOr(term: string, agentIds: string[]): string {
  // Values are pre-normalized (`,` `%` `*` `.` `(` `)` stripped) so they are
  // safe to interpolate into the PostgREST .or() grammar; agent ids are UUIDs.
  const t = `%${term}%`;
  const parts = [
    `display_no.ilike.${t}`,
    `customer_name.ilike.${t}`,
    `customer_phone.ilike.${t}`,
    `branch_no.ilike.${t}`,
    `category.ilike.${t}`,
    `description.ilike.${t}`,
  ];
  if (agentIds.length > 0) parts.push(`agent_id.in.(${agentIds.join(",")})`);
  return parts.join(",");
}

function ComplaintsList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { role, profile, user } = useAuth();
  const canView = hasPerm(role, profile?.permissions as any, "view_complaints");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_complaints");
  const canEditAll = hasPerm(role, profile?.permissions as any, "edit_all_complaints");
  const canEditOwn = hasPerm(role, profile?.permissions as any, "edit_complaints");
  const canResolveAll = hasPerm(role, profile?.permissions as any, "resolve_all_complaints");
  const canResolveOwn = hasPerm(role, profile?.permissions as any, "resolve_complaints");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSizeState] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
    const v = Number(window.sessionStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return PAGE_SIZE_OPTIONS.includes(v as any) ? v : DEFAULT_PAGE_SIZE;
  });
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setPage(0);
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(n));
  };

  // Debounce the search input so we don't fire a query per keystroke.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const term = normalizeSearchTerm(debouncedQ);
  const searching = term.length > 0;

  // Small reference lookups for name + city enrichment (bounded by #agents and
  // #branches, not by #complaints). Shared, cached across routes.
  const { data: agentOpts } = useAgentDirectory();
  const namesById = useMemo(
    () => new Map((agentOpts ?? []).map((a: any) => [a.id, a.full_name])),
    [agentOpts],
  );
  const { data: cities } = useQuery({
    queryKey: queryKeys.lookups.ordersDirectory(),
    queryFn: async () => {
      const { data: branches } = await supabase.from("branches").select("branch_no,city");
      return new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
    },
  });

  // Agent ids whose name matches the search term — lets agent-name search run
  // server-side without a join against the 100k complaints table.
  const agentMatchIds = useMemo(() => {
    if (!searching) return [] as string[];
    const lc = term.toLowerCase();
    return (agentOpts ?? [])
      .filter((a: any) => (a.full_name ?? "").toLowerCase().includes(lc))
      .map((a: any) => a.id as string);
  }, [agentOpts, term, searching]);

  const filters = { status, mineOnly, term, agentMatch: agentMatchIds.join(","), userId: user?.id };

  // Apply the shared filter set to a PostgREST query builder. Preserves the
  // exact filters the client version had: status, mine-only, and search (no
  // date bound — the complaints list is not date-scoped).
  const applyFilters = (qb: any) => {
    if (status !== "all") qb = qb.eq("status", status);
    if (mineOnly && user?.id) qb = qb.eq("agent_id", user.id);
    if (searching) qb = qb.or(buildSearchOr(term, agentMatchIds));
    return qb;
  };

  // Paginated page fetch (server-side range + exact count + server sort).
  const { data: pageData, isLoading } = useQuery({
    queryKey: queryKeys.complaints.page(filters, page, pageSize),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const offset = page * pageSize;
      let qb = supabase.from("complaints" as any).select("*", { count: "exact" });
      qb = applyFilters(qb);
      qb = qb.order("created_at", { ascending: false });
      qb = qb.range(offset, offset + pageSize - 1);
      const { data, count, error } = await qb;
      if (error) throw error;
      return { rows: (data as any[]) ?? [], total: count ?? 0 };
    },
  });

  const pageRows = useMemo(() => {
    const rows = pageData?.rows ?? [];
    return rows.map((c: any) => ({
      ...c,
      agent_name: namesById.get(c.agent_id) ?? "—",
      city: cities?.get(c.branch_no) ?? "",
    }));
  }, [pageData, namesById, cities]);

  const total = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const rangeStart = total === 0 ? 0 : currentPage * pageSize + 1;
  const rangeEnd = Math.min(total, (currentPage + 1) * pageSize);

  const toggleStatus = async (complaint: any, resolved: boolean) => {
    const owned = complaint.agent_id === user?.id;
    if (!(canResolveAll || (owned && canResolveOwn))) {
      toast.error("You don't have permission to resolve this complaint");
      return;
    }
    const id = complaint.id;
    const { error } = await supabase
      .from("complaints" as any)
      .update({ status: resolved ? "Resolved" : "In Progress" } as any)
      .eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: queryKeys.complaints.all() });
    qc.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
  };

  const doExport = async () => {
    if (!canExport) {
      toast.error("You don't have permission to export reports");
      return;
    }
    toast.info("Preparing export…");
    // Fetch every row matching the current filters, in batches, respecting RLS —
    // preserves the previous "export everything matching" behaviour without ever
    // holding the whole table for the on-screen list.
    const BATCH = 1000;
    const all: any[] = [];
    for (let start = 0; ; start += BATCH) {
      let qb = supabase.from("complaints" as any).select("*");
      qb = applyFilters(qb);
      qb = qb.order("created_at", { ascending: false });
      qb = qb.range(start, start + BATCH - 1);
      const { data, error } = await qb;
      if (error) {
        toast.error(error.message);
        return;
      }
      all.push(...((data as any[]) ?? []));
      if (!data || (data as any[]).length < BATCH) break;
    }
    const XLSX = await import("xlsx");
    const xrows = all.map((c: any) => ({
      "#": c.display_no,
      Date: c.complaint_date,
      "Customer Name": c.customer_name ?? "",
      "Customer Phone": c.customer_phone ?? "",
      "Branch No.": c.branch_no ?? "",
      City: cities?.get(c.branch_no) ?? "",
      Agent: namesById.get(c.agent_id) ?? "—",
      Notes: c.description ?? "",
      Status: c.status,
    }));
    const ws = XLSX.utils.json_to_sheet(xrows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Complaints");
    XLSX.writeFile(wb, `complaints_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  if (!canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Complaints.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Complaints</h1>
          <p className="text-sm text-muted-foreground">
            {total} complaint{total !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Button
            variant={mineOnly ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setMineOnly((v) => !v);
              setPage(0);
            }}
          >
            {mineOnly ? "Mine" : "All"}
          </Button>
          {canExport && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                doExport().catch((e) => toast.error(e?.message ?? "Export failed"));
              }}
            >
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => navigate({ to: "/complaints/new" })}>
              <Plus className="h-4 w-4 mr-2" />
              New complaint
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4 grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search customer/phone/branch/agent…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              className="pl-9 h-10"
            />
          </div>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="h-10">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {COMPLAINT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">✓</TableHead>
                  <TableHead>#</TableHead>
                  <TableHead className="hidden sm:table-cell">Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden md:table-cell">Phone</TableHead>
                  <TableHead>Branch · City</TableHead>
                  <TableHead className="hidden lg:table-cell">Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && pageRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No complaints
                    </TableCell>
                  </TableRow>
                )}
                {pageRows.map((c: any) => {
                  const owned = c.agent_id === user?.id;
                  const canEditRow = canEditAll || (owned && canEditOwn);
                  const canResolveRow = canResolveAll || (owned && canResolveOwn);
                  const resolved = c.status === "Resolved";
                  return (
                    <TableRow key={c.id} className={resolved ? "bg-[var(--tint-resolved)]" : ""}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={resolved}
                          disabled={!canResolveRow}
                          onCheckedChange={(v) => toggleStatus(c, !!v)}
                          aria-label="Resolved"
                        />
                      </TableCell>
                      <TableCell className="font-mono font-semibold">{c.display_no}</TableCell>
                      <TableCell className="hidden sm:table-cell whitespace-nowrap">
                        {c.complaint_date}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{c.customer_name || "—"}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs">
                        {c.customer_phone || "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {c.branch_no ? `${c.branch_no} — ${c.city || "—"}` : "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell whitespace-nowrap">
                        {c.agent_name}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[c.status] ?? "bg-muted"}`}
                        >
                          {c.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        {canEditRow ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              navigate({ to: "/complaints/$id", params: { id: c.id } })
                            }
                            aria-label="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              navigate({ to: "/complaints/$id", params: { id: c.id } })
                            }
                            aria-label="View"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex flex-wrap items-center justify-between gap-3 p-3 border-t text-sm">
            <div className="text-muted-foreground">
              {total === 0 ? (
                "No complaints"
              ) : (
                <>
                  Showing{" "}
                  <span className="font-medium text-foreground">
                    {rangeStart}–{rangeEnd}
                  </span>{" "}
                  of <span className="font-medium text-foreground">{total}</span> complaints
                </>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-muted-foreground hidden sm:inline">Rows per page</span>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className="h-8 w-[72px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground px-2 whitespace-nowrap">
                Page {currentPage + 1} of {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">Prev</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage + 1 >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="h-4 w-4 sm:ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
