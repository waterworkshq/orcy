import fs from "node:fs";
import path from "node:path";

/**
 * Atomically write a string to `targetPath`: mkdir → write temp → fsync temp →
 * rename → best-effort parent-dir fsync. The temp file lives in the SAME directory
 * as the target so the rename is atomic on POSIX. On any failure the temp file is
 * cleaned up and the error rethrown — the target path never holds a partial write.
 *
 * Mode defaults to 0o600 (owner read/write only) for sensitive install state.
 */
export function atomicWriteJson(targetPath: string, data: string, mode: number = 0o600): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = targetPath + ".tmp";
  try {
    fs.writeFileSync(tmp, data, { mode });
    // fsync the temp file's data so the atomic rename is durable on power loss
    // (rename alone is not sufficient — the directory entry may persist while
    // the file contents are still in the page cache).
    const fd = fs.openSync(tmp, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist (failed before write completed) — ignore */
    }
    throw err;
  }

  // Best-effort fsync of the parent directory so the rename itself is durable on
  // power loss. Without this the directory entry update can remain in the page
  // cache while the file data is already flushed — a crash in that window loses
  // the rename. Some filesystems don't support directory fsync; ignore those.
  try {
    const dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  } catch {
    /* best-effort — directory fsync not supported on all filesystems */
  }
}
