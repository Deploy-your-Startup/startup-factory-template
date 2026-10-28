import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const source = new URL("../../", import.meta.url);
test("GIVEN a differently named factory WHEN creating a hub task THEN the stable hub target resolves without personal projects", () => {
  const root = mkdtempSync(join(tmpdir(), "renamed-factory-"));
  try {
    cpSync(new URL("sprowi", source), join(root, "sprowi"), { recursive: true });
    cpSync(new URL("scripts", source), join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "projects.yaml"), "projects: []\ntooling: []\n");
    const result = spawnSync("bash", [join(root, "scripts/sprowi.sh"), "new", "startup-factory", "first-idea"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /first-idea/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GIVEN an unreachable repository WHEN setup clones it THEN setup fails before reporting completion", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-clone-failure-"));
  try {
    cpSync(new URL("scripts", source), join(root, "scripts"), { recursive: true });
    const bin = join(root, "bin"); mkdirSync(bin);
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    for (const name of ["startup", "yq", "git", "dirname", "head"]) {
      const command = name === "startup" ? (process.env.STARTUP_TEST_EXECUTABLE || (existsSync(join(homedir(), ".local/share/startup/commands/startup")) ? join(homedir(), ".local/share/startup/commands/startup") : name)) : name;
      const found = spawnSync("which", [command], { encoding: "utf8" });
      assert.equal(found.status, 0, command);
      writeFileSync(join(bin, name), `#!/bin/bash\nexec ${quote(found.stdout.trim())} "$@"\n`, { mode: 0o755 });
    }
    for (const name of ["kubectl", "uv", "gh", "mise"]) {
      writeFileSync(join(bin, name), '#!/bin/bash\n[ "$1" = --version ] || exit 90\necho test-boundary\n', { mode: 0o755 });
    }
    writeFileSync(join(root, "projects.yaml"), `projects:\n  - name: example-app\n    repo: ${root}/missing.git\ntooling: []\n`);
    const result = spawnSync("/bin/bash", [join(root, "scripts/init.sh")], { env: { ...process.env, HOME: root, PATH: bin }, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Setup incomplete/);
    assert.doesNotMatch(result.stdout, /Done! Projects/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
