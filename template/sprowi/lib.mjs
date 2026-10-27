// Shared, deterministic pieces of the Sprowi loop: configuration, the engine
// table, the patch policy and the usage shape. Everything in here runs both on
// the host and inside a sandbox, so it may not touch anything host-specific.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const ENGINES = ["claude", "codex", "opencode", "copilot"];

export const hubRoot = resolve(import.meta.dirname, "..");

// Old sbx builds cannot disable the shared skills mount and also reject the
// corresponding environment-file field. Fail closed rather than dropping it.
export function supportsSandboxSkillIsolation() {
  const result = spawnSync("sbx", ["create", "--help"], { encoding: "utf8", timeout: 30000 });
  return result.status === 0 && /--skills(?:\s|=)/.test(result.stdout);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- registry -------------------------------------------------------------

// projects.yaml is parsed in exactly one place, scripts/registry.sh. Sprowi asks
// that script instead of reading the YAML itself, so a registry change reaches
// every consumer at once.
export function registryProjects(root = hubRoot) {
  const result = spawnSync(join(root, "scripts/registry.sh"), ["startups"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`registry.sh failed: ${result.stderr?.trim() ?? ""}`);
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, repo, deployed, kubectlContext] = line.split("\t");
      return { name, repo, deployed: deployed === "true", kubectlContext };
    });
}

// Each startup describes itself in docs/product.md (seeded by the application
// templates). Idea runs cannot see projects/ inside the sandbox, so the host
// passes these descriptions along. Read from disk rather than the registry, so
// a checkout without a description is simply absent.
export function productDescriptions(root = hubRoot) {
  const startups = join(root, "projects/startups");
  if (!existsSync(startups)) return [];
  return readdirSync(startups).sort().flatMap((project) => {
    const path = join(startups, project, "docs/product.md");
    return existsSync(path) ? [{ project, product: readFileSync(path, "utf8").slice(0, 6000) }] : [];
  });
}

export function resolveProject(name, root = hubRoot) {
  // The hub is a target like any other: it is the repository the idea files
  // live in. It is not in the registry, because the registry lists what gets
  // cloned below projects/ and the hub is what does the cloning.
  if (name === "startup-factory" || name === basename(root)) {
    return {
      name,
      repo: gitRemote(root),
      deployed: false,
      kubectlContext: "",
      path: root,
      slug: githubSlug(gitRemote(root)),
    };
  }
  const project = registryProjects(root).find((entry) => entry.name === name);
  if (!project) {
    const known = registryProjects(root).map((entry) => entry.name);
    throw new Error(
      `Unknown project "${name}". The registry knows: ${known.join(", ")}`,
    );
  }
  const path = join(root, "projects/startups", name);
  if (!existsSync(path)) {
    throw new Error(
      `${name} is registered but not checked out at ${path}. Run scripts/init.sh.`,
    );
  }
  return { ...project, path, slug: githubSlug(project.repo) };
}

