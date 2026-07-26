import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  branchImportApply,
  branchImportHistory,
  branchImportRollback,
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

export function useBranchImport() {
  const queryClient = useQueryClient();
  const applyFn = useServerFn(branchImportApply);
  const historyFn = useServerFn(branchImportHistory);
  const rollbackFn = useServerFn(branchImportRollback);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [importOptions, setImportOptions] = useState<ImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [parsing, setParsing] = useState(false);
  /** Kept so changing the duplicate policy re-parses without a second upload. */
  const [lastFile, setLastFile] = useState<File | null>(null);

  const history = useQuery({
    queryKey: queryKeys.branches.imports(HISTORY_LIMIT),
    queryFn: () => historyFn({ data: { limit: HISTORY_LIMIT } }) as Promise<ImportHistoryEntry[]>,
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
      // One invalidation sweeps the directory AND the history list, because both
      // are nested under the `branches` root.
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
  };
}
