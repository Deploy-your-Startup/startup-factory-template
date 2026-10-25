#!/bin/bash
set -euo pipefail

mode=preview
case "${1:-}" in
  "") ;;
  --apply) mode=apply ;;
  -h|--help)
    echo 'Usage: scripts/update-templates.sh [--apply]'
    echo 'Preview the latest template changes for registered startups; --apply writes them locally.'
    exit 0
    ;;
  *) echo 'Usage: scripts/update-templates.sh [--apply]' >&2; exit 1 ;;
esac
if [ "$#" -gt 1 ]; then
  echo 'Usage: scripts/update-templates.sh [--apply]' >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(dirname "$script_dir")"
command -v startup >/dev/null || { echo 'error: startup CLI is required.' >&2; exit 1; }
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
  if [ ! -f "$project/.copier-answers.yml" ]; then
    echo "$name — skipped: no Copier metadata."
    skipped=$((skipped + 1))
    continue
  fi
  if ! git_status="$(git -C "$project" status --porcelain)"; then
    echo "$name — failed: cannot read Git status." >&2
    failed=$((failed + 1))
    continue
  fi
  if [ -n "$git_status" ]; then
    echo "$name — skipped: uncommitted changes."
    skipped=$((skipped + 1))
    continue
  fi

  echo "$name — $mode latest template changes"
  args=(template update --project-dir "$project" --version HEAD)
  [ "$mode" = apply ] || args+=(--dry-run)
  if startup "${args[@]}"; then
    completed=$((completed + 1))
  else
    echo "$name — failed: review the template update output above." >&2
    failed=$((failed + 1))
  fi
done <<< "$registry"

echo "Summary ($mode): $completed completed, $skipped skipped, $failed failed."
if [ "$mode" = preview ]; then
  echo 'To apply locally: scripts/update-templates.sh --apply'
else
  echo 'Review each diff, resolve conflicts, run project checks and commit the update.'
fi
[ "$failed" -eq 0 ]
