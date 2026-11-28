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
# as it is. The copy is deployed beside any previous installer and swapped in
# only once its entry point exists, so a failed run leaves that one in place.
echo "==> Preparing installer..."
INSTALLER_DIR="${ORCY_HOME}/installer"
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
rm -rf "${INSTALLER_DIR}"
mv "${STAGED_DIR}" "${INSTALLER_DIR}"

# Run installer
echo "==> Running installer..."
# `curl … | bash` leaves the installer a drained pipe as stdin, so the
# interactive wizard would read end-of-input at its first question and exit.
# When a terminal is available, hand the installer that instead.
if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
  exec node "${INSTALLER_DIR}/dist/index.js" "$@" < /dev/tty
fi
exec node "${INSTALLER_DIR}/dist/index.js" "$@"
