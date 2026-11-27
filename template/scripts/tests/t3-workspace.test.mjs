import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(workspace.image, "factory-t3-pilot:0.1.13");
  assert.equal(workspace.imagePullPolicy, "IfNotPresent");
  assert.equal(pod.automountServiceAccountToken, false);
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