// git@github.com:owner/repo.git and https://github.com/owner/repo both yield
// "owner/repo", which is what every `gh -R` call needs.
export function gitRemote(path) {
  const result = spawnSync("git", ["-C", path, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function githubSlug(repositoryUrl) {
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(
    repositoryUrl ?? "",
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

// --- configuration --------------------------------------------------------

// The hub holds the defaults, the per-project file holds what that project
// actually verifies. Projects own no Sprowi code, so both files live here.
export function loadConfig(projectName, root = hubRoot) {
  const defaults = readJson(join(root, "sprowi/config.default.json"));
  const projectPath = join(root, "sprowi/projects", `${projectName}.json`);
  if (!existsSync(projectPath)) {
    throw new Error(
      `No Sprowi configuration for ${projectName}. Create one with:\n  scripts/sprowi.sh init ${projectName}`,
    );
  }
  return mergeConfig(defaults, readJson(projectPath));
}

export function mergeConfig(defaults, overlay) {
  const engines = { ...defaults.engines };
  for (const [name, values] of Object.entries(overlay.engines ?? {})) {
    if (!ENGINES.includes(name)) {
      throw new Error(`Unknown engine in the project configuration: ${name}`);
    }
    engines[name] = {
      ...engines[name],
      ...values,
      credential: { ...engines[name].credential, ...(values.credential ?? {}) },
      limits: { ...engines[name].limits, ...(values.limits ?? {}) },
    };
  }
  return {
    ...defaults,
    ...overlay,
    engines,
    limits: { ...defaults.limits, ...(overlay.limits ?? {}) },
    inputFiles: { ...defaults.inputFiles, ...(overlay.inputFiles ?? {}) },
    publish: {
      ...defaults.publish,
      ...(overlay.publish ?? {}),
      app: { ...defaults.publish.app, ...(overlay.publish?.app ?? {}) },
    },
  };
}

export function resolveEngine(config, requested) {
  const name = requested || config.engine;
  if (!ENGINES.includes(name)) {
    throw new Error(`Unknown engine: ${name}. Use one of ${ENGINES.join(", ")}.`);
  }
  const engine = config.engines?.[name];
  if (!engine) throw new Error(`Engine ${name} is missing from the config.`);
  return { name, ...engine };
}

// A run without checks would report "verified" for anything the agent wrote,
// which is the one failure mode worth refusing outright.
export function validateConfig(config) {
  const errors = [];
  if (Object.keys(config.acceptanceCommands ?? {}).length === 0) {
    errors.push(
      "acceptanceCommands is empty: nothing would verify the patch. Add at least one check.",
    );
  }
  for (const [group, commands] of [
    ["setupCommands", config.setupCommands],
    ["acceptanceCommands", config.acceptanceCommands],
  ]) {
    for (const [check, command] of Object.entries(commands ?? {})) {
      if (!Array.isArray(command) || command.length === 0) {
        errors.push(`${group}.${check} must be a non-empty argv array.`);
      }
    }
  }
  if (!config.allowedPaths?.length) errors.push("allowedPaths is empty.");
  return errors;
}

// --- path policy ----------------------------------------------------------

// "**" crosses directory separators, "*" does not. A "dir/**" pattern also
// matches "dir" itself, so protecting a directory protects the entry for it.
export function matchesPathPattern(path, pattern) {
  if (pattern.endsWith("/**") && path === pattern.slice(0, -3)) return true;
  const expression = pattern
    .split("**")
    .map((part) =>
      part
        .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]"),
    )
    .join(".*");
  return new RegExp(`^${expression}$`).test(path);
}

export function isSafeRepositoryPath(path) {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..") &&
    !/\s/.test(path)
  );
}

export function extractPatchPaths(patch) {
  const paths = new Set();
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/([^\t ]+) b\/([^\t ]+)$/.exec(line);
      if (!match) throw new Error(`Unsupported patch header: ${line}`);
      paths.add(match[1]);
      paths.add(match[2]);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const value = line.slice(4);
      if (value === "/dev/null") continue;
      const match = /^[ab]\/([^\t ]+)$/.exec(value);
      if (!match) throw new Error(`Unsupported file header: ${line}`);
      paths.add(match[1]);
      continue;
    }
    const metadata = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (metadata) {
      if (/\s/.test(metadata[1])) {
        throw new Error(`Unsupported rename or copy header: ${line}`);
      }
      paths.add(metadata[1]);
    }
  }
  return [...paths];
}

// The deterministic boundary of the whole loop: whatever the agent did inside
// its microVM, only a patch that survives this is allowed to leave.
export function validatePatch(config, patch) {
  const errors = [];
  const bytes = Buffer.byteLength(patch);
  if (bytes === 0) errors.push("The patch is empty.");
  if (bytes > config.limits.maxPatchBytes) {
    errors.push(`Patch size ${bytes} exceeds ${config.limits.maxPatchBytes} bytes.`);
  }
  if (patch.includes("GIT binary patch")) {
    errors.push("Binary patches are not allowed.");
  }
  if (
    /^(?:new file mode|old mode|new mode|deleted file mode) (?:120000|160000)$/m.test(patch)
  ) {
    errors.push("Symlink and submodule patches are not allowed.");
  }

  let paths = [];
  try {
    paths = extractPatchPaths(patch);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (paths.length > config.limits.maxChangedFiles) {
    errors.push(`${paths.length} changed paths exceed the limit of ${config.limits.maxChangedFiles}.`);
  }

  for (const path of paths) {
    if (!isSafeRepositoryPath(path)) {
      errors.push(`Unsafe repository path: ${path}`);
      continue;
    }
    if (config.protectedPaths.some((pattern) => matchesPathPattern(path, pattern))) {
      errors.push(`Protected path changed: ${path}`);
    }
    if (!config.allowedPaths.some((pattern) => matchesPathPattern(path, pattern))) {
      errors.push(`Path is outside the allowlist: ${path}`);
    }
  }

  return { bytes, paths, errors };
}

// --- engine plumbing ------------------------------------------------------

// Every engine reports the same fields, so budgets, usage.json and the run
// summary stay engine-independent. The token buckets are disjoint: input
// counts fresh prompt tokens only, never the cached or written ones.
export function emptyUsage(engine) {
  return {
    engine: engine.name,
    model: engine.model,
    reasoningEffort: engine.reasoningEffort ?? null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    steps: 0,
    limitReached: false,
    complete: false,
  };
}

// sbx routes egress through its host proxy, which swaps the placeholder for
// the real credential. An engine started with a reduced environment must keep
// these, or its requests bypass the proxy and travel with the placeholder.
const SANDBOX_PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];

export function sandboxProxyEnvironment(environment = process.env) {
  return Object.fromEntries(
    SANDBOX_PROXY_VARIABLES.filter((name) => environment[name]).map((name) => [
      name,
      environment[name],
    ]),
  );
}

// Sandbox images ship their own agent CLIs and the kit installs a pinned one
// into the global npm prefix, which is not always first on PATH.
export function resolvePinnedCli(name) {
  const prefix = spawnSync("npm", ["prefix", "--global"], { encoding: "utf8" });
  if (prefix.status !== 0) return name;
  const pinned = join(prefix.stdout.trim(), "bin", name);
  return existsSync(pinned) ? pinned : name;
}
