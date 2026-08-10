import fs from "node:fs";
import path from "node:path";

/**
 * Atomically write a string to `targetPath`: mkdir → write temp → fsync temp →
 * rename → best-effort parent-dir fsync. The temp file lives in the SAME directory
 * as the target so the rename is atomic on POSIX. On any failure the temp file is
 * cleaned up and the error rethrown — the target path never holds a partial write.
 *
 * Mode defaults to 0o600 (owner read/write only) for sensitive install state.
 *
 * T3.2: a per-write unique temp name guarantees `mode` is applied (writeFileSync's
 * mode only takes effect on file CREATION — a stale `.tmp` left by a prior crash
 * would otherwise inherit its old, possibly-looser mode). All fds are closed in a
 * `finally` so an fsync throw can't leak them.
 *
 * T3.1: the parent-dir fsync swallows only "not supported on this FS" errno codes
 * (EINVAL/ENOSYS/ENOTSUP); a real durability error (e.g. EIO) propagates so the
 * caller (commitJournal) does NOT delete the journal over a non-durable rename.
 */
export function atomicWriteJson(targetPath: string, data: string, mode: number = 0o600): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  // Per-write unique temp: a stale .tmp from a prior crash can't be overwritten
  // in place. The mode is FORCED via fchmod below (writeFileSync's `mode` only
  // applies on creation — a pre-existing same-named temp would inherit its mode).
  const tmp = `${targetPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, data);
    // Open the temp, force the mode (fchmod), then fsync its data before rename.
    // finally-close the fd so an fsync/fchmod throw can't leak it.
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, "r");
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* close best-effort */
        }
      }
    }
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist — ignore */
    }
    throw err;
  }

  // Best-effort parent-dir fsync so the rename's directory-entry update is
  // durable. Swallow only "not supported on this FS"; propagate a real I/O
  // error so a caller (commitJournal) doesn't treat a non-durable rename as
  // committed. fd is closed in a finally.
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOSYS" && code !== "ENOTSUP") {
      throw err; // real durability error — don't claim success
    }
    // else: dir fsync not supported on this FS — acceptable, file data IS durable
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* close best-effort */
      }
    }
  }
}
