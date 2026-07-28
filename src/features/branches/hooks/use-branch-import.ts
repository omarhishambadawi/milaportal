import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  branchImportApply,
  branchImportHistory,
  branchImportLastFile,
  branchImportLastFileMeta,
  branchImportRollback,
  type LastImportFileMeta,
} from "@/lib/branches.functions";
import { queryKeys } from "@/lib/query-keys";
import { parseWorkbookFile, summarize } from "../import-parse";
import {
  DEFAULT_IMPORT_OPTIONS,
  type FacilityDuplicateStrategy,
  type ImportHistoryEntry,
  type ImportMode,
  type ImportOptions,
  type ImportPreview,
} from "../types";

const HISTORY_LIMIT = 20;

/** Extensions the file picker and the drop handler accept. */
export const ACCEPTED_EXTENSIONS = [".xlsx", ".xlsm", ".xls", ".csv"];

/**
 * The uploaded workbook as base64, for storing alongside the import.
 *
 * Chunked rather than `String.fromCharCode(...bytes)`, which spreads the whole
 * array into one call and blows the argument limit somewhere around a hundred
 * thousand bytes — a real branch sheet is comfortably past that.
 */
async function encodeFile(file: File): Promise<{ base64: string; type: string; size: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return {
    base64: btoa(binary),
    type: file.type || "application/octet-stream",
    size: file.size,
  };
}

/** Hand a base64 payload to the browser as a download. */
function saveBase64(base64: string, type: string, fileName: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick rather than immediately: Safari cancels an
  // in-flight download when the object URL disappears in the same frame.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useBranchImport() {
  const queryClient = useQueryClient();
  const applyFn = useServerFn(branchImportApply);
  const historyFn = useServerFn(branchImportHistory);
  const rollbackFn = useServerFn(branchImportRollback);
  const lastFileMetaFn = useServerFn(branchImportLastFileMeta);
  const lastFileFn = useServerFn(branchImportLastFile);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [importOptions, setImportOptions] = useState<ImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [parsing, setParsing] = useState(false);
  /** Kept so changing the duplicate policy re-parses without a second upload. */
  const [lastFile, setLastFile] = useState<File | null>(null);
  /**
   * The same file as base64, encoded once when it is read rather than inside the
   * apply mutation — the mutation is what a "Import" click waits on, and reading
   * a few megabytes off disk is not something to do while somebody watches a
   * spinner. Null when encoding failed, which must not block an import.
   */
  const [encoded, setEncoded] = useState<{
    base64: string;
    type: string;
    size: number;
  } | null>(null);

  const history = useQuery({
    queryKey: queryKeys.branches.imports(HISTORY_LIMIT),
    queryFn: () => historyFn({ data: { limit: HISTORY_LIMIT } }) as Promise<ImportHistoryEntry[]>,
  });

  // Metadata only. The file itself is fetched when the button is pressed, so
  // opening this page does not pull a spreadsheet nobody asked for.
  const lastUpload = useQuery({
    queryKey: queryKeys.branches.lastImportFile(),
    queryFn: () => lastFileMetaFn({}) as Promise<LastImportFileMeta | null>,
  });

  const downloadLastUpload = useMutation({
    mutationFn: () => lastFileFn({}) as Promise<{ fileName: string; type: string; base64: string }>,
    onSuccess: (file) => saveBase64(file.base64, file.type, file.fileName),
    onError: (e: Error) =>
      toast.error("Could not download the last upload", { description: e.message }),
  });

  const readFile = useCallback(
    async (file: File, options: ImportOptions = importOptions) => {
      const name = file.name.toLowerCase();
      if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
        toast.error("Unsupported file", {
          description: `Upload one of ${ACCEPTED_EXTENSIONS.join(", ")}.`,
        });
        return;
      }
      setParsing(true);
      try {
        const result = await parseWorkbookFile(file, options);
        setPreview(result);
        setLastFile(file);
        setEncoded(await encodeFile(file).catch(() => null));
        const counts = summarize(result);
        if (counts.valid === 0) {
          toast.error("Nothing in that file can be imported", {
            description: "Every row was rejected — see the issues below.",
          });
        } else if (counts.critical > 0) {
          toast.warning(`${counts.valid} rows ready, ${counts.rejected} rejected`);
        } else {
          toast.success(`${counts.valid} rows ready to import`);
        }
      } catch (e) {
        toast.error("Could not read that file", {
          description: e instanceof Error ? e.message : String(e),
        });
        setPreview(null);
      } finally {
        setParsing(false);
      }
    },
    [importOptions],
  );

  /**
   * Change how duplicates are handled and re-run the validation.
   *
   * Re-parsing the file already in hand, rather than asking for it again: the
   * duplicate policy is exactly the setting an operator wants to try both ways
   * after seeing the preview, and making that cost a second upload would push
   * them to accept whichever default they got.
   */
  const setDuplicateStrategy = useCallback(
    (facilityDuplicates: FacilityDuplicateStrategy) => {
      const next = { ...importOptions, facilityDuplicates };
      setImportOptions(next);
      if (lastFile) void readFile(lastFile, next);
    },
    [importOptions, lastFile, readFile],
  );

  const clear = useCallback(() => {
    setPreview(null);
    setLastFile(null);
    setEncoded(null);
  }, []);

  const apply = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("No file loaded");
      // The row's Excel line number is a preview concern; it is not a column.
      const rows = preview.rows.map(({ row: _row, ...rest }) => rest);
      return applyFn({
        data: {
          mode,
          fileName: preview.fileName,
          // Kept so the next administrator can start from the file that was
          // actually uploaded rather than an export of the table, which has lost
          // the rejected rows and any columns the template does not carry.
          // Best-effort: a file that will not encode must not fail the import.
          sourceFile: encoded ?? undefined,
          rows,
          // The audit record has to carry what the file looked like, not just
          // what was written — see the migration note on validation_summary.
          validation: summarize(preview),
        },
      }) as Promise<{
        importId: string | null;
        added: number;
        updated: number;
        removed: number;
        skipped: number;
      }>;
    },
    onSuccess: (result) => {
      toast.success("Branch Directory updated", {
        description: [
          `${result.added} added`,
          `${result.updated} updated`,
          result.removed > 0 ? `${result.removed} deactivated` : null,
          result.skipped > 0 ? `${result.skipped} skipped by this mode` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
      setPreview(null);
      setEncoded(null);
      // One invalidation sweeps the directory, the history list AND the
      // last-uploaded-file metadata, because all three nest under the `branches`
      // root — so the download button starts offering the file just imported.
      queryClient.invalidateQueries({ queryKey: queryKeys.branches.all() });
    },
    onError: (e: Error) => toast.error("Import failed", { description: e.message }),
  });

  const rollback = useMutation({
    mutationFn: (importId: string) =>
      rollbackFn({ data: { importId } }) as Promise<{
        restored: number;
        deactivated: number;
      }>,
    onSuccess: (result) => {
      toast.success("Directory rolled back", {
        description: `${result.restored} branches restored${
          result.deactivated > 0 ? `, ${result.deactivated} deactivated` : ""
        }.`,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.branches.all() });
    },
    onError: (e: Error) => toast.error("Rollback failed", { description: e.message }),
  });

  return {
    preview,
    parsing,
    mode,
    setMode,
    importOptions,
    setDuplicateStrategy,
    readFile,
    clear,
    apply,
    rollback,
    history: history.data ?? [],
    historyLoading: history.isLoading,
    summary: preview ? summarize(preview) : null,
    /** Metadata for the most recent upload the directory still holds, or null. */
    lastUpload: lastUpload.data ?? null,
    downloadLastUpload,
  };
}
