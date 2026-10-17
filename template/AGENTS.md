# Factory agent instructions

Help the owner build, ship and validate ideas using this workspace. Read
[VISION.md](VISION.md): share reusable knowledge and invite contributions to the
shared tooling. Never publish personal startup lists, domains, production
contexts, tasks, credentials or private machine configuration as template data.

## Registry and ownership

`projects.yaml` records this owner's startups and the public tooling repositories.
Application repositories live under `projects/startups/<name>/`; tooling lives
under `projects/tooling/<name>/`. Read each repository's AGENTS.md before changes.
Keep the tooling list available so everyone can inspect, fork and contribute.
Do not assume write access to upstream repositories. Follow CONTRIBUTING.md.

Use `scripts/registry.sh` to read the registry. Run `scripts/init.sh` to clone
registered repositories, and `scripts/sync.sh` to pull existing checkouts. Neither
command applies a new Factory template release. Never run setup against an
unreviewed registry. Verify `url`, `deployed` and `kubectl_context` against live
state before adding them; keep one context with the right namespace per startup.

Several startups can share one cluster. Each application repository records its
cluster in `deployment/cluster.yml` (`owner`, `nodes`) and in
`startup_cluster_owner` (`deployment/group_vars/all.yml`). Read these before
checking pods, capacity or nodes: contexts of a shared cluster reach the same
nodes, so query each startup in its own namespace and treat node load, outages
and maintenance as affecting every attached startup.

## Creating and updating projects

Use `startup bootstrap --output-dir projects/startups` from the workspace root.
Provisioning incurs provider costs; agree on the project and budget first. After
creation (including partial bootstrap), record the actual Git remote in the
registry. Verify GitHub Actions, DNS and HTTPS before claiming deployment success.
Do not remove an interrupted project: bootstrap supports resuming it.

Use `startup` for deployment, Ansible and Vault operations. Install its bundled
skill with `startup skills install`. Never use raw Ansible or manually edit
`deployment/.shared-roles`. Secret input uses stdin and the macOS Keychain; never
put credentials in process arguments, logs or tracked files. Preview secret
changes with `--dry-run`; obtain confirmation before destructive actions,
credential rotation, force-pushing or infrastructure removal.

Factory and application updates use `startup template update --version <release>
--dry-run` in the relevant clean repository, followed by the actual update, diff
review, conflict resolution and tests. Commit `.copier-answers.yml`. Owner registry
and Sprowi configuration are seeded once and preserved by Factory updates. Review
new defaults manually when releases change those files.

`startup sync` separately updates shared deployment roles/workflows in the owner's
account. Preview first and select a reviewed source release. Existing application
role pins do not advance automatically. Verify fresh database, media and cluster
backups plus a provider recovery snapshot before any VM, OS or cluster upgrade.
Never reopen Kubernetes API access to work around a client connection problem.

## Tests and local runtimes

Follow [Testing policy and completion evidence](docs/testing-policy.md).
Every behavior change needs integration tests of the real command, repository or
application; changed user flows also need E2E tests. Use explicit GIVEN / WHEN /
THEN. Replace only external boundaries, never our own code. Unit tests supplement
these checks only for complex algorithms. Report failures, skipped checks and
uncovered flows honestly; green checks do not prove a live deployment.

Use `mise -C <project> run <task>` or `mise -C <project> exec -- ...` for the
project's runtime. `mise tasks --all` lists tasks across the portfolio. Install
`uv` globally; Python services own their `.python-version`. Keep formatting and
lint separate: `make.sh format` writes, `make.sh lint` checks only. CI is the gate;
do not add Git hooks. Run `mise run test` for the Factory's local checks.

## Public launch

Before a public launch, collect missing publication-approved operator name,
postal address and contact details together. Never infer a private address.
Prepare disclosures matching actual hosting, login, analytics and processing;
generic legal text is a draft. Keep optional analytics disabled until disclosures
are reviewed. Use supported site-policy configuration and local consent controls;
no extra consent-service account is required. Test rejection, acceptance and
withdrawal as well as anonymous/other-account access, CSRF, throttling and quotas.
Record legal or security gaps and do not claim launch readiness while they remain.

## Optional Sprowi

Sprowi is opt-in: `scripts/init.sh --with-sprowi`. Its configuration, tasks and
experiments belong to this owner. The stable `startup-factory` target refers to
this hub regardless of its directory name. See docs/sprowi.md for budgets, sandbox
boundaries and publishing. Never run an engine or publish without authorization.

No personal plugin or agent settings are shipped with this workspace.
