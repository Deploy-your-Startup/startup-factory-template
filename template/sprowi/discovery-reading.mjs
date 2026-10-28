// Host-only reading copies. Never publish research, credentials or run artifacts.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { hubRoot, readJson } from "./lib.mjs";

const state = join(hubRoot, "sprowi/discovery/state");
const history = join(state, "history");
const output = join(hubRoot, "discovery");
const ideaName = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

function command(executable, args) {
  const result = spawnSync(executable, args, { cwd: hubRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr?.trim() || result.stdout?.trim() || result.error?.message || result.status}`);
  return result.stdout.trim();
}

export function readingSettings(config) {
  const value = config.reading ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["enabled", "publish", "repository"].includes(key)) ||
      ["enabled", "publish"].some((key) => value[key] !== undefined && typeof value[key] !== "boolean")) {
    throw new Error("reading must contain enabled/publish booleans and an optional repository.");
  }
  if (value.repository !== undefined && (typeof value.repository !== "string" || (value.repository !== "" && !/^[\w.-]+\/[\w.-]+$/.test(value.repository)))) throw new Error("reading.repository must be OWNER/REPO.");
  if (value.publish && (!value.enabled || !value.repository)) throw new Error("Automatic reading publication requires reading.enabled and reading.repository.");
  return { enabled: false, publish: false, repository: "", ...value };
}

// Refuse symlinks in both the private input and tracked output, including parents.
function safePath(base, path) {
  const rel = relative(base, resolve(path));
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) throw new Error("Reading path escapes its directory.");
  let current = base;
  for (const part of ["", ...rel.split(sep)]) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Reading paths must not be symlinks: ${current}`);
  }
  return path;
}

