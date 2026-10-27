import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.FACTORY_TEST_PYTHON || "python3";
function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120000, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function git(cwd, ...args) { return run("git", args, cwd); }
function init(path) {
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Factory integration");
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "config", "commit.gpgsign", "false");
  git(path, "config", "tag.gpgsign", "false");
  git(path, "config", "core.hooksPath", "/dev/null");
}
function commit(path) { git(path, "add", "-A"); git(path, "commit", "-m", "test fixture"); }
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}

function copySource(target) {
  mkdirSync(target, { recursive: true });
  for (const name of ["template", "copier.yml", "LICENSE"]) {
    cpSync(join(root, name), join(target, name), { recursive: true });
  }
}

test("GIVEN the standalone template WHEN validating distribution THEN owner state is absent", () => {
  run(python, [join(root, "scripts/validate-template.py")], root);
  const content = files(join(root, "template")).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(content.includes("/Users/"), false, "Template contains a local home path");
  assert.match(readFileSync(join(root, "template/projects.yaml"), "utf8"), /^projects: \[\]/m);
});

test("GIVEN a generated factory with owner data WHEN previewing and applying the next release THEN the harness updates and owner data survives", () => {
  const temp = mkdtempSync(join(tmpdir(), "factory-lifecycle-"));
  try {
    const source = join(temp, "source");
    copySource(source);
    init(source); commit(source); git(source, "tag", "v1.0.0");
    const factory = join(temp, "my-independent-workspace");
    run(python, ["-m", "cli.startup", "factory", "init", "--template", source, "--version", "v1.0.0", "--project-dir", factory], temp);
    assert.match(readFileSync(join(factory, ".startup-factory.yml"), "utf8"), /schema: 1/);
    init(factory); git(factory, "remote", "add", "origin", "https://github.com/example-owner/my-factory.git");
    assert.match(readFileSync(join(factory, "README.md"), "utf8"), /^# my-independent-workspace/);
    const registry = readFileSync(join(factory, "projects.yaml"), "utf8");
    assert.match(registry, /projects: \[\]/);
    for (const name of ["cli", "deploy-template", "django-backend-template", "vue-django-template", "pitch-template"]) assert.ok(registry.includes(`name: ${name}`));
    assert.ok(registry.includes("name: startup-factory-mod"));
    const claudeSettings = JSON.parse(readFileSync(join(factory, ".claude/settings.json"), "utf8"));
    assert.equal(claudeSettings.extraKnownMarketplaces["startup-factory-mod"].source.repo, "Deploy-your-Startup/startup-factory-mod");
    assert.equal(claudeSettings.enabledPlugins["startup-factory@startup-factory-mod"], true);
    assert.ok(!JSON.parse(readFileSync(join(factory, "sprowi/config.default.json"), "utf8")).publish.app.id);
    assert.ok(!existsSync(join(factory, "sprowi/tasks")));
    assert.ok(!existsSync(join(factory, "copier.yml")));
    // GIVEN committed owner data and an independently customized shared file.
    const ownerRegistry = registry.replace("projects: []", "projects:\n  - name: owner-app\n    repo: https://github.com/example-owner/owner-app.git");
    writeFileSync(join(factory, "projects.yaml"), ownerRegistry);
    const configPath = join(factory, "sprowi/config.default.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")); config.publish.app.id = 123456;
    writeFileSync(configPath, JSON.stringify(config));
    const discoveryConfig = join(factory, "sprowi/discovery/config.json");
    const discovery = JSON.parse(readFileSync(discoveryConfig, "utf8"));
    discovery.language = "Owner language";
    discovery.preferences = ["Owner's private audience"];
    discovery.reading = { enabled: true, publish: false, repository: "example-owner/private-factory" };
    writeFileSync(discoveryConfig, JSON.stringify(discovery));
    const privateHistory = join(factory, "sprowi/discovery/state/history");
    mkdirSync(privateHistory, { recursive: true });
    writeFileSync(join(privateHistory, "owner-note.txt"), "Private decisions survive updates\n");
    mkdirSync(join(factory, "discovery/2025-01-01"), { recursive: true });
    // Reading exports wrap source URLs in angle brackets, as CommonMark allows.
    const edition = "Owner reading edition\n\n[Source 1](<https://news.ycombinator.com/item?id=50193416>)\n";
    writeFileSync(join(factory, "discovery/2025-01-01/README.md"), edition);
    writeFileSync(join(factory, "owner-notes.md"), "Only this instance\n");
    writeFileSync(join(factory, "README.md"), readFileSync(join(factory, "README.md"), "utf8") + "\nOwner customization.\n");
    const projectSettings = join(factory, "sprowi/projects/startup-factory.json");
    const ownerSettings = JSON.parse(readFileSync(projectSettings, "utf8"));
    ownerSettings.limits = { maxRounds: 1 };
    writeFileSync(projectSettings, JSON.stringify(ownerSettings));
    commit(factory);
    // WHEN an existing customized workspace adopts a release, THEN only metadata is added.
    rmSync(join(factory, ".copier-answers.yml"));
    commit(factory);
    run(python, ["-m", "cli.startup", "template", "adopt", "--template", source, "--version", "v1.0.0", "--data", "project_name=my-independent-workspace"], factory);
    assert.equal(git(factory, "status", "--porcelain").trim(), "?? .copier-answers.yml");
    assert.equal(readFileSync(join(factory, "projects.yaml"), "utf8"), ownerRegistry);
    commit(factory);
    const oldAnswers = readFileSync(join(factory, ".copier-answers.yml"), "utf8");
    writeFileSync(join(source, "template/SHARED-IMPROVEMENT.md"), "A new shared improvement\n");
    writeFileSync(join(source, "template/projects.yaml"), "projects: []\ntooling: []\n");
    writeFileSync(join(source, "template/sprowi/config.default.json"), "{}\n");
    writeFileSync(join(source, "template/sprowi/projects/startup-factory.json"), "{}\n");
    writeFileSync(join(source, "template/sprowi/discovery/config.json"), "{}\n");
    const sharedReadme = join(source, "template/README.md.jinja");
    writeFileSync(sharedReadme, readFileSync(sharedReadme, "utf8").replace("## Set up your workspace", "A new shared onboarding improvement.\n\n## Set up your workspace"));
    commit(source); git(source, "tag", "v1.1.0");
    // WHEN the real CLI previews the upgrade, THEN the instance is unchanged.
    const preview = run(python, ["-m", "cli.startup", "template", "update", "--version", "v1.1.0", "--dry-run"], factory);
    assert.match(preview, /SHARED-IMPROVEMENT/);
    assert.equal(git(factory, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(factory, ".copier-answers.yml"), "utf8"), oldAnswers);
    // WHEN the real CLI applies it, THEN new shared files arrive and owner data survives.
    run(python, ["-m", "cli.startup", "template", "update", "--version", "v1.1.0"], factory);
    assert.equal(readFileSync(join(factory, "SHARED-IMPROVEMENT.md"), "utf8"), "A new shared improvement\n");
    assert.equal(readFileSync(join(factory, "projects.yaml"), "utf8"), ownerRegistry);
    assert.equal(readFileSync(configPath, "utf8"), JSON.stringify(config));
    assert.equal(readFileSync(projectSettings, "utf8"), JSON.stringify(ownerSettings));
    assert.equal(readFileSync(discoveryConfig, "utf8"), JSON.stringify(discovery));
    assert.equal(readFileSync(join(privateHistory, "owner-note.txt"), "utf8"), "Private decisions survive updates\n");
    assert.equal(readFileSync(join(factory, "discovery/2025-01-01/README.md"), "utf8"), edition);
    assert.match(readFileSync(join(factory, "README.md"), "utf8"), /Owner customization/);
    assert.match(readFileSync(join(factory, "README.md"), "utf8"), /new shared onboarding improvement/);
    assert.equal(readFileSync(join(factory, "owner-notes.md"), "utf8"), "Only this instance\n");
    assert.match(readFileSync(join(factory, ".copier-answers.yml"), "utf8"), /v1.1.0/);
    const checks = files(join(factory, "scripts/tests")).concat(files(join(factory, "sprowi")).filter((file) => file.endsWith(".integration.test.mjs")));
    // Without the outer runner's context, the nested run reports and fails on its own.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    run(process.execPath, ["--test", ...checks], factory, { env });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});


test("GIVEN an owner reading repository in template defaults WHEN validating THEN automatic publication is rejected", () => {
  const temp = mkdtempSync(join(tmpdir(), "factory-reading-privacy-"));
  try {
    copySource(temp);
    mkdirSync(join(temp, "scripts"));
    cpSync(join(root, "scripts/validate-template.py"), join(temp, "scripts/validate-template.py"));
    const path = join(temp, "template/sprowi/discovery/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.reading = { enabled: true, publish: true, repository: "example-owner/private-factory" };
    writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(python, [join(temp, "scripts/validate-template.py")], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /must not enable owner reading/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

for (const ownerPath of ["template/.git/config", "template/sprowi/tasks/private/task.md", "template/sprowi/runs/private/result.json", "template/sprowi/experiments/private/observation.json", "template/sprowi/discovery/state/feedback.jsonl", "template/discovery/2026-01-01/README.md", "template/.env"]) {
  test(`GIVEN owner state at ${ownerPath} WHEN validating THEN publication is rejected`, () => {
    const temp = mkdtempSync(join(tmpdir(), "factory-privacy-"));
    try {
      const source = join(temp, "source");
      mkdirSync(join(source, "scripts"), { recursive: true });
      cpSync(join(root, "template"), join(source, "template"), { recursive: true });
      cpSync(join(root, "scripts/validate-template.py"), join(source, "scripts/validate-template.py"));
      const privateFile = join(source, ownerPath);
      mkdirSync(join(privateFile, ".."), { recursive: true });
      writeFileSync(privateFile, "synthetic owner data");
      const result = spawnSync(python, [join(source, "scripts/validate-template.py")], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /owner state or repository history/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
