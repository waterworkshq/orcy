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

# One bootstrap at a time per ORCY_HOME: two would race on the source tree, the
# staged installer and its promotion. The lock is the exclusive creation of a
# file holding this process's PID. One held by a live process stops this run
# before it touches anything; one left behind by a run that is gone is taken
# over. It is released before the installer is handed off to.
LOCK_FILE="${ORCY_HOME}/bootstrap.lock"
INSTALLER_DIR="${ORCY_HOME}/installer"
BACKUP_DIR="${INSTALLER_DIR}.old"
take_lock() { ( set -C; echo $$ > "$LOCK_FILE" ) 2>/dev/null; }
mkdir -p "$ORCY_HOME"
if ! take_lock; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "Another orcy installer run is in progress for this user (pid $LOCK_PID)."
    echo "Wait for it to finish, or - if none is running - remove $LOCK_FILE and retry."
    exit 1
  fi
  rm -f "$LOCK_FILE"
  take_lock || {
    echo "Could not take the installer lock $LOCK_FILE."
    exit 1
  }
fi
trap 'rm -f "$LOCK_FILE"' EXIT

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
  # A backup can only be stale here: the active installer is present.
  rm -rf "${BACKUP_DIR}"
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
rm -rf "${BACKUP_DIR}"

# Run installer (the bootstrap lock no longer applies: promotion is done)
rm -f "$LOCK_FILE"
echo "==> Running installer..."
# `curl … | bash` leaves the installer a drained pipe as stdin, so the
# interactive wizard would read end-of-input at its first question and exit.
# When a terminal is available, hand the installer that instead.
if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
  exec node "${INSTALLER_DIR}/dist/index.js" "$@" < /dev/tty
fi
exec node "${INSTALLER_DIR}/dist/index.js" "$@"
