#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/coding-sandbox.sh [hub|PROJECT]
       scripts/coding-sandbox.sh --prepare [hub|PROJECT]
       scripts/coding-sandbox.sh --diff SANDBOX

Open Codex in a local Docker Sandbox with a copy of the selected Git HEAD.
--prepare creates the sandbox without opening Codex.
--diff writes the sandbox's changes as a patch to stdout.
EOF
}

fail() { printf '%s\n' "$*" >&2; exit 1; }

# The Docker CLI can forward the caller's SSH agent when opening a sandbox.
unset SSH_AUTH_SOCK

guest_checkout=/home/agent/workspace/factory-checkout

case "${1:-}" in
  -h|--help) usage; exit ;;
  --diff)
    [ "$#" -eq 2 ] && [[ "$2" =~ ^factory-code-[0-9a-f]{16}$ ]] || fail "Provide a sandbox name printed by this script."
    exec sbx --no-input exec --workdir "$guest_checkout" "$2" bash -euc '
      git add --all
      git --no-pager diff --cached --binary --full-index --no-ext-diff --no-textconv factory-baseline --
    '
    ;;
  --prepare) prepare=1; shift ;;
  *) prepare=0 ;;
esac

[ "$#" -le 1 ] || fail "Select one registered project or hub."
target="${1:-hub}"
[[ "$target" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail "Select one registered project or hub."
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
checkout="$root"
if [ "$target" != hub ]; then
  checkout=""
  for section in startups tooling; do
    entries="$("$root/scripts/registry.sh" "$section")"
    while IFS=$'\t' read -r name _; do
      if [ "$name" = "$target" ]; then
        [ -z "$checkout" ] || fail "Project is registered more than once: $target"
        checkout="$root/projects/$section/$target"
      fi
    done <<< "$entries"
  done
  [ -n "$checkout" ] || fail "Unknown project: $target"
fi

[ -d "$checkout" ] && [ "$(cd -- "$checkout" && pwd -P)" = "$checkout" ] &&
  [ "$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null)" = "$checkout" ] ||
  fail "Expected a separate Git checkout at $checkout."
baseline="$(git -C "$checkout" rev-parse --verify HEAD)"
command -v sbx >/dev/null || fail "Install Docker Sandboxes (sbx) first."

if [ "$(sbx --no-input settings get ssh.agentForwardingEnabled)" = true ] &&
  [ -n "$(sbx --no-input settings get ssh.agentSocketPath)" ]; then
  fail "Docker Sandboxes is configured to forward a fixed host SSH socket. Disable that forwarding before opening the coding sandbox."
fi

sandbox="factory-code-$(openssl rand -hex 8)"
printf 'Creating %s for %s at %s\n' "$sandbox" "$target" "$baseline" >&2
# Use the official kit directly, independent of locally configured shortcuts.
# No workspace path means the checkout lives on the VM's own filesystem.
bash "$root/scripts/with-factory-kit.sh" create --name "$sandbox" --skills=off --static-mcp none \
  --env GH_TOKEN= --env GITHUB_TOKEN= \
  --deny-network github.com --deny-network '*.github.com' \
  --deny-network '*.hetzner.cloud' --deny-network api.cloudflare.com \
  --deny-network localhost --deny-network host.docker.internal \
  docker.io/sbx/codex:latest >&2

printf 'Sandbox: %s\n' "$sandbox" >&2
sbx --no-input exec "$sandbox" bash -euc '
  for credential in SSH_AUTH_SOCK GH_TOKEN GITHUB_TOKEN; do
    if [ -n "${!credential:-}" ]; then
      printf "Unexpected credential in the sandbox environment: %s\n" "$credential" >&2
      exit 1
    fi
  done
  mkdir -p "$1"
' bash "$guest_checkout"

git -C "$checkout" archive --format=tar "$baseline" |
  sbx --no-input exec -i --workdir "$guest_checkout" "$sandbox" tar -xf -
sbx --no-input exec --workdir "$guest_checkout" "$sandbox" bash -euc '
  git init --quiet
  git add --force --all
  git -c user.name="Factory sandbox" -c user.email="sandbox@example.invalid" \
    commit --quiet --allow-empty -m "Factory baseline"
  git tag factory-baseline
'

if [ "$prepare" -eq 1 ]; then
  printf '%s\n' "$sandbox"
else
  sbx run --name "$sandbox" --workdir "$guest_checkout" --env GH_TOKEN= --env GITHUB_TOKEN=
  printf 'Collect changes with: scripts/coding-sandbox.sh --diff %s > sandbox.patch\n' "$sandbox" >&2
fi
