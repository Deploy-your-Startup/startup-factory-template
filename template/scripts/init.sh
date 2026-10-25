#!/bin/bash
set -euo pipefail

# Preserve the runtime selected by mise and the CLI launcher.
if [ -f "$HOME/.zshrc" ]; then
  export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(dirname "$script_dir")"
projects_yaml="$root_dir/projects.yaml"

has_tty() { { : </dev/tty; } 2>/dev/null; }

with_sprowi=0
for argument in "$@"; do
  case "$argument" in
    --with-sprowi) with_sprowi=1 ;;
    -h|--help)
      printf 'Usage: %s [--with-sprowi]\n\n' "$(basename "$0")"
      printf '  --with-sprowi  also set up Sprowi, the agent loop (beta): Docker Sandboxes\n'
      printf '               and the engine credential. See docs/sprowi.md.\n'
      exit 0
      ;;
    *)
      printf 'unknown option: %s (try --help)\n' "$argument" >&2
      exit 1
      ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo "=== startup-factory init ==="
echo ""

# --- Phase 1: Tool-Check ---
echo "Checking required tools..."
missing=0

for tool in startup uv gh git yq mise; do
  if command -v "$tool" &>/dev/null; then
    version=$("$tool" --version 2>/dev/null | head -1 || echo "installed")
    echo -e "  ${GREEN}✓${NC} $tool ($version)"
  else
    echo -e "  ${RED}✗${NC} $tool — not found in PATH"
    missing=$((missing + 1))
  fi
done

# Optional: only needed to inspect a startup's Kubernetes cluster yourself.
# Bootstrap, deployment and landing pages work without it.
if command -v kubectl &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} kubectl ($(kubectl version --client 2>/dev/null | head -1)) — optional"
else
  echo "  - kubectl — optional, only to inspect a full-stack startup's cluster (brew install kubectl)"
fi

# Optional: only projects in private network mode need it, and the startup CLI
# says so itself when one does.
if command -v tailscale &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} tailscale ($(tailscale version 2>/dev/null | head -1)) — optional"
else
  echo "  - tailscale — optional, needed for startups in private network mode (brew install tailscale)"
fi

echo ""

if [ "$missing" -gt 0 ]; then
  echo -e "${RED}$missing required tool(s) missing. Please install them before continuing.${NC}"
  echo ""
  echo "Install hints:"
  echo "  startup:  uv tool install --python 3.14 'git+https://github.com/Deploy-your-Startup/cli.git@v0.1.17'"
  echo "  uv:       curl -LsSf https://astral.sh/uv/install.sh | sh"
  echo "  gh:       brew install gh"
  echo "  yq:       brew install yq"
  echo "  mise:     brew install mise"
  exit 1
fi

echo -e "${GREEN}All tools available.${NC}"
echo ""

# Read the registry before installing skills or cloning anything. Command
# substitution lets a parse error stop init instead of looking like no projects.
registry_startups="$("$script_dir/registry.sh" startups)" || exit 1
registry_tooling="$("$script_dir/registry.sh" tooling)" || exit 1
registry_deployed="$("$script_dir/registry.sh" deployed)" || exit 1

# --- Phase 2: Install CLI and hub skills ---
# A first-time setup may have no coding agent yet; that is not an error.
has_agent=0
for agent_dir in .claude .codex .config/opencode; do
  [ -d "$HOME/$agent_dir" ] && has_agent=1
done
if [ "$has_agent" -eq 1 ]; then
  echo "Installing the CLI's deploy-your-startup skill..."
  if ! startup skills install; then
    echo -e "${YELLOW}CLI skill installation failed. Resolve the error above and rerun startup skills install.${NC}"
  fi
else
  echo "  - No coding agent found. After installing one, run: startup skills install"
fi

echo "Installing startup-factory skills..."

if command -v npx &>/dev/null; then
  for skill in sprowi-task; do
    echo -n "  ⟳ $skill — installing... "
    if npx --yes skills add "$root_dir" --skill "$skill" -a claude-code -a codex -a opencode --copy -y >/dev/null 2>&1; then
      echo -e "${GREEN}done${NC}"
    else
      echo -e "${RED}failed${NC}"
    fi
  done
