#!/bin/sh
set -eu

umask 077
case "${T3_WORKSPACE_PROFILE:-factory}" in
  factory) checkout="$HOME/factory" ;;
  startup) checkout="$HOME/project" ;;
  *) echo "Unknown T3 workspace profile." >&2; exit 1 ;;
esac
mkdir -p "$checkout" "$T3CODE_HOME"
cd "$checkout"

# Ordinary headless startup prints a pairing credential and a QR code.
# The operator requests a fresh pairing link interactively when needed.
echo "Starting T3 Code on port 3773."
exec t3 serve --host 0.0.0.0 --port 3773 "$PWD" >/dev/null 2>&1
