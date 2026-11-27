import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const base = fileURLToPath(new URL("../../sandbox/t3-workspace/", import.meta.url));
const hasKubectl = !spawnSync("kubectl", ["version", "--client"], { stdio: "ignore" }).error;
const options = { skip: hasKubectl ? false : "Kubernetes rendering requires kubectl" };

function render(directory) {
  const yaml = execFileSync("kubectl", ["kustomize", directory]);
  const json = execFileSync("yq", ["eval-all", "-o=json", "-I=0", "[.]", "-"], { input: yaml });
  return JSON.parse(json);
}

test("GIVEN a generated Factory WHEN rendering the T3 pilot THEN one private workspace keeps its home across pod replacements", options, () => {
  const resources = render(base);
  const resource = (kind) => resources.find((item) => item.kind === kind);
  const namespace = resource("Namespace");
  const deployment = resource("Deployment").spec;
  const service = resource("Service").spec;
  const home = resource("PersistentVolumeClaim");
  const pod = deployment.template.spec;
  const [workspace] = pod.containers;

  assert.equal(namespace.metadata.name, "factory-t3-pilot");
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  assert.ok(resources.filter((item) => item.kind !== "Namespace")
    .every((item) => item.metadata.namespace === namespace.metadata.name));
  assert.equal(deployment.replicas, 1);
  assert.equal(deployment.strategy.type, "Recreate");
  assert.equal(service.type, "ClusterIP");
  assert.deepEqual(service.selector, deployment.template.metadata.labels);
  assert.deepEqual(service.selector, deployment.selector.matchLabels);
  assert.equal(service.ports[0].port, 3773);
  assert.equal(service.ports[0].targetPort, workspace.ports[0].name);
  assert.equal(workspace.ports[0].containerPort, 3773);
  assert.equal(workspace.image, "factory-t3-pilot:0.1.13-factory.1");
  assert.equal(workspace.imagePullPolicy, "IfNotPresent");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(resource("ServiceAccount").metadata.name, pod.serviceAccountName);
  assert.equal(resource("ServiceAccount").automountServiceAccountToken, false);
  assert.ok(pod.volumes.every((volume) => !volume.secret && !volume.projected));
  assert.equal(pod.securityContext.runAsUser, 1000);
  assert.equal(workspace.securityContext.readOnlyRootFilesystem, true);
  assert.equal(workspace.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(workspace.securityContext.capabilities.drop, ["ALL"]);
  const homeMount = workspace.volumeMounts.find((mount) => mount.mountPath === "/home/node");
  const homeVolume = pod.volumes.find((volume) => volume.name === homeMount.name);
  assert.equal(homeVolume.persistentVolumeClaim.claimName, home.metadata.name);
  assert.deepEqual(home.spec.accessModes, ["ReadWriteOnce"]);

  const policy = resource("NetworkPolicy").spec;
  assert.deepEqual(policy.podSelector, {});
  assert.deepEqual(policy.ingress, []);
  assert.deepEqual(policy.policyTypes, ["Ingress", "Egress"]);
  const [dns, https] = policy.egress;
  assert.equal(policy.egress.length, 2);
  assert.deepEqual(dns.to, [{
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
    podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
  }]);
  assert.deepEqual(dns.ports, [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }]);
  assert.deepEqual(https.ports, [{ protocol: "TCP", port: 443 }]);
  assert.equal(https.to.length, 1);
  assert.equal(https.to[0].ipBlock.cidr, "0.0.0.0/0");
  for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]) {
    assert.ok(https.to[0].ipBlock.except.includes(cidr), cidr);
  }
});

