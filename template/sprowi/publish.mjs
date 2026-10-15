// The only step that writes anything outside a throwaway directory. It runs on
// the host, after the agent sandbox is gone, and never executes code from the
// patch: it applies it in a detached worktree, commits, pushes and opens a
// draft pull request.

import { spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args[0]} failed: ${result.stderr?.trim()}`);
  }
  return result;
}

function gh(args, environment, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...environment },
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr?.trim()}`);
  }
  return result;
}

function tokenEnvironment(token) {
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

// --- the GitHub App -------------------------------------------------------

async function githubApi(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} answered ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

// Authenticates as the App itself and is good for nothing else: it can ask for
// an installation token and read the App's own record, and that is all. Ten
// minutes is GitHub's ceiling for `exp`, and the backdated `iat` absorbs clock
// skew between this machine and github.com, which is otherwise a flat 401.
function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claim = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(claim).end().sign(privateKey).toString("base64url");
  return `${claim}.${signature}`;
}

// `security` prints anything that is not a single line of printable ASCII as a
// hex dump, and a PEM is neither. So the key is stored base64-encoded: one
// line in, the same line out. A key pasted raw is still accepted, because the
// failure it produces otherwise is an unreadable wall of hex.
function keyFromKeychain(service) {
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const stored = result.stdout.trim();
  const key = stored.includes("PRIVATE KEY") ? stored : Buffer.from(stored, "base64").toString("utf8");
  if (!key.includes("PRIVATE KEY")) {
    throw new Error(
      `The Keychain item ${service} does not hold a PEM private key. Run scripts/sprowi.sh github-setup to configure the App, or point SPROWI_GITHUB_APP_KEY at its PEM file.`,
    );
  }
  return key;
}

function appCredentials(config) {
  const id = process.env.SPROWI_GITHUB_APP_ID ?? config.publish.app?.id;
  if (!id) return null;
  const keyService = config.publish.app?.keyService ?? "SPROWI_GITHUB_KEY";
  const inline = process.env.SPROWI_GITHUB_APP_KEY;
  const privateKey = inline
    ? inline.includes("PRIVATE KEY")
      ? inline
      : readFileSync(inline, "utf8")
    : keyFromKeychain(keyService);
  if (!privateKey) {
    throw new Error(
      `publish.app.id is set to ${id}, but no private key was found in ${keyService}. ` +
        `Run scripts/sprowi.sh github-setup to configure the App, or point SPROWI_GITHUB_APP_KEY at its PEM file.`,
    );
  }
  return { id: String(id), privateKey, keyService };
}

// GitHub links a commit to the bot account by the noreply address alone, and
// the number in that address is the bot *user's* id, not the App's. A wrong
// guess produces commits attributed to nobody, so it is looked up rather than
// configured — and a failure here is not worth losing the pull request over.
async function botIdentity(jwt, token) {
  try {
    const { slug } = await githubApi("/app", { token: jwt });
    const user = await githubApi(`/users/${encodeURIComponent(`${slug}[bot]`)}`, { token });
    return { name: `${slug}[bot]`, email: `${user.id}+${slug}[bot]@users.noreply.github.com` };
  } catch {
    return null;
  }
}

async function mintAppCredentials(slug, app) {
  const jwt = appJwt(app.id, app.privateKey);
  const repository = slug.split("/")[1];
  let installation;
  try {
    installation = await githubApi(`/repos/${slug}/installation`, { token: jwt });
  } catch (error) {
    throw new Error(
      `App ${app.id} has no installation on ${slug}. Install it on that repository, or check that ` +
        `${app.keyService} holds the key of that App.\n${error.message}`,
    );
  }
  // Narrowed to the one repository this run touches, even when the App is
  // installed on all of them, and it expires in an hour either way.
  const { token } = await githubApi(`/app/installations/${installation.id}/access_tokens`, {
    token: jwt,
    method: "POST",
    body: { repositories: [repository], permissions: { contents: "write", pull_requests: "write" } },
  });
  return {
    environment: tokenEnvironment(token),
    // An SSH push would be signed by whoever owns the key on this machine —
    // you — which is exactly the attribution the App exists to avoid. So the
    // App pushes over HTTPS, as itself.
    push: { url: `https://github.com/${slug}.git`, token },
    identity: await botIdentity(jwt, token),
  };
}

// The active gh account on this machine is not necessarily the one that owns
// these repositories, and a wrong account does not fail loudly: a private repo
// it cannot see looks like a repo that does not exist. So the credential is
// pinned explicitly, and the fallback verifies access before it writes
// anything.
async function resolveCredentials(slug, config) {
  if (process.env.SPROWI_GITHUB_TOKEN) {
    return { environment: tokenEnvironment(process.env.SPROWI_GITHUB_TOKEN) };
  }
  const app = appCredentials(config);
  if (app) return mintAppCredentials(slug, app);
  const keychain = spawnSync("security", ["find-generic-password", "-s", "SPROWI_GITHUB", "-w"], {
    encoding: "utf8",
  });
  if (keychain.status === 0 && keychain.stdout.trim()) {
    return { environment: tokenEnvironment(keychain.stdout.trim()) };
  }
  const check = gh(["repo", "view", slug, "--json", "name"], {}, { allowFailure: true });
  if (check.status !== 0) {
    const account = gh(["api", "user", "--jq", ".login"], {}, { allowFailure: true }).stdout.trim();
    throw new Error(
      `The active gh account (${account || "unknown"}) cannot see ${slug}. Either set up the GitHub App ` +
        `(publish.app.id in sprowi/config.default.json), store a token for Sprowi:\n` +
        `  security add-generic-password -U -a "$USER" -s SPROWI_GITHUB -T "" -w\n` +
        `or switch the account with: gh auth switch`,
    );
  }
  return { environment: {} };
}

