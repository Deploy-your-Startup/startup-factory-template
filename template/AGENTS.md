# Factory agent instructions

Help the owner build, ship and validate ideas using this workspace. It holds the
registry, scripts and optional Sprowi configuration; application code lives in
the repositories under `projects/`. Read [VISION.md](VISION.md): share reusable
knowledge, invite contributions, and never publish personal startup lists,
domains, production contexts, tasks, credentials or machine settings as
template data.

Before completing code changes, run lint and all tests locally, including
browser E2E where available. Record failures and skips.

Read `run_e2e` in `.github/workflows/`: `false` means local E2E only,
`true` also runs it in CI. Dependabot PRs always run E2E in CI.

## Where the rules live

| Topic | Source |
|---|---|
| Tests and completion claims | [Testing policy and completion evidence](docs/testing-policy.md) |
| Deploying, secrets, shared clusters, legal onboarding | the `deploy-your-startup` skill (`startup skills install`) |
| A project's services, commands and ADRs | its own `AGENTS.md` under `projects/startups/<name>/` or `projects/tooling/<name>/` |
| Contributing to the shared tooling | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Sprowi, the optional agent loop | [docs/sprowi.md](docs/sprowi.md) |

Do not restate those rules here. When one is wrong or missing, improve it at its
source and contribute it back. After each launch, turn recurring issues into
concise rules and integration or E2E checks in the owning CLI, shared workflow or
template; update existing guidance instead of writing launch reports.

## Registry

`projects.yaml` records this owner's startups and the public tooling
repositories. Read it with `scripts/registry.sh`; never run setup against an
unreviewed registry. Set `deployed`, `url` and `kubectl_context` only after
verifying Actions, DNS, HTTPS and cluster access, with one context and the right
namespace per startup. Keep the tooling list so everyone can inspect, fork and
contribute; do not assume upstream write access.

`scripts/init.sh` clones registered repositories and `scripts/sync.sh` pulls
existing checkouts, pointing origin at a moved repository's registered URL when
it shares history; neither applies a Factory release. `mise run registry:check`
(also run by `sync.sh`) fails on drift: unregistered or missing checkouts, a
different origin, or a `url`/`kubectl_context` without `deployed: true`. Resolve
each by registering, cloning or removing; a startup without a cluster, such as a
Cloudflare Pages site, has `deployed` and `url` but no `kubectl_context`. `mise tasks --all` lists
every repository's tasks; run them with `mise -C <project> run <task>`. Run
`mise run test` for the Factory's own checks.

`.claude/settings.json` enables the public `startup-factory` Claude Code mod from
[Deploy-your-Startup/startup-factory-mod](https://github.com/Deploy-your-Startup/startup-factory-mod):
a `/factory` pane with website status, pod health and git state read from this
registry. Accurate `url`, `deployed` and `kubectl_context` values keep it correct.

## Operating startups

Use the `startup` CLI for Vault, Ansible, provisioning, deployment, sync and
template updates; never run Ansible directly or edit `deployment/.shared-roles`.

- New startups: agree on the project and budget first, then run
  `startup bootstrap --output-dir projects/startups` and register the actual Git
  remote, also after a partial bootstrap. Do not delete an interrupted project;
  bootstrap resumes it.
- Updates: `startup template update --version <release> --dry-run` in a clean
  repository, then apply, review, test and commit `.copier-answers.yml`. Factory
  updates preserve the registry and Sprowi configuration. `startup sync` updates
  shared deployment roles separately and does not advance existing role pins.
- Shared clusters: each application records its cluster in
  `deployment/cluster.yml` (`owner`, `nodes`) and `startup_cluster_owner`
  (`deployment/group_vars/all.yml`). Read them before checking pods, capacity or
  nodes; query each startup in its own namespace and treat node load, outages and
  maintenance as affecting every attached startup.

## Guardrails

- Ask before destructive operations: deleting resources, rotating secrets,
  force-pushing, restores, VM or cluster changes. Sprowi runs and publishing
  also need the owner's authorization.
- Before any VM, OS or cluster upgrade, verify fresh database, media and cluster
  backups plus a provider recovery snapshot. Never reopen Kubernetes API access
  to work around a client problem.
- Secrets go through stdin and the Keychain; never put them in process
  arguments, logs or tracked files.
- Never infer an operator's private address or call a startup ready for public
  launch while legal or security gaps remain.
- Report what you verified; local checks do not prove a production deployment.
