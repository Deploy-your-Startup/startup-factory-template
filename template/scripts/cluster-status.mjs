import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Run on the host from a private directory. The trusted profile is generated
// outside the sandbox mount before registering the tool.
const profile = JSON.parse(readFileSync(new URL("cluster-status.json", import.meta.url), "utf8"));

const tool = {
  name: "cluster_status",
  description: "Read pod and deployment health for one configured Factory startup.",
  inputSchema: {
    type: "object",
    properties: { project: { type: "string", enum: Object.keys(profile.projects) } },
    required: ["project"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

function reply(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

function status(args) {
  if (!args || Object.keys(args).length !== 1 ||
      typeof args.project !== "string" || !Object.hasOwn(profile.projects, args.project)) {
    return reply({ error: "Choose a configured startup.", projects: Object.keys(profile.projects) }, true);
  }
  const { context, namespace } = profile.projects[args.project];
  const result = spawnSync(profile.kubectl, [
    "--kubeconfig", profile.kubeconfig, "--context", context, "--namespace", namespace,
    "--request-timeout=8s", "get", "pods,deployments", "-o", "json",
  ], {
    cwd: profile.home,
    env: { HOME: profile.home, PATH: profile.path, ...profile.ssh },
    encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 ** 2,
  });
  if (result.status !== 0) {
    return reply({ project: args.project, status: "unavailable", error: "The Mac could not read this cluster context." }, true);
  }
  const pods = [];
  const deployments = [];
  for (const item of JSON.parse(result.stdout).items) {
    if (item.metadata?.namespace !== namespace) continue;
    if (item.kind === "Pod") {
      const containers = item.status?.containerStatuses ?? [];
      pods.push({
        name: item.metadata.name,
        phase: item.status?.phase ?? "Unknown",
        ready: containers.filter((entry) => entry.ready).length,
        containers: item.spec?.containers?.length ?? 0,
        restarts: containers.reduce((sum, entry) => sum + (entry.restartCount ?? 0), 0),
      });
    }
    if (item.kind === "Deployment") {
      deployments.push({
        name: item.metadata.name,
        desired: item.spec?.replicas ?? 1,
        ready: item.status?.readyReplicas ?? 0,
        available: item.status?.availableReplicas ?? 0,
      });
    }
  }
  return reply({ project: args.project, namespace, pods, deployments });
}

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  let result;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(message.params?.protocolVersion)
            ? message.params.protocolVersion : "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "factory-cluster-status", version: "1.0.0" },
        };
        break;
      case "tools/list":
        result = { tools: [tool] };
        break;
      case "tools/call":
        result = message.params?.name === tool.name
          ? status(message.params.arguments) : reply({ error: "Unknown tool." }, true);
        break;
      case "ping":
        result = {};
        break;
    }
    const response = result === undefined ? { error: { code: -32601, message: "Unknown method" } } : { result };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response }) + "\n");
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: "Cluster status unavailable." },
    }) + "\n");
  }
}
