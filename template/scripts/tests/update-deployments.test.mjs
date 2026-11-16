import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const scripts = new URL("../", import.meta.url);
const python = process.env.FACTORY_TEST_PYTHON || "python3";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const shared = "example-owner/deploy-your-startup/.github/workflows/deploy.yml";
// GitHub is the only stand-in: `gh` clones local bare repositories instead.
const fakeGh = `#!/bin/bash
if [ "$1 $2" = "repo clone" ]; then
  remote="$TEST_REMOTES/\${3##*/}.git"; target="$4"; shift 4; [ "\${1:-}" = "--" ] && shift
  exec git clone -q "$@" "$remote" "$target"
fi
if [ "$1" = api ] && [[ "$2" == users/* ]]; then echo User; fi
`;

function workspace(startup) {
  const root = mkdtempSync(join(tmpdir(), "factory-deployment-updates-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  for (const name of ["update-deployments.sh", "registry.sh"]) {
    copyFileSync(new URL(name, scripts), join(root, "scripts", name));
  }
  // Exercise the real installed CLI even when the user's launcher depends on HOME.
  writeFileSync(join(root, "bin/startup"), startup ?? `#!/bin/bash\nexec ${quote(python)} -m cli.startup "$@"\n`, { mode: 0o755 });
  writeFileSync(join(root, "bin/gh"), fakeGh, { mode: 0o755 });
  return root;
}

function invoke(root, command, args, cwd = root) {
  return spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 120000,
    env: {
      ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Factory integration", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Factory integration", GIT_COMMITTER_EMAIL: "test@example.invalid",
      TEST_REMOTES: join(root, "remotes"), STARTUP_ANSIBLE_REPO_OWNER: "example-owner",
      STARTUP_ANSIBLE_REPO_URL: `file://${join(root, "remotes/deploy-your-startup.git")}`,
    },
  });
}

function run(root, command, args, cwd = root) {
  const result = invoke(root, command, args, cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function git(root, cwd, ...args) {
  return run(root, "git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], cwd).trim();
}

function repository(root, directory, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  git(root, directory, "init", "-q", "-b", "main");
  git(root, directory, "add", "-A");
  git(root, directory, "commit", "-qm", "fixture");
  return directory;
}

function remotes(root) {
  const owner = "§§deploy_your_startup.github_username§§/§§deploy_your_startup.deploy_repo_name§§";
  const template = repository(root, join(root, "sources/deploy-template"), {
    ".github/workflows/deploy.yml": `jobs:\n  deploy:\n    steps:\n      - uses: ${owner}/.github/actions/deploy@main\n`,
    "roles/sample/tasks/main.yml": "- ansible.builtin.debug:\n    msg: reviewed\n",
  });
  const copy = repository(root, join(root, "sources/deploy-your-startup"), { "README.md": "owner copy\n" });
  mkdirSync(join(root, "remotes"));
  for (const source of [template, copy]) git(root, root, "clone", "-q", "--bare", source, join(root, "remotes", `${source.split("/").pop()}.git`));
  return join(root, "remotes/deploy-your-startup.git");
}

function project(root, name, deployment = true) {
  const files = { "README.md": `${name}\n` };
  if (deployment) {
    files["deployment/playbook.yml"] = "[]\n";
    files[".github/workflows/deploy.yml"] = `jobs:\n  deploy:\n    uses: ${shared}@main\n`;
  }
  return repository(root, join(root, "projects/startups", name), files);
}

function registry(root, names) {
  writeFileSync(join(root, "projects.yaml"), `projects:\n${names.map((name) => `  - name: ${name}\n    repo: https://example.invalid/${name}.git`).join("\n")}\ntooling: []\n`);
}

test("GIVEN registered startups WHEN previewing and applying shared deployment updates THEN preview changes nothing and apply pins clean startups without moving the owner's main", () => {
  const root = workspace();
  try {
    const copy = remotes(root);
    const main = git(root, copy, "rev-parse", "main");
    const healthy = project(root, "healthy");
    const dirty = project(root, "dirty");
    project(root, "landing", false);
    writeFileSync(join(dirty, "README.md"), "Uncommitted owner work\n");
    registry(root, ["healthy", "dirty", "landing", "absent"]);

    const preview = run(root, "bash", [join(root, "scripts/update-deployments.sh")], tmpdir());

    assert.match(preview, /Update available: release source-[0-9a-f]{12}\./);
    assert.match(preview, /landing — skipped: no deployment directory/);
    assert.match(preview, /absent — skipped: checkout missing/);
    assert.match(preview, /Summary \(preview\): 2 completed, 2 skipped, 0 failed/);
    assert.equal(git(root, healthy, "status", "--porcelain"), "");
    assert.equal(git(root, copy, "tag"), "");

    const applied = run(root, "bash", [join(root, "scripts/update-deployments.sh"), "--apply"]);

    assert.match(applied, /dirty — skipped: uncommitted changes/);
    assert.match(applied, /Summary \(apply\): 1 completed, 3 skipped, 0 failed/);
    const release = git(root, copy, "tag");
    const commit = git(root, copy, "rev-parse", release);
    assert.equal(readFileSync(join(healthy, "deployment/shared-roles.ref"), "utf8").trim(), commit);
    assert.equal(readFileSync(join(healthy, ".github/workflows/deploy.yml"), "utf8"), `jobs:\n  deploy:\n    uses: ${shared}@${commit} # ${release}\n`);
    assert.match(git(root, copy, "show", `${release}:.github/workflows/deploy.yml`), new RegExp(`example-owner/deploy-your-startup/.github/actions/deploy@${release}`));
    assert.equal(git(root, copy, "rev-parse", "main"), main);
    assert.equal(git(root, healthy, "rev-parse", "HEAD"), git(root, healthy, "rev-parse", "main"));
    assert.equal(existsSync(join(dirty, "deployment/shared-roles.ref")), false);

    const again = run(root, "bash", [join(root, "scripts/update-deployments.sh")]);
    assert.match(again, /Up to date: this project runs release/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GIVEN a startup CLI without the update command WHEN running the script THEN it asks for the current release and touches nothing", () => {
  const root = workspace('#!/bin/bash\necho "Error: No such command \'update\'." >&2\nexit 2\n');
  try {
    const healthy = project(root, "healthy");
    registry(root, ["healthy"]);

    const result = invoke(root, "bash", [join(root, "scripts/update-deployments.sh"), "--apply"]);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /install the current release/);
    assert.equal(git(root, healthy, "status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
