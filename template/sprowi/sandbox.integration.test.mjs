import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Opt in on a host with authenticated sbx and Docker. This exercises the actual
// VM, kit composition, installation and proxy; no substitute sandbox executable.
test("GIVEN current sbx WHEN the verifier is created THEN v3 kits install runtimes and preserve isolation", {
  skip: process.env.SPROWI_TEST_SANDBOX !== "1" && "requires SPROWI_TEST_SANDBOX=1, Docker and authenticated sbx",
  timeout: 300000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "sprowi-v3-test-"));
  const name = `sprowi-v3-test-${process.pid}`;
  const definition = fileURLToPath(new URL("sandbox/verifier.sbxenv.yaml", import.meta.url));
  for (const folder of ["workspace", "input", "output"]) mkdirSync(join(directory, folder));
  const environment = [definition, ...Object.entries({ name, workspace: join(directory, "workspace"), input: join(directory, "input"), output: join(directory, "output"), config: join(directory, "input/config.json") }).flatMap(([key, value]) => ["--env-arg", `${key}=${value}`])];
  const agentEnvironment = [
    fileURLToPath(new URL("sandbox/agent.sbxenv.yaml", import.meta.url)),
    fileURLToPath(new URL("sandbox/codex.sbxenv.yaml", import.meta.url)),
    ...environment.slice(1), "--env-arg", "engine=codex", "--env-arg", "accountId=fixture-account",
    "--env-arg", "secretCommand=printf sprowi-fixture",
  ];
  function sbx(args) {
    const result = spawnSync("sbx", args, { encoding: "utf8", timeout: 240000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  }
  try {
    sbx(["env", "create", "--force", ...environment]);
    const output = sbx(["exec", name, "sh", "-c", `set -eu
node --version
mise --version
docker --version
test -z "\${OPENAI_API_KEY:-}"
test -z "\${ANTHROPIC_AUTH_TOKEN:-}"
if touch '${join(directory, "input/forbidden")}' 2>/dev/null; then exit 91; fi
curl -sS --max-time 15 https://api.anthropic.com
curl -sS --max-time 15 https://github.com
`]);
    assert.match(output, /v24\./);
    assert.match(output, /2026\.9\.11/);
    assert.match(output, /Docker version/);
    assert.match(output, /Blocked by local rule for api\.anthropic\.com/);
    assert.match(output, /Blocked by local rule for github\.com/);
    sbx(["env", "rm", "--force", ...environment]);
    // A built-in codex workload and our auth mixin must have distinct kit names.
    // The synthetic host credential must become a sentinel, never the value.
    sbx(["env", "create", "--force", ...agentEnvironment]);
    sbx(["exec", name, "sh", "-c", 'test -n "$OPENAI_API_KEY" && test "$OPENAI_API_KEY" != sprowi-fixture']);
  } finally {
    try { sbx(["env", "rm", "--force", "--prune-bindings", ...agentEnvironment]); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
