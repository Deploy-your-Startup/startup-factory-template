import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const source = new URL("../../", import.meta.url);
// The owner's Git configuration, such as insteadOf rewrites, must not change the outcome.
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
}

function git(cwd, ...args) {
  run("git", ["-c", "user.name=Factory integration", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], cwd);
}

function workspace(registry) {
  const root = mkdtempSync(join(tmpdir(), "factory-registry-"));
  cpSync(new URL("scripts", source), join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "projects.yaml"), registry);
  return root;
}

function checkout(root, path, origin) {
  const directory = join(root, "projects", path);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q", "-b", "main");
  if (origin) git(directory, "remote", "add", "origin", origin);
}

function check(root) {
  return spawnSync("bash", [join(root, "scripts/registry.sh"), "check"], { cwd: root, env, encoding: "utf8" });
}

test("GIVEN checkouts matching the registry, including a Pages site without a cluster WHEN checking THEN no drift is reported", () => {
  const root = workspace(`projects:
  - name: landing
    repo: git@github.com:Example/Landing.git
    url: landing.example
    deployed: true
tooling:
  - name: cli
    repo: https://github.com/Example/cli.git
`);
  try {
    checkout(root, "startups/landing", "https://github.com/example/landing");
    checkout(root, "tooling/cli", "git@github.com:Example/cli.git");
    writeFileSync(join(root, "projects/startups/cluster.yml"), "shared: true\n");

    const result = check(root);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Registry matches the checkouts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GIVEN every kind of drift WHEN checking THEN each one is named and the check fails", () => {
  const root = workspace(`projects:
  - name: planned
    repo: https://github.com/example/planned.git
    url: planned.example
  - name: orphan-context
    repo: https://github.com/example/orphan-context.git
    kubectl_context: orphan-production
  - name: incomplete
    repo: https://github.com/example/incomplete.git
    deployed: true
  - name: moved
    repo: https://github.com/example/moved.git
tooling: []
`);
  try {
    for (const name of ["planned", "orphan-context", "incomplete"]) {
      checkout(root, `startups/${name}`, `https://github.com/example/${name}.git`);
    }
    checkout(root, "startups/moved", "https://github.com/someone-else/moved.git");
    checkout(root, "startups/forgotten", "https://github.com/example/forgotten.git");
    checkout(root, "tooling/scratch");

    const result = check(root);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /planned — url without deployed: true/);
    assert.match(result.stdout, /orphan-context — kubectl_context without deployed: true/);
    assert.match(result.stdout, /incomplete — deployed: true without url/);
    assert.match(result.stdout, /startups\/moved — origin https:\/\/github\.com\/someone-else\/moved\.git differs/);
    assert.match(result.stdout, /startups\/forgotten — checkout not in projects\.yaml/);
    assert.match(result.stdout, /tooling\/scratch — checkout not in projects\.yaml/);
    assert.match(result.stdout, /6 registry drift\(s\) found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GIVEN a registered repository that is not cloned WHEN checking THEN init is suggested", () => {
  const root = workspace("projects:\n  - name: absent\n    repo: https://github.com/example/absent.git\ntooling: []\n");
  try {
    const result = check(root);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /startups\/absent — registered but not cloned \(run scripts\/init\.sh\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GIVEN an up-to-date hub with an unregistered checkout WHEN syncing THEN sync reports the drift and fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-sync-drift-"));
  try {
    const origin = join(directory, "hub.git");
    const seed = join(directory, "seed");
    run("git", ["init", "-q", "--bare", "-b", "main", origin], directory);
    mkdirSync(seed);
    cpSync(new URL("scripts", source), join(seed, "scripts"), { recursive: true });
    writeFileSync(join(seed, "projects.yaml"), "projects: []\ntooling: []\n");
    writeFileSync(join(seed, ".gitignore"), "projects/\n");
    git(seed, "init", "-q", "-b", "main");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "hub");
    git(seed, "push", "-q", origin, "main");
    const hub = join(directory, "hub");
    run("git", ["clone", "-q", origin, hub], directory);
    checkout(hub, "startups/stray", "https://github.com/example/stray.git");

    const result = spawnSync("bash", [join(hub, "scripts/sync.sh")], { cwd: hub, env, encoding: "utf8", timeout: 30000 });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /startup-factory \(main\) — pulling\.\.\. .*already up to date/);
    assert.match(result.stdout, /startups\/stray — checkout not in projects\.yaml/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function hubWithProject(directory, registeredRepo) {
  const hubOrigin = join(directory, "hub.git");
  const seed = join(directory, "seed");
  run("git", ["init", "-q", "--bare", "-b", "main", hubOrigin], directory);
  mkdirSync(seed);
  cpSync(new URL("scripts", source), join(seed, "scripts"), { recursive: true });
  writeFileSync(join(seed, "projects.yaml"), `projects:\n  - name: site\n    repo: ${registeredRepo}\ntooling: []\n`);
  writeFileSync(join(seed, ".gitignore"), "projects/\n");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "hub");
  git(seed, "push", "-q", hubOrigin, "main");
  const hub = join(directory, "hub");
  run("git", ["clone", "-q", hubOrigin, hub], directory);
  return hub;
}

function repository(directory, name, message) {
  const bare = join(directory, `${name}.git`);
  const work = join(directory, `${name}-work`);
  run("git", ["init", "-q", "--bare", "-b", "main", bare], directory);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "commit", "-q", "--allow-empty", "-m", message);
  git(work, "push", "-q", bare, "main");
  return { bare, work };
}

function sync(hub) {
  return spawnSync("bash", [join(hub, "scripts/sync.sh")], { cwd: hub, env, encoding: "utf8", timeout: 30000 });
}

function originOf(directory) {
  return spawnSync("git", ["remote", "get-url", "origin"], { cwd: directory, env, encoding: "utf8" }).stdout.trim();
}

test("GIVEN a repository moved to a new owner in the registry WHEN syncing THEN origin follows the registry and the new commits are pulled", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-sync-moved-"));
  try {
    const old = repository(directory, "old-owner", "initial");
    const moved = join(directory, "new-owner.git");
    run("git", ["clone", "-q", "--bare", old.bare, moved], directory);
    git(old.work, "commit", "-q", "--allow-empty", "-m", "after the move");
    git(old.work, "push", "-q", moved, "main");
    const hub = hubWithProject(directory, moved);
    run("git", ["clone", "-q", old.bare, join(hub, "projects/startups/site")], directory);

    const result = sync(hub);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /site — origin moved: .*old-owner\.git → .*new-owner\.git/);
    assert.match(result.stdout, /site \(main\) — pulling\.\.\. .*updated/);
    assert.match(result.stdout, /Registry matches the checkouts/);
    assert.equal(originOf(join(hub, "projects/startups/site")), moved);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("GIVEN a registered repository without shared history WHEN syncing THEN origin is kept and the drift is reported", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-sync-unrelated-"));
  try {
    const current = repository(directory, "current", "current history");
    const unrelated = repository(directory, "unrelated", "unrelated history");
    const hub = hubWithProject(directory, unrelated.bare);
    run("git", ["clone", "-q", current.bare, join(hub, "projects/startups/site")], directory);

    const result = sync(hub);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /site — registered .*unrelated\.git shares no history with origin, keeping .*current\.git/);
    assert.match(result.stdout, /startups\/site — origin .*current\.git differs from registered/);
    assert.equal(originOf(join(hub, "projects/startups/site")), current.bare);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
