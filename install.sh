#!/bin/sh
# install.sh — bootstrapper for orcy
# Usage: curl -fsSL https://raw.githubusercontent.com/waterworkshq/orcy/main/install.sh | bash
# Or:    sh install.sh [options]
#
# Downloads the source from GitHub main branch, builds it, and runs the installer.

set -e

ORCY_HOME="${HOME}/.orcy"
SRC_DIR="${ORCY_HOME}/src/orcy"
CACHE_DIR="${ORCY_HOME}/cache"
REPO_URL="https://github.com/waterworkshq/orcy"
ARCHIVE_URL="${REPO_URL}/archive/refs/heads/main.tar.gz"

echo "==> orcy installer"

# Check Node (keep in sync with root package.json engines.node: Node 24 LTS and 26 Current)
NODE_VERSION=$(node --version 2>/dev/null || echo "")
if [ -z "$NODE_VERSION" ]; then
  echo "Node.js not found. Orcy supports Node.js 24 (LTS) and 26 (Current): https://nodejs.org"
  exit 1
fi
NODE_MAJOR=""
case "$NODE_VERSION" in
  *'
'*) ;;
  *) NODE_MAJOR=$(printf '%s\n' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\)\.[0-9][0-9]*\.[0-9][0-9]*$/\1/p') ;;
esac
case "$NODE_MAJOR" in
  24|26) ;;
  *)
    echo "Unsupported Node.js version: $NODE_VERSION. Orcy supports Node.js 24 (LTS) and 26 (Current)."
    exit 1
    ;;
esac
echo "    Node $NODE_VERSION found"