test("GIVEN a renamed startup with local and remote grants WHEN rendering THEN it uses its own home, identity and kubeconfigs", options, (t) => {
  const temp = mkdtempSync(join(tmpdir(), "factory-t3-startup-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  cpSync(base, join(temp, "source"), { recursive: true });
  const overlay = join(temp, "owner");
  mkdirSync(overlay);
  writeFileSync(join(overlay, "kustomization.yaml"), [
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "namespace: another-startup-t3",
    "resources: [../source/profiles/startup]",
    "components: [../source/access/local-api, ../source/access/remote-api, ../source/access/github]",
  ].join("\n"));
  const resources = render(overlay);
  const resource = (kind) => resources.find((r) => r.kind === kind);
  assert.equal(resource("Namespace").metadata.name, "another-startup-t3");
  assert.ok(resources.filter((r) => r.kind !== "Namespace").every((r) => r.metadata.namespace === "another-startup-t3"));
  const pod = resource("Deployment").spec.template.spec;
  const container = pod.containers[0];
  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]));
  assert.equal(env.T3_WORKSPACE_PROFILE, "startup");
  assert.deepEqual(container.env.find((v) => v.name === "GH_TOKEN").valueFrom.secretKeyRef, { name: "t3-github", key: "token" });
  const volume = (name) => pod.volumes.find((v) => v.name === name);
  assert.equal(pod.serviceAccountName, resource("ServiceAccount").metadata.name);
  assert.equal(volume("home").persistentVolumeClaim.claimName, resource("PersistentVolumeClaim").metadata.name);
  assert.equal(volume("local-identity").projected.sources[0].serviceAccountToken.expirationSeconds, 3600);
  assert.equal(volume("local-kubeconfig").configMap.name, resource("ConfigMap").metadata.name);
  assert.equal(volume("remote-kubeconfig").secret.secretName, "t3-remote-kubeconfig");
  const mount = (name) => container.volumeMounts.find((v) => v.name === name);
  assert.deepEqual(env.KUBECONFIG.split(":"), [mount("local-kubeconfig"), mount("remote-kubeconfig")].map((v) => v.mountPath + "/config"));
  const localConfig = JSON.parse(execFileSync("yq", ["-o=json", ".", "-"], { input: resource("ConfigMap").data.config }));
  assert.equal(localConfig.users[0].user.tokenFile, mount("local-identity").mountPath + "/token");
  assert.equal(localConfig.clusters[0].cluster["certificate-authority"], mount("local-identity").mountPath + "/ca.crt");
  assert.deepEqual(resources.filter((r) => /RoleBinding$/.test(r.kind)), []);
});

test("GIVEN two private APIs WHEN rendering egress THEN each address opens only its chosen TCP port", () => {
  const script = join(base, "access/api-egress.mjs");
  const policy = JSON.parse(execFileSync(process.execPath, [script, "sample-t3", "--endpoint", "192.0.2.7", "6443", "--endpoint", "2001:db8::7", "443"]));
  assert.equal(policy.metadata.namespace, "sample-t3");
  assert.deepEqual(policy.spec.egress, [
    { to: [{ ipBlock: { cidr: "192.0.2.7/32" } }], ports: [{ protocol: "TCP", port: 6443 }] },
    { to: [{ ipBlock: { cidr: "2001:db8::7/128" } }], ports: [{ protocol: "TCP", port: 443 }] },
  ]);
  assert.notEqual(spawnSync(process.execPath, [script, "sample-t3", "--endpoint", "0.0.0.0/0", "443"]).status, 0);
});

test("GIVEN a fresh home WHEN the server starts THEN each profile selects its own default checkout", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "factory-t3-entrypoint-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bin = join(temp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "t3"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$HOME/invocation"\n', { mode: 0o755 });
  for (const [profile, checkout] of [["factory", "factory"], ["startup", "project"]]) {
    const home = join(temp, profile);
    execFileSync("sh", [join(base, "entrypoint.sh")], { env: {
      PATH: bin + ":" + process.env.PATH, HOME: home, T3CODE_HOME: join(home, ".t3"), T3_WORKSPACE_PROFILE: profile,
    } });
    const path = join(home, checkout);
    const invocation = readFileSync(join(home, "invocation"), "utf8").trimEnd().split("\n");
    assert.equal(invocation[0], path);
    assert.equal(invocation.at(-1), path);
    assert.equal(existsSync(join(home, profile === "factory" ? "project" : "factory")), false);
  }
});

test("GIVEN an owner's registry image WHEN rendering an overlay THEN Kubernetes runs that image", options, (t) => {
  const overlay = mkdtempSync(join(tmpdir(), "factory-t3-overlay-"));
  t.after(() => rmSync(overlay, { recursive: true, force: true }));
  cpSync(base, join(overlay, "base"), { recursive: true });
  writeFileSync(join(overlay, "kustomization.yaml"), [
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "resources: [base]",
    "images:",
    "  - name: factory-t3-pilot",
    "    newName: registry.example.com/factory/t3",
    "    newTag: candidate",
    "",
  ].join("\n"));
  const deployment = render(overlay).find((item) => item.kind === "Deployment");
  assert.equal(deployment.spec.template.spec.containers[0].image, "registry.example.com/factory/t3:candidate");
});
