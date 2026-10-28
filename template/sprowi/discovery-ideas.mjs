// Host-only filing of discovery proposals into ideas/. Never publish research,
// credentials or run artifacts; only the idea files themselves reach Git.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { hubRoot, readJson } from "./lib.mjs";

const state = join(hubRoot, "sprowi/discovery/state");
const history = join(state, "history");
const output = join(hubRoot, "ideas");
const ideaName = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

function command(executable, args) {
  const result = spawnSync(executable, args, { cwd: hubRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr?.trim() || result.stdout?.trim() || result.error?.message || result.status}`);
  return result.stdout.trim();
}

// `reading` is the pre-ideas/ name of this setting; its publish/repository still apply.
export function publishSettings(config) {
  const legacy = config.reading;
  const value = config.publish ?? (legacy ? { enabled: legacy.publish, repository: legacy.repository } : {});
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["enabled", "repository"].includes(key)) ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean")) {
    throw new Error("publish must contain an enabled boolean and an optional repository.");
  }
  if (value.repository !== undefined && (typeof value.repository !== "string" || (value.repository !== "" && !/^[\w.-]+\/[\w.-]+$/.test(value.repository)))) throw new Error("publish.repository must be OWNER/REPO.");
  if (value.enabled && !value.repository) throw new Error("Automatic publication requires publish.repository.");
  return { enabled: false, repository: "", ...value };
}

// Refuse symlinks in both the private input and tracked output, including parents.
function safePath(base, path) {
  const rel = relative(base, resolve(path));
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) throw new Error("Idea path escapes its directory.");
  let current = base;
  for (const part of ["", ...rel.split(sep)]) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Idea paths must not be symlinks: ${current}`);
  }
  return path;
}

// The rank only orders one day's batch; in the shared collection it is noise.
function withoutRank(text) {
  const lines = text.split("\n"), start = lines.findIndex((line) => line.trim() === "## Rank");
  if (start < 0) return text;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return [...lines.slice(0, start), ...(end < 0 ? [] : lines.slice(end))].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function existingTitles() {
  if (!existsSync(output)) return new Map();
  return new Map(readdirSync(output).filter((name) => ideaName.test(name)).flatMap((name) => {
    const title = /^# (.+)$/m.exec(readFileSync(join(output, name), "utf8"))?.[1]?.trim();
    return title ? [[title.toLowerCase(), name]] : [];
  }));
}

function loadBatch(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("Date must be a real YYYY-MM-DD date.");
  const directory = join(history, day);
  const batch = readJson(safePath(hubRoot, join(directory, "batch.json")));
  if (batch.status !== "complete" || batch.day !== day || !Array.isArray(batch.ideas) || batch.ideas.length !== 3) throw new Error("Filing requires a complete three-idea batch.");
  const ideas = batch.ideas.map((idea) => {
    if (!ideaName.test(idea.file) || (idea.filedAs !== undefined && !ideaName.test(idea.filedAs))) throw new Error("Invalid archived idea filename.");
    return { ...idea, text: readFileSync(safePath(hubRoot, join(directory, "ideas", idea.file)), "utf8") };
  }).sort((a, b) => a.rank - b.rank);
  if (ideas.map((idea) => idea.rank).join() !== "1,2,3" || new Set(ideas.map((idea) => idea.file)).size !== 3) throw new Error("Filing requires unique ranks and files.");
  return { directory, batch, ideas };
}

function preflightPublication(repository) {
  if (!repository) throw new Error("Set publish.repository to the expected private OWNER/REPO before publishing.");
  if (command("git", ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Publishing ideas requires a clean worktree and index. Commit or review existing changes yourself; nothing was stashed or staged.");
  const remote = command("git", ["remote", "get-url", "origin"]);
  const info = JSON.parse(command("gh", ["repo", "view", remote, "--json", "nameWithOwner,isPrivate,defaultBranchRef,url"]));
  if (info.nameWithOwner !== repository || info.isPrivate !== true) throw new Error("Publishing ideas requires origin to match publish.repository and be private.");
  const branch = command("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== info.defaultBranchRef?.name) throw new Error("Publishing ideas requires the repository's default branch.");
  const remoteHead = command("git", ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]).split(/\s+/)[0];
  if (remoteHead !== command("git", ["rev-parse", "HEAD"])) throw new Error("Local HEAD differs from the remote default branch. Reconcile or push existing commits yourself before publishing ideas.");
  const url = new URL(info.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("GitHub returned an invalid repository URL.");
  return { remote, branch, head: remoteHead, url: url.href.replace(/\/$/, "") };
}

// Each proposal is added once, under the next free number, so a batch never
// collides with ideas written by hand or by an earlier day.
export function fileIdeas({ day, config, publish = false }) {
  const settings = publishSettings(config);
  // Fully validate the selected batch before writing or invoking GitHub.
  const { directory, batch, ideas } = loadBatch(day);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, "filing.lock");
  try { mkdirSync(lock); } catch { throw new Error(`Idea filing already running; inspect ${lock} before removing a stale lock.`); }
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const target = publish ? preflightPublication(settings.repository) : null;
    safePath(hubRoot, output);
    mkdirSync(output, { recursive: true });
    const titles = existingTitles();
    let next = Math.max(0, ...readdirSync(output).filter((name) => ideaName.test(name)).map((name) => Number(name.slice(0, 3)))) + 1;
    for (const idea of ideas) {
      if (idea.filedAs && existsSync(join(output, idea.filedAs))) continue;
      const known = titles.get(idea.title.toLowerCase());
      if (known) { idea.filedAs = known; continue; }
      if (next > 999) throw new Error("ideas/ has no free three-digit number left.");
      const name = `${String(next++).padStart(3, "0")}-${idea.file.slice(4)}`;
      writeFileSync(safePath(hubRoot, join(output, name)), withoutRank(idea.text), { mode: 0o644, flag: "wx" });
      idea.filedAs = name;
    }
    const manifest = join(directory, "batch.json"), temporary = `${manifest}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...batch, ideas: batch.ideas.map((entry) => ({ ...entry, filedAs: ideas.find((idea) => idea.file === entry.file).filedAs })) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, manifest);
    for (const idea of ideas) console.log(`DISCOVERY_IDEA ${idea.rank} ${join(output, idea.filedAs)}`);
    if (target && (command("git", ["rev-parse", "HEAD"]) !== target.head || command("git", ["diff", "--cached", "--name-only"]))) throw new Error("Checkout or index changed while filing. Review the new idea files before retrying.");
    // The next run patches against HEAD and refuses a dirty checkout, so the
    // filed ideas are committed by path; other owner changes stay untouched.
    const paths = ideas.map((idea) => relative(hubRoot, join(output, idea.filedAs)));
    command("git", ["add", "--", ...paths]);
    const staged = command("git", ["diff", "--cached", "--name-only", "-z", "--", ...paths]).split("\0").filter(Boolean);
    if (target && command("git", ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean).some((path) => !paths.includes(path))) throw new Error("Unexpected staged changes; idea publication stopped without committing.");
    if (staged.length) {
      command("git", ["diff", "--cached", "--check", "--", ...paths]);
      command("git", ["commit", "-m", `Add startup discovery ideas ${day}`, "--", ...paths]);
    }
    if (!target) return;
    if (staged.length) command("git", ["push", target.remote, `HEAD:refs/heads/${target.branch}`]);
    console.log(`IDEAS_PUBLISHED ${target.url}/tree/${encodeURIComponent(target.branch)}/ideas`);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
