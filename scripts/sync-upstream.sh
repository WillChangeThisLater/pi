#!/usr/bin/env bash
# scripts/sync-upstream.sh
#
# Pull latest changes from upstream (badlogic/pi-mono) into this fork's main
# branch, then optionally rebase the current feature branch on top.
# Checks for merge conflicts BEFORE touching any local branches.
#
# Usage:
#   ./scripts/sync-upstream.sh                                  # update main only
#   ./scripts/sync-upstream.sh --rebase-branch                   # update main + rebase current branch
#   ./scripts/sync-upstream.sh --rebase-branch --dry-run         # check for conflicts, do nothing
#
# Dependencies: git
# Working directory: repo root (run from ~/repos/pi)

set -euo pipefail

REBASE_BRANCH=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --rebase-branch) REBASE_BRANCH=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# //'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: $0 [--rebase-branch] [--dry-run]"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- Guard: ensure upstream remote exists ---
if ! git remote get-url upstream &>/dev/null; then
  echo "ERROR: No remote named 'upstream' found."
  echo "Set it up: git remote add upstream https://github.com/badlogic/pi-mono"
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)

# --- Fetch upstream (harmless, no branches touched) ---
echo "Fetching upstream..."
git fetch upstream --prune --tags

# --- Pre-check: what would happen to main? ---
echo "Checking fast-forward compatibility on main..."
MAIN_MERGE_BASE=$(git merge-base main upstream/main)

if [[ "$MAIN_MERGE_BASE" != "$(git rev-parse upstream/main)" ]]; then
  echo "main is not a fast-forward of upstream/main."
  echo "  main:         $(git rev-parse --short HEAD)"
  echo "  upstream/main: $(git rev-parse --short upstream/main)"
  echo ""
  echo "This means you have commits on main that diverge from upstream."
  echo "Running merge-tree to find conflicting files..."

  CONFLICT_FILES=$(git merge-tree "$MAIN_MERGE_BASE" main upstream/main \
    | grep -A5 "^changed in both" \
    | grep "^base\|^our\|^their" || true)

  if [[ -n "$CONFLICT_FILES" ]]; then
    echo "CONFLICTS would occur in these files when merging upstream into main:"
    echo "$CONFLICT_FILES"
    echo ""
    echo "Aborting. Resolve conflicts manually, or reset main to match upstream with:"
    echo "  git checkout main && git reset --hard upstream/main"
    exit 1
  else
    echo "No conflicts found (merge required but clean)."
  fi
else
  echo "main can fast-forward — no divergence."
fi

# --- Pre-check: rebase conflicts for current feature branch ---
if [[ "$REBASE_BRANCH" == "true" && "$CURRENT_BRANCH" != "main" ]]; then
  echo ""
  echo "Pre-checking rebase of '$CURRENT_BRANCH' onto upstream/main..."
  NEW_BASE=$(git rev-parse upstream/main)
  OLD_BASE=$(git merge-base "$CURRENT_BRANCH" upstream/main)

  # If the branch is already based on the upstream we just fetched, nothing to do
  if [[ "$OLD_BASE" == "$NEW_BASE" ]]; then
    echo "Branch '$CURRENT_BRANCH' is already based on upstream/main — no rebase needed."
    REBASE_BRANCH=false
  else
    # Simulate the rebase: merge-tree of (old_base, new_base, branch_tip)
    # This shows what merging the branch onto the new base would produce.
    SIMULATED=$(git merge-tree "$OLD_BASE" "$NEW_BASE" "$CURRENT_BRANCH" 2>&1 || true)
    CONFLICT_FILES=$(echo "$SIMULATED" \
      | grep -A5 "^changed in both" \
      | grep "^base\|^our\|^their" || true)

    if [[ -n "$CONFLICT_FILES" ]]; then
      echo ""
      echo "WARNING: Conflicts detected in the simulated rebase:"
      echo "$CONFLICT_FILES"
      echo ""
      echo "You can proceed anyway with --rebase-branch (resolve conflicts manually"
      echo "during the rebase), or cancel, fix conflicts upstream, and re-run."
      echo ""
      echo "For now, refreshing main only."
      REBASE_BRANCH=false
    else
      echo "No conflicts predicted for rebase onto upstream/main."
    fi
  fi
fi

# --- Bail if dry-run ---
if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "Dry-run complete — no changes made."
  exit 0
fi

# --- Stash dirty worktree if needed ---
HAS_STASH=false
if ! git diff --quiet --ignore-submodules HEAD; then
  echo "Stashing uncommitted changes..."
  git stash push --include-untracked --message "sync-upstream: auto-stash $(date +%Y%m%d-%H%M%S)"
  HAS_STASH=true
fi

# --- Update main ---
echo ""
echo "Updating main from upstream..."
git checkout main
git pull --ff-only upstream/main
git push origin main
git push origin --tags --force

# --- Rebase feature branch (if still requested and clean) ---
if [[ "$REBASE_BRANCH" == "true" && "$CURRENT_BRANCH" != "main" ]]; then
  echo ""
  echo "Rebasing '$CURRENT_BRANCH' onto updated main..."
  git checkout "$CURRENT_BRANCH"
  git rebase main
elif [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "" ]]; then
  git checkout "$CURRENT_BRANCH"
fi

# --- Pop stash ---
if [[ "$HAS_STASH" == "true" ]]; then
  echo ""
  echo "Restoring stashed changes..."
  git stash pop
fi

echo ""
echo "Done. main is at $(git -C main rev-parse --short HEAD 2>/dev/null || git rev-parse --short HEAD)"
echo "Upstream changelog: https://github.com/badlogic/pi-mono/blob/main/CHANGELOG.md"