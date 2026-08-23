#!/usr/bin/env bash
# Installs the committed pre-push migration gate (hooks/pre-push) into this
# checkout's .git/hooks/. Idempotent — re-running just re-copies. Refuses to
# run outside a git work tree.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "install-hooks: not inside a git work tree — nothing to install." >&2
  exit 1
}
src="$repo_root/hooks/pre-push"
[ -f "$src" ] || { echo "install-hooks: missing $src" >&2; exit 1; }
# rev-parse --git-path resolves correctly inside linked worktrees too.
dst="$(git -C "$repo_root" rev-parse --git-path hooks/pre-push)"
mkdir -p "$(dirname "$dst")"
cp "$src" "$dst"
chmod +x "$dst"
echo "install-hooks: installed $dst (main-push migration gate)."
