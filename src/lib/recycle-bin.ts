import { supabase } from "@/integrations/supabase/client";

export const RECYCLE_BIN_RETENTION_DAYS = 30;

type PurgeResult = {
  purged: number;
  skipped: number;
  files: { bucket: string; path: string }[];
};

// Permanently removes Recycle Bin entries older than 30 days
// (purge_recycle_bin() in 20260930090000_recycle_bin_and_customer_delete.sql).
// There's no scheduled-job mechanism in this project, so this runs whenever
// an admin opens the app or the Recycle Bin tab. SQL can't delete Storage
// objects, so the purged records' files are removed here.
export async function purgeRecycleBin(): Promise<PurgeResult> {
  const { data, error } = await supabase.rpc("purge_recycle_bin" as any);
  if (error) throw error;
  const result = data as PurgeResult;
  const byBucket = new Map<string, string[]>();
  for (const f of result.files ?? []) {
    if (!f?.bucket || !f?.path) continue;
    byBucket.set(f.bucket, [...(byBucket.get(f.bucket) ?? []), f.path]);
  }
  for (const [bucket, paths] of byBucket) {
    try {
      await supabase.storage.from(bucket).remove(paths);
    } catch {
      // Non-fatal: the records are gone either way.
    }
  }
  return result;
}
