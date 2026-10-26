#!/bin/bash
set -euo pipefail

# registry.sh — single source of truth for reading projects.yaml.
#
# Other scripts (init.sh, sync.sh, secrets.sh) must NOT parse projects.yaml
# themselves. They call into here so the YAML is parsed in exactly one place,
# with a real YAML parser (yq) instead of grep/sed line-matching.
#
# Output is tab-separated (one record per line) so callers can read it with
# `while IFS=$'\t' read -r ...`.
#
# Commands:
#   startups          name <TAB> repo <TAB> deployed <TAB> kubectl_context
#   tooling           name <TAB> repo
#   deployed          name        (startups with `deployed: true`)
#   evidence-repo     OWNER/NAME of the private PR review evidence repository
#                     (`evidence_repo`; empty when unset)
#   check             compare the registry with the checkouts under projects/;
#                     prints each drift and exits 1 if there is any
#   same-repo A B     exit 0 when two remote URLs name the same repository

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(dirname "$script_dir")"
projects_yaml="$root_dir/projects.yaml"

if ! command -v yq >/dev/null 2>&1; then
  printf 'error: `yq` not found on PATH (brew install yq).\n' >&2
  exit 1
fi

if [ ! -f "$projects_yaml" ]; then
  printf 'error: registry not found: %s\n' "$projects_yaml" >&2
  exit 1
fi

# Compare repository URLs by host and path, so SSH and HTTPS remotes of the
# same repository match.
normalize_repo() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E \
    -e 's#^[a-z+]+://##' -e 's#^[^@/]+@##' -e 's#:#/#' -e 's#/+$##' -e 's#\.git$##'
}

check_registry() {
  local drift=0 section kind name repo entries dir origin
  report() { printf '  ✗ %s\n' "$1"; drift=$((drift + 1)); }

  # A deployment record must be complete: no url or context without deployed.
  while IFS=$'\t' read -r name problem; do
    if [ -n "$name" ]; then report "$name — $problem"; fi
  done < <(yq '
      [.projects[] | select((.deployed == true) and ((.url // "") == "")) | [.name, "deployed: true without url"]] +
      [.projects[] | select((.deployed != true) and ((.url // "") != "")) | [.name, "url without deployed: true"]] +
      [.projects[] | select((.deployed != true) and ((.kubectl_context // "") != "")) | [.name, "kubectl_context without deployed: true"]] |
      .[] | @tsv' "$projects_yaml")

  # Review screenshots go to one private repository, written by
  # `startup evidence upload`; it must name a GitHub OWNER/NAME.
  local evidence
  evidence="$(yq '.evidence_repo // ""' "$projects_yaml")"
  if [ -n "$evidence" ] && ! [[ "$evidence" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    report "evidence_repo — $evidence is not OWNER/NAME"
  fi

  for section in projects:startups tooling:tooling; do
    kind="${section#*:}"
    entries="$(yq ".${section%%:*}[] | [.name, .repo] | @tsv" "$projects_yaml")"
    while IFS=$'\t' read -r name repo; do
      [ -n "$name" ] || continue
      dir="$root_dir/projects/$kind/$name"
      if [ ! -d "$dir" ]; then
        report "projects/$kind/$name — registered but not cloned (run scripts/init.sh)"
      elif ! origin="$(git -C "$dir" remote get-url origin 2>/dev/null)"; then
        report "projects/$kind/$name — no Git origin"
      elif [ "$(normalize_repo "$origin")" != "$(normalize_repo "$repo")" ]; then
        report "projects/$kind/$name — origin $origin differs from registered $repo"
      fi
    done <<< "$entries"

    [ -d "$root_dir/projects/$kind" ] || continue
    for dir in "$root_dir/projects/$kind"/*/; do
      [ -d "$dir" ] || continue
      name="$(basename "$dir")"
      grep -Fxq -- "$name" <<< "$(cut -f1 <<< "$entries")" ||
        report "projects/$kind/$name — checkout not in projects.yaml (register or remove it)"
    done
  done

  if [ "$drift" -gt 0 ]; then
    printf '%d registry drift(s) found.\n' "$drift"
    return 1
  fi
  printf 'Registry matches the checkouts.\n'
}

case "${1:-}" in
  startups)
    yq '.projects[] | [.name, .repo, (.deployed // false), (.kubectl_context // "")] | @tsv' "$projects_yaml"
    ;;
  tooling)
    yq '.tooling[] | [.name, .repo] | @tsv' "$projects_yaml"
    ;;
  deployed)
    yq '.projects[] | select(.deployed == true) | .name' "$projects_yaml"
    ;;
  evidence-repo)
    yq '.evidence_repo // ""' "$projects_yaml"
    ;;
  check)
    check_registry
    ;;
  same-repo)
    [ "$#" -eq 3 ] || { printf 'Usage: %s same-repo <url> <url>\n' "$(basename "$0")" >&2; exit 2; }
    [ "$(normalize_repo "$2")" = "$(normalize_repo "$3")" ]
    ;;
  *)
    printf 'Usage: %s {startups|tooling|deployed|evidence-repo|check|same-repo}\n' "$(basename "$0")" >&2
    exit 1
    ;;
esac
