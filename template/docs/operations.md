# Factory operations

Help the owner build, ship and validate ideas using this workspace. It holds the
registry, scripts and optional Sprowi configuration; application code lives in
the repositories under `projects/`. Read [VISION.md](../VISION.md): share reusable
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
| Tests and completion claims | [Testing policy and completion evidence](../docs/testing-policy.md) |
| Deploying, secrets, shared clusters, legal onboarding | the `deploy-your-startup` skill (`startup skills install`) |
| A project's services, commands and ADRs | its own `AGENTS.md` under `projects/startups/<name>/` or `projects/tooling/<name>/` |
| Contributing to the shared tooling | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Sprowi, the optional agent loop | [docs/sprowi.md](../docs/sprowi.md) |

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
`evidence_repo` names the private `OWNER/NAME` repository for pull request
review screenshots; `startup evidence upload` creates it on first use and prints
the links to embed, so screenshots never enter code history.

Choose the sync scope from [the session rules](../AGENTS.md). Local `main` may be stale; verify the base before creating a worktree.

`scripts/init.sh` clones registered repositories and `scripts/sync.sh` pulls
existing checkouts, pointing origin at a moved repository's registered URL when
it shares history; neither applies a Factory release. `mise run registry:check`
(also run by full sync) fails on drift: unregistered or missing checkouts, a
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

Use the `startup` CLI for Vault, Ansible, provisioning, deployment, shared
deployment and template updates; never run Ansible directly or edit `deployment/.shared-roles`.

- New startups: agree on the project and budget first, then run
  `startup bootstrap --output-dir projects/startups` and register the actual Git
  remote, also after a partial bootstrap. Do not delete an interrupted project;
  bootstrap resumes it.
- Updates: `startup template update --version <release> --dry-run` in a clean
  repository, then apply, review, test and commit `.copier-answers.yml`. Factory
  updates preserve the registry and Sprowi configuration. For all registered
  startups, preview with `scripts/update-templates.sh`, then apply locally with
  `scripts/update-templates.sh --apply`.
- Shared roles and workflows: each startup runs one immutable release of the
  public `Deploy-your-Startup/deploy` and changes only when told to.
  `startup update --check` in a startup shows its release and a newer one,
  `startup update` adopts it, `startup update --version <release>` selects one
  or goes back. It edits the role pin and workflow references and deploys
  nothing: review, commit and push to roll out, one startup first.
  Pages projects use the same commands; their workflow references are the pin.
  The scripts require a CLI with `update --project-dir` and stop before changes
  when an older installation is selected.
  `scripts/update-deployments.sh` shows every registered startup's release and
  `--apply` moves the clean checkouts locally. A startup that still calls a
  per-owner `deploy-your-startup` copy moves once with `startup migrate deploy`.
- Shared clusters: each application records its cluster in
  `deployment/cluster.yml` (`owner`, `nodes`) and `startup_cluster_owner`
  (`deployment/group_vars/all.yml`). Read them before checking pods, capacity or
  nodes; query each startup in its own namespace and treat node load, outages and
  maintenance as affecting every attached startup.

## Guardrails

- Ask before destructive operations: deleting resources, rotating secrets,
  force-pushing, restores, VM or cluster changes. Sprowi runs and publishing
  also need the owner's authorization.
- Before package updates (`update-vms`), OS upgrades or cluster upgrades, run
  `startup ansible backup --working-directory <project>/deployment --environment production`
  for every startup on the cluster, attached ones included. Verify the downloaded
  database, Django and media backups. Use this CLI command for application backups.
- Package updates need no provider snapshot. Before OS or cluster upgrades,
  additionally verify a cluster-state backup and a provider recovery snapshot.
  The k3s upgrade role creates an etcd snapshot before upgrading; application
  backups, cluster-state backups and provider snapshots cover different recovery
  needs.
- Never reopen Kubernetes API access to work around a client problem.
- Secrets go through stdin and the Keychain; never put them in process
  arguments, logs or tracked files.
- Never infer an operator's private address or call a startup ready for public
  launch while legal or security gaps remain.
- Report what you verified; local checks do not prove a production deployment.

## Sync scopes and output

For read-only questions and planning, use local files without pulling repositories.
Before code changes, inspect the affected checkout and run
`scripts/sync.sh --project <registered-name>`; repeat `--project` for multiple
repositories, and add `--hub` when changing the hub. Select names exactly as
registered in `projects.yaml`. All selections are validated before any sync.
Scoped runs do not check unrelated registry entries; run `mise run registry:check`
after registry edits. `scripts/sync.sh --all` (or no arguments) syncs the entire
portfolio and checks registry drift.

Successful runs print one summary; `--verbose` adds repository details. Errors
and skips are always visible and return nonzero. Dirty checkouts (including
untracked files) and detached HEADs are skipped without changing their work.
A missing remote branch or inaccessible origin fails explicitly without switching
branches. Inspect the intended base and resolve these conditions before claiming
that a checkout is current. A registered origin migration still requires shared
history. Sync does not install a Factory template release.
