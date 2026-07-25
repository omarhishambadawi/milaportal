import type { UserSort, UserStatusFilter } from "./types";

/** Status facet options, in the order the dropdown renders them. */
export const STATUS_FILTERS: { value: UserStatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "pending", label: "Awaiting password" },
];

export const SORT_OPTIONS: { value: UserSort; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "name", label: "Name (A–Z)" },
  { value: "role", label: "Role" },
];

/**
 * Client-side page size.
 *
 * The list arrives whole (one `adminListUsers` call), so paging here is purely a
 * rendering budget: every row carries an avatar, a dropdown menu and several
 * badges, and mounting hundreds of them at once is what made this page slow on a
 * large tenant. Filtering and the counts always run over the *entire* list, not
 * the visible page — a search that only looked at page one would be a bug, not
 * an optimisation.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

/** Matches the orders list, so typing feels the same across the app. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * How long a fetched list stays fresh.
 *
 * User administration is not a live feed: rows change when someone on this page
 * changes them, and every one of those paths invalidates the query explicitly.
 * Without this, each remount (navigating away and back) triggered a refetch that
 * re-signed every avatar server-side.
 */
export const USERS_STALE_TIME_MS = 60_000;
