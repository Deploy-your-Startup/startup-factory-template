#!/bin/bash
# sync.sh — pull startup-factory + all project repos
set -uo pipefail

if [ -f "$HOME/.zshrc" ]; then
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(dirname "$script_dir")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo "=== startup-factory sync ==="
echo ""

updated=0
already_current=0
skipped_missing=0
failed=0

pull_repo() {
  local name="$1"
  local target_dir="$2"

  if [ ! -d "$target_dir" ]; then
    echo -e "  ${YELLOW}⊘${NC} $name — directory missing, run init.sh to clone"
    skipped_missing=$((skipped_missing + 1))
    return
  fi

  local branch
  branch=$(git -C "$target_dir" branch --show-current 2>/dev/null || echo "")
  if [ -z "$branch" ]; then
    echo -e "  ${YELLOW}⊘${NC} $name — detached HEAD, skipping"
    return
  fi

  local dirty=""
  if ! git -C "$target_dir" diff --quiet 2>/dev/null || \
     ! git -C "$target_dir" diff --cached --quiet 2>/dev/null; then
    dirty=" ${YELLOW}(dirty)${NC}"
  fi

  local before_hash
  before_hash=$(git -C "$target_dir" rev-parse --short HEAD 2>/dev/null || echo "")

  echo -ne "  ⟳ $name ($branch)$dirty — pulling... "

  local pull_output
  if pull_output=$(git -C "$target_dir" pull --rebase origin "$branch" --quiet 2>&1); then
    local after_hash
    after_hash=$(git -C "$target_dir" rev-parse --short HEAD 2>/dev/null || echo "")
    if [ "$before_hash" != "$after_hash" ]; then
      echo -e "${GREEN}updated${NC} ($before_hash → $after_hash)"
      updated=$((updated + 1))
    else
      echo -e "${CYAN}already up to date${NC}"
      already_current=$((already_current + 1))
    fi
  else
    echo -e "${RED}failed${NC}"
    [ -z "$pull_output" ] || printf '    %s\n' "$pull_output"
    failed=$((failed + 1))
  fi
}

# Phase 1: Hub-Repo selbst
echo "Hub repo:"
hub_branch=$(git -C "$root_dir" branch --show-current 2>/dev/null || echo "")
if [ -n "$hub_branch" ]; then
  before=$(git -C "$root_dir" rev-parse --short HEAD 2>/dev/null || echo "")
  echo -n "  ⟳ startup-factory ($hub_branch) — pulling... "
  if pull_output=$(git -C "$root_dir" pull --rebase origin "$hub_branch" --quiet 2>&1); then
    after=$(git -C "$root_dir" rev-parse --short HEAD 2>/dev/null || echo "")
    if [ "$before" != "$after" ]; then
      echo -e "${GREEN}updated${NC} ($before → $after)"
      updated=$((updated + 1))
    else
      echo -e "${CYAN}already up to date${NC}"
      already_current=$((already_current + 1))
    fi
  else
    echo -e "${RED}failed${NC}"
    [ -z "$pull_output" ] || printf '    %s\n' "$pull_output"
    failed=$((failed + 1))
  fi
fi
echo ""

# Phase 2: Alle Projekt-Repos
registry_startups="$("$script_dir/registry.sh" startups)" || exit 1
registry_tooling="$("$script_dir/registry.sh" tooling)" || exit 1

echo "Startups:"
while IFS=$'\t' read -r name _repo _deployed _ctx; do
  [ -n "$name" ] || continue
  pull_repo "$name" "$root_dir/projects/startups/$name"
done <<< "$registry_startups"

echo ""
echo "Tooling:"
while IFS=$'\t' read -r name _repo; do
  [ -n "$name" ] || continue
  pull_repo "$name" "$root_dir/projects/tooling/$name"
done <<< "$registry_tooling"

# Summary
echo ""
echo "=== Summary ==="
echo -e "  ${GREEN}Updated:${NC}         $updated"
echo -e "  ${CYAN}Already current:${NC} $already_current"
[ "$skipped_missing" -gt 0 ] && echo -e "  ${YELLOW}Missing (→ run init.sh):${NC} $skipped_missing"
[ "$failed" -gt 0 ] && echo -e "  ${RED}Failed:${NC}          $failed"
echo ""

# Pulling cannot notice unregistered or mismatched checkouts; report them here.
echo "Registry:"
drift=0
"$script_dir/registry.sh" check || drift=1
echo ""
if [ "$failed" -gt 0 ] || [ "$drift" -gt 0 ]; then
  exit 1
fi
