import { Search, SlidersHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_LABEL } from "@/lib/roles";

import { SORT_OPTIONS, STATUS_FILTERS } from "../constants";
import type { UserSort, UserStatusFilter } from "../types";

/**
 * Search, facets and sort.
 *
 * A single row that wraps rather than a collapsible filter panel: there are only
 * four controls, and hiding them behind a toggle costs a click on every visit to
 * save space that the layout already has.
 */
export function UsersToolbar({
  q, onQChange,
  role, onRoleChange,
  status, onStatusChange,
  sort, onSortChange,
  resultCount,
  filtersActive,
  onClear,
}: {
  q: string;
  onQChange: (value: string) => void;
  role: string;
  onRoleChange: (value: string) => void;
  status: UserStatusFilter;
  onStatusChange: (value: UserStatusFilter) => void;
  sort: UserSort;
  onSortChange: (value: UserSort) => void;
  resultCount: number;
  filtersActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
      <div className="relative min-w-[200px] flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          placeholder="Search name, email or agent code…"
          aria-label="Search users"
          className="h-9 pl-9 pr-9"
        />
        {q.length > 0 && (
          <button
            type="button"
            onClick={() => onQChange("")}
            aria-label="Clear search"
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      <Select value={role} onValueChange={onRoleChange}>
        <SelectTrigger className="h-9 w-[160px]" aria-label="Filter by role">
          <SelectValue placeholder="All roles" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All roles</SelectItem>
          {Object.entries(ROLE_LABEL).map(([key, label]) => (
            <SelectItem key={key} value={key}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={status} onValueChange={(v) => onStatusChange(v as UserStatusFilter)}>
        <SelectTrigger className="h-9 w-[170px]" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_FILTERS.map((s) => (
            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={sort} onValueChange={(v) => onSortChange(v as UserSort)}>
        <SelectTrigger className="h-9 w-[150px]" aria-label="Sort users">
          <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((s) => (
            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {filtersActive && (
        <Button variant="ghost" size="sm" className="h-9" onClick={onClear}>
          Clear
        </Button>
      )}

      <div className="ml-auto text-xs text-muted-foreground" aria-live="polite">
        {resultCount} result{resultCount === 1 ? "" : "s"}
      </div>
    </div>
  );
}
