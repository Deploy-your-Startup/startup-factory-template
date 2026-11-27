import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
