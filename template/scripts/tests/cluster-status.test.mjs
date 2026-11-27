import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("GIVEN a host context WHEN the sandbox requests status THEN only the configured namespace and health fields are returned", (t) => {
  const home = mkdtempSync(join(tmpdir(), "factory-status-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const kubectl = join(home, "kubectl");
  const kubeconfig = join(home, "kubeconfig");
  const server = join(home, "cluster-status.mjs");
  copyFileSync(new URL("../cluster-status.mjs", import.meta.url), server);
  writeFileSync(kubectl, [
    "#!/bin/sh",
    'printf "%s\\n" "$@" >> kubectl.args',
    "cat response.json",
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(home, "cluster-status.json"), JSON.stringify({
    home, path: "/usr/bin:/bin", kubectl, kubeconfig, ssh: {},
    projects: { sample: { context: "approved", namespace: "sample-prod" } },
  }));
  writeFileSync(join(home, "response.json"), JSON.stringify({ items: [
    { kind: "Pod", metadata: { name: "web", namespace: "sample-prod" }, spec: { containers: [
      { env: [{ name: "INTERNAL", value: "DUMMY_SECRET" }] },
    ] }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 2 }] } },
    { kind: "Pod", metadata: { name: "other-project", namespace: "other" } },
    { kind: "Deployment", metadata: { name: "backend", namespace: "sample-prod" }, spec: { replicas: 2 },
      status: { readyReplicas: 1, availableReplicas: 1 } },
  ] }));

  const call = (id, args) => ({
    jsonrpc: "2.0", id, method: "tools/call", params: { name: "cluster_status", arguments: args },
  });
  const result = spawnSync(process.execPath, [server], {
    input: [
      call(1, { project: "another-project" }),
      call(2, { project: "sample", namespace: "other" }),
      call(3, { project: "sample" }),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /DUMMY_SECRET|other-project/);
  const [unknown, extraArgument, valid] = result.stdout.trim().split("\n").map((line) => JSON.parse(line).result);
  assert.equal(unknown.isError, true);
  assert.equal(extraArgument.isError, true);
  assert.equal(valid.isError, false);
  assert.deepEqual(JSON.parse(valid.content[0].text), {
    project: "sample", namespace: "sample-prod",
    pods: [{ name: "web", phase: "Running", ready: 1, containers: 1, restarts: 2 }],
    deployments: [{ name: "backend", desired: 2, ready: 1, available: 1 }],
  });
  assert.deepEqual(readFileSync(join(home, "kubectl.args"), "utf8").trim().split("\n"), [
    "--kubeconfig", kubeconfig, "--context", "approved", "--namespace", "sample-prod",
    "--request-timeout=8s", "get", "pods,deployments", "-o", "json",
  ]);
});

test("GIVEN a shared context WHEN preparing the status grant THEN only checkouts matching the committed registry supply a namespace", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "factory-status-grant-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "factory");
  const home = join(temp, "home");
  for (const directory of [join(root, "scripts"), join(home, "bin"), join(home, ".kube"), join(home, ".local")]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const file of ["registry.sh", "prepare-cluster-status.mjs", "cluster-status.mjs"]) {
    copyFileSync(new URL("../" + file, import.meta.url), join(root, "scripts", file));
  }
  for (const file of ["pyproject.toml", "uv.lock", "sandbox/factory-tools/kit.dockerfile"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(new URL("../../" + file, import.meta.url), join(root, file));
  }
  writeFileSync(join(home, ".kube/config"), "");
  writeFileSync(join(home, "bin/kubectl"), '#!/bin/sh\n[ "$3 $4 $5 $6" = "config get-contexts -o name" ] || exit 2\necho shared\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: join(home, "bin") + ":" + process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Fixture", ...args], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const names = ["shop", "blog"];
  const registry = { projects: names.map((name) => ({ name, repo: "https://example.invalid/" + name, deployed: true, kubectl_context: "shared" })) };
  writeFileSync(join(root, "projects.yaml"), JSON.stringify(registry));
  git(root, "init", "-q"); git(root, "add", "projects.yaml"); git(root, "commit", "-qm", "Registry");
  for (const name of names) {
    const checkout = join(root, "projects/startups", name);
    mkdirSync(join(checkout, "deployment/group_vars"), { recursive: true });
    writeFileSync(join(checkout, "deployment/group_vars/all.yml"), "k8s_namespace: " + name + "\n");
    git(checkout, "init", "-q"); git(checkout, "remote", "add", "origin", "git@example.invalid:" + (name === "shop" ? "shop" : "different"));
    git(checkout, "add", "deployment"); git(checkout, "commit", "-qm", "Namespace");
  }
  registry.projects[1].repo = "https://example.invalid/different";
  writeFileSync(join(root, "projects.yaml"), JSON.stringify(registry));
  const result = spawnSync(process.execPath, [join(root, "scripts/prepare-cluster-status.mjs"), "owner-status"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const grant = JSON.parse(readFileSync(join(dirname(result.stdout.trim()), "cluster-status.json"), "utf8"));
  assert.deepEqual(grant.projects, { shop: { context: "shared", namespace: "shop" } });
});
