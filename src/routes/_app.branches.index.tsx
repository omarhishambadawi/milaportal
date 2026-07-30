import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
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
import { BranchEditDialog } from "@/features/branches/components/branch-edit-dialog";
import { BranchList, type BranchFocusRequest } from "@/features/branches/components/branch-list";
import { BranchLocatorPanel } from "@/features/branches/components/branch-locator-panel";
import { BranchMapSurface } from "@/features/branches/components/branch-map-surface";
import { BranchSearchBar } from "@/features/branches/components/branch-search-bar";
import { BranchDirectoryMeta } from "@/features/branches/components/branch-stats";
import { exportBranches } from "@/features/branches/export";
import { useBranchDirectory } from "@/features/branches/hooks/use-branch-directory";
import { useBranchFilters } from "@/features/branches/hooks/use-branch-filters";
import { useBranchLocator } from "@/features/branches/hooks/use-branch-locator";
import { useDirectoryFreshness } from "@/features/branches/hooks/use-directory-freshness";
import { LIST_PANEL_ID, MAP_PANEL_ID, useMapPanel } from "@/features/branches/hooks/use-map-panel";
import { EMPTY_FILTERS, hasActiveFilters, type BranchFilters } from "@/features/branches/search";
import type { BranchView } from "@/features/branches/types";

export const Route = createFileRoute("/_app/branches/")({
  head: () => ({ meta: [{ title: "Branch Directory — MilaServ Portal" }] }),
  component: BranchDirectory,
});

