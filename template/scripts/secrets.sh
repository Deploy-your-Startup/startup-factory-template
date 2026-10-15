#!/bin/bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  printf 'Usage: %s <command> [project-name]\n' "$(basename "$0")"
  printf '\nCommands:\n'
  printf '  store <project>   Store vault password in macOS Keychain\n'
  printf '  update <project>  Update existing vault password\n'
  printf '  check <project>   Check if vault password exists\n'
  printf '  list              List all deployed projects and their secret status\n'
  printf '  store-all         Store vault passwords for all deployed projects (skips existing)\n'
}

keychain_service() {
  local name
  name="$(printf 'VAULT_PASSWORD_%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
  printf '%s' "$name"
}

keychain_has_secret() {
  security find-generic-password -a "$USER" -s "$(keychain_service "$1")" >/dev/null 2>&1
}

# Guard for the write paths (store/update/store-all). Secrets must only ever be
# entered interactively on the owner's Mac — never on a remote/CI host or from a
# non-interactive (agent) session. This makes that a structural requirement.
ensure_store_env() {
  if [ "$(uname -s)" != "Darwin" ]; then
    printf 'error: writing secrets requires macOS (Keychain) — run this on your Mac, not a remote/CI host.\n' >&2
    exit 1
  fi
  if ! command -v security >/dev/null 2>&1; then
    printf 'error: `security` (macOS Keychain tool) not found on PATH.\n' >&2
    exit 1
  fi
  if [ ! -r /dev/tty ]; then
    printf 'error: writing secrets requires an interactive terminal (no /dev/tty available).\n' >&2
    exit 1
  fi
}

store_secret() {
  local project="$1"
  local service
  service="$(keychain_service "$project")"

  printf '\n%s\n' "Storing vault password for: $project"
  printf 'Search for "%s" in the Passwords app and copy its value.\n' "$service"
  printf 'Store it for %s now? [Y/n] ' "$project"
  read -r proceed </dev/tty
  case "${proceed:-y}" in
    n|N) printf 'skipped %s\n' "$project"; return 1 ;;
  esac

  # Let `security` read the password from its own (hidden) interactive prompt.
  # The plaintext is never assigned to a shell variable and never appears in the
  # process argument list, so it cannot leak via `ps` or this script's output.
  if security add-generic-password -U -a "$USER" -s "$service" -w; then
    printf 'saved vault password for %s to macOS Keychain\n' "$project"
  else
    printf 'skipped %s (no password entered)\n' "$project"
    return 1
  fi
}

get_deployed_projects() {
  "$script_dir/registry.sh" deployed
}

cmd_store() {
  local project="${1:-}"
  if [ -z "$project" ]; then
    printf 'error: project name required\n' >&2
    usage
    exit 1
  fi

  ensure_store_env

  if keychain_has_secret "$project"; then
    printf 'vault password for %s already exists in Keychain. Overwrite? [y/N] ' "$project"
    read -r answer
    if [ "${answer:-}" != "y" ] && [ "${answer:-}" != "Y" ]; then
      printf 'skipped\n'
      return 0
    fi
  fi

  open -a Passwords >/dev/null 2>&1 || true
  store_secret "$project"
}

cmd_update() {
  local project="${1:-}"
  if [ -z "$project" ]; then
    printf 'error: project name required\n' >&2
    usage
    exit 1
  fi

  ensure_store_env

  if ! keychain_has_secret "$project"; then
    printf 'no existing password for %s — use "store" instead\n' "$project" >&2
    exit 1
  fi

  open -a Passwords >/dev/null 2>&1 || true
  store_secret "$project"
}

cmd_check() {
  local project="${1:-}"
  if [ -z "$project" ]; then
    printf 'error: project name required\n' >&2
    exit 1
  fi

  if keychain_has_secret "$project"; then
    printf 'present: %s\n' "$project"
  else
    printf 'missing: %s\n' "$project"
    return 1
  fi
}

cmd_list() {
  local project
  local missing=0

  printf 'Deployed projects vault password status:\n\n'
  while IFS= read -r project; do
    if keychain_has_secret "$project"; then
      printf '  ✓ %s\n' "$project"
    else
      printf '  ✗ %s\n' "$project"
      missing=$((missing + 1))
    fi
  done < <(get_deployed_projects)

  if [ "$missing" -gt 0 ]; then
    printf '\n%d project(s) missing vault password. Run: scripts/secrets.sh store-all\n' "$missing"
  else
    printf '\nAll vault passwords present.\n'
  fi
}

cmd_store_all() {
  local project
  local opened_app=0

  ensure_store_env

  while IFS= read -r project; do
    if keychain_has_secret "$project"; then
      printf 'already present: %s\n' "$project"
      continue
    fi

    if [ "$opened_app" -eq 0 ]; then
      open -a Passwords >/dev/null 2>&1 || true
      opened_app=1
    fi

    store_secret "$project" || true
  done < <(get_deployed_projects)
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ -z "${1:-}" ]; then
  usage
  exit 0
fi

command="$1"
shift

case "$command" in
  store)     cmd_store "$@" ;;
  update)    cmd_update "$@" ;;
  check)     cmd_check "$@" ;;
  list)      cmd_list ;;
  store-all) cmd_store_all ;;
  *)
    printf 'unknown command: %s\n' "$command" >&2
    usage
    exit 1
    ;;
esac
