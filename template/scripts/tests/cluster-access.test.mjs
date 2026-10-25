import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = new URL("../../", import.meta.url);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

// detached starts a new session, so the script has no controlling terminal even
// when the suite runs from one, as in an agent or CI shell.
function runWithoutTerminal(script, args, options) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [script, ...args], { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function realBinary(name) {
  const target = name === "startup"
    ? (process.env.STARTUP_TEST_EXECUTABLE || (existsSync(join(homedir(), ".local/share/startup/commands/startup")) ? join(homedir(), ".local/share/startup/commands/startup") : name))
    : name;
  const found = spawnSync("which", [target], { encoding: "utf8" });
  assert.equal(found.status, 0, `${name} is required for this integration test`);
  return found.stdout.trim();
}

function factory(prefix, registry) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const scripts = join(directory, "scripts");
  const binaries = join(directory, "bin");
  mkdirSync(scripts);
  mkdirSync(binaries);
  for (const name of ["init.sh", "registry.sh", "secrets.sh"]) {
    copyFileSync(new URL(`scripts/${name}`, root), join(scripts, name));
  }
  writeFileSync(join(directory, "projects.yaml"), registry);
  return { directory, scripts, binaries };
}

test("GIVEN no terminal WHEN storing vault passwords THEN secrets.sh refuses before writing to the Keychain", async () => {
  const { directory, scripts, binaries } = factory("factory-secrets-tty-",
    "projects:\n  - name: shop\n    repo: git@github.com:example/shop.git\n    deployed: true\n    url: shop.example.com\ntooling: []\n");
  try {
    for (const name of ["yq", "dirname", "basename", "tr"]) {
      writeFileSync(join(binaries, name), `#!/bin/bash\nexec ${quote(realBinary(name))} "$@"\n`, { mode: 0o755 });
    }
    // macOS boundaries: the Keychain records every call, nothing is stored.
    const calls = join(directory, "security-calls");
    writeFileSync(join(binaries, "uname"), "#!/bin/bash\necho Darwin\n", { mode: 0o755 });
    writeFileSync(join(binaries, "security"), `#!/bin/bash\nprintf '%s\\n' "$1" >> ${quote(calls)}\nexit 44\n`, { mode: 0o755 });
    // WHEN store-all runs from a session without a controlling terminal.
    const result = await runWithoutTerminal(join(scripts, "secrets.sh"), ["store-all"], {
      cwd: directory,
      env: { HOME: directory, PATH: binaries, USER: "owner" },
    });
    // THEN it stops with the terminal error and never adds a password.
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /requires an interactive terminal/);
    assert.doesNotMatch(existsSync(calls) ? readFileSync(calls, "utf8") : "", /add-generic-password/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GIVEN deployed startups with kubectl contexts and no terminal WHEN init runs THEN it lists the optional SSH connect commands and connects nothing", async () => {
  const { directory, scripts, binaries } = factory("factory-cluster-access-", [
    "projects:",
    "  - name: shop",
    "    repo: git@github.com:example/shop.git",
    "    deployed: true",
    "    url: shop.example.com",
    "    kubectl_context: shop-production",
    "  - name: blog",
    "    repo: git@github.com:example/blog.git",
    "    deployed: true",
    "    url: blog.example.com",
    "    kubectl_context: blog-production",
    "  - name: notes",
    "    repo: git@github.com:example/notes.git",
    "    deployed: true",
    "    url: notes.example.com",
    "    kubectl_context: notes-production",
    "  - name: landing",
    "    repo: git@github.com:example/landing.git",
    "    deployed: true",
    "    url: landing.example.com",
    "tooling: []",
    "",
  ].join("\n"));
  try {
    // shop is attached to a shared cluster described by cluster.yml.
    const shop = join(directory, "projects/startups/shop/deployment");
    mkdirSync(join(shop, "group_vars"), { recursive: true });
    writeFileSync(join(shop, "cluster.yml"), "schema: 1\nnodes:\n  - name: owner-master-0\n    host: 203.0.113.10\n    ssh_user: root\n    role: master\n");
    writeFileSync(join(shop, "group_vars/all.yml"), 'k8s_namespace: "shop"\n');
    for (const name of ["blog", "notes", "landing"]) {
      mkdirSync(join(directory, "projects/startups", name), { recursive: true });
    }
    for (const name of ["startup", "yq", "dirname", "head", "sed", "tr"]) {
      writeFileSync(join(binaries, name), `#!/bin/bash\nexec ${quote(realBinary(name))} "$@"\n`, { mode: 0o755 });
    }
    for (const name of ["uv", "gh", "git", "mise"]) {
      writeFileSync(join(binaries, name), '#!/bin/bash\n[ "$1" = --version ] || exit 90\necho test-boundary\n', { mode: 0o755 });
    }
    // Every startup already has its vault password.
    writeFileSync(join(binaries, "security"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    // Kubernetes boundary: blog points at its server directly, notes already
    // uses a local SSH tunnel and shop has no context yet.
    writeFileSync(join(binaries, "kubectl"), [
      "#!/bin/bash",
      '[ "$1" = version ] && { echo "Client Version: test"; exit 0; }',
      'case "$*" in',
      '  *contexts*blog-production*) echo blog-cluster ;;',
      '  *contexts*notes-production*) echo notes-tunnel ;;',
      '  *clusters*blog-cluster*) echo https://198.51.100.20:6443 ;;',
      '  *clusters*notes-tunnel*) echo https://127.0.0.1:52000 ;;',
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });
    // WHEN the real init script runs without a terminal.
    const result = await runWithoutTerminal(join(scripts, "init.sh"), [], {
      cwd: directory,
      env: { HOME: directory, PATH: binaries, USER: "owner" },
    });
    // THEN connected contexts are confirmed and the others get exact commands.
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Cluster access \(optional/);
    assert.match(result.stdout, /notes-production — connected over SSH/);
    assert.match(result.stdout, /startup cluster connect --context shop-production --host 203\.0\.113\.10 --namespace shop\n/);
    assert.match(result.stdout, /startup cluster connect --context blog-production --host 198\.51\.100\.20\n/);
    assert.doesNotMatch(result.stdout, /landing-production|context landing/);
    assert.doesNotMatch(result.stdout, /Connect \d+ cluster context/);
    assert.doesNotMatch(result.stdout + result.stderr, /SSH access ready/);
    assert.match(result.stdout, /Done! Projects are in/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
