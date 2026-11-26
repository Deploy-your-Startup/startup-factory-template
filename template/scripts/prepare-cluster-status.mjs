import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

const root = realpathSync(join(import.meta.dirname, ".."));
const home = realpathSync(homedir());
const name = process.argv[2];
if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/prepare-cluster-status.mjs SANDBOX-NAME");
}

function outsideWorkspace(path) {
  const absolute = realpathSync(path);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(".." + "/") && !isAbsolute(rel) && rel !== "..")) {
    throw new Error("Host commands and credentials must live outside the Factory checkout.");
  }
  return absolute;
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: home, encoding: "utf8", ...options });
const find = (command) => outsideWorkspace(run("/usr/bin/which", [command]).trim());
const kubectl = find("kubectl");
const yq = find("yq");
const node = outsideWorkspace(process.execPath);
const kubeconfig = outsideWorkspace(join(home, ".kube", "config"));
const hostPath = process.env.PATH.split(delimiter).filter((path) => {
  try { return isAbsolute(path) && outsideWorkspace(path); } catch { return false; }
}).join(delimiter);
const ssh = {};
if (process.env.SSH_AUTH_SOCK) {
  try { ssh.SSH_AUTH_SOCK = outsideWorkspace(process.env.SSH_AUTH_SOCK); } catch { /* Use the host's normal SSH config. */ }
}

const gitShow = (checkout, file) => run("/usr/bin/git", ["-C", checkout, "show", "HEAD:" + file], {
  stdio: ["ignore", "pipe", "ignore"],
});
const registry = JSON.parse(run(yq, ["-o=json", ".", "-"], { input: gitShow(root, "projects.yaml") }));
const contexts = new Set(run(kubectl, ["--kubeconfig", kubeconfig, "config", "get-contexts", "-o", "name"]).trim().split("\n"));
const slug = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const projects = {};
for (const project of registry.projects ?? []) {
  if (project.deployed !== true || !slug.test(project.name) || !contexts.has(project.kubectl_context)) continue;
  const checkout = join(root, "projects", "startups", project.name);
  let namespace;
  try {
    if (realpathSync(checkout) !== checkout ||
        run("/usr/bin/git", ["-C", checkout, "rev-parse", "--show-toplevel"]).trim() !== checkout) continue;
    namespace = run(yq, ["-r", '.k8s_namespace // ""', "-"], {
      input: gitShow(checkout, "deployment/group_vars/all.yml"),
    }).trim();
  } catch { continue; }
  if (slug.test(namespace)) projects[project.name] = { context: project.kubectl_context, namespace };
}
if (!Object.keys(projects).length) throw new Error("No deployed startups have a namespace and a matching host kubeconfig context.");

const capsuleRoot = join(home, ".local", "share", "factory-cluster-status");
outsideWorkspace(dirname(dirname(capsuleRoot)));
mkdirSync(capsuleRoot, { recursive: true, mode: 0o700 });
const capsule = mkdtempSync(join(outsideWorkspace(capsuleRoot), name + "-"));
const kit = join(capsule, "kit");
mkdirSync(kit);
for (const file of ["pyproject.toml", "uv.lock"]) copyFileSync(join(root, file), join(kit, file));
copyFileSync(join(root, "sandbox", "factory-tools", "kit.dockerfile"), join(kit, "kit.dockerfile"));
copyFileSync(join(root, "scripts", "cluster-status.mjs"), join(capsule, "cluster-status.mjs"));
const write = (directory, file, value) =>
  writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
write(capsule, "cluster-status.json", { home, path: hostPath, kubectl, kubeconfig, ssh, projects });

const denied = ["github.com", "*.github.com", "*.hetzner.cloud", "api.cloudflare.com", "localhost", "host.docker.internal"];
writeFileSync(join(kit, "kit.yaml"), "# syntax=docker/sandbox-kit:3\n" + JSON.stringify({
  schemaVersion: "3", kind: "mixin", displayName: "factory-tools",
  capabilities: [{
    type: "com.docker.sandbox/network-policy@1",
    config: { install: { deny: denied }, runtime: { deny: denied } },
  }],
}, null, 2) + "\n");

write(capsule, "factory-status.sbxenv.yaml", {
  schemaVersion: "1", name, agent: "codex", workspace: root,
  kits: [{ source: "docker.io/sbx/codex:latest" }, { source: kit }],
  sandboxOptions: { skills: "off" },
  env: { GH_TOKEN: "", GITHUB_TOKEN: "" },
  mcp: { servers: [{ name: "factory-cluster-status", command: node, args: [join(capsule, "cluster-status.mjs")] }] },
});
process.stdout.write(join(capsule, "factory-status.sbxenv.yaml") + "\n");
