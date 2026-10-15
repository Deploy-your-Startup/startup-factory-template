#!/usr/bin/env node

// The host side of a Sprowi run: prepare two throwaway checkouts of the target
// project, create the agent and verifier sandboxes, then drive rounds of
// implement → patch policy → verify → review until the change is verified or
// the budget is gone. Nothing here trusts the sandbox: the patch is taken
// against a recorded baseline and checked by a verifier that has no
// credentials of its own.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  feedbackDocument,
  parseReview,
  problemSignature,
  problemSummary,
  remainingEngine,
  sumUsage,
} from "./feedback.mjs";
import {
  hubRoot,
  loadConfig,
  resolveEngine,
  resolveProject,
  validateConfig,
  validatePatch,
} from "./lib.mjs";

// Only these are copied into the read-only input mount. The sandbox runs them,
// so its own workspace copy of anything must never be what executes.
const TRUSTED_SCRIPTS = ["lib.mjs", "feedback.mjs", "run-agent.mjs", "run-commands.mjs", "engines"];

export async function runLoop({ projectName, taskDirectory, engineName, model, rounds, publish, checkOnly }) {
  const project = resolveProject(projectName);
  const config = loadConfig(projectName);
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    throw new Error(`sprowi/projects/${projectName}.json is not usable:\n- ${configErrors.join("\n- ")}`);
  }
  // A run-scoped override: the effective config handed to the sandbox is built
  // from this object, so the sandbox sees the model the run actually uses.
  const engine = { ...resolveEngine(config, engineName), ...(model ? { model } : {}) };
  const maxRounds = rounds ?? config.limits.maxRounds;
  const taskName = taskDirectory ? basename(taskDirectory) : "check";

  function run(command, args, options = {}) {
    const { allowFailure = false, capture = false, ...spawnOptions } = options;
    const result = spawnSync(command, args, {
      cwd: project.path,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: capture ? "pipe" : "inherit",
      ...spawnOptions,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) {
      throw new Error(
        `${command} failed with status ${result.status}${capture ? `: ${result.stderr?.trim()}` : ""}`,
      );
    }
    return result;
  }

  // --- preconditions ------------------------------------------------------

  if (!checkOnly && !existsSync(join(taskDirectory, config.inputFiles.task))) {
    throw new Error(`The task directory has no ${config.inputFiles.task}: ${taskDirectory}`);
  }
  run("sbx", ["version"], { capture: true });
  if (run("sbx", ["ls", "--json"], { allowFailure: true, capture: true }).status !== 0) {
    throw new Error("Docker Sandboxes is not authenticated. Run: sbx login && sbx policy init balanced");
  }
  // Task documents are inputs, not part of the change: they are copied into the
  // sandbox by value and never read from the workspace. Exempting them matters
  // when the hub is the target, because then writing a brief would otherwise
  // block the run that the brief was written for.
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true })
    .stdout.split("\n")
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith("sprowi/tasks/"));
  if (dirty.length > 0) {
    throw new Error(
      `${project.name} has uncommitted changes. Commit or stash them; the patch is taken against HEAD:\n${dirty.join("\n")}`,
    );
  }

  // --- layout -------------------------------------------------------------

  const runIdentifier = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${taskName}`;
  const output = join(hubRoot, "sprowi/runs", projectName, runIdentifier);
  const temporaryRoot = mkdtempSync(join(tmpdir(), `sprowi-${projectName}-`));
  const workspace = join(temporaryRoot, "workspace");
  const verifiedWorkspace = join(temporaryRoot, "verified");
  const input = join(temporaryRoot, "input");
  const feedbackPath = join(input, "feedback.md");
  // Outside every mount: sandboxed processes can write the output directory,
  // so the patch that was verified is kept where they cannot reach it.
  const candidatePatchPath = join(temporaryRoot, "candidate.patch");
  const agentSandbox = `sprowi-${projectName}-${process.pid}`;
  const verifierSandbox = `sprowi-verify-${projectName}-${process.pid}`;
  const definitions = join(hubRoot, "sprowi/sandbox");

  mkdirSync(input, { recursive: true });
  mkdirSync(output, { recursive: true });
  for (const filename of taskDirectory ? Object.values(config.inputFiles) : []) {
    const source = join(taskDirectory, filename);
    if (existsSync(source)) cpSync(source, join(input, filename));
  }
  for (const entry of TRUSTED_SCRIPTS) {
    cpSync(join(hubRoot, "sprowi", entry), join(input, "sprowi", entry), { recursive: true });
  }
  const reviewInstructions = [
    ...(taskDirectory ? [join(taskDirectory, "review.md")] : []),
    join(hubRoot, "sprowi/projects", `${projectName}.review.md`),
    join(hubRoot, "sprowi/review.default.md"),
  ].find((path) => existsSync(path));
  const reviewEnabled = Boolean(reviewInstructions);
  if (reviewEnabled) cpSync(reviewInstructions, join(input, "review.md"));
  const effectiveConfigPath = join(input, "config.json");
  writeFileSync(effectiveConfigPath, `${JSON.stringify(config, null, 2)}\n`);

  console.log(`Sprowi is working on ${projectName} / ${taskName} with ${engine.name}.`);
  console.log(`Run directory: ${output}`);

  // --- workspaces ---------------------------------------------------------

  // Dependency directories survive a reset, so setupCommands run once per
  // sandbox instead of once per round. They are excluded from git as well, so
  // they can never end up in the patch.
  const cleanExcludes = config.cachePaths.flatMap((path) => ["-e", path]);

  function restoreBaseline(destination) {
    mkdirSync(destination, { recursive: true });
    const archive = run("git", ["-c", "core.fsmonitor=false", "archive", "--format=tar", "HEAD"], {
      capture: true,
      encoding: null,
    }).stdout;
    run("tar", ["-xf", "-", "-C", destination], { capture: true, input: archive, encoding: null });
    run("git", ["init", "--quiet"], { cwd: destination });
    // .sprowi holds the reports an engine call writes; excluding it keeps them
    // out of the patch even when a call leaves one behind.
    writeFileSync(
      join(destination, ".git/info/exclude"),
      `${[...config.cachePaths, ".sprowi/"].join("\n")}\n`,
    );
    run("git", ["config", "user.name", "sprowi"], { cwd: destination });
    run("git", ["config", "user.email", "sprowi@users.noreply.github.com"], { cwd: destination });
    run("git", ["add", "--all"], { cwd: destination });
    run("git", ["commit", "--quiet", "-m", "baseline"], { cwd: destination });
    return run("git", ["rev-parse", "HEAD"], { cwd: destination, capture: true }).stdout.trim();
  }

  function resetWorkspace(destination, baseline) {
    run("git", ["reset", "--quiet", "--hard", baseline], { cwd: destination });
    run("git", ["clean", "-fdxq", ...cleanExcludes], { cwd: destination });
  }

  function capturePatch(destination, baseline) {
    run("git", ["add", "--all"], { cwd: destination });
    return run(
      "git",
      ["--no-pager", "diff", "--cached", "--binary", "--full-index", baseline, "--", "."],
      { cwd: destination, capture: true },
    ).stdout;
  }

  // --- sandboxes ----------------------------------------------------------

  function environmentFor(files, environmentArguments) {
    return [
      ...files.map((file) => join(definitions, file)),
      ...Object.entries(environmentArguments).flatMap(([key, value]) => ["--env-arg", `${key}=${value}`]),
    ];
  }

  function createSandbox(environment, credentialService) {
    // An SSH agent socket would be a way out of the microVM that nothing in
    // the run needs.
    const { SSH_AUTH_SOCK: _ignored, ...environmentWithoutSshAgent } = process.env;
    const create = run("sbx", ["env", "create", "--auto-approve", ...environment], {
      env: environmentWithoutSshAgent,
      allowFailure: true,
    });
    if (create.status === 0) return;
    // sbx resolves the credential on the host while it creates the sandbox, so
    // a missing Keychain entry surfaces here rather than at the first request.
    throw new Error(
      credentialService
        ? `Creating the ${engine.name} sandbox failed. If sbx could not resolve the secret "${credentialService}", store it once:\n  security add-generic-password -U -a "$USER" -s ${credentialService} -T "" -w\nThen check the machine with: scripts/sprowi.sh doctor --engine ${engine.name}`
        : "Creating the verifier sandbox failed.",
    );
  }

  function removeSandbox(environment) {
    run("sbx", ["env", "rm", "--force", "--prune-bindings", ...environment], {
      allowFailure: true,
      capture: true,
    });
  }

  function shellQuote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
  }

  // sbx runs this on the host and keeps the value out of this process and out
  // of the sandbox. Only the placeholder ever reaches the engine.
  // An engine may name its own way of producing the credential — codex does,
  // because its subscription token is refreshed in place every few days and a
  // copy in the Keychain would go stale. The trailing `tr` is not cosmetic: a
  // value pasted with a stray newline is stored as pasted, and the 401 it
  // produces is indistinguishable from a genuinely invalid credential.
  const secretCommand =
    process.env.SPROWI_SECRET_COMMAND ??
    engine.credential.command ??
    `security find-generic-password -s ${shellQuote(engine.credential.service)} -w | tr -d '[:space:]'`;

  // Not a secret, so it is read here and handed over as a plain value.
  function hostValue(command, what) {
    const result = spawnSync("bash", ["-lc", command], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(
        `Could not read ${what} for the ${engine.name} engine. The command was:\n  ${command}`,
      );
    }
    return result.stdout.trim();
  }

  const agentEnvironment = environmentFor(["agent.sbxenv.yaml", `${engine.name}.sbxenv.yaml`], {
    name: agentSandbox,
    engine: engine.name,
    workspace,
    input,
    output,
    config: effectiveConfigPath,
    secretCommand,
    ...(engine.cli ? { cli: engine.cli } : {}),
    ...(engine.name === "opencode" ? { modelHost: new URL(engine.upstreamUrl).host } : {}),
    ...(engine.name === "codex"
      ? { accountId: hostValue(engine.accountIdCommand, "the ChatGPT account id") }
      : {}),
  });
  const verifierEnvironment = environmentFor(["verifier.sbxenv.yaml"], {
    name: verifierSandbox,
    workspace: verifiedWorkspace,
    input,
    output,
    config: effectiveConfigPath,
  });

  function runSetup(sandbox, directory) {
    if (Object.keys(config.setupCommands).length === 0) return;
    console.log(`SPROWI_EVENT ${JSON.stringify({ type: "setup", sandbox })}`);
    run("sbx", [
      "exec", "--workdir", directory, sandbox,
      "node", join(input, "sprowi/run-commands.mjs"),
      "--config", effectiveConfigPath,
      "--group", "setupCommands",
    ]);
  }

  // --- the loop ------------------------------------------------------------

  const usages = [];
  const result = {
    project: projectName,
    task: taskName,
    engine: engine.name,
    status: "failed",
    rounds: 0,
    maxRounds,
    reason: null,
    problems: null,
    review: null,
  };

  function emit(event) {
    console.log(`SPROWI_EVENT ${JSON.stringify(event)}`);
  }

  // The limits cover the whole run: each call gets what the earlier calls left.
  function runEngine(mode, round, extraArguments) {
    const budget = remainingEngine(engine, usages);
    if (!budget) return { ok: false, reason: "The run budget is used up." };
    const { name, ...settings } = budget;
    writeFileSync(
      effectiveConfigPath,
      `${JSON.stringify({ ...config, engine: name, engines: { ...config.engines, [name]: settings } }, null, 2)}\n`,
    );
    const callOutput = join(output, `round-${round}-${mode}`);
    const call = run(
      "sbx",
      [
        "exec", "--workdir", workspace, agentSandbox,
        "node", join(input, "sprowi/run-agent.mjs"),
        "--mode", mode,
        "--output", callOutput,
        ...extraArguments,
      ],
      { allowFailure: true },
    );
    const usagePath = join(callOutput, "usage.json");
    if (existsSync(usagePath)) usages.push(JSON.parse(readFileSync(usagePath, "utf8")));
    if (call.status === 78) return { ok: false, reason: "The run budget is used up." };
    if (call.status !== 0) {
      return { ok: false, reason: `The ${mode} call exited with status ${call.status}.` };
    }
    return { ok: true };
  }

  // The independent verifier: the trusted baseline plus this patch, checked in
  // the sandbox that has no credentials. Returns the first failure, or null.
  function verifyCandidate(patch, baseline) {
    resetWorkspace(verifiedWorkspace, baseline);
    if (patch.trim()) {
      writeFileSync(candidatePatchPath, patch);
      const apply = run("git", ["apply", candidatePatchPath], {
        cwd: verifiedWorkspace,
        allowFailure: true,
        capture: true,
      });
      if (apply.status !== 0) {
        return { check: "apply", command: "git apply", output: apply.stderr };
      }
    }
    run("git", ["add", "--all"], { cwd: verifiedWorkspace });
    run("git", ["commit", "--quiet", "--allow-empty", "-m", "candidate"], { cwd: verifiedWorkspace });

    const reportPath = join(output, "acceptance.json");
    rmSync(reportPath, { force: true });
    const acceptance = run(
      "sbx",
      [
        "exec", "--workdir", verifiedWorkspace, verifierSandbox,
        "node", join(input, "sprowi/run-commands.mjs"),
        "--config", effectiveConfigPath,
        "--group", "acceptanceCommands",
        "--report", reportPath,
      ],
      { allowFailure: true },
    );
    if (acceptance.status !== 0) {
      return existsSync(reportPath)
        ? JSON.parse(readFileSync(reportPath, "utf8"))
        : {
            check: "acceptance",
            command: "run-commands.mjs",
            output: `The acceptance run exited with status ${acceptance.status} before a check reported.`,
          };
    }
    // A check that changes files means generated or formatted output is
    // missing from the patch.
    const changes = run("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: verifiedWorkspace,
      capture: true,
    }).stdout.trim();
    if (changes) {
      return {
        check: "generated-files",
        command: "git status --porcelain",
        output: `The checks changed files, so generated or formatted output is missing from the change. Run the formatters and generators and keep their result:\n${changes}`,
      };
    }
    return null;
  }

  // Engines write their reports into the workspace's ignored .sprowi directory.
  // Each is read right after its call and removed, so a later call cannot
  // leave one behind for the host to pick up.
  function takeReport(path, archivedPath) {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    mkdirSync(dirname(archivedPath), { recursive: true });
    writeFileSync(archivedPath, text);
    rmSync(path, { force: true });
    return text;
  }

  // The reviewer may not change the workspace; whatever it touched is undone.
  function reviewCandidate(round, patch, baseline) {
    if (!reviewEnabled) return { pass: true, findings: [], scenarios: [] };
    const reportPath = join(workspace, ".sprowi/review.json");
    mkdirSync(dirname(reportPath), { recursive: true });
    rmSync(reportPath, { force: true });
    const call = runEngine("review", round, [
      "--review-instructions", join(input, "review.md"),
      "--review-report", reportPath,
    ]);
    const report = takeReport(reportPath, join(output, `round-${round}-review`, "review.json"));
    if (capturePatch(workspace, baseline) !== patch) {
      resetWorkspace(workspace, baseline);
      if (patch.trim()) run("git", ["apply", candidatePatchPath], { cwd: workspace });
    }
    if (!call.ok || report === null) return null;
    return parseReview(report);
  }

  let lastPatch = "";
  try {
    const verifiedBaseline = restoreBaseline(verifiedWorkspace);
    createSandbox(verifierEnvironment);

    // A check-only run answers the question every real run depends on: do the
    // configured commands pass on an untouched checkout? If they do not, round
    // one fails for reasons that have nothing to do with the agent.
    if (checkOnly) {
      runSetup(verifierSandbox, verifiedWorkspace);
      const failure = verifyCandidate("", verifiedBaseline);
      if (failure) {
        throw new Error(
          `The check \`${failure.check}\` fails on an untouched checkout.\nCommand: ${failure.command}\n\n${failure.output}`,
        );
      }
      console.log(`All ${Object.keys(config.acceptanceCommands).length} checks pass on an untouched ${projectName}.`);
      return { project: projectName, status: "checks-pass" };
    }

    const agentBaseline = restoreBaseline(workspace);
    // Before the setup commands, because this is where the engine credential
    // is read: a missing one should cost seconds, not two dependency installs.
    createSandbox(agentEnvironment, engine.credential.service);
    runSetup(agentSandbox, workspace);
    runSetup(verifierSandbox, verifiedWorkspace);

    let previousSignature = null;
    // A round with only review findings is publishable. If a later round
    // breaks the checks, the run falls back to that patch.
    let lastVerified = null;

    for (let round = 1; round <= maxRounds; round += 1) {
      result.rounds = round;
      emit({ type: "round", round, maxRounds });
      const implement = runEngine("implement", round, round > 1 ? ["--feedback", feedbackPath] : []);
      if (!implement.ok) {
        result.reason = implement.reason;
        break;
      }

      const patch = capturePatch(workspace, agentBaseline);
      lastPatch = patch;
      const policyErrors = validatePatch(config, patch).errors;
      const checkFailure = policyErrors.length === 0 ? verifyCandidate(patch, verifiedBaseline) : null;
      let problems = policyErrors.length
        ? { patchErrors: policyErrors }
        : checkFailure
          ? { checkFailure }
          : null;

      if (!problems) {
        emit({ type: "checks-passed", round, maxRounds });
        const review = reviewCandidate(round, patch, agentBaseline);
        result.review = review;
        if (!review || review.pass) result.problems = null;
        if (!review) {
          result.status = "verified";
          result.reason = "The review produced no usable verdict.";
          break;
        }
        if (review.pass) {
          result.status = "verified";
          break;
        }
        result.status = "verified-with-findings";
        problems = { findings: review.findings };
        lastVerified = { round, patch, review, problems };
      } else {
        result.status = "failed";
      }

      result.problems = problems;
      const summary = problemSummary(problems);
      const signature = problemSignature(problems);
      if (signature === previousSignature) {
        result.reason = `No progress: ${summary} failed the same way twice.`;
        break;
      }
      previousSignature = signature;
      if (round === maxRounds) {
        result.reason = `Still failing ${summary} after ${maxRounds} rounds.`;
        break;
      }
      emit({ type: "retry", round, maxRounds, summary });
      writeFileSync(feedbackPath, feedbackDocument(round, maxRounds, problems));
    }

    if (result.status === "failed" && lastVerified) {
      result.status = "verified-with-findings";
      result.reason = `${result.reason} Kept the verified patch from round ${lastVerified.round}.`;
      result.review = lastVerified.review;
      result.problems = lastVerified.problems;
      lastPatch = lastVerified.patch;
    }

    // Written only once the agent sandbox is gone, so nothing sandboxed can
    // replace the verified patch or the verdict afterwards.
    removeSandbox(agentEnvironment);
    const patchPath = join(output, "result.patch");
    writeFileSync(patchPath, lastPatch);
    writeFileSync(join(output, "usage.json"), `${JSON.stringify(sumUsage(engine, usages), null, 2)}\n`);
    const resultPath = join(output, "result.json");
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

    const usage = sumUsage(engine, usages);
    console.log(
      `Usage: ${usage.steps} steps, ${usage.totalTokens} tokens, $${usage.costUsd.toFixed(3)} over ${usage.calls} call(s).`,
    );
    console.log(`SPROWI_RESULT ${resultPath}`);

    if (result.status === "failed") {
      throw new Error(result.reason ?? "The loop did not converge.");
    }
    console.log(`Verified patch: ${patchPath}`);
    if (publish) {
      const { publishPatch } = await import("./publish.mjs");
      result.publication = await publishPatch({ project, config, taskDirectory, patchPath, result });
      writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } finally {
    removeSandbox(agentEnvironment);
    removeSandbox(verifierEnvironment);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
