#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# Reuse the shipped test dependency without creating a venv inside the template.
export UV_PROJECT_ENVIRONMENT="$root/.venv"
exec uv run --locked --project "$root/template" python "$root/template/scripts/test.py" --root "$root"
