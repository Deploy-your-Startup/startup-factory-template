import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real CLI, archives, filesystem and local/bare Git repositories. Only GitHub's
// metadata API is replaced; these scenarios do not establish live OAuth access.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-reading-test-"));
  const factory = join(root, "factory"), bin = join(root, "bin");
  mkdirSync(factory); mkdirSync(bin);
  cpSync(new URL("./", import.meta.url), join(factory, "sprowi"), { recursive: true, filter: (path) => !/\/(state|runs|experiments)(\/|$)/.test(path) });
  writeFileSync(join(factory, ".gitignore"), "/sprowi/discovery/state/\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Reading test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Reading test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const exec = (name, args, cwd = factory) => spawnSync(name, args, { cwd, env, encoding: "utf8" });
  const git = (...args) => { const r = exec("git", args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "main"); git("config", "commit.gpgsign", "false");
  const configPath = join(factory, "sprowi/discovery/config.json");
  const configure = (reading) => {
    const c = JSON.parse(readFileSync(configPath)); c.reading = reading;
    writeFileSync(configPath, JSON.stringify(c));
  };
  configure({ enabled: false, publish: false, repository: "example/private-factory" });
  git("add", "."); git("commit", "-qm", "factory fixture");
  const remote = join(root, "origin.git");
  assert.equal(exec("git", ["init", "--bare", "-q", "-b", "main", remote]).status, 0);
  git("remote", "add", "origin", remote); git("push", "-q", "origin", "main");
  const metadata = join(root, "github.json"), calls = join(root, "github-calls");
  writeFileSync(metadata, JSON.stringify({ nameWithOwner: "example/private-factory", isPrivate: true, defaultBranchRef: { name: "main" }, url: "https://github.com/example/private-factory" }));
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nimport {readFileSync,appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
const value=JSON.parse(readFileSync(${JSON.stringify(metadata)}));
if(value.denied){console.error('synthetic GitHub access denied');process.exit(1);}
console.log(JSON.stringify(value));\n`, { mode: 0o755 });
  const archive = (day, extra = {}) => {
    const path = join(factory, "sprowi/discovery/state/history", day);
    mkdirSync(join(path, "ideas"), { recursive: true });
    const ideas = [1, 2, 3].map((rank) => {
      const file = `00${rank}-problem-${rank}.md`;
      const text = `# Customer problem ${rank}\n\n` + ["Problem", "Evidence", "Distribution", "Smallest test", "Assumption", "Why it might fail"].map((heading) => `## ${heading}\n\nIf at least four of eight customers use the paper workflow within three days, test this hypothesis. https://example.invalid/source-${rank}\n`).join("\n");
      writeFileSync(join(path, "ideas", file), text);
      return { file, title: `Customer problem ${rank}`, rank };
    });
    writeFileSync(join(path, "batch.json"), JSON.stringify({ day, status: "complete", verification: "verified", ideas, findings: [], researchErrors: [], ...extra }));
    for (const file of ["research.json", "usage.json", "result.json", "result.patch"]) writeFileSync(join(path, file), "PRIVATE-RAW-ARTIFACT");
    writeFileSync(join(factory, "sprowi/discovery/state/feedback.jsonl"), "PRIVATE-FEEDBACK");
    return path;
  };
  const run = (...args) => exec(process.execPath, [join(factory, "sprowi/cli.mjs"), "discover", ...args]);
  return { root, factory, remote, metadata, calls, git, exec, configure, archive, run, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

test("GIVEN complete batches WHEN exporting readings THEN linked ranked editions preserve earlier dates, findings and the raw private archive", () => {
  const f = fixture();
  try {
    f.archive("2026-01-01", { verification: "verified-with-findings", findings: [{ rule: "Evidence", problem: "Demand is still uncertain" }], researchErrors: [{ url: "https://example.invalid/unavailable", error: "HTTP 503" }] });
    const first = f.run("export", "--date", "2026-01-01");
    assert.equal(first.status, 0, first.stderr);
    const destination = join(f.factory, "discovery"), date = join(destination, "2026-01-01");
    assert.deepEqual(readdirSync(date).sort(), ["README.md", "ideas"]);
    const report = readFileSync(join(date, "README.md"), "utf8");
    assert.match(report, /First ten participants/); assert.match(report, /Success \/ stop criteria/);
    assert.match(report, /Demand is still uncertain/); assert.match(report, /Research errors: 1/);
    assert.doesNotMatch(report, /PRIVATE-RAW|PRIVATE-FEEDBACK/);
    for (const file of readdirSync(join(date, "ideas"))) {
      assert.equal(readFileSync(join(date, "ideas", file), "utf8"), readFileSync(join(f.factory, "sprowi/discovery/state/history/2026-01-01/ideas", file), "utf8"));
    }
    for (const md of [join(destination, "README.md"), join(date, "README.md")]) {
      for (const match of readFileSync(md, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
        if (!match[1].startsWith("<https:")) assert.ok(existsSync(join(md, "..", match[1])), match[1]);
      }
    }
    f.archive("2026-01-02"); assert.equal(f.run("export", "--date", "2026-01-02").status, 0);
    const index = readFileSync(join(destination, "README.md"), "utf8");
    assert.match(index, /Latest · 2026-01-02/); assert.ok(index.indexOf("| [2026-01-02]") < index.indexOf("| [2026-01-01]"));
    assert.equal(f.run("export", "--date", "2026-01-01").status, 0);
    assert.equal(readFileSync(join(destination, "README.md"), "utf8"), index);
    assert.equal(existsSync(f.calls), false, "Local export must not call GitHub.");
    assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/reading.lock")), false);
  } finally { f.close(); }
});

test("GIVEN a matching private origin WHEN publishing and retrying THEN only reading copies reach Git and the retry creates no commit", () => {
  const f = fixture();
  try {
    f.archive("2026-01-01");
    const before = f.git("rev-parse", "HEAD");
    const result = f.run("export", "--date", "2026-01-01", "--publish");
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /READING_PUBLISHED https:\/\/github.com\/example\/private-factory/);
    assert.equal(f.git("status", "--porcelain"), "");
    const after = f.git("rev-parse", "HEAD"); assert.notEqual(after, before);
    const changed = f.git("diff", "--name-only", before, after).split("\n");
    assert.equal(changed.length, 5); assert.ok(changed.every((path) => path.startsWith("discovery/")));
    assert.equal(f.git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], after);
    assert.doesNotMatch(f.git("ls-tree", "-r", "--name-only", "HEAD", "--", "discovery", "sprowi/discovery/state"), /state\/|feedback|research\.json|usage\.json|result\.patch/);
    assert.equal(JSON.parse(readFileSync(f.calls, "utf8").trim().split("\n")[0])[2], f.remote, "Query the actual origin, not just the configured slug.");
    const again = f.run("export", "--date", "2026-01-01", "--publish");
    assert.equal(again.status, 0, again.stderr); assert.equal(f.git("rev-parse", "HEAD"), after);
  } finally { f.close(); }
});

