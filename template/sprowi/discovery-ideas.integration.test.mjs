import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real CLI, archives, ideas/ files, filesystem and local/bare Git repositories. Only GitHub's
// metadata API is replaced; these scenarios do not establish live OAuth access.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-ideas-test-"));
  const factory = join(root, "factory"), bin = join(root, "bin");
  mkdirSync(factory); mkdirSync(bin);
  cpSync(new URL("./", import.meta.url), join(factory, "sprowi"), { recursive: true, filter: (path) => !/\/(state|runs|experiments)(\/|$)/.test(path) });
  writeFileSync(join(factory, ".gitignore"), "/sprowi/discovery/state/\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Ideas test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Ideas test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const exec = (name, args, cwd = factory) => spawnSync(name, args, { cwd, env, encoding: "utf8" });
  const git = (...args) => { const r = exec("git", args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "main"); git("config", "commit.gpgsign", "false");
  const configPath = join(factory, "sprowi/discovery/config.json");
  const configure = (publish, key = "publish") => {
    const c = JSON.parse(readFileSync(configPath)); delete c.publish; delete c.reading; c[key] = publish;
    writeFileSync(configPath, JSON.stringify(c));
  };
  configure({ enabled: false, repository: "example/private-factory" });
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
  const archive = (day, extra = {}, prefix = "Customer problem") => {
    const path = join(factory, "sprowi/discovery/state/history", day);
    mkdirSync(join(path, "ideas"), { recursive: true });
    const ideas = [1, 2, 3].map((rank) => {
      const file = `00${rank}-problem-${rank}.md`;
      const text = `# ${prefix} ${rank}\n\n` + ["Problem", "Evidence", "Distribution", "Smallest test", "Assumption", "Why it might fail"].map((heading) => `## ${heading}\n\nIf at least four of eight customers use the paper workflow within three days, test this hypothesis. https://example.invalid/source-${rank}\n`).join("\n") + `\n## Rank\n\n${rank}\n`;
      writeFileSync(join(path, "ideas", file), text);
      return { file, title: `${prefix} ${rank}`, rank };
    });
    writeFileSync(join(path, "batch.json"), JSON.stringify({ day, status: "complete", verification: "verified", ideas, findings: [], researchErrors: [], ...extra }));
    for (const file of ["research.json", "usage.json", "result.json", "result.patch"]) writeFileSync(join(path, file), "PRIVATE-RAW-ARTIFACT");
    writeFileSync(join(factory, "sprowi/discovery/state/feedback.jsonl"), "PRIVATE-FEEDBACK");
    return path;
  };
  const run = (...args) => exec(process.execPath, [join(factory, "sprowi/cli.mjs"), "discover", ...args]);
  return { root, factory, remote, metadata, calls, git, exec, configure, archive, run, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

test("GIVEN complete batches and a hand-written idea WHEN filing THEN each proposal is added once under the next free number without its rank", () => {
  const f = fixture();
  try {
    const archive = f.archive("2026-01-01");
    mkdirSync(join(f.factory, "ideas"));
    writeFileSync(join(f.factory, "ideas/001-hand-written.md"), "# A hand-written idea\n");
    const first = f.run("file", "--date", "2026-01-01");
    assert.equal(first.status, 0, first.stderr);
    const ideas = join(f.factory, "ideas");
    assert.deepEqual(readdirSync(ideas).sort(), ["001-hand-written.md", "002-problem-1.md", "003-problem-2.md", "004-problem-3.md"]);
    const filed = readFileSync(join(ideas, "002-problem-1.md"), "utf8");
    assert.match(filed, /^# Customer problem 1\n/); assert.doesNotMatch(filed, /## Rank|PRIVATE/);
    assert.match(filed, /## Why it might fail/);
    assert.equal(readFileSync(join(archive, "ideas/001-problem-1.md"), "utf8"), filed.replace(/\n$/, "") + "\n\n## Rank\n\n1\n", "The private archive keeps the proposal as generated.");
    assert.deepEqual(JSON.parse(readFileSync(join(archive, "batch.json"), "utf8")).ideas.map((idea) => idea.filedAs), ["002-problem-1.md", "003-problem-2.md", "004-problem-3.md"]);
    assert.equal(f.run("file", "--date", "2026-01-01").status, 0);
    assert.equal(readdirSync(ideas).length, 4, "Refiling a date adds nothing.");
    f.archive("2026-01-02", {}, "Later problem");
    assert.equal(f.run("file", "--date", "2026-01-02").status, 0);
    assert.deepEqual(readdirSync(ideas).sort().slice(4), ["005-problem-1.md", "006-problem-2.md", "007-problem-3.md"]);
    assert.equal(f.git("status", "--porcelain"), "?? ideas/001-hand-written.md", "Filing commits only its own ideas.");
    assert.equal(existsSync(join(f.factory, "discovery")), false);
    assert.equal(existsSync(f.calls), false, "Local filing must not call GitHub.");
    assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/filing.lock")), false);
  } finally { f.close(); }
});

test("GIVEN a matching private origin WHEN publishing and retrying THEN only the new ideas reach Git and the retry creates no commit", () => {
  const f = fixture();
  try {
    f.archive("2026-01-01");
    const before = f.git("rev-parse", "HEAD");
    const result = f.run("file", "--date", "2026-01-01", "--publish");
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /IDEAS_PUBLISHED https:\/\/github.com\/example\/private-factory\/tree\/main\/ideas/);
    assert.equal(f.git("status", "--porcelain"), "");
    const after = f.git("rev-parse", "HEAD"); assert.notEqual(after, before);
    const changed = f.git("diff", "--name-only", before, after).split("\n");
    assert.deepEqual(changed, ["ideas/001-problem-1.md", "ideas/002-problem-2.md", "ideas/003-problem-3.md"]);
    assert.equal(f.git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], after);
    assert.doesNotMatch(f.git("ls-tree", "-r", "--name-only", "HEAD", "--", "ideas", "sprowi/discovery/state"), /state\/|feedback|research\.json|usage\.json|result\.patch/);
    assert.equal(JSON.parse(readFileSync(f.calls, "utf8").trim().split("\n")[0])[2], f.remote, "Query the actual origin, not just the configured slug.");
    const again = f.run("file", "--date", "2026-01-01", "--publish");
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
        const result = f.run("file", "--date", "2026-01-01", "--publish");
        assert.equal(result.status, 1, result.stdout); assert.ok(result.stderr.length);
        assert.equal(existsSync(join(f.factory, "ideas")), false);
        assert.equal(f.git("status", "--porcelain"), status); assert.equal(f.git("rev-parse", "HEAD"), head);
        assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/filing.lock")), false);
      } finally { f.close(); }
    });
  }
});

