import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("GIVEN a conflicting global CLI WHEN using the test runtime THEN the repository pin and explicit launcher are used", () => {
  // GIVEN a global executable that must never be used.
  const directory = mkdtempSync(join(tmpdir(), "factory-cli-runtime-"));
  try {
    writeFileSync(join(directory, "startup"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    assert.ok(process.env.FACTORY_TEST_PYTHON, "Run mise run test to use the locked runtime");
    assert.ok(process.env.STARTUP_TEST_EXECUTABLE);
    // WHEN real Python checks the installed distribution and runs the explicit launcher.
    const result = spawnSync(process.env.FACTORY_TEST_PYTHON, ["-c", `
import importlib.metadata, json, pathlib, subprocess, sys, tomllib
config = tomllib.loads(pathlib.Path(sys.argv[1]).read_text())
expected = config['tool']['uv']['sources']['deploy-your-startup-cli']['rev']
distribution = importlib.metadata.distribution('deploy-your-startup-cli')
source = json.loads(distribution.read_text('direct_url.json'))
assert source['vcs_info']['commit_id'] == expected
subprocess.run([sys.argv[2], '--help'], check=True, capture_output=True)
# GIVEN legacy metadata containing a synthetic private key, WHEN inspected through
# the locked CLI, THEN its public diagnostic never emits the credential.
marker = 'synthetic-private-key-do-not-log'
state = pathlib.Path('connection.yml').resolve()
state.write_text(json.dumps({'host': '203.0.113.10', 'ssh_user': 'root', 'ssh_port': 22, 'user': {'client-key-data': marker}}))
config = pathlib.Path('config.json').resolve()
config.write_text(json.dumps({'contexts': [{'name': 'sample', 'context': {'user': 'sample'}}], 'users': [{'name': 'sample', 'user': {'exec': {'args': ['-I', '-m', 'cli.kube_access', str(state)]}}}]}))
result = subprocess.run([sys.argv[2], 'cluster', 'inspect', '--context', 'sample', '--kubeconfig', str(config)], check=True, capture_output=True, text=True)
assert marker not in result.stdout + result.stderr
assert json.loads(result.stdout)['credential_storage'] == 'legacy-local'

`, fileURLToPath(new URL("../../pyproject.toml", import.meta.url)), process.env.STARTUP_TEST_EXECUTABLE], {
      cwd: directory, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PATH: directory },
    });
    // THEN the locked CLI works despite the incompatible ambient executable.
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