test("GIVEN denied access, a public or different origin, or unrelated work WHEN publishing THEN it refuses before writing, staging or committing", async (t) => {
  for (const scenario of ["public", "different", "denied", "missing-repository", "unstaged", "staged", "untracked", "branch", "ahead", "behind"]) {
    await t.test(scenario, () => {
      const f = fixture();
      try {
        f.archive("2026-01-01");
        if (["public", "different", "denied"].includes(scenario)) {
          const value = JSON.parse(readFileSync(f.metadata));
          if (scenario === "public") value.isPrivate = false;
          if (scenario === "different") value.nameWithOwner = "someone/else";
          if (scenario === "denied") value.denied = true;
          writeFileSync(f.metadata, JSON.stringify(value));
        }
        if (scenario === "missing-repository") { f.configure({}); f.git("add", "."); f.git("commit", "-qm", "no repository configured"); f.git("push", "-q", "origin", "main"); }
        if (["unstaged", "staged", "untracked", "ahead"].includes(scenario)) {
          const path = join(f.factory, scenario === "untracked" ? "owner.txt" : ".gitignore");
          writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + "OWNER-CHANGE\n");
        }
        if (["staged", "ahead"].includes(scenario)) f.git("add", ".gitignore");
        if (scenario === "ahead") f.git("commit", "-qm", "owner's unpushed change");
        if (scenario === "branch") f.git("switch", "-qc", "owner-work");
        if (scenario === "behind") {
          const other = join(f.root, "other");
          assert.equal(f.exec("git", ["clone", "-q", f.remote, other]).status, 0);
          writeFileSync(join(other, "owner-remote.txt"), "Remote owner work\n");
          for (const args of [["add", "."], ["-c", "commit.gpgsign=false", "commit", "-qm", "remote owner change"], ["push", "-q", "origin", "main"]]) assert.equal(f.exec("git", args, other).status, 0);
        }
        const status = f.git("status", "--porcelain"), head = f.git("rev-parse", "HEAD");
        const result = f.run("export", "--date", "2026-01-01", "--publish");
        assert.equal(result.status, 1, result.stdout); assert.ok(result.stderr.length);
        assert.equal(existsSync(join(f.factory, "discovery")), false);
        assert.equal(f.git("status", "--porcelain"), status); assert.equal(f.git("rev-parse", "HEAD"), head);
        assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/reading.lock")), false);
      } finally { f.close(); }
    });
  }
});