else
  echo -e "  ${YELLOW}⊘${NC} npx — skipping skill installation"
fi

echo ""

# --- Phase 3: Clone projects ---
echo "Cloning projects from $projects_yaml..."
echo ""

cloned=0
skipped=0
failed=0

clone_repo() {
  local name="$1"
  local repo="$2"
  local target_dir="$3"

  if [ -d "$target_dir" ]; then
    echo -e "  ${YELLOW}⊘${NC} $name — already exists, skipping"
    skipped=$((skipped + 1))
  else
    echo -n "  ⟳ $name — cloning... "
    if git clone --quiet "$repo" "$target_dir"; then
      echo -e "${GREEN}done${NC}"
      cloned=$((cloned + 1))
    else
      echo -e "${RED}failed${NC}"
      failed=$((failed + 1))
    fi
  fi
}

# Parse projects section
echo "Startups:"
while IFS=$'\t' read -r name repo _deployed _ctx; do
  [ -n "$name" ] || continue
  clone_repo "$name" "$repo" "$root_dir/projects/startups/$name"
done <<< "$registry_startups"

echo ""
echo "Tooling:"
while IFS=$'\t' read -r name repo; do
  [ -n "$name" ] || continue
  clone_repo "$name" "$repo" "$root_dir/projects/tooling/$name"
done <<< "$registry_tooling"

# --- Summary ---
echo ""
echo "=== Summary ==="
echo -e "  ${GREEN}Cloned:${NC}  $cloned"
echo -e "  ${YELLOW}Skipped:${NC} $skipped"
if [ "$failed" -gt 0 ]; then
  echo -e "  ${RED}Failed:${NC}  $failed"
fi
echo ""
# Fail before secret setup when repositories could not be cloned.
if [ "$failed" -gt 0 ]; then
  echo "Setup incomplete: fix the clone errors and rerun scripts/init.sh." >&2
  exit 1
fi

# --- Phase 4: Vault passwords ---
# Only deployed projects have vault passwords; a new Factory has none yet.
vault_missing=0
vault_present=0

check_vault_password() {
  local name="$1"
  local service
  service="$(printf 'VAULT_PASSWORD_%s' "$name" | tr '[:lower:]-' '[:upper:]_')"

  if security find-generic-password -a "$USER" -s "$service" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $name"
    vault_present=$((vault_present + 1))
  else
    echo -e "  ${RED}✗${NC} $name — no vault password in Keychain"
    vault_missing=$((vault_missing + 1))
  fi
}

if [ -n "$registry_deployed" ]; then
  echo "Checking vault passwords for deployed projects..."
  echo ""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    check_vault_password "$name"
  done <<< "$registry_deployed"

  echo ""
  if [ "$vault_missing" -gt 0 ]; then
    echo -e "${YELLOW}$vault_missing deployed project(s) missing vault password.${NC}"
    echo ""
    if has_tty; then
      "$script_dir/secrets.sh" store-all
    else
      echo "  Secrets are entered only in an interactive terminal. Run there:"
      echo "    scripts/secrets.sh store-all"
    fi
  else
    echo -e "${GREEN}All vault passwords present.${NC}"
  fi
  echo ""
fi

# --- Phase 4b: Cluster access (optional) ---
# Connects each deployed startup's kubectl_context over an SSH tunnel so its
# pods are visible. Only useful with kubectl; nothing else depends on it.
connect_cmds=()
connect_hints=()
connect_done=()

