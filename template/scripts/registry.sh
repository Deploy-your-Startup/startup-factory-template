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
  *)
    printf 'Usage: %s {startups|tooling|deployed}\n' "$(basename "$0")" >&2
    exit 1
    ;;
esac