test("GIVEN a server refusing pushes WHEN publishing THEN the batch and local ideas commit survive with an actionable retry error", () => {
  const f = fixture();
  try {
    const archive = f.archive("2026-01-01"), remoteHead = f.git("rev-parse", "HEAD");
    assert.equal(f.exec("git", ["--git-dir", f.remote, "config", "core.bare", "false"]).status, 0);
    assert.equal(f.exec("git", ["--git-dir", f.remote, "config", "receive.denyCurrentBranch", "refuse"]).status, 0);
    const failed = f.run("file", "--date", "2026-01-01", "--publish");
    assert.equal(failed.status, 1); assert.match(failed.stderr, /rejected|refusing/i);
    assert.equal(JSON.parse(readFileSync(join(archive, "batch.json"))).status, "complete");
    assert.notEqual(f.git("rev-parse", "HEAD"), remoteHead);
    assert.equal(f.git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], remoteHead);
    const again = f.run("file", "--date", "2026-01-01", "--publish");
    assert.equal(again.status, 1); assert.match(again.stderr, /push existing commits yourself/);
    assert.equal(existsSync(join(f.factory, "ideas/001-problem-1.md")), true);
  } finally { f.close(); }
});

test("GIVEN invalid batches or unsafe paths WHEN filing THEN no idea file or GitHub request is produced", async (t) => {
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
        if (scenario === "output-symlink") symlinkSync(f.root, join(f.factory, "ideas"));
        if (scenario === "concurrent") mkdirSync(join(f.factory, "sprowi/discovery/state/filing.lock"));
        const result = f.run("file", "--date", scenario === "invalid-date" ? "2026-02-30" : "2026-01-01");
        assert.equal(result.status, 1, result.stdout);
        assert.equal(existsSync(join(f.factory, "ideas/001-problem-1.md")), false);
        assert.equal(existsSync(join(f.root, "001-problem-1.md")), false);
        assert.equal(existsSync(f.calls), false);
      } finally { f.close(); }
    });
  }
});

for (const [engine, key, publish] of [["claude", "publish", { enabled: true, repository: "example/private-factory" }], ["codex", "reading", { enabled: true, publish: true, repository: "example/private-factory" }]]) {
  test(`GIVEN ${engine} and publication via ${key} WHEN reusing a complete batch THEN the common run publishes without another model call`, () => {
    const f = fixture();
    try {
      f.archive("2026-01-01");
      f.configure(publish, key);
      const path = join(f.factory, "sprowi/discovery/config.json"), config = JSON.parse(readFileSync(path));
      config.engine = engine; writeFileSync(path, JSON.stringify(config));
      f.git("add", "."); f.git("commit", "-qm", "enable idea publication"); f.git("push", "-q", "origin", "main");
      const result = f.run("run", "--date", "2026-01-01");
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Already complete/); assert.match(result.stdout, /IDEAS_PUBLISHED/);
      assert.equal(f.git("status", "--porcelain"), "");
    } finally { f.close(); }
  });
}
