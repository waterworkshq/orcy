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
# it holds that run's PID. It is kept until the installer has exited and
# nothing of the install is running — on success, failure, Ctrl-C or a
# termination request. A lock that is already
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

# The supervisor below hands the install to an anchor: a process in a session of
# its own — so its process group is the whole install — that starts the
# installer and outlives it until the run is over. Every process the installer
# starts joins that group at birth and stays in it even once its parent is
# gone. While the anchor is unreaped, the group's number is its PID alone, so
# the group is this run's to signal at any moment, the installer still running
# or not. Nothing is looked up to be signalled: /proc — or, where there is
# none, ps — is read to look, never to signal by.
# - On SIGINT, SIGTERM, SIGHUP or SIGQUIT it freezes the group, then kills it —
#   the installer and every process it started — and never reports success.
# - Ctrl-Z and resume reach this process alone, so they are passed on to the
#   install.
# - It exits once the installer has exited and nothing of the install is
#   running, and releases the lock then — only the lock this process created:
#   the directory has to hold this process's PID, and it goes only once that
#   marker is gone from it. If something of the install is still running after
#   that, the lock is kept and it says so.
# - It exits with the installer's status, or 128 + the signal number for a
#   cancelled run.
# - The installer keeps this process's stdin, stdout and stderr, and — owning
#   no terminal — reads them without being stopped as a background job, so the
#   wizard's terminal access is as before.
SUPERVISOR=$(cat <<'EOF'
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { signals } = require("node:os").constants;
const [entry, ...args] = process.argv.slice(1);
const lock = process.env.ORCY_INSTALLER_LOCK;
const marker = lock + "/pid";
// The anchor leads the install's session and process group, starts the
// installer, reports its exit through a pipe, and stays until it is killed.
const anchor = spawn(process.execPath, ["-e", `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
// A build tool may signal its whole group: the anchor has to outlive that.
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => {});
const installer = spawn(process.execPath, process.argv.slice(1), { stdio: "inherit" });
const supervisor = process.ppid;
installer.on("exit", (code, signal) => {
  try { fs.writeSync(3, JSON.stringify([code, signal]) + "\\n"); } catch {}
  // Killed outright, the supervisor can no longer end the anchor: once the
  // install has ended and no supervisor is left, it leaves by itself.
  setInterval(() => { if (process.ppid !== supervisor) process.exit(0); }, 250);
});
setInterval(() => {}, 1 << 30);
`, entry, ...args], { stdio: ["inherit", "inherit", "inherit", "pipe"], detached: true });
const group = -anchor.pid;
let active = true; // the anchor is not reaped yet, so the group is this run's to signal
let cancelled = 0;
let ended; // the installer's exit status, once the anchor has reported it
let stopping = false;
let settling = false;
let keepLock = false;
let over = false; // the install is over, and the anchor — its last process — is being killed
process.on("exit", () => {
  // Dying while the install is not over must not free the lock, and neither must a run that is not over.
  if (keepLock || (active && !over)) return;
  try {
    if (fs.readFileSync(marker, "utf8").trim() !== String(process.pid)) return;
    fs.unlinkSync(marker);
    fs.rmdirSync(lock);
  } catch {}
});
const signal = (name) => {
  if (active) { try { process.kill(group, name); } catch {} }
};
// Every process's state and process group. Read to look, never to signal by,
// and null whenever a line cannot be vouched for.
// ponytail: a process that starts a session of its own leaves the group unseen; the build tools do not.
const processes = () => {
  let pids;
  try { pids = fs.readdirSync("/proc"); } catch { return fromPs(); }
  const out = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    // Owned by another user, so not a process this run started — and where
    // /proc hides other users' entries, not this one's to read either.
    let owner;
    try { owner = fs.statSync(`/proc/${pid}`).uid; } catch { continue; }
    if (owner !== process.geteuid()) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); }
    catch (err) { if (err.code !== "ENOENT" && err.code !== "ESRCH") return null; continue; }
    // The name may hold spaces, parentheses and newlines: it ends at the last one.
    const end = stat.lastIndexOf(")");
    const [state, , pgrp] = stat.slice(end + 2).split(" ");
    if (end < 0 || state === undefined || pgrp === undefined) return null;
    out.push([state[0], pgrp, pid]);
  }
  return out;
};
// The BSDs and macOS have no /proc: there ps stands in, for looking only — and
// bound, so that a listing that hangs cannot hold the stop up.
const fromPs = () => {
  let out;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, killSignal: "SIGKILL" });
  } catch { return null; }
  return out.trim().split("\n").map((line) => {
    const [pid, pgrp, state] = line.trim().split(/\s+/);
    return pid && pgrp && state ? [state[0], pgrp, pid] : null;
  });
};
// The states of the group's live members, zombies left out. The anchor itself
// is not the install, and is not counted.
const states = () => {
  const all = processes();
  if (all === null || all.includes(null)) return null;
  return all
    .filter(([state, pgrp, pid]) => pgrp === String(-group) && state !== "Z" && pid !== String(-group))
    .map(([state]) => state);
};
// Whether anything of the install is still running. Nothing is once the group
// is gone. A group that is still there may hold nothing but zombies — processes
// that have exited and only wait to be reaped, so use no tree — which Linux
// tells from live ones. What cannot be read cannot be vouched for, and counts
// as running.
const running = () => {
  try { process.kill(group, 0); } catch (err) { return err.code !== "ESRCH"; }
  const live = states();
  return live === null || live.length > 0;
};
// Whether anything of the group can still act, that is anything but stopped. A
// stopped process cannot fork. Where /proc cannot say, nothing is held back.
const moving = () => {
  const live = states();
  return live !== null && live.some((state) => state !== "T" && state !== "t");
};
// Ends the run once nothing of it is running — the anchor included — and the
// lock is released. Something still running at the deadline keeps the lock.
const settle = (deadline) => {
  if (settling) return;
  settling = true;
  let clear = 0; // two looks in a row: one can miss a process forked while it was taken
  const look = () => {
    clear = running() ? 0 : clear + 1;
    if (clear < 2 && Date.now() <= deadline) return setTimeout(look, 20);
    over = clear >= 2;
    if (!over) {
      keepLock = true;
      console.error("A process of this install is still running, so the lock is kept: " + lock);
      console.error("Once nothing of it is running, remove " + lock + " and run this again.");
    }
    if (active) anchor.kill("SIGKILL");
    process.exit(cancelled ? 128 + cancelled : over ? ended ?? 1 : 1);
  };
  look();
};
// Stops the install. The group is frozen first: a stopped process cannot fork,
// so once nothing of it moves any more, the kill that follows reaches all of
// it — a worker forked through an earlier signal included.
const stop = () => {
  if (stopping) return;
  stopping = true;
  const deadline = Date.now() + 5000;
  const kill = () => { signal("SIGKILL"); settle(deadline); };
  const freeze = () => {
    // The group exists only once the anchor has made its session, a moment after the fork.
    if (active) { try { process.kill(group, "SIGSTOP"); } catch { anchor.kill("SIGKILL"); } }
    setTimeout(() => (active && moving() && Date.now() < deadline ? freeze() : kill()), 20);
  };
  freeze();
};
// SIGQUIT is Ctrl-\ at the terminal: the install runs in a session of its own,
// so it does not reach the install by itself, as it used to.
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.on(name, () => {
    cancelled ||= signals[name];
    stop();
  });
}
anchor.on("error", (err) => {
  // Nothing was started, so nothing of the install can be left: report and go.
  active = false;
  console.error(err);
  process.exit(1);
});
anchor.on("exit", () => {
  // Killed by another hand: the group is no longer this run's to signal.
  active = false;
  settle(Date.now() + 5000);
});
let report = "";
if (anchor.stdio[3]) {
  anchor.stdio[3].setEncoding("utf8");
  anchor.stdio[3].on("data", (chunk) => {
    report += chunk;
    if (!report.includes("\n")) return;
    const [code, name] = JSON.parse(report);
    ended = code ?? 128 + signals[name];
    settle(Date.now() + 5000); // the installer has exited: wait for the rest, and stop nothing
  });
}
const pause = () => {
  process.off("SIGTSTP", pause);
  // Ctrl-Z, as a stop the install cannot decline: the group is orphaned — its
  // parent is in another session — and the kernel drops SIGTSTP to such a group.
  signal("SIGSTOP");
  process.kill(process.pid, "SIGTSTP");
};
process.on("SIGTSTP", pause);
process.on("SIGCONT", () => {
  process.on("SIGTSTP", pause);
  signal("SIGCONT");
});
EOF
)

# Run installer. A small supervisor takes this process's place, so that a
# signal sent to it reaches the installer, the lock is released only once the
# installer has exited and nothing of the install is running, and a cancelled
# run never reports success. The EXIT trap stays armed for the one case the
# supervisor never starts — a failed `exec` — and does not run when the exec
# succeeds.
echo "==> Running installer..."
# `curl … | bash` leaves the installer a drained pipe as stdin, so the
# interactive wizard would read end-of-input at its first question and exit.
# When a terminal is available, hand the installer that instead.
if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
  ORCY_INSTALLER_LOCK="$LOCK_DIR" exec node -e "$SUPERVISOR" "${INSTALLER_DIR}/dist/index.js" "$@" < /dev/tty
fi
ORCY_INSTALLER_LOCK="$LOCK_DIR" exec node -e "$SUPERVISOR" "${INSTALLER_DIR}/dist/index.js" "$@"
