import { toast } from "sonner";
import { TEMPLATE_COLUMNS } from "./constants";
import type { BranchView } from "./types";

/**
 * Export the branches currently on screen.
 *
 * Deliberately written in the *template's* column order and with the template's
 * headers, so an export is a valid import. That closes the loop an operations
 * team actually needs: filter to one city, export, correct the rows in Excel,
 * upload again in "Update Existing" mode. An export with prettier column names
 * would look better and be useless for that.
 */
export async function exportBranches(
  branches: BranchView[],
  context: { filtered: boolean },
): Promise<void> {
  if (branches.length === 0) {
    toast.error("Nothing to export — no branches match the current filters.");
    return;
  }

  const XLSX = await import("xlsx");
  const headers = TEMPLATE_COLUMNS.map((column) => column.header);

  const rows = branches.map((branch) => ({
    "Branch Code": branch.branch_no,
    // The E.164 form rather than the spaced display form: a spaced number
    // re-imports fine, but pasting it into a dialler does not.
    "Phone No": branch.phoneE164 ?? branch.phone ?? "",
    City: branch.city,
    Scooter: branch.scooter_note ?? (branch.scooter ? "سكوتر" : "N/A"),
    "Area Manager": branch.area_manager ?? "",
    "Area Manager Contact Number": branch.managerPhoneE164 ?? branch.area_manager_phone ?? "",
    Email: branch.email ?? "",
    Address: branch.address ?? "",
    Location: branch.maps_url ?? branch.mapsLink ?? "",
    Latitude: branch.latitude ?? "",
    Longitude: branch.longitude ?? "",
    "Duty Hours": branch.duty_hours ?? "",
    "Start - End": branch.working_hours ?? "",
    "Friday Duty": branch.friday_hours ?? "",
  }));

  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  sheet["!cols"] = TEMPLATE_COLUMNS.map((column) => ({ wch: column.width }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Branches");

  const stamp = new Date().toISOString().slice(0, 10);
  const scope = context.filtered ? "filtered" : "all";
  XLSX.writeFile(workbook, `branch-directory_${scope}_${stamp}.xlsx`);
  toast.success(`Exported ${rows.length} ${rows.length === 1 ? "branch" : "branches"}`);
}

/** Every phone number on screen, one per line, for a bulk paste. */
export function allContactNumbers(branches: BranchView[]): string {
  const lines: string[] = [];
  for (const branch of branches) {
    const number = branch.phoneE164 ?? branch.phoneDisplay;
    if (number) lines.push(`${branch.branch_no}\t${number}`);
  }
  return lines.join("\n");
}

/**
 * A Google Maps directions URL through every branch on screen.
 *
 * Capped, because the "open all filtered branches on the map" request runs into
 * a hard limit: Google Maps accepts an origin, a destination and a handful of
 * waypoints, and a URL naming 145 branches is silently truncated rather than
 * rejected. Ten is comfortably inside what the endpoint honours, and the caller
 * warns when the filter holds more.
 */
export const MAX_MAP_WAYPOINTS = 10;

export function multiStopMapUrl(branches: BranchView[]): string | null {
  const points = branches
    .filter((branch) => branch.hasCoords)
    .slice(0, MAX_MAP_WAYPOINTS)
    .map((branch) => `${branch.latitude},${branch.longitude}`);
  if (points.length === 0) return null;
  if (points.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${points[0]}`;
  }
  const origin = points[0];
  const destination = points[points.length - 1];
  const waypoints = points.slice(1, -1);
  const params = new URLSearchParams({ api: "1", origin, destination });
  if (waypoints.length > 0) params.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
