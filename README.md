# Startup Factory template

Share the knowledge of building and operating startups, and contribute to the
shared tooling while keeping your own portfolio in your own accounts. See the
[vision](template/VISION.md) and [contribution guide](template/CONTRIBUTING.md).

This repository contains a Copier template with an empty startup registry and
public tooling repositories. It contains no operator portfolio or account setup.

## Create a factory

Requires macOS, Git and Startup CLI v0.1.15 or newer. The public onboarding
installs the CLI, connects GitHub and creates your own Factory before the first
startup. Install only the CLI without starting a project, then create a Factory:

```bash
curl -fsSL https://deploy-your-startup.com/install.sh | bash
gh auth login -h github.com -p https -s repo,workflow,read:packages,write:packages
gh auth setup-git
startup doctor
startup factory init --project-dir my-factory --setup
cd my-factory
startup bootstrap
```

The CLI selects its pinned, supported Factory template release by default.
Use `startup factory init --help` to see the default for your installed CLI;
pass `--version <release-tag>` only to deliberately select another release.
`--setup` installs missing workspace tools through Homebrew when available,
installs the declared mise runtimes and clones the public tooling.
Without Homebrew, follow the printed prerequisites
and rerun the same command. Existing Factory files survive retries. Initializing
the workspace creates no cloud resources. Bootstrap shows provider costs and
asks before creating the application and infrastructure.

Review the generated README, initialize Git and commit the files including
`.copier-answers.yml` before updating the template. Startups created in
`projects/startups` are registered automatically once their Git remote exists,
including when bootstrap needs to resume. Deployment status remains unset until
live verification. Sprowi is included but setup is optional:
`mise exec -- ./scripts/init.sh --with-sprowi`.

Sprowi includes daily startup discovery with either Claude or Codex: dated public
research, three reviewed and ranked bets, explicit owner feedback and private
history. Proposals focus on small websites and web apps with a useful first flow,
a planned Factory deployment/distribution path and measurable real usage. The
first test includes a small build; paper-only exercises are not the default.
Discovery describes these plans and does not build or deploy them automatically.
`scripts/sprowi.sh discover schedule` previews an optional macOS job;
`--install` enables it after owner authorization. No Codex app is required for
the Claude engine. See the generated [discovery guide](template/docs/sprowi.md#daily-discovery-with-claude-or-codex)
for prerequisites, research-source limits and verification boundaries.
An opt-in reading export creates a linked `discovery/` morning overview and
dated proposals. It can commit and push those copies to the owner's explicitly
configured private GitHub repository for reading on a phone, with the same
workflow for Claude and Codex. Nothing is exported or published by default;
see [reading editions](template/docs/sprowi.md#reading-the-ideas-away-from-your-computer).

## Update an existing factory

From the factory's clean, committed Git root:

```bash
startup template update --version <release-tag> --dry-run
startup template update --version <release-tag>
```

Review changes, resolve conflicts, run `mise run test` and commit the new answers.
The registry and Sprowi configuration are owner-managed and preserved. Their new
defaults must be reviewed manually. Applications and deployment roles have
separate update paths described in the generated README.

For an existing workspace without Copier metadata, adopt an explicit baseline
with `startup template adopt --template <template-source> --version <baseline>`.
Adoption only records the baseline; it does not apply prior template changes.
Review differences deliberately before claiming the workspace matches a release.

## Contribute and release

Edit the files under `template/`. Render the candidate into a disposable Git
repository and test creation plus updates from the previous release, including
preservation of owner configuration and custom files. Never add personal startup
lists, account identifiers, secrets or production context to this source.

Use an immutable Git release tag for distribution. Before publishing, verify
README commands against the released CLI and its pinned Factory default in a
complete quickstart, verify public release refs and download URLs, review the
license and run the lifecycle checks. No release is implied by a local render.
