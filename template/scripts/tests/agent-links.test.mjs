import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Agent instructions stay short by linking to the documents that hold the
// details. These checks keep the links working and assert no wording.
const root = fileURLToPath(new URL("../../", import.meta.url));
// Markdown inside registered repositories is checked by those repositories.
const skipped = new Set([".git", "node_modules", "projects", ".venv", "experiments"]);

function markdown(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdown(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

// A link into a registered repository must resolve in its checkout or, when it
// is not cloned (as in CI), in the repository's default branch.
function registered(kind, name) {
  const command = kind === "startups" ? "startups" : "tooling";
  const records = execFileSync(join(root, "scripts/registry.sh"), [command], { encoding: "utf8" });
  return records.split("\n").map((line) => line.split("\t")).find(([entry]) => entry === name)?.[1];
}

function existsInRegistered(resolved) {
  const [kind, name, ...rest] = relative(join(root, "projects"), resolved).split(sep);
  const checkout = join(root, "projects", kind, name ?? "");
  if (existsSync(checkout)) return existsSync(resolved);
  const repo = name && registered(kind, name);
  if (!repo) return false;
  const url = repo.replace(/^git@github\.com:/, "https://github.com/");
  const clone = mkdtempSync(join(tmpdir(), "factory-link-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth=1", "--filter=blob:none", "--no-checkout", url, clone], { stdio: "ignore" });
    const path = rest.filter(Boolean).join("/");
    execFileSync("git", ["-C", clone, "cat-file", "-e", `HEAD:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function targets(text) {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const links = [...prose.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)/g)].map((match) => match[1]);
  const imports = [...prose.matchAll(/^@(\S+)$/gm)].map((match) => match[1]);
  return [...links, ...imports];
}

test("GIVEN the workspace's Markdown WHEN following relative links THEN every target exists", () => {
  const broken = [];
  for (const document of markdown(root)) {
    for (const target of targets(readFileSync(document, "utf8"))) {
      const path = target.split("#")[0];
      if (!path || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = join(dirname(document), path);
      const exists = resolved.startsWith(join(root, "projects/"))
        ? existsInRegistered(resolved)
        : existsSync(resolved);
      if (!exists) broken.push(`${relative(root, document)} → ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("GIVEN the agent instructions WHEN looking for their sources THEN they link the testing policy and the vision", () => {
  const links = targets(readFileSync(join(root, "AGENTS.md"), "utf8"));
  assert.ok(links.includes("docs/testing-policy.md"));
  assert.ok(links.includes("VISION.md"));
});
