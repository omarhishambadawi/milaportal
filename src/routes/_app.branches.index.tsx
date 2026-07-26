import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  Download,
  Map as MapIcon,
  PanelRightClose,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { BranchList } from "@/features/branches/components/branch-list";
import { BranchMapSurface } from "@/features/branches/components/branch-map-surface";
import { BranchSearchBar } from "@/features/branches/components/branch-search-bar";
import { BranchDirectoryMeta } from "@/features/branches/components/branch-stats";
import { exportBranches } from "@/features/branches/export";
import { useBranchDirectory } from "@/features/branches/hooks/use-branch-directory";
import { useBranchFilters } from "@/features/branches/hooks/use-branch-filters";
import { useDirectoryFreshness } from "@/features/branches/hooks/use-directory-freshness";
import { LIST_PANEL_ID, MAP_PANEL_ID, useMapPanel } from "@/features/branches/hooks/use-map-panel";
import { hasActiveFilters } from "@/features/branches/search";

export const Route = createFileRoute("/_app/branches/")({
  head: () => ({ meta: [{ title: "Branch Directory — MilaServ Portal" }] }),
  component: BranchDirectory,
});

function BranchDirectory() {
  const { branches, isLoading, error, canView, canManage, canExport } = useBranchDirectory();
  const {
    filters,
    results,
    tokens,
    stats,
    cities,
    dutyHours,
    managers,
    favourites,
    toggleFavourite,
    recent,
    rememberSearch,
    clearRecent,
    recentBranches,
    rememberBranch,
    clearRecentBranches,
    setQuery,
    toggleCity,
    toggleScooter,
    toggleDutyHours,
    toggleManager,
    toggleFavouritesOnly,
    focusBranch,
    clearFilters,
    reset,
  } = useBranchFilters(branches);

  const { lastUpdated, lastImport } = useDirectoryFreshness(branches, canManage);
  const map = useMapPanel();

  const [selected, setSelected] = useState<string | null>(null);
  const [mobileMapOpen, setMobileMapOpen] = useState(false);

  const byCode = useMemo(
    () => new Map(branches.map((branch) => [branch.branch_no, branch])),
    [branches],
  );

  /**
   * Opening a card is what counts as "viewing" a branch.
   *
   * Recorded here rather than in the card so it happens once per selection,
   * whether the branch was clicked in the list or picked off the map.
   */
  const handleSelect = useCallback(
    (branchNo: string | null) => {
      setSelected((current) => {
        const next = current === branchNo ? null : branchNo;
        if (next) rememberBranch(next);
        return next;
      });
    },
    [rememberBranch],
  );

  const handleFocusBranch = useCallback(
    (branchNo: string) => {
      focusBranch(branchNo);
      setSelected(branchNo);
      rememberBranch(branchNo);
    },
    [focusBranch, rememberBranch],
  );

  const filtered = hasActiveFilters(filters);

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to the Branch Directory.
        </p>
      </div>
    );
  }

  const showMapPanel = map.showPanel;

  return (
    // Sized to the viewport rather than growing with content: the search box has
    // to stay put while results scroll beneath it, and a page that scrolls as a
    // whole cannot do that.
    <div className="flex flex-col gap-3 h-[calc(100dvh-5.5rem)] sm:h-[calc(100dvh-6rem)] lg:h-[calc(100dvh-7rem)]">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Branch Directory</h1>
          <div className="mt-0.5">
            <BranchDirectoryMeta
              stats={stats}
              loading={isLoading}
              resultCount={results.length}
              filtered={filtered}
              lastUpdated={lastUpdated}
              lastImport={lastImport}
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="lg:hidden"
            onClick={() => setMobileMapOpen(true)}
          >
            <MapIcon className="h-4 w-4" />
            Map
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="hidden lg:inline-flex"
            onClick={map.toggle}
            aria-pressed={map.visible}
          >
            {map.visible ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <MapIcon className="h-4 w-4" />
            )}
            {map.visible ? "Hide map" : "Show map"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Actions
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {filtered ? `${results.length} matching branches` : "All branches"}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {canExport && (
                <DropdownMenuItem onClick={() => exportBranches(results, { filtered })}>
                  <Download className="h-4 w-4" />
                  Export {filtered ? "filtered" : "all"} to Excel
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/branches/import">
                      <Upload className="h-4 w-4" />
                      Import branches
                    </Link>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="shrink-0">
        <BranchSearchBar
          filters={filters}
          resultCount={results.length}
          totalCount={branches.length}
          cities={cities}
          dutyHours={dutyHours}
          managers={managers}
          favourites={favourites}
          recent={recent}
          recentBranches={recentBranches}
          byCode={byCode}
          onQueryChange={setQuery}
          onCommitQuery={rememberSearch}
          onClearRecent={clearRecent}
          onClearRecentBranches={clearRecentBranches}
          onToggleCity={toggleCity}
          onToggleScooter={toggleScooter}
          onToggleDutyHours={toggleDutyHours}
          onToggleManager={toggleManager}
          onToggleFavourites={toggleFavouritesOnly}
          onClearFilters={clearFilters}
          onFocusBranch={handleFocusBranch}
        />
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load branches: {error.message}
        </div>
      ) : (
        // `min-h-0` is what lets the list scroll instead of stretching this row:
        // a flex child defaults to min-height:auto, which refuses to shrink below
        // its content and pushes the overflow onto the page.
        <ResizablePanelGroup
          key={map.layoutKey}
          defaultLayout={map.defaultLayout}
          onLayoutChanged={map.remember}
          className="min-h-0 flex-1"
        >
          <ResizablePanel id={LIST_PANEL_ID} minSize={map.listMinWidth} className="min-w-0">
            <BranchList
              branches={results}
              loading={isLoading}
              selected={selected}
              favourites={favourites}
              tokens={tokens}
              query={filters.query}
              onSelect={handleSelect}
              onToggleFavourite={toggleFavourite}
              onResetFilters={reset}
              onClearSearch={() => setQuery("")}
              filtered={filtered}
              className="h-full"
            />
          </ResizablePanel>

          {showMapPanel && (
            <>
              {/* A wider grab area than the 1px line it draws — a hairline is a
                  target nobody hits on the first try. */}
              <ResizableHandle
                className="mx-1.5 w-px bg-transparent after:w-4 hover:bg-primary/40 focus-visible:bg-primary/60 data-[dragging]:bg-primary/60"
                aria-label="Resize the map"
              />
              <ResizablePanel
                id={MAP_PANEL_ID}
                minSize={map.minWidth}
                maxSize={map.maxWidth}
                className="min-w-0"
              >
                <BranchMapSurface
                  branches={results}
                  selected={selected}
                  onSelect={handleSelect}
                  className="h-full"
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}

      {/* Mobile map. A full-height sheet rather than a squeezed split — half a
          phone screen of map is neither a usable map nor a usable list. */}
      <Sheet open={mobileMapOpen} onOpenChange={setMobileMapOpen}>
        <SheetContent side="bottom" className="h-[85dvh] p-0 lg:hidden">
          <SheetHeader className="border-b border-border/60 px-4 py-3">
            <SheetTitle className="text-base">
              Branch map
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {results.length} {results.length === 1 ? "branch" : "branches"}
              </span>
            </SheetTitle>
          </SheetHeader>
          <BranchMapSurface
            branches={results}
            selected={selected}
            onSelect={handleSelect}
            className={cn("h-[calc(85dvh-4rem)] rounded-none border-0")}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
