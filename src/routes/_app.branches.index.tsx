import { ClientOnly, createFileRoute, Link } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, ShieldAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BranchEditDialog } from "@/features/branches/components/branch-edit-dialog";
import { BranchList, type BranchFocusRequest } from "@/features/branches/components/branch-list";
import { BranchLocatorPanel } from "@/features/branches/components/branch-locator-panel";
import { BranchSearchBar } from "@/features/branches/components/branch-search-bar";
import { BranchDirectoryMeta } from "@/features/branches/components/branch-stats";
import { ScrollToTop } from "@/features/branches/components/scroll-to-top";
import { StickySearchBar } from "@/features/branches/components/sticky-search-bar";
import { exportBranches } from "@/features/branches/export";
import { useBranchDirectory } from "@/features/branches/hooks/use-branch-directory";
import { useBranchFilters } from "@/features/branches/hooks/use-branch-filters";
import { useBranchLocator } from "@/features/branches/hooks/use-branch-locator";
import { useDirectoryFreshness } from "@/features/branches/hooks/use-directory-freshness";
import { EMPTY_FILTERS, hasActiveFilters, type BranchFilters } from "@/features/branches/search";
import type { BranchView } from "@/features/branches/types";

/**
 * The map, client-only and lazily imported.
 *
 * The Google Maps SDK is a browser-only global, so both the render *and* the
 * import have to stay off the SSR path — see the execution-model rules.
 */
const BranchMap = lazy(() => import("@/features/branches/components/branch-map"));

/** Placeholder that reserves the map's height so nothing shifts on hydration. */
const MAP_FALLBACK = (
  <div className="h-[320px] w-full animate-pulse rounded-xl border bg-muted/40 sm:h-[380px]" />
);

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

  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The card a locator result asked to be shown, and how many times it has asked.
   *
   * Separate from `selected` because the two mean different things. Selection is
   * a state the list and the locator row both read; this is an event — "scroll
   * there and flash it" — that must be able to repeat for a branch that is
   * already selected.
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
   * however the branch was reached.
   *
   * Sets rather than toggles. Clicking the already-selected card used to clear
   * it, which contradicts the rule that the highlight survives until *another*
   * branch is chosen — an agent who clicked a card twice while reading it lost
   * the border for no reason they could name.
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

  /**
   * The locator strip, watched by the sticky bar to know when it has left view.
   *
   * A ref to the element rather than a scroll threshold, because "has the locator
   * scrolled away" is a question about the locator's own height, which changes as
   * it collapses and expands. A hard pixel offset would be wrong the moment either
   * happens.
   */
  const locatorRef = useRef<HTMLDivElement | null>(null);

  /**
   * "Change search", from the sticky bar.
   *
   * Expands the locator *and* returns to it, in that order. Expanding alone would
   * reveal the panel somewhere above the current scroll position, which reads as
   * the button having done nothing.
   */
  const handleChangeSearch = useCallback(() => {
    setLocatorCollapsed(false);
    locatorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

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

  return (
    // Grows with its content, so the page owns the only vertical scrollbar.
    //
    // There is nothing else on this page that scrolls any more. The viewport lock
    // and the two-pane split are both gone with the map, which is what makes the
    // scrolling question finally trivial: one document, one scrollbar, and the
    // locator's own results list as the single deliberate exception.
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

      {/* Locator mode takes over the search strip and leaves the cards below it
          exactly where they were.

          Deliberately *not* sticky: expanded, this panel is most of a laptop
          viewport, so pinning it would permanently spend the screen space that
          collapsing exists to give back. The compact sticky bar at the bottom of
          this component is what keeps the search reachable once it scrolls away. */}
      <div ref={locatorRef}>
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
            branchQuery={locator.branchQuery}
            branchFiltered={locator.branchFiltered}
            rankedCount={locator.rankedCount}
            selected={selected}
            collapsed={locatorCollapsed}
            onQueryChange={locator.setQuery}
            onCityChange={locator.setCity}
            onSearch={locator.search}
            onBranchQueryChange={locator.setBranchQuery}
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

      {/* The filtered rows on a map. Markers follow `results`, so every filter
          and the locator's own selection are reflected here without any second
          source of branch data. */}
      {!error && (
        <ClientOnly fallback={MAP_FALLBACK}>
          <Suspense fallback={MAP_FALLBACK}>
            <BranchMap branches={results} selected={selected} onSelect={handleFocusBranch} />
          </Suspense>
        </ClientOnly>
      )}

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load branches: {error.message}
        </div>
      ) : (
        /*
         * The cards, full width and in page flow.
         *
         * What used to be here was a resizable two-pane split whose library styled
         * both the group and each panel for a fixed-height world — `overflow:
         * hidden` on one, `overflow: auto; max-height: 100%` on the other — and
         * those were the nested scroll ports that made the page feel stuck. All of
         * it goes with the map. The grid's column count is measured from the
         * element's own width (`useColumnCount`), so reclaiming the map's third of
         * the screen widens the cards with no layout code at all: the same viewport
         * that fitted two columns beside a map now fits three or four.
         */
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
      )}

      {/* Appears once the locator has scrolled away, so the search an agent just
          ran stays one click away without pinning the full panel. */}
      <StickySearchBar
        active={locator.active}
        query={locator.query}
        city={locator.city}
        cities={locator.cities}
        searching={locator.searching}
        selected={selected}
        anchorRef={locatorRef}
        onQueryChange={locator.setQuery}
        onCityChange={locator.setCity}
        onSearch={locator.search}
        onChangeSearch={handleChangeSearch}
      />

      <ScrollToTop />

      {/* Owner, Admin and Supervisor — the same `admin_access` the server
          function checks, so the button is never offered to someone the write
          would refuse. */}
      <BranchEditDialog branch={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
