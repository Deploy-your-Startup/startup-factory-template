import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const scenario of ["success", "old-gh", "installation-failure"]) {
test(`GIVEN Codex and ${scenario} WHEN init runs THEN Factory skills install locally or setup reports the error`, () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-init-skills-"));
  try {
    const root = new URL("../../", import.meta.url);
    const scripts = join(directory, "scripts");
    const binaries = join(directory, "bin");
    mkdirSync(scripts);
    mkdirSync(binaries);
    mkdirSync(join(directory, ".codex"));
    writeFileSync(join(directory, ".zshrc"), "# Installer-created profile\n");
    for (const name of ["init.sh", "registry.sh"]) {
      copyFileSync(new URL(`scripts/${name}`, root), join(scripts, name));
    }
    writeFileSync(join(directory, "projects.yaml"), "projects: []\ntooling: []\n");
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    // Use the actual installed CLI and YAML parser; isolate all account access.
    for (const name of ["startup", "yq", "dirname", "head", "gh"]) {
      const found = spawnSync("which", [name === "startup" ? (process.env.STARTUP_TEST_EXECUTABLE || (existsSync(join(homedir(), ".local/share/startup/commands/startup")) ? join(homedir(), ".local/share/startup/commands/startup") : name)) : name], { encoding: "utf8" });
      assert.equal(found.status, 0, `${name} is required for this integration test`);
      writeFileSync(join(binaries, name), `#!/bin/bash\nexec ${quote(found.stdout.trim())} "$@"\n`, { mode: 0o755 });
    }
    for (const name of ["kubectl", "uv", "git", "mise"]) {
      writeFileSync(join(binaries, name), '#!/bin/bash\n[ "$1" = --version ] || exit 90\necho test-boundary\n', { mode: 0o755 });
    }
    cpSync(new URL("skills/", root), join(directory, "skills"), { recursive: true });
    // A new optional skill must not become part of the automatic installation.
    mkdirSync(join(directory, "skills/optional-example"));
    writeFileSync(join(directory, "skills/optional-example/SKILL.md"), "---\nname: optional-example\ndescription: Optional example\n---\n# Optional\n");
    if (scenario !== "success") {
      writeFileSync(join(binaries, "gh"), `#!/bin/bash\n[ "$1" = --version ] && { echo test-gh; exit 0; }\n${scenario === "old-gh" ? "exit 1" : '[ "$1 $2 $3" = "skill install --help" ] && exit 0; echo installation-denied >&2; exit 1'}\n`, { mode: 0o755 });
    }
    // WHEN the real init script completes against the isolated empty registry.
    const result = spawnSync("/bin/bash", [join(scripts, "init.sh")], {
      cwd: directory,
      env: { ...process.env, HOME: directory, PATH: binaries },
      encoding: "utf8",
      timeout: 30000,
    });
    if (scenario !== "success") {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, scenario === "old-gh" ? /Update gh and rerun/ : /installation-denied/);
      assert.doesNotMatch(result.stdout, /Cloning projects|Done! Projects/);
      return;
    }
    // THEN the installed content comes from the CLI and no legacy skill is requested.
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const bundled = spawnSync(join(binaries, "startup"), ["skills", "show"], { encoding: "utf8" });
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.equal(readFileSync(join(directory, ".agents/skills/deploy-your-startup/SKILL.md"), "utf8"), bundled.stdout);
    for (const skill of ["sprowi-task", "idea-personas"]) {
      const installed = readFileSync(join(directory, ".agents/skills", skill, "SKILL.md"), "utf8");
      const source = readFileSync(join(directory, "skills", skill, "SKILL.md"), "utf8");
      assert.ok(installed.includes(source.slice(source.indexOf("\n# "))));
    }
    assert.equal(existsSync(join(directory, ".agents/skills/optional-example")), false);
    assert.equal(existsSync(join(directory, ".claude/skills")), false);
    assert.equal(existsSync(join(directory, ".opencode/skills")), false);
    assert.match(result.stdout, /Done! Projects are in/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
}

test("GIVEN missing tools WHEN running init THEN it stops before setup and offers a pinned Git installation", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-init-"));
  try {
    const scripts = join(directory, "scripts");
    const binaries = join(directory, "bin");
    mkdirSync(scripts);
    mkdirSync(binaries);
    const root = new URL("../../", import.meta.url);
    copyFileSync(new URL("scripts/init.sh", root), join(scripts, "init.sh"));
    // Only OS utilities are available. External account/tool boundaries are absent.
    for (const name of ["dirname", "head"]) {
      writeFileSync(join(binaries, name), `#!/bin/bash\nexec /usr/bin/${name} "$@"\n`, { mode: 0o755 });
    }
    const result = spawnSync("/bin/bash", [join(scripts, "init.sh")], {
      env: { ...process.env, HOME: directory, PATH: binaries },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /required tool\(s\) missing/);
    assert.match(result.stdout, /git\+https:\/\/github\.com\/Deploy-your-Startup\/cli\.git@(?:v\d+\.\d+\.\d+|[a-f0-9]{40})(?=['"\s]|$)/);
    assert.doesNotMatch(result.stdout, /uv tool install deploy-your-startup-cli(?:\s|$)/);
    assert.doesNotMatch(result.stdout, /Cloning projects|Installing startup-factory skills/);
    const readme = readFileSync(new URL("README.md", root), "utf8");
    const installation = result.stdout.match(/uv tool install[^\n]+/)?.[0];
    assert.ok(installation);
    assert.ok(readme.includes("https://deploy-your-startup.com/get-started"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GIVEN the required tools but no kubectl WHEN init runs THEN setup completes and reports kubectl as optional", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-init-no-kubectl-"));
  try {
    const root = new URL("../../", import.meta.url);
    const scripts = join(directory, "scripts");
    const binaries = join(directory, "bin");
    mkdirSync(scripts);
    mkdirSync(binaries);
    for (const name of ["init.sh", "registry.sh"]) {
      copyFileSync(new URL(`scripts/${name}`, root), join(scripts, name));
    }
    writeFileSync(join(directory, "projects.yaml"), "projects: []\ntooling: []\n");
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    // No shell profile, so init cannot pick up a kubectl from Homebrew paths.
    for (const name of ["startup", "yq", "dirname", "head"]) {
      const found = spawnSync("which", [name === "startup" ? (process.env.STARTUP_TEST_EXECUTABLE || (existsSync(join(homedir(), ".local/share/startup/commands/startup")) ? join(homedir(), ".local/share/startup/commands/startup") : name)) : name], { encoding: "utf8" });
      assert.equal(found.status, 0, `${name} is required for this integration test`);
      writeFileSync(join(binaries, name), `#!/bin/bash\nexec ${quote(found.stdout.trim())} "$@"\n`, { mode: 0o755 });
    }
    for (const name of ["uv", "gh", "git", "mise"]) {
      writeFileSync(join(binaries, name), '#!/bin/bash\n[ "$1" = --version ] || exit 90\necho test-boundary\n', { mode: 0o755 });
    }
    const installerCalls = join(directory, "installer-calls");
    writeFileSync(join(binaries, "npx"), `#!/bin/bash\nprintf 'unexpected call' > ${quote(installerCalls)}\nexit 91\n`, { mode: 0o755 });
    // WHEN the real init script runs without kubectl on PATH.
    const result = spawnSync("/bin/bash", [join(scripts, "init.sh")], {
      cwd: directory,
      env: { ...process.env, HOME: directory, PATH: binaries },
      encoding: "utf8",
      timeout: 30000,
    });
    // THEN setup completes and kubectl is offered as an optional tool.
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /All tools available/);
    assert.match(result.stdout, /kubectl — optional, only to inspect a full-stack startup's cluster \(brew install kubectl\)/);
    // A first setup without a coding agent or deployed projects reports no errors.
    assert.match(result.stdout, /No coding agent found\. After installing one, run: startup skills install/);
    assert.doesNotMatch(result.stdout + result.stderr, /Error:|failed/);
    assert.match(result.stdout, /After setting up your coding agent, rerun scripts\/init.sh/);
    assert.equal(existsSync(installerCalls), false);
    assert.doesNotMatch(result.stdout, /vault password/);
    assert.match(result.stdout, /Done! Projects are in/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GIVEN local deployment experiments WHEN Git considers generated files THEN credentials and scratch checkouts stay untracked", () => {
  const root = new URL("../../", import.meta.url);
  const paths = [
    "experiments/probe/deployment/hcloud_token_production",
    "experiments/probe/deployment/group_vars/production.yml",
    ".worktrees/review/deployment/group_vars/production.yml",
    "dry-run-output/production.yml",
  ];
  for (const path of paths) {
    const result = spawnSync("git", ["check-ignore", "--no-index", path], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), path);
  }
});
