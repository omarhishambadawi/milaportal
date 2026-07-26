import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  Download,
  Map as MapIcon,
  MapPin,
  PanelRightClose,
  PhoneOutgoing,
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { copyText } from "@/features/branches/clipboard";
import { BranchFilterBar } from "@/features/branches/components/branch-filter-bar";
import { BranchList } from "@/features/branches/components/branch-list";
import { BranchMapSurface } from "@/features/branches/components/branch-map-surface";
import { BranchStatsRow } from "@/features/branches/components/branch-stats";
import {
  MAX_MAP_WAYPOINTS,
  allContactNumbers,
  exportBranches,
  multiStopMapUrl,
} from "@/features/branches/export";
import { useBranchDirectory } from "@/features/branches/hooks/use-branch-directory";
import { useBranchFilters } from "@/features/branches/hooks/use-branch-filters";
import { hasActiveFilters } from "@/features/branches/search";

export const Route = createFileRoute("/_app/branches/")({
  head: () => ({ meta: [{ title: "Branch Directory — MilaServ Portal" }] }),
  component: BranchDirectory,
});

const MAP_PREF_KEY = "milaserv.branches.map";

function BranchDirectory() {
  const { branches, isLoading, error, canView, canManage, canExport } = useBranchDirectory();
  const {
    filters,
    results,
    stats,
    cities,
    dutyHours,
    favourites,
    toggleFavourite,
    recent,
    rememberSearch,
    clearRecent,
    setQuery,
    toggleCity,
    toggleScooter,
    toggleDutyHours,
    toggleFavouritesOnly,
    reset,
  } = useBranchFilters(branches);

  const [selected, setSelected] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [mobileMapOpen, setMobileMapOpen] = useState(false);

  // Hydrated after mount rather than in the initial state, so the server-rendered
  // markup does not depend on a value only the browser has.
  useEffect(() => {
    try {
      if (localStorage.getItem(MAP_PREF_KEY) === "0") setShowMap(false);
    } catch {}
  }, []);

  const toggleMap = useCallback(() => {
    setShowMap((current) => {
      const next = !current;
      try {
        localStorage.setItem(MAP_PREF_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const handleSelect = useCallback((branchNo: string | null) => {
    setSelected((current) => (current === branchNo ? null : branchNo));
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

  const copyAllNumbers = () => {
    const text = allContactNumbers(results);
    if (!text) {
      toast.error("None of the matching branches has a phone number on file.");
      return;
    }
    copyText(text, `${results.length} contact numbers`);
  };

  const openAllOnMap = () => {
    const url = multiStopMapUrl(results);
    if (!url) {
      toast.error("None of the matching branches has coordinates.");
      return;
    }
    if (results.length > MAX_MAP_WAYPOINTS) {
      toast.info(`Opening the first ${MAX_MAP_WAYPOINTS} branches`, {
        description: "Google Maps accepts a limited number of stops in one route.",
      });
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    // Sized to the viewport rather than growing with content: the search box and
    // the filter chips have to stay put while results scroll beneath them, and a
    // page that scrolls as a whole cannot do that without the chips eating a
    // third of a phone screen on every scroll.
    <div className="flex flex-col gap-3 h-[calc(100dvh-5.5rem)] sm:gap-4 sm:h-[calc(100dvh-6rem)] lg:h-[calc(100dvh-7rem)]">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Branch Directory</h1>
          <p className="text-xs text-muted-foreground sm:text-sm">
            {isLoading
              ? "Loading branches…"
              : filtered
                ? `${results.length} of ${branches.length} branches match`
                : `${branches.length} branches across ${stats.cities} cities`}
          </p>
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
            onClick={toggleMap}
            aria-pressed={showMap}
          >
            {showMap ? <PanelRightClose className="h-4 w-4" /> : <MapIcon className="h-4 w-4" />}
            {showMap ? "Hide map" : "Show map"}
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
              <DropdownMenuItem onClick={copyAllNumbers}>
                <PhoneOutgoing className="h-4 w-4" />
                Copy all contact numbers
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openAllOnMap}>
                <MapPin className="h-4 w-4" />
                Open on Google Maps
              </DropdownMenuItem>
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
        <BranchStatsRow stats={stats} loading={isLoading} />
      </div>

      <div className="shrink-0">
        <BranchFilterBar
          filters={filters}
          resultCount={results.length}
          totalCount={branches.length}
          cities={cities}
          dutyHours={dutyHours}
          favouriteCount={favourites.size}
          recent={recent}
          onQueryChange={setQuery}
          onCommitQuery={rememberSearch}
          onClearRecent={clearRecent}
          onToggleCity={toggleCity}
          onToggleScooter={toggleScooter}
          onToggleDutyHours={toggleDutyHours}
          onToggleFavourites={toggleFavouritesOnly}
          onReset={reset}
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
        <div className="flex min-h-0 flex-1 gap-4">
          <BranchList
            branches={results}
            loading={isLoading}
            selected={selected}
            favourites={favourites}
            onSelect={handleSelect}
            onToggleFavourite={toggleFavourite}
            onResetFilters={reset}
            filtered={filtered}
            className={cn("min-w-0 flex-1", showMap && "lg:max-w-[54%]")}
          />

          {showMap && (
            <BranchMapSurface
              branches={results}
              selected={selected}
              onSelect={handleSelect}
              className="hidden flex-1 lg:block"
            />
          )}
        </div>
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
            className="h-[calc(85dvh-4rem)] rounded-none border-0"
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
