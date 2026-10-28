# Factory agent instructions

This hub holds the registry, scripts and optional Sprowi configuration;
application code lives in separate repositories under `projects/`.
Read [VISION.md](VISION.md) before product, design or positioning changes.
Keep personal portfolio data out of shared templates.

## Start with the task

- Questions, reviews and planning: inspect local files; no automatic sync.
- Code changes: inspect status and the target repository's `AGENTS.md`, then
  sync only affected repositories with `scripts/sync.sh --project <name>`
  (repeatable), or `--hub` for this hub. Preserve existing changes. If sync
  fails, report it and distinguish local work from verified upstream state.
  Verify the intended base before creating a branch or worktree.
- Portfolio maintenance: use `scripts/sync.sh --all`. Add `--verbose` for
  per-repository details. No arguments retains full sync for compatibility.
- New machine: `scripts/init.sh`. Sync does not apply template releases.

## Read details when needed

Read only the sources relevant to the task, before taking the corresponding
operation. Fix shared rules at their source instead of duplicating them here.

| Task | Source |
|---|---|
| Code changes, checks, completion evidence | [Testing policy](docs/testing-policy.md) and the target repository's `AGENTS.md` |
| Registry, setup, Git policy, template updates and portfolio operations | [Operations](docs/operations.md) |
| Deployment, secrets, clusters, backups, upgrades and legal onboarding | `deploy-your-startup` skill; read before operating infrastructure |
| Sprowi runs and publishing | [Sprowi](docs/sprowi.md); require owner authorization |

`projects.yaml` is the registry source of truth. Verify Actions, DNS, HTTPS and
cluster access before setting deployment fields. Run `mise run registry:check`
after registry changes. Use `mise -C <project> run <task>` for project runtimes.

Before completing code changes, run lint and all local tests, including browser
E2E where available; record failures and skips. Run `mise run test` for this hub.

Ask before destructive operations, secret rotation, force-pushes, restores, and
VM or cluster changes. Never log or commit secrets, infer private addresses, or
claim public launch readiness with legal or security gaps. Local checks do not
prove production deployment.
