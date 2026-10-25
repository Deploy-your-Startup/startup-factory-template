import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const scripts = new URL("../", import.meta.url);
const python = process.env.FACTORY_TEST_PYTHON || "python3";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "factory-template-updates-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  for (const name of ["update-templates.sh", "registry.sh"]) {
    copyFileSync(new URL(name, scripts), join(root, "scripts", name));
  }
  // Exercise the real installed CLI even when the user's launcher depends on HOME.
  writeFileSync(join(root, "bin/startup"), `#!/bin/bash\nexec ${quote(python)} -m cli.startup "$@"\n`, { mode: 0o755 });
  return root;
}

function invoke(root, command, args, cwd = root) {
  return spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 60000,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function run(root, command, args, cwd = root) {
  const result = invoke(root, command, args, cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function git(root, cwd, ...args) {
  return run(root, "git", ["-c", "user.name=Factory integration", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], cwd).trim();
}

function commit(root, directory) {
  git(root, directory, "add", "-A");
  git(root, directory, "commit", "-qm", "fixture");
}

function template(root, name) {
  const directory = join(root, `${name}-template`);
  mkdirSync(join(directory, "template"), { recursive: true });
  writeFileSync(join(directory, "copier.yml"), "_subdirectory: template\nproject_name:\n  default: example-app\n");
  writeFileSync(join(directory, "template/.copier-answers.yml.jinja"), "{{ _copier_answers | to_nice_yaml }}\n");
  writeFileSync(join(directory, "template/message.txt"), `${name} original\n`);
  git(root, directory, "init", "-q", "-b", "main");
  commit(root, directory);
  git(root, directory, "tag", "v1.0.0");
  return directory;
}

function project(root, name, source) {
  const directory = join(root, "projects/startups", name);
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(source, "template/message.txt"), join(directory, "message.txt"));
  writeFileSync(join(directory, "owner.txt"), "Owner customization\n");
  git(root, directory, "init", "-q", "-b", "main");
  git(root, directory, "remote", "add", "origin", `https://github.com/example-owner/${name}.git`);
  commit(root, directory);
  run(root, "startup", ["template", "adopt", "--project-dir", directory, "--template", source, "--version", "v1.0.0", "--data", `project_name=${name}`]);
  commit(root, directory);
  return directory;
}

function registry(root, names) {
  writeFileSync(join(root, "projects.yaml"), `projects:\n${names.map((name) => `  - name: ${name}\n    repo: https://example.invalid/${name}.git`).join("\n")}\ntooling:\n  - name: untouched\n    repo: https://example.invalid/tool.git\n`);
}

test("GIVEN startups using different templates WHEN previewing and applying updates THEN each uses its own latest HEAD and preview changes nothing", () => {
  const root = workspace();
  try {
    const sources = [template(root, "backend"), template(root, "landing")];
    const projects = sources.map((source, i) => project(root, `example-${i}`, source));
    registry(root, ["example-0", "example-1"]);
    const before = projects.map((directory) => ({
      head: git(root, directory, "rev-parse", "HEAD"),
      answers: readFileSync(join(directory, ".copier-answers.yml"), "utf8"),
      message: readFileSync(join(directory, "message.txt"), "utf8"),
    }));
    for (const [i, source] of sources.entries()) {
      writeFileSync(join(source, "template/message.txt"), `Latest template ${i}\n`);
      commit(root, source);
    }
    const tooling = join(root, "projects/tooling/untouched");
    mkdirSync(tooling, { recursive: true });
    writeFileSync(join(tooling, "owner.txt"), "Leave tooling alone\n");

    const preview = run(root, "bash", [join(root, "scripts/update-templates.sh")], tmpdir());

    assert.match(preview, /Summary \(preview\): 2 completed, 0 skipped, 0 failed/);
    for (const [i, directory] of projects.entries()) {
      assert.equal(git(root, directory, "status", "--porcelain"), "");
      assert.equal(readFileSync(join(directory, ".copier-answers.yml"), "utf8"), before[i].answers);
      assert.equal(readFileSync(join(directory, "message.txt"), "utf8"), before[i].message);
    }

    const applied = run(root, "bash", [join(root, "scripts/update-templates.sh"), "--apply"]);

    assert.match(applied, /Summary \(apply\): 2 completed, 0 skipped, 0 failed/);
    for (const [i, directory] of projects.entries()) {
      assert.equal(readFileSync(join(directory, "message.txt"), "utf8"), `Latest template ${i}\n`);
      assert.equal(readFileSync(join(directory, "owner.txt"), "utf8"), "Owner customization\n");
      assert.notEqual(readFileSync(join(directory, ".copier-answers.yml"), "utf8"), before[i].answers);
      assert.equal(git(root, directory, "rev-parse", "HEAD"), before[i].head);
    }
    assert.equal(readFileSync(join(tooling, "owner.txt"), "utf8"), "Leave tooling alone\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GIVEN dirty, missing and legacy checkouts plus a broken template WHEN applying THEN skips are explicit and other startups still update despite the failure", () => {
  const root = workspace();
  try {
    const source = template(root, "backend");
    for (const name of ["dirty", "staged", "untracked", "broken", "healthy"]) project(root, name, source);
    const base = join(root, "projects/startups");
    writeFileSync(join(base, "dirty/message.txt"), "Uncommitted owner work\n");
    writeFileSync(join(base, "staged/message.txt"), "Staged owner work\n");
    git(root, join(base, "staged"), "add", "message.txt");
    writeFileSync(join(base, "untracked/new.txt"), "Untracked owner work\n");
    mkdirSync(join(base, "legacy"));
    git(root, join(base, "legacy"), "init", "-q");
    writeFileSync(join(base, "broken/.copier-answers.yml"), `_src_path: ${join(root, "missing-template")}\n_commit: v1.0.0\n`);
    commit(root, join(base, "broken"));
    writeFileSync(join(source, "template/message.txt"), "Latest backend\n");
    commit(root, source);
    registry(root, ["dirty", "staged", "untracked", "legacy", "absent", "broken", "healthy"]);

    const result = invoke(root, "bash", [join(root, "scripts/update-templates.sh"), "--apply"]);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    for (const name of ["dirty", "staged", "untracked"]) assert.match(result.stdout, new RegExp(`${name} — skipped: uncommitted changes`));
    assert.match(result.stdout, /legacy — skipped: no Copier metadata/);
    assert.match(result.stdout, /absent — skipped: checkout missing/);
    assert.match(result.stderr, /broken — failed: review/);
    assert.match(result.stdout, /Summary \(apply\): 1 completed, 5 skipped, 1 failed/);
    assert.equal(readFileSync(join(base, "dirty/message.txt"), "utf8"), "Uncommitted owner work\n");
    assert.equal(git(root, join(base, "staged"), "diff", "--cached", "--name-only"), "message.txt");
    assert.equal(readFileSync(join(base, "untracked/new.txt"), "utf8"), "Untracked owner work\n");
    assert.equal(readFileSync(join(base, "healthy/message.txt"), "utf8"), "Latest backend\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