function section(text, name) {
  const lines = text.split("\n"), start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

function excerpt(text, limit = 320) {
  const plain = String(text).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[*`#<>]/g, "").replace(/\s+/g, " ").trim();
  return (plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain).replace(/[\\[\]|]/g, "\\$&");
}

function loadBatch(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("Reading date must be a real YYYY-MM-DD date.");
  const directory = join(history, day);
  const batch = readJson(safePath(hubRoot, join(directory, "batch.json")));
  if (batch.status !== "complete" || batch.day !== day || !Array.isArray(batch.ideas) || batch.ideas.length !== 3) throw new Error("Reading export requires a complete three-idea batch.");
  const ideas = batch.ideas.map((idea) => {
    if (!ideaName.test(idea.file)) throw new Error("Invalid archived idea filename.");
    return { ...idea, text: readFileSync(safePath(hubRoot, join(directory, "ideas", idea.file)), "utf8") };
  }).sort((a, b) => a.rank - b.rank);
  if (ideas.map((idea) => idea.rank).join() !== "1,2,3" || new Set(ideas.map((idea) => idea.file)).size !== 3) throw new Error("Reading export requires unique ranks and files.");
  return { ...batch, ideas };
}

function sources(text) {
  const urls = [...new Set(section(text, "Evidence").match(/https?:\/\/[^\s<>()\]]+/g) ?? [])];
  return urls.slice(0, 3).flatMap((value, index) => {
    try {
      const url = new URL(value.replace(/[.,;]+$/, ""));
      return !url.username && !url.password ? [`[Source ${index + 1}](<${url.href}>)`] : [];
    } catch { return []; }
  }).join(" · ");
}

function card(idea, prefix, detailed = false) {
  let text = `### ${idea.rank}. ${excerpt(idea.title, 180)}\n\n${excerpt(section(idea.text, "Problem"), 360)}\n\n`;
  const web = section(idea.text, "Web experiment");
  if (web) text += `**Web experiment:** ${excerpt(web, detailed ? 1800 : 500)}\n\n`;
  if (detailed) text += `**First ten participants:** ${excerpt(section(idea.text, "Distribution"), 900)}\n\n`;
  text += `**Smallest test:** ${excerpt(section(idea.text, "Smallest test"), detailed ? 1400 : 300)}\n\n`;
  if (detailed) text += `**Success / stop criteria:** ${excerpt(section(idea.text, "Assumption"), 1800)}\n\n`;
  text += `**Strongest objection:** ${excerpt(section(idea.text, "Why it might fail"), detailed ? 900 : 300)}\n\n`;
  return `${text}[Full proposal](${prefix}ideas/${idea.file}) · ${sources(idea.text)}\n`;
}

function preflightPublication(repository) {
  if (!repository) throw new Error("Set reading.repository to the expected private OWNER/REPO before publishing.");
  if (command("git", ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Reading publication requires a clean worktree and index. Commit or review existing changes yourself; nothing was stashed or staged.");
  const remote = command("git", ["remote", "get-url", "origin"]);
  const info = JSON.parse(command("gh", ["repo", "view", remote, "--json", "nameWithOwner,isPrivate,defaultBranchRef,url"]));
  if (info.nameWithOwner !== repository || info.isPrivate !== true) throw new Error("Reading publication requires origin to match reading.repository and be private.");
  const branch = command("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== info.defaultBranchRef?.name) throw new Error("Reading publication requires the repository's default branch.");
  const remoteHead = command("git", ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]).split(/\s+/)[0];
  if (remoteHead !== command("git", ["rev-parse", "HEAD"])) throw new Error("Local HEAD differs from the remote default branch. Reconcile or push existing commits yourself before publishing readings.");
  const url = new URL(info.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("GitHub returned an invalid repository URL.");
  return { remote, branch, head: remoteHead, url: url.href.replace(/\/$/, "") };
}

export function exportReading({ day, config, publish = false }) {
  const settings = readingSettings(config);
  // Fully validate the selected batch before writing or invoking GitHub.
  const batch = loadBatch(day);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, "reading.lock");
  try { mkdirSync(lock); } catch { throw new Error(`Reading export already running; inspect ${lock} before removing a stale lock.`); }
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const target = publish ? preflightPublication(settings.repository) : null;
    safePath(hubRoot, output);
    const dates = new Set([day]);
    if (existsSync(output)) for (const entry of readdirSync(output)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && existsSync(safePath(hubRoot, join(output, entry, "README.md")))) dates.add(entry);
    }
    const ordered = [...dates].sort().reverse();
    const latest = ordered[0] === day ? batch : existsSync(join(history, ordered[0], "batch.json")) ? loadBatch(ordered[0]) : null;
    const note = "These are unvalidated proposals. Structure checks and model review are not market validation or permission to build or contact anyone.";
    const table = ordered.map((date) => `| [${date}](${date}/README.md) |`).join("\n");
    const index = `# Startup discovery · morning reading\n\n${note}\n\n## Latest · ${ordered[0]}\n\n${latest ? latest.ideas.map((idea) => card(idea, `${ordered[0]}/`)).join("\n") : `[Read the latest edition](${ordered[0]}/README.md)\n`}\n## All editions\n\n| Date |\n| --- |\n${table}\n\nPublished copies can be read on GitHub while the computer is offline. New generation still needs the configured runner, Docker and engine credentials. A failed discovery does not replace the latest successful edition. Raw research, feedback and run logs stay in the private local state directory.\n`;
    const findings = batch.findings ?? [], errors = batch.researchErrors ?? [];
    const details = `# Startup discovery · ${day}\n\n[← All editions](../README.md)\n\n${note}\n\n${batch.ideas.map((idea) => card(idea, "", idea.rank === 1)).join("\n")}\n## Review and research\n\nVerification: ${excerpt(batch.verification ?? "unknown")}. Open review findings: ${findings.length}. Research errors: ${errors.length}.\n\n${findings.length ? findings.map((finding) => `- ${excerpt(JSON.stringify(finding), 4000)}`).join("\n") + "\n\n" : ""}${errors.length ? errors.map((error) => `- ${excerpt(error.error ?? "Source retrieval failed", 600)} (source details remain in local research.json)`).join("\n") + "\n" : ""}`;
    const files = new Map([[join(output, "README.md"), index.trimEnd() + "\n"], [join(output, day, "README.md"), details.trimEnd() + "\n"], ...batch.ideas.map((idea) => [join(output, day, "ideas", idea.file), idea.text])]);
    for (const path of files.keys()) safePath(hubRoot, path);
    for (const [path, text] of files) {
      mkdirSync(join(path, ".."), { recursive: true });
      if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text, { mode: 0o600 });
    }
    console.log(`DISCOVERY_READING ${join(output, "README.md")}`);
    if (!target) return;
    if (command("git", ["rev-parse", "HEAD"]) !== target.head || command("git", ["diff", "--cached", "--name-only"])) throw new Error("Checkout or index changed during export. Review the reading files before retrying.");
    const paths = [...files.keys()].map((path) => relative(hubRoot, path));
    command("git", ["add", "--", ...paths]);
    const staged = command("git", ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
    if (staged.some((path) => !paths.includes(path))) throw new Error("Unexpected staged changes; reading publication stopped without committing.");
    if (staged.length) {
      command("git", ["diff", "--cached", "--check"]);
      command("git", ["commit", "-m", `Archive startup discovery ${day}`, "--", ...paths]);
      command("git", ["push", target.remote, `HEAD:refs/heads/${target.branch}`]);
    }
    console.log(`READING_PUBLISHED ${target.url}/tree/${encodeURIComponent(target.branch)}/discovery`);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
