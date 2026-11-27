import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("GIVEN shared sandbox kits WHEN coding and marketing are composed THEN tools are role-specific and unknown roles fail closed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-profiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  cpSync(new URL("../with-factory-kit.sh", import.meta.url), join(root, "scripts/with-factory-kit.sh"));
  cpSync(new URL("../../sandbox", import.meta.url), join(root, "sandbox"), { recursive: true });
  for (const file of ["pyproject.toml", "uv.lock"]) cpSync(new URL("../../" + file, import.meta.url), join(root, file));
  const bin = join(root, "bin"); mkdirSync(bin);
  const log = join(root, "calls");
  // External boundaries only: exercise the real composer and staged recipe.
  writeFileSync(join(bin, "docker"), '#!/bin/sh\nif [ "$*" = "buildx inspect" ]; then echo "Driver: docker"; fi\n', { mode: 0o755 });
  writeFileSync(join(bin, "sbx"), '#!/bin/sh\nprintf "%s\\n" "$@" "builder=$BUILDX_BUILDER" > "$PROFILE_CALLS"\n', { mode: 0o755 });
  const invoke = (profile) => spawnSync("bash", ["scripts/with-factory-kit.sh", "create", "--profile", profile, "--name", "fixture", "docker.io/sbx/codex:latest"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH, PROFILE_CALLS: log, BUILDX_BUILDER: "" },
  });
  let result = invoke("coding"); assert.equal(result.status, 0, result.stderr);
  let calls = readFileSync(log, "utf8");
  assert.match(calls, /sandbox\/kits\/mise/); assert.match(calls, /sandbox\/kits\/boundary/);
  assert.match(calls, /sandbox\/kits\/images/); assert.match(calls, /factory-kit[.]/);
  assert.match(calls, /^builder=sbx-kits$/m);
  assert.match(calls, /sandbox\/kits\/github-subdomains/);
  result = invoke("marketing"); assert.equal(result.status, 0, result.stderr);
  calls = readFileSync(log, "utf8");
  assert.match(calls, /sandbox\/kits\/mise/); assert.match(calls, /sandbox\/kits\/boundary/);
  assert.doesNotMatch(calls, /factory-kit[.]|sandbox\/kits\/images/);
  assert.match(calls, /^builder=sbx-kits$/m);
  assert.match(calls, /sandbox\/kits\/github-subdomains/);
  result = invoke("publish-everything"); assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown sandbox profile/);
});

function readYaml(file) {
  const result = spawnSync("yq", ["-o=json", ".", file.pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("GIVEN Sprowi role overlays WHEN resolving shared kits THEN all engines and the separate verifier use one runtime and boundary", () => {
  const root = new URL("../../", import.meta.url);
  for (const role of ["codex", "claude", "copilot", "opencode", "verifier"]) {
    const file = new URL("sprowi/sandbox/" + role + ".sbxenv.yaml", root);
    const environment = readYaml(file);
    const kits = environment.kits.map((kit) => new URL((kit.source ?? kit) + "/spec.yaml", file));
    assert.ok(kits.some((kit) => kit.pathname === new URL("sandbox/kits/mise/spec.yaml", root).pathname));
    assert.ok(kits.some((kit) => kit.pathname === new URL("sandbox/kits/boundary/spec.yaml", root).pathname));
    const network = kits.flatMap((kit) => readYaml(kit).capabilities)
      .filter((capability) => capability.type === "com.docker.sandbox/network-policy@1");
    const denied = network.flatMap(({ config }) => config.runtime?.deny ?? []);
    if (role === "copilot") {
      const allowed = network.flatMap(({ config }) => config.runtime?.allow ?? []);
      assert.ok(allowed.includes("api.github.com"));
      assert.ok(!denied.includes("api.github.com") && !denied.includes("*.github.com"));
      assert.ok(denied.includes("github.com"));
    } else {
      assert.ok(denied.includes("*.github.com"), role);
    }
    if (role === "verifier") {
      const config = readFileSync(file, "utf8");
      assert.doesNotMatch(config, /secrets:|sprowi-codex|factory-tools/);
      assert.match(readFileSync(new URL("sprowi/sandbox/kits/verifier/spec.yaml", root), "utf8"), /api.openai.com/);
    }
  }
});
