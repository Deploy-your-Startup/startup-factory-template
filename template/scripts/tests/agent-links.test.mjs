import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Agent instructions stay short by linking to the documents that hold the
// details. These checks keep the links working and assert no wording.
const root = fileURLToPath(new URL("../../", import.meta.url));
// Registered repositories are separate checkouts with their own checks.
const skipped = new Set([".git", "node_modules", "projects", ".venv", "experiments"]);

function markdown(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdown(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
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
      if (resolved.startsWith(join(root, "projects/"))) continue;
      if (!existsSync(resolved)) broken.push(`${relative(root, document)} → ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("GIVEN the agent instructions WHEN looking for their sources THEN they link the testing policy and the vision", () => {
  const links = targets(readFileSync(join(root, "AGENTS.md"), "utf8"));
  assert.ok(links.includes("docs/testing-policy.md"));
  assert.ok(links.includes("VISION.md"));
});
