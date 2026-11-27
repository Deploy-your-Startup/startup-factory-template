import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function invoke(cwd, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000, ...options });
  assert.ifError(result.error);
  return result;
}

function run(cwd, command, args) {
  const result = invoke(cwd, command, args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "factory-coding-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  for (const file of ["coding-sandbox.sh", "registry.sh", "with-factory-kit.sh"]) {
    copyFileSync(new URL("../" + file, import.meta.url), join(scripts, file));
  }
  writeFileSync(join(root, "projects.yaml"), "projects:\n  - name: sample\n    repo: https://example.invalid/sample.git\ntooling: []\n");
  return root;
}

test("GIVEN a Factory registry WHEN the target or agent is invalid THEN the starter refuses it", (t) => {
  const root = fixture(t);
  const startupDir = join(root, "projects/startups");
  mkdirSync(startupDir, { recursive: true });
  symlinkSync(root, join(startupDir, "sample"));
  for (const [target, message] of [
    ["unknown", /Unknown project/],
    ["../other-project", /Select one registered project/],
    ["sample", /Expected a separate Git checkout/],
  ]) {
    const result = invoke(root, "bash", ["scripts/coding-sandbox.sh", "--prepare", target]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  const unsupported = invoke(root, "bash", ["scripts/coding-sandbox.sh", "--agent", "shell"]);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Select codex or claude/);
});

test("GIVEN a wrong checkout WHEN starting a project sandbox or a Sprowi check THEN both refuse it before creating a sandbox", (t) => {
  const root = fixture(t);
  cpSync(new URL("../../sprowi", import.meta.url), join(root, "sprowi"), { recursive: true });
  copyFileSync(new URL("../sprowi.sh", import.meta.url), join(root, "scripts/sprowi.sh"));
  writeFileSync(join(root, "sprowi/projects/sample.json"), "{}");
  const checkout = join(root, "projects/startups/sample");
  mkdirSync(checkout, { recursive: true });
  run(root, "git", ["init", "--quiet"]);
  function assertRefused(message) {
    for (const args of [["scripts/coding-sandbox.sh", "--prepare", "sample"], ["scripts/sprowi.sh", "check", "sample"]]) {
      const result = invoke(root, "bash", args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /unrelated-repository/);
    }
  }
  assertRefused(/Expected a separate Git checkout/);
  run(checkout, "git", ["init", "--quiet"]);
  assertRefused(/origin for sample must match/);
  run(checkout, "git", ["remote", "add", "origin", "https://example.invalid/unrelated-repository"]);
  assertRefused(/origin for sample must match/);
  run(checkout, "git", ["remote", "set-url", "origin", "git@example.invalid:sample.git"]);
  assert.equal(run(root, "bash", ["scripts/registry.sh", "checkout", "sample"]).trim(), checkout);
});

function checkSandbox(t, agent) {
  const root = fixture(t);
  for (const file of ["pyproject.toml", "uv.lock"]) {
    copyFileSync(new URL("../../" + file, import.meta.url), join(root, file));
  }
  cpSync(new URL("../../sandbox", import.meta.url), join(root, "sandbox"), { recursive: true });
  const checkout = join(root, "projects/startups/sample");
  const siblingSecret = join(root, "projects/startups/other/.env");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(dirname(siblingSecret), { recursive: true });
  writeFileSync(siblingSecret, "DUMMY_OTHER_SECRET");
  writeFileSync(join(checkout, "sample.txt"), "committed content\n");
  writeFileSync(join(checkout, ".gitignore"), ".env\n");
  symlinkSync(siblingSecret, join(checkout, "outside-link"));
  run(checkout, "git", ["init", "--quiet"]);
  run(checkout, "git", ["remote", "add", "origin", "https://example.invalid/sample.git"]);
  run(checkout, "git", ["add", "--all"]);
  run(checkout, "git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  writeFileSync(join(checkout, ".env"), "DUMMY_LOCAL_SECRET");
  writeFileSync(join(checkout, "sample.txt"), "uncommitted content\n");

  const agentOption = agent === "claude" ? ["--agent", "claude"] : [];
  const result = invoke(root, "bash", ["scripts/coding-sandbox.sh", ...agentOption, "--prepare", "sample"], {
    env: { ...env, VAULT_PASSWORD_FIXTURE: "dummy", GH_TOKEN: "dummy", SSH_AUTH_SOCK: "/dummy/socket" },
  });
  const sandbox = /Sandbox: (factory-code-[0-9a-f]{16})/.exec(result.stderr)?.[1];
  if (sandbox) t.after(() => run(tmpdir(), "sbx", ["--no-input", "rm", "--force", sandbox]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(sandbox);

  const inspection = JSON.parse(run(root, "sbx", ["inspect", sandbox, "--json"]));
  assert.equal(inspection.agent, agent);
  assert.deepEqual(inspection.host_mounts, []);
  assert.match(run(root, "sbx", ["exec", sandbox, agent, "--version"]), /\d+\.\d+\.\d+/);
  const mcpProbe = [
    "import json, os, urllib.request",
    "url = os.environ['MCP_GATEWAY_URL']",
    "headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}",
    "def request(method, params, request_id=None):",
    "    message = {'jsonrpc': '2.0', 'method': method, 'params': params}",
    "    if request_id is not None: message['id'] = request_id",
    "    with urllib.request.urlopen(urllib.request.Request(url, json.dumps(message).encode(), headers), timeout=5) as response:",
    "        session = response.headers.get('Mcp-Session-Id')",
    "        if session: headers['Mcp-Session-Id'] = session",
    "        if response.headers.get_content_type() == 'application/json': return json.load(response)",
    "        for line in response:",
    "            if line.startswith(b'data: '): return json.loads(line[6:])",
    "request('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'fixture', 'version': '1'}}, 1)['result']",
    "request('notifications/initialized', {})",
    "tools = request('tools/list', {}, 2)['result']['tools']",
    "assert {tool['name'] for tool in tools} <= {'code-mode', 'mcp-exec'}",
  ].join("\n");
  run(root, "sbx", ["exec", sandbox, "/opt/factory/venv/bin/python", "-c", mcpProbe]);
  for (const url of ["https://api.github.com/", "https://api.hetzner.cloud/", "https://api.cloudflare.com/"]) {
    const check = invoke(root, "sbx", ["policy", "check", "http", "--sandbox", sandbox, url]);
    assert.match(check.stdout, /^\s*Denied:/m, check.stderr + check.stdout);
  }
  const guest = "/home/agent/workspace/factory-checkout";
  assert.match(run(root, "sbx", ["exec", sandbox, "startup", "--version"]), /^startup \d/m);
  assert.match(run(root, "sbx", ["exec", sandbox, "kubectl", "version", "--client"]), /Client Version: v1\.36\.5/);
  run(root, "sbx", ["exec", "--workdir", guest, sandbox, "bash", "-euc", [
    'fail() { echo "$1" >&2; exit 1; }',
    "test ! -e .env || fail 'Local .env is visible'",
    'test ! -e "$1" || fail "Other project is visible"',
    "test -L outside-link && test ! -e outside-link || fail 'Unexpected archived symlink'",
    'for name in VAULT_PASSWORD_FIXTURE GH_TOKEN GITHUB_TOKEN SSH_AUTH_SOCK KUBECONFIG; do',
    '  test -z "$(printenv "$name")" || fail "$name is set"',
    "done",
    'test ! -e "$HOME/.kube/config" || fail "Kubeconfig is present"',
    'test -z "$(git remote)" || fail "Git remote is configured"',
    'grep -qx "committed content" sample.txt || fail "Expected committed file content"',
    'printf "sandbox update\n" > sample.txt',
    "touch new-file",
  ].join("\n"), "bash", siblingSecret]);
  const patch = run(root, "bash", ["scripts/coding-sandbox.sh", "--diff", sandbox]);
  assert.match(patch, /^\+sandbox update$/m);
  assert.match(patch, /diff --git a\/new-file b\/new-file/);
  assert.doesNotMatch(patch, /DUMMY_|uncommitted content/);
  assert.match(run(checkout, "git", ["diff", "--", "sample.txt"]), /^\+uncommitted content$/m);
}

for (const agent of ["codex", "claude"]) {
  test("GIVEN committed code and local dummy secrets WHEN preparing " + agent + " THEN the sandbox contains the tools and returns edits as a patch", {
    skip: process.env.FACTORY_TEST_CODING_SANDBOX !== "1" && "Requires a signed-in local Docker Sandboxes host",
  }, (t) => checkSandbox(t, agent));
}
