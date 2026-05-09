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

# Check Node
NODE_VERSION=$(node --version 2>/dev/null || echo "")
if [ -z "$NODE_VERSION" ]; then
  echo "Node.js not found. Please install Node.js >= 20: https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js >= 20 required, found $NODE_VERSION"
  exit 1
fi
echo "    Node $NODE_VERSION found"

# Check / install pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  echo "    pnpm not found. Installing pnpm via npm..."
  npm install -g pnpm
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "    Failed to install pnpm. Please install manually: npm install -g pnpm"
    exit 1
  fi
  echo "    pnpm installed"
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

# Install dependencies
echo "==> Installing dependencies..."
(cd "$SRC_DIR" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
echo "    Dependencies installed"

# Build
echo "==> Building packages..."
(cd "$SRC_DIR" && pnpm -r build)
echo "    Build complete"

# Run installer
echo "==> Running installer..."
mkdir -p "${ORCY_HOME}/installer"
cp -r "${SRC_DIR}/packages/installer/dist" "${ORCY_HOME}/installer/"
cp -r "${SRC_DIR}/packages/installer/skills" "${ORCY_HOME}/installer/"

echo ""
echo "Setup complete. Visit http://localhost:4000/app to create your admin account."
echo ""

exec node "${ORCY_HOME}/installer/dist/index.js" "$@"