export async function publishPatch({ project, config, taskDirectory, patchPath, result }) {
  const patch = readFileSync(patchPath, "utf8");
  if (!patch.trim()) {
    console.log("Nothing to publish: the verified patch is empty.");
    return { published: false, reason: "empty patch" };
  }
  if (!project.slug) {
    throw new Error(`${project.name} has no GitHub remote in the registry, so it cannot be published.`);
  }

  const credentials = await resolveCredentials(project.slug, config);
  const environment = credentials.environment;
  const author = credentials.identity ?? config.publish.author;
  const branch = `${config.publish.branchPrefix}${result.task}`;
  const baseBranch = gh(
    ["repo", "view", project.slug, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    environment,
  ).stdout.trim();

  const existing = git(project.path, ["rev-parse", "--verify", branch], { allowFailure: true });
  if (existing.status === 0) {
    throw new Error(`The branch ${branch} already exists in ${project.name}. Remove it or rename the task.`);
  }

  // A detached worktree keeps the working checkout the user has open
  // untouched, whatever happens below.
  const worktree = mkdtempSync(join(tmpdir(), `sprowi-publish-${project.name}-`));
  rmSync(worktree, { recursive: true, force: true });
  git(project.path, ["worktree", "add", "-b", branch, worktree, "HEAD"]);

  try {
    const apply = git(worktree, ["apply", patchPath], { allowFailure: true });
    if (apply.status !== 0) {
      throw new Error(`The verified patch no longer applies to HEAD: ${apply.stderr.trim()}`);
    }
    git(worktree, ["add", "--all"]);

    const taskText = existsSync(join(taskDirectory, config.inputFiles.task))
      ? readFileSync(join(taskDirectory, config.inputFiles.task), "utf8")
      : "";
    const title = (taskText.split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? result.task)
      .trim()
      .slice(0, 72);

    const findings = result.review?.findings ?? [];
    const body = [
      `Implemented by Sprowi (engine \`${result.engine}\`, ${result.rounds} round(s), status \`${result.status}\`).`,
      "",
      "## Task",
      "",
      taskText.trim() || `_(see sprowi/tasks/${project.name}/${result.task})_`,
      "",
      findings.length > 0
        ? `## Open review findings\n\n${findings
            .map((finding) => `- **${finding.rule ?? "Finding"}**${finding.file ? ` (\`${finding.file}\`)` : ""}: ${finding.problem}`)
            .join("\n")}`
        : "The reviewer reported no open findings.",
      "",
      "The patch was produced in a Docker Sandbox microVM and verified against a clean checkout by a sandbox without credentials. Review it as you would any change.",
    ].join("\n");

    git(worktree, [
      "-c", `user.name=${author.name}`,
      "-c", `user.email=${author.email}`,
      "commit", "--quiet", "-m", `${title}\n\nTask: ${result.task}\nEngine: ${result.engine}\n`,
    ]);

    if (credentials.push) {
      // The token reaches git through a credential helper reading the
      // environment. In the URL it would be written into the worktree's config
      // and echoed back in git's own output; in argv it would be readable by
      // every process on the machine.
      git(
        worktree,
        [
          "-c", "credential.helper=",
          "-c", `credential.helper=!f() { echo username=x-access-token; echo "password=$SPROWI_PUSH_TOKEN"; }; f`,
          "push", "--quiet", credentials.push.url, `HEAD:refs/heads/${branch}`,
        ],
        { stdio: "inherit", env: { ...process.env, SPROWI_PUSH_TOKEN: credentials.push.token } },
      );
    } else {
      git(worktree, ["push", "--set-upstream", "origin", branch], {
        stdio: "inherit",
        env: { ...process.env, ...environment },
      });
    }

    // A worktree's .git is a pointer file; keep the description in its Git directory.
    const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
    const descriptionPath = join(gitDirectory, "sprowi-pr-body.md");
    writeFileSync(descriptionPath, body, { mode: 0o600 });
    const pullRequest = gh(
      [
        "pr", "create",
        "-R", project.slug,
        "--base", baseBranch,
        "--head", branch,
        "--title", title,
        "--body-file", descriptionPath,
        ...(config.publish.draft ? ["--draft"] : []),
      ],
      environment,
    ).stdout.trim();

    console.log(`Draft pull request: ${pullRequest}`);
    return {
      published: true,
      branch,
      baseBranch,
      author: author.name,
      url: pullRequest.split("\n").pop(),
    };
  } finally {
    git(project.path, ["worktree", "remove", "--force", worktree], { allowFailure: true });
  }
}
