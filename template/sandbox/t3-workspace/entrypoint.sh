#!/bin/sh
set -eu

umask 077
mkdir -p "$HOME/factory" "$T3CODE_HOME"
cd "$HOME/factory"

# Ordinary headless startup prints a pairing credential and a QR code.
# The operator requests a fresh pairing link interactively when needed.
echo "Starting T3 Code on port 3773."
exec t3 serve --host 0.0.0.0 --port 3773 "$PWD" >/dev/null 2>&1
