#!/bin/bash
# Show or adopt the latest shared deployment release for every registered startup.
set -euo pipefail

usage='Usage: scripts/update-deployments.sh [--apply]'
mode=preview
case "${1:-}" in
  "") ;;
  --apply) mode=apply ;;
  -h|--help)
    echo "$usage"
    echo 'Show which shared deployment release each startup runs; --apply moves them to the latest locally.'
    exit 0
    ;;
  *) echo "$usage" >&2; exit 1 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "$usage" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(dirname "$script_dir")"
command -v startup >/dev/null || { echo 'error: startup CLI is required.' >&2; exit 1; }
update_help="$(startup update --help 2>/dev/null)" || update_help=''
if ! grep -q -- '--project-dir' <<<"$update_help" || ! grep -qF -- '.github/workflows/startup.yml' <<<"$update_help"; then
  echo 'error: this startup CLI cannot update single-version deployment projects; install the current release.' >&2
  exit 1
fi
registry="$("$script_dir/registry.sh" startups)"
completed=0
skipped=0
failed=0

while IFS=$'\t' read -r name _repo _deployed _context; do
  [ -n "$name" ] || continue
  project="$root_dir/projects/startups/$name"
  if [ ! -e "$project/.git" ]; then
    echo "$name — skipped: checkout missing (run scripts/init.sh)."
    skipped=$((skipped + 1))
    continue
  fi
  if [ ! -d "$project/deployment" ] && ! grep -rqE 'uses:.*[^/]+/[^/]+/\.github/(workflows|actions)/' "$project/.github/workflows" 2>/dev/null; then
    echo "$name — skipped: no shared deployment workflows."
    skipped=$((skipped + 1))
    continue
  fi
  args=(update --project-dir "$project")
  if [ "$mode" = preview ]; then
    args+=(--check)
  elif [ -n "$(git -C "$project" status --porcelain)" ]; then
    echo "$name — skipped: uncommitted changes."
    skipped=$((skipped + 1))
    continue
  fi

  echo "$name — $mode latest shared deployment release"
  if startup "${args[@]}" </dev/null; then
    completed=$((completed + 1))
  else
    echo "$name — failed: review the update output above." >&2
    failed=$((failed + 1))
  fi
done <<< "$registry"

echo "Summary ($mode): $completed completed, $skipped skipped, $failed failed."
if [ "$mode" = preview ]; then
  echo 'To move every startup to the latest release locally: scripts/update-deployments.sh --apply'
else
  echo 'Nothing is deployed yet. Review each diff, then commit and push the startups you want to roll out.'
fi
[ "$failed" -eq 0 ]