test("GIVEN a server refusing pushes WHEN publishing THEN the batch and local reading commit survive with an actionable retry error", () => {
  const f = fixture();
  try {
    const archive = f.archive("2026-01-01"), remoteHead = f.git("rev-parse", "HEAD");
    assert.equal(f.exec("git", ["--git-dir", f.remote, "config", "core.bare", "false"]).status, 0);
    assert.equal(f.exec("git", ["--git-dir", f.remote, "config", "receive.denyCurrentBranch", "refuse"]).status, 0);
    const failed = f.run("export", "--date", "2026-01-01", "--publish");
    assert.equal(failed.status, 1); assert.match(failed.stderr, /rejected|refusing/i);
    assert.equal(JSON.parse(readFileSync(join(archive, "batch.json"))).status, "complete");
    assert.notEqual(f.git("rev-parse", "HEAD"), remoteHead);
    assert.equal(f.git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], remoteHead);
    const again = f.run("export", "--date", "2026-01-01", "--publish");
    assert.equal(again.status, 1); assert.match(again.stderr, /push existing commits yourself/);
    assert.equal(existsSync(join(f.factory, "discovery/README.md")), true);
  } finally { f.close(); }
});

test("GIVEN invalid batches or unsafe paths WHEN exporting THEN no reading copy or GitHub request is produced", async (t) => {
  for (const scenario of ["incomplete", "filename", "ranks", "input-symlink", "output-symlink", "invalid-date", "concurrent"]) {
    await t.test(scenario, () => {
      const f = fixture();
      try {
        const path = f.archive("2026-01-01");
        const manifest = join(path, "batch.json"), batch = JSON.parse(readFileSync(manifest));
        if (scenario === "incomplete") batch.status = "failed";
        if (scenario === "filename") batch.ideas[0].file = "../../private.md";
        if (scenario === "ranks") batch.ideas[1].rank = 1;
        writeFileSync(manifest, JSON.stringify(batch));
        if (scenario === "input-symlink") {
          const file = join(path, "ideas", batch.ideas[0].file); rmSync(file); symlinkSync(join(f.factory, ".gitignore"), file);
        }
        if (scenario === "output-symlink") symlinkSync(f.root, join(f.factory, "discovery"));
        if (scenario === "concurrent") mkdirSync(join(f.factory, "sprowi/discovery/state/reading.lock"));
        const result = f.run("export", "--date", scenario === "invalid-date" ? "2026-02-30" : "2026-01-01");
        assert.equal(result.status, 1, result.stdout);
        assert.equal(existsSync(join(f.factory, "discovery/2026-01-01")), false);
        assert.equal(existsSync(f.calls), false);
      } finally { f.close(); }
    });
  }
});

for (const engine of ["claude", "codex"]) {
  test(`GIVEN ${engine} and enabled publication WHEN reusing a complete batch THEN the common run publishes without another model call`, () => {
    const f = fixture();
    try {
      f.archive("2026-01-01");
      f.configure({ enabled: true, publish: true, repository: "example/private-factory" });
      const path = join(f.factory, "sprowi/discovery/config.json"), config = JSON.parse(readFileSync(path));
      config.engine = engine; writeFileSync(path, JSON.stringify(config));
      f.git("add", "."); f.git("commit", "-qm", "enable reading publication"); f.git("push", "-q", "origin", "main");
      const result = f.run("run", "--date", "2026-01-01");
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Already complete/); assert.match(result.stdout, /READING_PUBLISHED/);
      assert.equal(f.git("status", "--porcelain"), "");
    } finally { f.close(); }
  });
}
