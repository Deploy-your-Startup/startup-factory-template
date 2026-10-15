# Factory template development

This repository is the sole source of the reusable Factory template. Edit shared
workspace files in `template/`; `copier.yml` defines rendering and preservation.
Owner portfolios consume tagged releases through Copier. Never copy an owner's
registry, configuration, tasks, secrets or Git history into this repository.
Read [VISION.md](template/VISION.md) and the generated
[agent instructions](template/AGENTS.md) before changes.

Follow [Testing policy and completion evidence](template/docs/testing-policy.md).
Every behavior change needs integration tests; user flows need E2E tests of the
real CLI and real Git repositories. Use GIVEN / WHEN / THEN. Do not mock our own
code. Keep formatting separate from checking; do not introduce Git hooks.

Run `mise run test`. Install the published Startup CLI v0.1.15 with its Copier
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