function BranchDirectory() {
  const { branches, isLoading, error, canView, canManage, canExport, canUseActions } =
    useBranchDirectory();
  const {
    filters,
    results,
    tokens,
    stats,
    cities,
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
    toggleManager,
    toggleFavouritesOnly,
    focusBranch,
    clearFilters,
    replaceFilters,
    reset,
  } = useBranchFilters(branches);

  const locator = useBranchLocator(branches);

  const { lastUpdated } = useDirectoryFreshness(branches);
  const map = useMapPanel();

  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The card a locator result asked to be shown, and how many times it has asked.
   *
   * Separate from `selected` because the two mean different things. Selection is
   * a state the map, the list and the locator row all read; this is an event —
   * "scroll there and flash it" — that must be able to repeat for a branch that
   * is already selected.
   */
  const [focusRequest, setFocusRequest] = useState<BranchFocusRequest | null>(null);
  /**
   * Whether the locator is minimised to its summary bar.
   *
   * A separate flag from `locator.active` because the two answer different
   * questions: active is "is the agent locating a customer", collapsed is "have
   * they finished and moved on to reading the branch". Collapsing must not touch
   * the search, the city scope or the results — reopening has to show exactly
   * what was there, so the state it hides has to stay put.
   */
  const [locatorCollapsed, setLocatorCollapsed] = useState(false);
  const [mobileMapOpen, setMobileMapOpen] = useState(false);
  /** The branch whose edit dialog is open, or null. */
  const [editing, setEditing] = useState<BranchView | null>(null);

  const byCode = useMemo(
    () => new Map(branches.map((branch) => [branch.branch_no, branch])),
    [branches],
  );

  /**
   * Opening a card is what counts as "viewing" a branch.
   *
   * Recorded here rather than in the card so it happens once per selection,
   * whether the branch was clicked in the list or picked off the map.
   *
   * Sets rather than toggles. Clicking the already-selected card used to clear
   * it, which contradicts the rule that the highlight survives until *another*
   * branch is chosen — an agent who clicked a card twice while reading it lost
   * the border and the map pin for no reason they could name. Passing `null`
   * still clears, which is how a click on empty map space deselects.
   */
  const handleSelect = useCallback(
    (branchNo: string | null) => {
      setSelected(branchNo);
      if (branchNo) rememberBranch(branchNo);
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

  /**
   * Picking a locator result.
   *
   * Sets rather than toggles, unlike `handleSelect`: a result row is a
   * destination, and clicking the one already showing should keep showing it
   * rather than clear the highlight the agent just asked for.
   *
   * Two things are set, not one. `selected` is the state the map pin, the card
   * ring and the locator row all share — that is the synchronization, and it is
   * the directory's existing behaviour rather than anything the locator does
   * itself. `focusRequest` is the accompanying event: scroll to the card and
   * flash it. The nonce increments on every click, including a repeat click on
   * the same row, so "show me that one again" is always answered.
   */
  const handleLocatorSelect = useCallback(
    (branchNo: string) => {
      setSelected(branchNo);
      setFocusRequest((current) => ({ branchNo, nonce: (current?.nonce ?? 0) + 1 }));
      rememberBranch(branchNo);
      // The locator has done its job. Collapsing it to a one-line summary hands
      // the screen back to the card the agent is now reading, without discarding
      // the search that found it — see `locatorCollapsed`.
      setLocatorCollapsed(true);
    },
    [rememberBranch],
  );

  /**
   * Whatever the directory was narrowed to before locator mode took over.
   *
   * Parked rather than discarded: an agent who had filtered to Jeddah, took a
   * call, located a customer and closed the locator expects Jeddah back. Held in
   * a ref because restoring it is an event, not something any render reads.
   */
  const parkedFilters = useRef<BranchFilters | null>(null);
  const { open: openLocatorMode, close: closeLocatorMode } = locator;

  /*
   * Opening and closing the locator no longer clears the selection.
   *
   * They both used to, and it was wrong in the same way: the branch an agent
   * picked is the answer to the call they are still on, and reaching for the
   * locator again — or shutting it because they were done with it — is not them
   * saying "forget which branch". Only choosing a different branch does that.
   */
  const openLocator = useCallback(() => {
    parkedFilters.current = filters;
    // Cleared for the duration: a city chip left on from earlier would exclude
    // the nearest branch from the list, and a result that highlights a card
    // which is not rendered is a click that appears to do nothing.
    replaceFilters(EMPTY_FILTERS);
    setLocatorCollapsed(false);
    openLocatorMode();
  }, [filters, replaceFilters, openLocatorMode]);

  const closeLocator = useCallback(() => {
    closeLocatorMode();
    setLocatorCollapsed(false);
    replaceFilters(parkedFilters.current ?? EMPTY_FILTERS);
    parkedFilters.current = null;
  }, [closeLocatorMode, replaceFilters]);

  /** Reopen the collapsed locator with its search and city scope intact. */
  const expandLocator = useCallback(() => setLocatorCollapsed(false), []);

  const filtered = hasActiveFilters(filters);

  /**
   * Where the delivery coverage ring is centred, or null for the plain directory.
   *
   * Only in locator mode and only once an origin has resolved: a ring drawn
   * around nothing, or left behind after the locator closed, would be a claim
   * about a customer who is no longer on the phone.
   */
  const coverageCenter = locator.active ? (locator.origin?.point ?? null) : null;

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
    // Grows with its content, so the page owns the only vertical scrollbar.
    //
    // This was pinned to the viewport so the search box could stay put while
    // results scrolled beneath it. That bought a fixed header at the cost of the
    // bug this sprint is about: the cards lived in their own scroll port, so a
    // wheel gesture that reached the end of them had nowhere to go and the page
    // felt stuck. Sticky positioning gives the same fixed header without a nested
    // port, which is the trade the old comment did not have available.
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Branch Directory</h1>
          <div className="mt-0.5">
            <BranchDirectoryMeta
              stats={stats}
              loading={isLoading}
              resultCount={results.length}
              filtered={filtered}
              lastUpdated={lastUpdated}
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

          {/* Owner, Admin, Supervisor and Auditor only. See `canUseActions`. */}
          {canUseActions && (
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
          )}
        </div>
      </div>

      {/* Locator mode takes over the search strip and leaves everything below
          it — cards, map, the resizable split — exactly where it was.

          Deliberately *not* sticky. Pinning it was the obvious way to keep the
          old fixed-header feel, and it is the wrong trade here: expanded, this
          panel is most of a laptop viewport, so sticking it would permanently
          spend the screen space that collapsing to the summary bar exists to give
          back — and it would slide underneath the sticky map beside it. Scrolling
          away is what "natural" means, and the summary bar is what keeps the
          search one click away once a branch is chosen. */}
      <div>
        {locator.active ? (
          <BranchLocatorPanel
            query={locator.query}
            city={locator.city}
            cities={locator.cities}
            origin={locator.origin}
            results={locator.results}
            choices={locator.choices}
            suggestions={locator.suggestions}
            error={locator.error}
            searching={locator.searching}
            selected={selected}
            collapsed={locatorCollapsed}
            onQueryChange={locator.setQuery}
            onCityChange={locator.setCity}
            onSearch={locator.search}
            onChooseLocation={locator.chooseLocation}
            onSelect={handleLocatorSelect}
            onExpand={expandLocator}
            onClose={closeLocator}
          />
        ) : (
          <BranchSearchBar
            filters={filters}
            resultCount={results.length}
            totalCount={branches.length}
            cities={cities}
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
            onToggleManager={toggleManager}
            onToggleFavourites={toggleFavouritesOnly}
            onClearFilters={clearFilters}
            onFocusBranch={handleFocusBranch}
            onOpenLocator={openLocator}
          />
        )}
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load branches: {error.message}
        </div>
      ) : (
        /*
         * The split, in page flow rather than pinned to the viewport.
         *
         * `react-resizable-panels` styles both the group and each panel's inner
         * wrapper for a fixed-height world: the group gets `height: 100%;
         * overflow: hidden`, and every panel's inner div gets `max-height: 100%;
         * overflow: auto`. Those were the nested scroll ports — a panel whose
         * content is taller than the group scrolls *inside itself*, which is the
         * trapped wheel. Both libraries' declarations are emitted before the
         * `style` prop is spread, so passing `style` overrides them, and that is
         * the documented escape hatch rather than a hack.
         *
         * Overriding rather than dropping the library keeps drag-to-resize, which
         * is entirely a width concern and unaffected by any of this.
         */
        <ResizablePanelGroup
          key={map.layoutKey}
          defaultLayout={map.defaultLayout}
          onLayoutChanged={map.remember}
          // No `items-start`: the panels must keep the default `stretch`, so the
          // map panel's box is as tall as the list beside it. A sticky element can
          // only travel inside its containing block, so a map panel sized to its
          // own content would let the map follow for one viewport and then scroll
          // away with the box that ran out.
          style={{ height: "auto", overflow: "visible" }}
        >
          <ResizablePanel
            id={LIST_PANEL_ID}
            minSize={map.listMinWidth}
            className="min-w-0"
            style={{ overflow: "visible", maxHeight: "none" }}
          >
            <BranchList
              branches={results}
              loading={isLoading}
              selected={selected}
              focus={focusRequest}
              favourites={favourites}
              tokens={tokens}
              query={filters.query}
              canEdit={canManage}
              onSelect={handleSelect}
              onToggleFavourite={toggleFavourite}
              onEdit={setEditing}
              onResetFilters={reset}
              onClearSearch={() => setQuery("")}
              filtered={filtered}
            />
          </ResizablePanel>

          {showMapPanel && (
            <>
              {/* A wider grab area than the 1px line it draws — a hairline is a
                  target nobody hits on the first try. Sticky so the handle stays
                  alongside the map it resizes. */}
              <ResizableHandle
                className="sticky top-3 mx-1.5 h-[calc(100dvh-7rem)] w-px bg-transparent after:w-4 hover:bg-primary/40 focus-visible:bg-primary/60 data-[dragging]:bg-primary/60"
                aria-label="Resize the map"
              />
              <ResizablePanel
                id={MAP_PANEL_ID}
                minSize={map.minWidth}
                maxSize={map.maxWidth}
                className="min-w-0"
                // Overflow must stay visible here too, and for a second reason:
                // `position: sticky` is measured against the nearest scrolling
                // ancestor, so a panel wrapper with `overflow: auto` would make
                // the map stick to the panel — which never scrolls — instead of to
                // the viewport, and it would simply never move.
                style={{ overflow: "visible", maxHeight: "none" }}
              >
                <div className="sticky top-3 h-[calc(100dvh-7rem)]">
                  <BranchMapSurface
                    branches={results}
                    selected={selected}
                    onSelect={handleSelect}
                    coverageCenter={coverageCenter}
                    className="h-full"
                  />
                </div>
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
            coverageCenter={coverageCenter}
            className={cn("h-[calc(85dvh-4rem)] rounded-none border-0")}
          />
        </SheetContent>
      </Sheet>

      {/* Owner, Admin and Supervisor — the same `admin_access` the server
          function checks, so the button is never offered to someone the write
          would refuse. */}
      <BranchEditDialog branch={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
