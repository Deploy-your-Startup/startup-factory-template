# Contribute what you learn

Everyone can contribute useful defaults, fixes, tests and documentation. The
`tooling` entries in `projects.yaml` point to the public source repositories;
`./scripts/init.sh` makes their code available locally. Read the relevant
repository's AGENTS.md and contributor documentation first.

Choose the repository that owns the change. Create a branch from its current
main and run its checks. With write access, push the branch to that repository
and open a pull request.
Never push personal application code or portfolio data into a tooling repository.

For Factory improvements, use the template source recorded as `_src_path` in
`.copier-answers.yml`. Work on that source's `template/` files, test a generated
workspace and open your PR there. After the PR is merged and included in a
release, other Factory owners can adopt your improvement with
`startup template update --version <release-tag>`.

Turn personal experience into neutral, reproducible examples. Exclude startup
names, private domains, production contexts, account IDs, credentials and task
history. Share the explanation and the reusable improvement. Add integration and
E2E coverage for affected behavior and state any remaining verification gaps.