# One installer run at a time per ORCY_HOME: two would race on the source tree,
# the staged installer, its promotion and the tree the wizard rebuilds. The lock
# is a directory, because creating it is atomic: whoever creates it runs, and
# it holds that run's PID. It is kept until the installer has exited — on
# success, failure, Ctrl-C or a termination request. A lock that is already
# there stops this run before it touches anything. It is never taken over
# automatically: a run cannot tell a dead owner's lock from a live one's, and
# removing the wrong one would let two runs through. One left by a run that
# was killed outright is removed by hand; the message below says which.
LOCK_DIR="${ORCY_HOME}/bootstrap.lock"
INSTALLER_DIR="${ORCY_HOME}/installer"
BACKUP_DIR="${INSTALLER_DIR}.old"
release_lock() {
  # Only this run's lock: the directory has to hold this process's PID, and it
  # is removed only once that marker is gone from it — so a lock another run
  # has taken since is left alone.
  [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ] || return 0
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
mkdir -p "$ORCY_HOME"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another orcy installer run may be in progress for this user: $LOCK_DIR already exists."
  echo "If no installer is running, that lock was left by an interrupted run."
  echo "Remove $LOCK_DIR and run this again."
  exit 1
fi
echo $$ > "$LOCK_DIR/pid"
trap release_lock EXIT
# An interruption before the handoff ends this run with the signal's own exit
# status, once the step running in the foreground has exited (POSIX defers the
# trap until then), so it never looks like a successful install.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# A run interrupted while promoting the installer leaves no active installer
# and the previous one moved aside. Put it back before anything fallible
# happens, so a failure further down never costs the machine its installer.
if [ ! -e "$INSTALLER_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  if ! mv "$BACKUP_DIR" "$INSTALLER_DIR"; then
    echo "Could not restore the previous installer from $BACKUP_DIR."
    exit 1
  fi
fi

# Download source
echo "==> Downloading source from GitHub..."
mkdir -p "$CACHE_DIR" "$SRC_DIR"
ARCHIVE_PATH="${CACHE_DIR}/orcy.tar.gz"

curl -fSL "$ARCHIVE_URL" -o "${ARCHIVE_PATH}.tmp" 2>/dev/null || {
  echo "Failed to download source from GitHub."
  echo "Check your internet connection and try again."
  exit 1
}
mv "${ARCHIVE_PATH}.tmp" "$ARCHIVE_PATH"
echo "    Downloaded"

# Extract
echo "==> Extracting source..."
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$SRC_DIR" --strip-components=1
echo "    Extracted to ${SRC_DIR}"

# Resolve the exact pnpm version pinned by the extracted source. Anything other
# than a strict pnpm@<version> pin (optional corepack hash suffix) fails closed.
PNPM_VERSION=$(node -e '
const fs = require("fs");
let spec;
try { spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packageManager; } catch {}
const m = typeof spec === "string" ? spec.match(/^pnpm@(\d+\.\d+\.\d+)(\+[A-Za-z0-9._-]+)?$/) : null;
if (!m) {
  console.error("install.sh: source packageManager field must pin an exact pnpm version (e.g. pnpm@9.0.0), got: " + String(spec));
  process.exit(1);
}
console.log(m[1]);
' "$SRC_DIR/package.json")
echo "    Source pins pnpm@${PNPM_VERSION}"

# Pin-aware pnpm dispatch: prefer corepack (bundled with Node.js), fall back to
# an ephemeral npx run of the same pin. No global pnpm is installed or mutated.
PNPM_RUNNER=""
run_pnpm() {
  if [ "$PNPM_RUNNER" = "corepack" ]; then
    corepack "pnpm@${PNPM_VERSION}" "$@"
  else
    npx --yes "pnpm@${PNPM_VERSION}" "$@"
  fi
}

if corepack "pnpm@${PNPM_VERSION}" --version >/dev/null 2>&1; then
  PNPM_RUNNER="corepack"
  echo "    Running pnpm@${PNPM_VERSION} via corepack"
elif npx --yes "pnpm@${PNPM_VERSION}" --version >/dev/null 2>&1; then
  PNPM_RUNNER="npx"
  echo "    Running pnpm@${PNPM_VERSION} via npx"
else
  echo "Unable to run the pinned pnpm (pnpm@${PNPM_VERSION}) via corepack or npx."
  echo "Install corepack (bundled with Node.js) or npm, then retry."
  exit 1
fi

# Install dependencies
echo "==> Installing dependencies..."
(cd "$SRC_DIR" && { run_pnpm install --frozen-lockfile 2>/dev/null || run_pnpm install; })
echo "    Dependencies installed"

# Build
echo "==> Building packages..."
(cd "$SRC_DIR" && run_pnpm -r build)
echo "    Build complete"

# Stage the installer
# The installer runs from ~/.orcy/installer, outside the workspace it was built
# in, so the copy cannot resolve the workspace's node_modules. `pnpm deploy`
# copies the built package together with a self-contained production
# node_modules resolved from the workspace lockfile: the exact versions that
# were just built, workspace packages included as real copies — not a fresh
# registry resolution of version ranges. Deploy requires the workspace to use
# injected workspace packages; passing the setting here leaves the source tree
# as it is. The copy is deployed beside any previous installer and takes its
# place only once its entry point exists, and the previous one is deleted only
# after that, so a failed run leaves a working installer in place.
echo "==> Preparing installer..."
STAGED_DIR="${INSTALLER_DIR}.new"
rm -rf "${STAGED_DIR}"
(cd "$SRC_DIR" && run_pnpm --filter ./packages/installer deploy --prod --config.inject-workspace-packages=true "${STAGED_DIR}") || {
  rm -rf "${STAGED_DIR}"
  echo "Failed to prepare the installer."
  exit 1
}
if [ ! -f "${STAGED_DIR}/dist/index.js" ]; then
  rm -rf "${STAGED_DIR}"
  echo "Failed to stage the installer: was packages/installer/dist built?"
  exit 1
fi
# Promotion: the previous installer is moved aside, the staged copy is put in
# its place, and the previous one is deleted only after that succeeded.
if [ -d "${INSTALLER_DIR}" ]; then
  # A backup can only be stale here: the active installer is present. It has to
  # go before the active installer can take its place — if it will not, stop
  # with the working installer untouched rather than replace it without a way back.
  if ! rm -rf "${BACKUP_DIR}" 2>/dev/null || [ -e "${BACKUP_DIR}" ]; then
    rm -rf "${STAGED_DIR}"
    echo "Could not remove the previous installer's backup at ${BACKUP_DIR}."
    echo "The current installer was left untouched. Remove ${BACKUP_DIR} and run this again."
    exit 1
  fi
  mv "${INSTALLER_DIR}" "${BACKUP_DIR}"
fi
if ! mv "${STAGED_DIR}" "${INSTALLER_DIR}"; then
  echo "Failed to put the new installer in place."
  # Put the previous installer back; if even that fails, say where it is kept.
  if [ -d "${BACKUP_DIR}" ] && ! mv "${BACKUP_DIR}" "${INSTALLER_DIR}"; then
    echo "The previous installer is kept at ${BACKUP_DIR}."
  fi
  exit 1
fi
# The new installer is active: not managing to delete the old one must not
# keep it from running.
rm -rf "${BACKUP_DIR}" 2>/dev/null ||
  echo "    Note: the previous installer is kept at ${BACKUP_DIR} and can be deleted."

# The supervisor below runs the installer as a child in this process's place.
# - On SIGINT, SIGTERM or SIGHUP it stops the install: first every process below
#   the installer (its builds run as child processes), then the installer itself.
# - It releases the lock on its own exit — after the installer has exited — and
#   only the lock this process created: the directory must still hold this
#   process's PID, and it goes only once that marker is gone from it.
# - It exits with the installer's status, or 128 + the signal number for a
#   cancelled run — never 0 for one.
SUPERVISOR='
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { signals } = require("node:os").constants;
const [entry, ...args] = process.argv.slice(1);
const lock = process.env.ORCY_INSTALLER_LOCK;
const marker = lock + "/pid";
process.on("exit", () => {
  try {
    if (fs.readFileSync(marker, "utf8").trim() !== String(process.pid)) return;
    fs.unlinkSync(marker);
    fs.rmdirSync(lock);
  } catch {}
});
const installer = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
let cancelled = 0;
// Everything below a process, deepest first, from one `ps` listing. Zombies are
// left out: a stopped parent cannot reap them.
const below = (pid) => {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,stat="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, , state]) => state[0] !== "Z");
  const out = [];
  const walk = (parent) => {
    for (const [child, ppid] of rows) {
      if (ppid === parent) {
        walk(child);
        out.push(Number(child));
      }
    }
  };
  walk(String(pid));
  return out;
};
const stop = () => {
  // The installer runs its builds through blocking child processes. Stopping it
  // alone would leave them working in the shared source tree after the lock is
  // gone, so the whole tree below it is stopped first. A child dying makes the
  // installer exit or start another step, but that lands on this event loop,
  // which this function holds until the tree is gone.
  try {
    for (let pass = 0; pass < 10; pass++) {
      const kids = below(installer.pid);
      if (!kids.length) break;
      for (const pid of kids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  } catch {}
  installer.kill("SIGKILL");
};
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(name, () => {
    cancelled ||= signals[name];
    stop();
  });
}
installer.on("exit", (code, signal) => {
  const status = code ?? 128 + (signals[signal] ?? 0);
  process.exit(cancelled ? 128 + cancelled : status);
});
'

# Run installer. A small supervisor takes this process's place, so that a
# signal sent to it reaches the installer, the lock is released only once the
# installer has exited, and a cancelled run never reports success. The
# installer runs in the same process group, so it keeps the terminal. The EXIT
# trap stays armed for the one case the supervisor never starts — a failed
# `exec` — and does not run when the exec succeeds.
echo "==> Running installer..."
# `curl … | bash` leaves the installer a drained pipe as stdin, so the
# interactive wizard would read end-of-input at its first question and exit.
# When a terminal is available, hand the installer that instead.
if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
  ORCY_INSTALLER_LOCK="$LOCK_DIR" exec node -e "$SUPERVISOR" "${INSTALLER_DIR}/dist/index.js" "$@" < /dev/tty
fi
ORCY_INSTALLER_LOCK="$LOCK_DIR" exec node -e "$SUPERVISOR" "${INSTALLER_DIR}/dist/index.js" "$@"
