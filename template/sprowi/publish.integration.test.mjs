import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPatch } from "./publish.mjs";

test(`GIVEN an installed App with SPROWI options WHEN publishing a verified patch THEN real Git receives the patch and a draft PR uses its bot identity`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "sprowi-publish-test-"));
  const previousEnvironment = { ...process.env };
  const previousFetch = globalThis.fetch;
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const runGit = (cwd, ...args) => {
    const result = spawnSync(realGit, args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    // GIVEN real local Git repositories and a synthetic App key; only GitHub is a stand-in.
    const repository = join(directory, "repository");
    const remote = join(directory, "remote.git");
    const bin = join(directory, "bin");
    const task = join(directory, "task");
    for (const path of [repository, bin, task]) mkdirSync(path);
    runGit(directory, "init", "--bare", remote);
    runGit(repository, "init", "-b", "main");
    runGit(repository, "config", "user.name", "Test owner");
    runGit(repository, "config", "user.email", "owner@example.invalid");
    runGit(repository, "config", "commit.gpgsign", "false");
    runGit(repository, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(repository, "feature.txt"), "before\n");
    runGit(repository, "add", ".");
    runGit(repository, "commit", "-m", "baseline");
    runGit(repository, "remote", "add", "origin", remote);
    runGit(repository, "config", `url.file://${remote}.insteadOf`, "https://github.com/example/demo.git");
    writeFileSync(join(repository, "feature.txt"), "after\n");
    const patch = join(directory, "verified.patch");
    writeFileSync(patch, runGit(repository, "diff") + "\n");
    runGit(repository, "restore", "feature.txt");
    writeFileSync(join(task, "task.md"), "# Task\nShip the feature\n\nKeep this description multiline.\n");
    const key = join(directory, "key.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const trace = join(directory, "arguments.jsonl");
    writeFileSync(join(bin, "git"), `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
appendFileSync(process.env.SPROWI_TEST_TRACE, JSON.stringify(process.argv.slice(2))+'\\n');
const result=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='repo') console.log('main');
else if(args[0]==='pr') {
 const index=args.indexOf('--body-file');
 if(index<0 || !args.includes('--draft')) process.exit(2);
 writeFileSync(process.env.SPROWI_TEST_PR,JSON.stringify({args,body:readFileSync(args[index+1],'utf8'),tokenPresent:process.env.GH_TOKEN==='synthetic-installation-token'}));
 console.log('https://github.com/example/demo/pull/1');
} else process.exit(2);
`, { mode: 0o755 });
    for (const suffix of ["GITHUB_TOKEN", "GITHUB_APP_KEY", "GITHUB_APP_ID"]) delete process.env[`SPROWI_${suffix}`];
    process.env[`SPROWI_GITHUB_APP_KEY`] = key;
    process.env[`SPROWI_GITHUB_APP_ID`] = "123";
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.SPROWI_TEST_TRACE = trace;
    process.env.SPROWI_TEST_PR = join(directory, "pr.json");
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      let response;
      if (url.endsWith("/repos/example/demo/installation")) response = { id: 456 };
      else if (url.endsWith("/app/installations/456/access_tokens")) response = { token: "synthetic-installation-token" };
      else if (url.endsWith("/app")) response = { slug: "factory-sprowi" };
      else if (url.includes("/users/")) response = { id: 789 };
      else throw new Error("Unexpected GitHub request");
      return new Response(JSON.stringify(response), { status: 200 });
    };
    // WHEN the public publisher applies the verified patch and pushes it.
    const result = await publishPatch({
      project: { name: "demo", slug: "example/demo", path: repository },
      config: { publish: { app: { id: 123 }, author: { name: "Fallback", email: "fallback@example.invalid" }, branchPrefix: "sprowi/", draft: true }, inputFiles: { task: "task.md" } },
      taskDirectory: task, patchPath: patch,
      result: { task: "feature", engine: "codex", rounds: 1, status: "verified", review: { findings: [] } },
    });
    // THEN the real remote contains the patch, authored by the App, with safe PR arguments.
    assert.equal(runGit(remote, "show", "sprowi/feature:feature.txt"), "after");
    assert.equal(runGit(remote, "show", "-s", "--format=%an <%ae>", "sprowi/feature"), "factory-sprowi[bot] <789+factory-sprowi[bot]@users.noreply.github.com>");
    assert.equal(readFileSync(join(repository, "feature.txt"), "utf8"), "before\n");
    assert.equal(runGit(repository, "status", "--porcelain"), "");
    assert.equal(runGit(repository, "worktree", "list", "--porcelain").split("worktree ").length, 2);
    const pr = JSON.parse(readFileSync(process.env.SPROWI_TEST_PR, "utf8"));
    assert.ok(pr.body.includes("Keep this description multiline."));
    assert.ok(pr.tokenPresent);
    assert.equal(result.url, "https://github.com/example/demo/pull/1");
    assert.deepEqual(requests.find(request => request.url.endsWith("/access_tokens")).body.repositories, ["demo"]);
    assert.ok(!readFileSync(trace, "utf8").includes("synthetic-installation-token"));
    assert.ok(!readFileSync(trace, "utf8").includes("BEGIN PRIVATE KEY"));
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    rmSync(directory, { recursive: true, force: true });
  }
});
