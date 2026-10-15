#!/bin/bash
set -euo pipefail

# sprowi.sh — thin entry point for Sprowi, your startup companion.
#
# Everything it does lives in sprowi/cli.mjs; this exists so the hub keeps its
# "one script per verb" shape and so the loop runs with the hub's node.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$(dirname "$script_dir")/sprowi/cli.mjs" "$@"
