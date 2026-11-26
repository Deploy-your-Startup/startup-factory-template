#!/bin/bash
set -euo pipefail
unset SSH_AUTH_SOCK

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
stage_kit() {
  kit="$(mktemp -d "${TMPDIR:-/tmp}/factory-kit.XXXXXXXX")"
  trap 'rm -rf -- "$kit"' EXIT
  # Only the checked-in recipe and dependency inputs enter the builder.
  cp "$root/sandbox/factory-tools/kit.yaml" "$root/sandbox/factory-tools/kit.dockerfile" \
    "$root/pyproject.toml" "$root/uv.lock" "$kit/"
}

use_oci_builder() {
  # The legacy Docker image store cannot export the OCI layers sbx consumes.
  # Keep the user's default builder selected and use a dedicated one for kits.
  if [ -z "${BUILDX_BUILDER:-}" ] &&
    docker buildx inspect | grep -qE '^Driver:[[:space:]]+docker[[:space:]]*$' &&
    ! docker info --format '{{json .DriverStatus}}' | grep -q 'io.containerd.snapshotter'; then
    if ! docker buildx inspect sbx-kits >/dev/null 2>&1; then
      docker buildx create --driver docker-container --name sbx-kits >&2 ||
        docker buildx inspect sbx-kits >/dev/null
    fi
    export BUILDX_BUILDER=sbx-kits
  fi
}

case "${1:-}" in
  build)
    [ "$#" -eq 1 ] || exit 2
    stage_kit
    docker buildx build --load -f "$kit/kit.yaml" -t factory-tools:local "$kit"
    ;;
  create)
    shift
    stage_kit
    use_oci_builder
    sbx create --kit "$kit" "$@"
    ;;
  add)
    [ "$#" -eq 2 ] || exit 2
    stage_kit
    use_oci_builder
    sbx kit add "$2" "$kit"
    ;;
  status)
    [ "$#" -eq 2 ] || exit 2
    use_oci_builder
    environment="$(node "$root/scripts/prepare-cluster-status.mjs" "$2")"
    printf 'Environment: %s\n' "$environment"
    sbx env create "$environment"
    sbx mcp load factory-cluster-status --sandbox "$2"
    ;;
  *)
    printf 'Usage: %s build | create SBX_OPTIONS | add SANDBOX | status SANDBOX\n' "${0##*/}" >&2
    exit 2
    ;;
esac