# The master comes from the startup's cluster.yml, else from an existing
# context that still points at the server directly.
cluster_master() {
  local name="$1" context="$2" deployment="$root_dir/projects/startups/$1/deployment"
  local host="" cluster server
  if [ -f "$deployment/cluster.yml" ]; then
    host="$(yq '[.nodes[] | select(.role == "master") | .host][0] // ""' "$deployment/cluster.yml")"
  fi
  if [ -z "$host" ]; then
    cluster="$(kubectl config view -o jsonpath="{.contexts[?(@.name==\"$context\")].context.cluster}" 2>/dev/null || true)"
    server="$(kubectl config view -o jsonpath="{.clusters[?(@.name==\"$cluster\")].cluster.server}" 2>/dev/null || true)"
    host="$(printf '%s' "$server" | sed -E 's#^https?://##; s#:[0-9]+$##')"
  fi
  printf '%s' "$host"
}

context_tunneled() {
  local cluster server
  cluster="$(kubectl config view -o jsonpath="{.contexts[?(@.name==\"$1\")].context.cluster}" 2>/dev/null || true)"
  [ -n "$cluster" ] || return 1
  server="$(kubectl config view -o jsonpath="{.clusters[?(@.name==\"$cluster\")].cluster.server}" 2>/dev/null || true)"
  [[ "$server" == https://127.0.0.1:* ]]
}

if command -v kubectl &>/dev/null; then
  while IFS=$'\t' read -r name _repo deployed context; do
    [ "$deployed" = "true" ] && [ -n "$context" ] || continue
    if context_tunneled "$context"; then
      connect_done+=("$context")
      continue
    fi
    host="$(cluster_master "$name" "$context")"
    if [ -z "$host" ] || [ "$host" = "127.0.0.1" ]; then
      connect_hints+=("  $context: cd projects/startups/$name/deployment && startup ansible kubeconfig --environment production --context-name $context")
      continue
    fi
    namespace=""
    if [ -f "$root_dir/projects/startups/$name/deployment/group_vars/all.yml" ]; then
      namespace="$(yq '.k8s_namespace // ""' "$root_dir/projects/startups/$name/deployment/group_vars/all.yml")"
    fi
    connect_cmds+=("startup cluster connect --context $context --host $host${namespace:+ --namespace $namespace}")
  done <<< "$registry_startups"

  if [ "${#connect_cmds[@]}" -gt 0 ] || [ "${#connect_hints[@]}" -gt 0 ] || [ "${#connect_done[@]}" -gt 0 ]; then
    echo "Cluster access (optional, needs SSH access to each master):"
    for context in "${connect_done[@]+"${connect_done[@]}"}"; do
      echo -e "  ${GREEN}✓${NC} $context — connected over SSH"
    done
    proceed=n
    if [ "${#connect_cmds[@]}" -gt 0 ] && has_tty; then
      printf '  Connect %d cluster context(s) over SSH now? [Y/n] ' "${#connect_cmds[@]}"
      read -r proceed </dev/tty
      proceed="${proceed:-y}"
    fi
    for cmd in "${connect_cmds[@]+"${connect_cmds[@]}"}"; do
      if [ "$proceed" = y ] || [ "$proceed" = Y ]; then
        # shellcheck disable=SC2086 # registry values are single words
        $cmd || echo -e "  ${YELLOW}⊘${NC} failed: $cmd"
      else
        echo "  $cmd"
      fi
    done
    for hint in "${connect_hints[@]+"${connect_hints[@]}"}"; do
      echo "$hint"
    done
    echo ""
  fi
fi

# --- Phase 5: Sprowi (beta, opt-in) ---
if [ "$with_sprowi" -eq 1 ]; then
  echo "Setting up Sprowi, the agent loop (beta)..."
  echo ""

  sprowi_missing=0
  for tool in docker sbx mise; do
    if command -v "$tool" &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} $tool"
    else
      echo -e "  ${RED}✗${NC} $tool — not found in PATH"
      sprowi_missing=$((sprowi_missing + 1))
    fi
  done

  if [ "$sprowi_missing" -gt 0 ]; then
    echo ""
    echo -e "${RED}Sprowi needs $sprowi_missing more tool(s):${NC}"
    echo "  docker:  Docker Desktop 4.58 or newer"
    echo "  sbx:     brew install sbx"
    echo "  mise:    brew install mise"
  else
    # sbx resolves the engine credential on the host while it creates a
    # sandbox, so it has to be signed in before the first run, not during it.
    if sbx ls --json &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} sbx signed in"
    else
      echo -e "  ${YELLOW}⊘${NC} sbx not signed in"
      if has_tty; then
        printf '    Run `sbx login && sbx policy init balanced` now? [Y/n] '
        read -r proceed </dev/tty
        case "${proceed:-y}" in
          n|N) echo "    skipped — run it before the first Sprowi run" ;;
          *) sbx login && sbx policy init balanced ;;
        esac
      else
        echo "    Run: sbx login && sbx policy init balanced"
      fi
    fi

    echo ""
    # The engine and its Keychain service name both come from the Sprowi config,
    # so there is no second place where these names could drift.
    default_engine="$(yq -r '.engine' "$root_dir/sprowi/config.default.json")"
    echo "  Engine credentials (one is enough; the default engine is $default_engine):"

    # A newline-separated list rather than arrays: macOS ships bash 3.2, where
    # expanding an empty array under `set -u` is an error.
    sprowi_present=0
    sprowi_missing=""
    while IFS=$'\t' read -r engine service; do
      if security find-generic-password -a "$USER" -s "$service" >/dev/null 2>&1; then
        echo -e "    ${GREEN}✓${NC} $engine ($service)"
        sprowi_present=$((sprowi_present + 1))
      else
        echo -e "    ${YELLOW}⊘${NC} $engine ($service) — not in the Keychain"
        # The default engine goes first, so a fresh machine is offered the one
        # credential it actually needs before any of the alternatives.
        entry="$engine"$'\t'"$service"$'\n'
        if [ "$engine" = "$default_engine" ]; then
          sprowi_missing="$entry$sprowi_missing"
        else
          sprowi_missing="$sprowi_missing$entry"
        fi
      fi
    done < <(yq -r '.engines | to_entries[] | [.key, .value.credential.service] | @tsv' "$root_dir/sprowi/config.default.json")

    if [ "$sprowi_present" -eq 0 ]; then
      echo ""
      echo "  The canonical values live in the Passwords app under exactly these"
      echo "  names, like the vault passwords: on another machine you import them"
      echo "  from there instead of creating new ones. The Keychain entry is only"
      echo "  this machine's copy, and sbx is the only thing that reads it."
      echo ""
      echo "  Nothing in Passwords yet? The default engine's token is minted once:"
      claude_service="$(yq -r '.engines.claude.credential.service' "$root_dir/sprowi/config.default.json")"
      echo "    claude setup-token     # then save it in Passwords as $claude_service"
      echo ""

      # A secret is only ever entered interactively on the owner's Mac, never
      # from a non-interactive (agent) session.
      if ! has_tty; then
        echo "  Not an interactive terminal — import them yourself:"
        while IFS=$'\t' read -r engine service; do
          [ -n "$service" ] || continue
          echo "    security add-generic-password -U -a \"\$USER\" -s $service -T \"\" -w"
        done <<< "$sprowi_missing"
      else
        open -a Passwords >/dev/null 2>&1 || true
        while IFS=$'\t' read -r engine service; do
          [ -n "$service" ] || continue
          default_answer="n"
          prompt="[y/N]"
          if [ "$engine" = "$default_engine" ]; then
            default_answer="y"
            prompt="[Y/n]"
          fi
          printf '  Import %s from Passwords now? %s ' "$service" "$prompt"
          read -r proceed </dev/tty
          case "${proceed:-$default_answer}" in
            y|Y) ;;
            *) echo "    skipped $service"; continue ;;
          esac
          echo "    Copy the value of \"$service\" from Passwords, then paste it below."
          # `security` reads the value from its own hidden prompt, so the secret
          # is never a shell variable and never appears in the argument list —
          # unlike passing it as -w <value>. It asks twice, to confirm.
          # -T "" trusts no application: every read shows a macOS dialog, which
          # is one confirmation per Sprowi run and deliberate.
          if security add-generic-password -U -a "$USER" -s "$service" -T "" -w; then
            echo -e "    ${GREEN}✓${NC} imported $service"
            echo "    That is enough to run Sprowi; the other engines stay optional."
            break
          fi
          echo -e "    ${RED}✗${NC} $service not stored"
        done <<< "$sprowi_missing"
      fi
    fi

    echo ""
    echo "  Next: scripts/sprowi.sh init <project> && scripts/sprowi.sh check <project>"
  fi
  echo ""
fi

echo "Done! Projects are in $root_dir/projects/"
if [ "$with_sprowi" -eq 0 ]; then
  echo "Sprowi (agent loop, beta) is not set up. Add --with-sprowi to include it."
fi
