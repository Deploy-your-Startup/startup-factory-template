# Factory template development

This repository is the sole source of the reusable Factory template. Edit shared
workspace files in `template/`; `copier.yml` defines rendering and preservation.
Owner portfolios consume tagged releases through Copier. Never copy an owner's
registry, configuration, tasks, secrets or Git history into this repository.
Read [VISION.md](template/VISION.md) and the generated
[agent instructions](template/AGENTS.md) before changes.

Follow [Testing policy and completion evidence](template/docs/testing-policy.md);
user flows are tested end to end with the real CLI and real Git repositories.

Run `mise run test`. Install the published Startup CLI v0.1.17 with its Copier
dependency first. Set `FACTORY_TEST_PYTHON` to that installation's Python when it
is not the default `python3`. Set `STARTUP_TEST_EXECUTABLE` to its actual console
entrypoint when a launcher depends on HOME. CI installs the pinned CLI directly.
The suite validates privacy, renders a workspace, adopts an existing workspace,
previews and applies updates, preserves owner configuration and customizations,
and runs the generated workspace's integration tests.

These offline tests do not establish real GitHub OAuth, macOS Keychain, cloud
provisioning, paid engines or Docker Sandbox execution. Report uncovered flows
and failed/skipped checks. Keep the separate CLI's required macOS onboarding E2E
gate enabled. Before release, review documentation, license, CLI compatibility,
public refs and template contents together. Use immutable release tags.

## User-facing writing

Write Factory READMEs, setup instructions and command output for people using
the Factory, not for its maintainers. Keep them short: explain the benefit,
what happens automatically and the next action the user needs to take.
Keep contribution workflows and implementation details in contributor docs;
include them in user instructions only when needed to complete a task.
Describe available behavior accurately; do not present planned skills or
integrations as released features.
