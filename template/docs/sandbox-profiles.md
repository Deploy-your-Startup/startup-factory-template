# Shared sandbox profiles

Factory agents share the versioned Node/mise runtime and network boundary in
`sandbox/kits/`. Each run still creates its own VM and checkout. A shared kit
is a recipe, never a shared live session, credential store or writable volume.

| Profile | Entry point | Tools and access |
| --- | --- | --- |
| Coding | `scripts/coding-sandbox.sh --profile coding` | Shared runtime, public image downloads, locked Factory CLI and kubectl; no host credentials or direct GitHub/infra access |
| Marketing drafts | `scripts/coding-sandbox.sh --profile marketing` | Shared runtime and boundary; no Factory CLI, cluster tools, posting integrations or host credentials |
| Sprowi agent | `scripts/sprowi.sh run` / `discover run` | Shared runtime and image access plus the selected engine credential through its host proxy |
| Sprowi verifier | Created separately by Sprowi | Same runtime and image access; no model credentials, provider access denied |

The marketing profile is a draft workspace, not an autonomous marketing bot.
It accepts the same registered target selection and returns changes as a patch.
It does not schedule work, send messages, publish content or deploy. Those actions
need explicit owner authorization and a separate, scoped host integration.

Sprowi retains its read-only trusted input mount, disposable verification baseline,
patch policy and host-side publishing. It does not load interactive MCP tools or
the Factory CLI kit. Interactive coding retains its VM-local Git archive rather
than exposing the owner's working directory. Model and browser sessions are never
reused between profiles.

To add another role, compose the shared kits and a narrowly scoped role overlay.
Do not add credentials or service integrations to the shared kits. Keep service
credentials proxy-managed on the host; verifier profiles must remain credential-free.
New outbound publishing capabilities require their own authorization checks and
integration tests. Public network access is not permission to post or contact people.

Tests: `scripts/tests/sandbox-profiles.test.mjs` exercises actual profile composition
with stand-ins for external Docker/sbx commands. Existing coding and Sprowi sandbox
integration tests cover live isolation when explicitly enabled on an authenticated
host; offline composition checks do not establish actual network enforcement.
