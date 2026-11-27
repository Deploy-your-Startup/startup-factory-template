import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

// Render exact API destinations. Service translation can occur on either side of
// NetworkPolicy enforcement, so include both the service and its HTTPS backends.
const [namespace, ...args] = process.argv.slice(2);
if (!namespace || namespace.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace) || !args.length) {
  throw new Error("Usage: node api-egress.mjs WORKSPACE_NAMESPACE [--local CONTEXT] [--endpoint IP PORT]...");
}
const destinations = new Map();
function add(ip, port) {
  const family = isIP(ip);
  if (!family || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("An API destination requires a single IPv4 or IPv6 address and a TCP port.");
  }
  const cidr = ip + (family === 4 ? "/32" : "/128");
  destinations.set(cidr + ":" + port, {
    to: [{ ipBlock: { cidr } }], ports: [{ protocol: "TCP", port }],
  });
}

function addHostingApi(context) {
  const read = (...resource) => JSON.parse(execFileSync("kubectl", [
    "--context", context, "--namespace", "default", "--request-timeout=15s", "get", ...resource, "-o", "json",
  ]));
  const service = read("service", "kubernetes");
  const front = service.spec.ports.find(({ name, protocol }) => name === "https" && protocol === "TCP");
  if (!front) throw new Error("The kubernetes Service has no HTTPS port.");
  for (const ip of service.spec.clusterIPs ?? [service.spec.clusterIP]) add(ip, front.port);
  const slices = read("endpointslices.discovery.k8s.io", "-l", "kubernetes.io/service-name=kubernetes").items;
  let found = false;
  for (const slice of slices) {
    const back = slice.ports?.find(({ name, protocol }) => name === front.name && protocol === "TCP");
    if (!back) continue;
    for (const endpoint of slice.endpoints) {
      if (endpoint.conditions?.ready === false || endpoint.conditions?.terminating) continue;
      for (const ip of endpoint.addresses) { add(ip, back.port); found = true; }
    }
  }
  if (!found) throw new Error("The kubernetes Service has no ready HTTPS endpoint; check the hosting context.");
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--local" && args[i + 1] && !args[i + 1].startsWith("-")) {
    addHostingApi(args[++i]);
  } else if (args[i] === "--endpoint" && args[i + 2]) {
    add(args[++i], Number(args[++i]));
  } else {
    throw new Error("Pass --local CONTEXT or --endpoint IP PORT for each approved API.");
  }
}

console.log(JSON.stringify({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: "t3-allowed-api-servers", namespace },
  spec: {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "t3-workspace" } },
    policyTypes: ["Egress"],
    egress: [...destinations.values()],
  },
}, null, 2));
