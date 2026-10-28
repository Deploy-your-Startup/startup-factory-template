#!/bin/bash
# Sync selected checkouts; no arguments preserves the legacy full sync.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(dirname "$script_dir")"
verbose=0
all=0
hub=0
selected=()
usage() {
  echo "Usage: scripts/sync.sh [--all | --hub | --project NAME ...] [--verbose]"
  echo "No scope selects all repositories. --hub and --project may be combined."
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --all) all=1; shift ;;
    --hub) hub=1; shift ;;
    --project)
      if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
        echo "--project requires a registered name" >&2; exit 2
      fi
      selected+=("$2"); shift 2 ;;
    --verbose) verbose=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ "$all" -eq 1 ] && { [ "$hub" -eq 1 ] || [ "${#selected[@]}" -gt 0 ]; }; then
  echo "--all cannot be combined with --hub or --project" >&2; exit 2
fi
if [ "$hub" -eq 0 ] && [ "${#selected[@]}" -eq 0 ]; then all=1; fi

# Resolve every name before touching any checkout.
records=()
for kind in startups tooling; do
  entries="$("$script_dir/registry.sh" "$kind")"
  while IFS=$'\t' read -r name repo _rest; do
    [ -n "$name" ] || continue
    records+=("$name"$'\t'"$root_dir/projects/$kind/$name"$'\t'"$repo")
  done <<< "$entries"
done
for name in "${selected[@]+"${selected[@]}"}"; do
  matches=0
  for record in "${records[@]+"${records[@]}"}"; do
    IFS=$'\t' read -r entry _rest <<< "$record"
    if [ "$entry" = "$name" ]; then matches=$((matches + 1)); fi
  done
  if [ "$matches" -ne 1 ]; then
    echo "Project must match exactly one registry entry: $name ($matches matches)" >&2
    exit 2
  fi
done

updated=0
already_current=0
skipped=0
failed=0
# Keep moved-origin diagnostics readable without terminal color codes.
CYAN='' YELLOW='' NC=''
follow_registered_origin() {
  local name="$1" target_dir="$2" repo="$3" branch="$4" origin
  origin=$(git -C "$target_dir" remote get-url origin 2>/dev/null) || return 0
  "$script_dir/registry.sh" same-repo "$origin" "$repo" && return 0

  if git -C "$target_dir" fetch --quiet "$repo" "$branch" 2>/dev/null &&
     git -C "$target_dir" merge-base HEAD FETCH_HEAD >/dev/null 2>&1; then
    git -C "$target_dir" remote set-url origin "$repo"
    echo -e "  ${CYAN}→${NC} $name — origin moved: $origin → $repo"
  else
    echo -e "  ${YELLOW}⊘${NC} $name — registered $repo shares no history with origin, keeping $origin"
    return 1
  fi
}


pull_repo() {
  local name="$1" target_dir="$2" repo="$3" branch before after output
  if [ ! -d "$target_dir" ]; then
    echo "$name: missing checkout; run scripts/init.sh" >&2
    failed=$((failed + 1)); return
  fi
  branch=$(git -C "$target_dir" branch --show-current)
  if [ -z "$branch" ]; then
    echo "$name: detached HEAD, skipped" >&2
    skipped=$((skipped + 1)); return
  fi
  if [ -n "$(git -C "$target_dir" status --porcelain)" ]; then
    echo "$name ($branch): local changes, skipped; preserve or commit them before syncing" >&2
    skipped=$((skipped + 1)); return
  fi
  if [ -n "$repo" ] && ! follow_registered_origin "$name" "$target_dir" "$repo" "$branch"; then
    failed=$((failed + 1)); return
  fi
  if ! git -C "$target_dir" ls-remote --exit-code origin "refs/heads/$branch" >/dev/null 2>&1; then
    echo "$name ($branch): remote branch missing or origin inaccessible; checkout unchanged" >&2
    failed=$((failed + 1)); return
  fi
  before=$(git -C "$target_dir" rev-parse HEAD)
  if output=$(git -C "$target_dir" pull --rebase origin "$branch" --quiet 2>&1); then
    after=$(git -C "$target_dir" rev-parse HEAD)
    if [ "$before" != "$after" ]; then
      updated=$((updated + 1))
      if [ "$verbose" -eq 1 ]; then echo "$name ($branch) — pulling... updated"; fi
    else
      already_current=$((already_current + 1))
      if [ "$verbose" -eq 1 ]; then echo "$name ($branch) — pulling... already up to date"; fi
    fi
  else
    echo "$name ($branch): sync failed" >&2
    printf '%s\n' "$output" >&2
    failed=$((failed + 1))
  fi
}

if [ "$all" -eq 1 ] || [ "$hub" -eq 1 ]; then
  pull_repo startup-factory "$root_dir" ""
fi
for record in "${records[@]+"${records[@]}"}"; do
  IFS=$'\t' read -r name directory repo <<< "$record"
  chosen=$all
  for selection in "${selected[@]+"${selected[@]}"}"; do
    if [ "$selection" = "$name" ]; then chosen=1; fi
  done
  if [ "$chosen" -eq 1 ]; then pull_repo "$name" "$directory" "$repo"; fi
done

# A scoped sync does not claim to validate unrelated checkouts.
drift=0
registry_state=not-checked
if [ "$all" -eq 1 ]; then
  registry_state=passed
  if output=$("$script_dir/registry.sh" check 2>&1); then
    if [ "$verbose" -eq 1 ]; then printf '%s\n' "$output"; fi
  else
    printf '%s\n' "$output" >&2
    drift=1
    registry_state=failed
  fi
fi
echo "Sync: $updated updated, $already_current current, $skipped skipped, $failed failed; registry=$registry_state"
if [ "$failed" -gt 0 ] || [ "$skipped" -gt 0 ] || [ "$drift" -gt 0 ]; then exit 1; fi
