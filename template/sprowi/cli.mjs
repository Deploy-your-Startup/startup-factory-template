#!/usr/bin/env node

// Sprowi, your startup companion: one loop that works on a task in any registered
// startup. The hub owns the loop and the per-project configuration; the
// project repositories stay free of agent plumbing.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ENGINES, hubRoot, loadConfig, readJson, registryProjects, resolveEngine, resolveProject, supportsSandboxSkillIsolation } from "./lib.mjs";
import { evaluateSelectedIdea, experimentDirectory, makeIdeaTask, selectIdea } from "./experiment.mjs";

const USAGE = `Sprowi · your startup companion

  scripts/sprowi.sh init <project>              write sprowi/projects/<project>.json from the project's own verbs
  scripts/sprowi.sh new  <project> <slug>       scaffold a task directory
  scripts/sprowi.sh ideas [--for <project>]     write a brief and run it: ideas for
                                              one startup, or for new ones
  scripts/sprowi.sh discover [run|status|feedback|schedule]
                                              research, review and archive daily startup bets
  scripts/sprowi.sh select <idea.md> <slug>    select an idea and create its experiment plan
  scripts/sprowi.sh evaluate <slug>           evaluate the recorded KPI against the plan
  scripts/sprowi.sh run  <project> <task>       run the loop
  scripts/sprowi.sh check <project>             run the configured checks on an untouched checkout
  scripts/sprowi.sh ls   [project]              list configured projects and their tasks
  scripts/sprowi.sh doctor [--engine <name>]    check the machine before a run
  scripts/sprowi.sh test                       run publishing integration tests
  scripts/sprowi.sh github-setup [--name <n>] [--org <o>]
                                              create the GitHub App that publishes,
                                              and store its key

Options for run:
  --engine <${ENGINES.join("|")}>   override the configured engine
  --model <id>                      override that engine's model, e.g. a cheap
                                    one for a first run
  --rounds <n>                      override limits.maxRounds
  --publish                         push a branch and open a draft pull request

Options for new:
  --experiment <slug>               turn a selected, measurable idea into a task
`;

const [command, ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- init -----------------------------------------------------------------

// The verbs the hub's projects answer. Everything else a project declares —
// dev servers, deployment tasks — is none of the loop's business.
const CHECK_VERBS = ["lint", "test", "build"];

// mise is the project's own entry point: its tasks carry the directory they run
// in and the runtime the project pins, so a check no longer depends on which
// node the sandbox image happens to ship.
function discoverTasks(projectPath) {
  const listed = spawnSync("mise", ["tasks", "--json"], { cwd: projectPath, encoding: "utf8" });
  if (listed.status !== 0) {
    fail(`mise tasks failed in ${projectPath}: ${listed.stderr?.trim()}`);
  }
  return JSON.parse(listed.stdout)
    // In this monorepo root a task is named //projects/startups/<name>:<task>.
    // Inside the sandbox only the project is mounted, so the name it answers to
    // is everything after that prefix.
    .map((task) => (task.name.startsWith("//") ? task.name.split(":").slice(1).join(":") : task.name))
    .filter((name) => name && !name.startsWith("deployment:"))
    .filter((name) => CHECK_VERBS.includes(name.split(":").pop()))
    .sort(
      (left, right) =>
        CHECK_VERBS.indexOf(left.split(":").pop()) - CHECK_VERBS.indexOf(right.split(":").pop()) ||
        left.localeCompare(right),
    );
}

// mise installs the runtimes; the package manager still has to be pointed at
// each service, because none of these projects declares an install task.
function discoverInstalls(projectPath) {
  const directories = ["", ...readdirSync(projectPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "deployment")
    .map((entry) => entry.name)];
  const installs = {};
  for (const directory of directories) {
    const label = directory || "root";
    if (existsSync(join(projectPath, directory, "package-lock.json"))) {
      installs[`install-${label}`] = ["mise", "exec", "--", "npm", "ci", "--prefix", directory || "."];
    } else if (existsSync(join(projectPath, directory, "uv.lock"))) {
      installs[`install-${label}`] = ["mise", "exec", "--", "uv", "sync", "--frozen", "--project", directory || "."];
    }
  }
  return installs;
}

function initProject(projectName, force) {
  const project = resolveProject(projectName);
  const target = join(hubRoot, "sprowi/projects", `${projectName}.json`);
  if (existsSync(target) && !force) {
    fail(`${target} already exists. Pass --force to overwrite it.`);
  }

  const tasks = discoverTasks(project.path);
  if (tasks.length === 0) {
    fail(
      `${project.path} declares no mise task ending in ${CHECK_VERBS.join(", ")}.\n` +
        `Write sprowi/projects/${projectName}.json by hand: acceptanceCommands is what verifies Sprowi's patch.`,
    );
  }

  const configuration = {
    $schema: "../config.schema.json",
    setupCommands: { tools: ["mise", "install"], ...discoverInstalls(project.path) },
    acceptanceCommands: Object.fromEntries(
      tasks.map((task) => [task.replaceAll(":", "-"), ["mise", "run", task]]),
    ),
  };

  mkdirSync(join(hubRoot, "sprowi/projects"), { recursive: true });
  writeFileSync(target, `${JSON.stringify(configuration, null, 2)}\n`);
  console.log(`Wrote ${target}:`);
  console.log(JSON.stringify(configuration, null, 2));
  console.log(
    "\nCheck the order and drop anything too slow to run every round, then run\n" +
      `  scripts/sprowi.sh check ${projectName}\n` +
      "Everything not listed here is invisible to the loop.",
  );
}

// --- new ------------------------------------------------------------------

function newTask(projectName, slug, experiment) {
  resolveProject(projectName);
  const ideaTask = experiment ? makeIdeaTask(experiment) : null;
  const root = join(hubRoot, "sprowi/tasks", projectName);
  mkdirSync(root, { recursive: true });
  const existing = readdirSync(root).filter((entry) => /^\d{3}-/.test(entry));
  const number = String(existing.length + 1).padStart(3, "0");
  const directory = join(root, `${number}-${slug}`);
  if (existsSync(directory)) fail(`${directory} already exists.`);
  mkdirSync(directory);

  writeFileSync(
    join(directory, "task.md"),
    ideaTask ?? `# Task\n\n<One sentence that says what should be true afterwards.>\n\n## Details\n\n- \n\n## Out of scope\n\n- \n`,
  );
  writeFileSync(
    join(directory, "acceptance-tests.md"),
    experiment
      ? `# Acceptance tests\n\n- GIVEN a real test participant, WHEN they complete the primary action, THEN the action is recorded with a stable participant ID and timestamp.\n- GIVEN internal test traffic, WHEN the same action occurs, THEN it can be excluded from the KPI count.\n- GIVEN the recorded events, WHEN the measurement window ends, THEN the event count and sample size can be exported with a reproducible source.\n`
      : `# Acceptance tests\n\n## <Scenario name>\n\n- GIVEN <starting state>\n- WHEN <the action>\n- THEN <the observable outcome>\n`,
  );
  console.log(`${directory}\n\nEdit task.md, then:\n  scripts/sprowi.sh run ${projectName} ${number}-${slug}`);
}

// --- ideas ----------------------------------------------------------------

// Idea runs always target the hub, because that is where the idea files live.
// The brief is generated rather than hand-written, so asking for ideas is one
// command; the task directory it writes stays, and can be edited and re-run.
const IDEAS_TARGET = "startup-factory";

function ideasBrief(project) {
  const shared = `## What an idea is here

A bet this portfolio could test cheaply, not a feature request. Each one names
a problem somebody actually has, the cheapest thing that would tell you whether
the bet holds, and an assumption that could turn out false. Where a claim is a
guess rather than something the portfolio has evidence for, say so plainly
instead of asserting it.

Read \`ideas/\` first and propose nothing that is already there.

## Out of scope

- Anything needing new infrastructure, a new service, or money spent before the
  smallest test is done
- Rewrites, migrations and refactorings — those are tasks, not ideas
- Ideas whose smallest test takes longer than a few days
`;

  if (project) {
    return `# Task

Propose three ideas for ${project} and write each one to its own file in \`ideas/\`.

## Where to look first

- \`projects/startups/${project}/\` — its README, its AGENTS.md, and the code
  itself: what it does, who it is for, what is already built
- \`projects.yaml\` — whether it is deployed, and what else exists around it

Look for what the project is missing rather than what it could add: the step
where someone gives up, the thing it asks for too early, the work it leaves to
the person running it.

${shared}`;
  }

  return `# Task

Propose three ideas for startups this portfolio does not have yet, and write
each one to its own file in \`ideas/\`.

## Where to look first

- \`projects.yaml\` — what already exists; do not propose a variation of it
- the existing projects under \`projects/startups/\` — what this factory is
  actually good at building and running

An idea has to fit the owner's available time, resources and supported stacks.
Do not assume an existing cluster or deployment when the registry is empty.
A business that needs a team, a licence or a warehouse is out of scope.

${shared}`;
}

async function ideas(project, options) {
  if (project) resolveProject(project);
  const scope = project ?? "new-startups";
  const root = join(hubRoot, "sprowi/tasks", IDEAS_TARGET);
  mkdirSync(root, { recursive: true });
  const number = String(
    readdirSync(root).filter((entry) => /^\d{3}-/.test(entry)).length + 1,
  ).padStart(3, "0");
  const directory = join(root, `${number}-ideas-${scope}`);
  mkdirSync(directory);
  writeFileSync(join(directory, "task.md"), ideasBrief(project));
  console.log(`Brief: ${join(directory, "task.md")}`);

  loadConfig(IDEAS_TARGET);
  const { runLoop } = await import("./run-local.mjs");
  await runLoop({
    projectName: IDEAS_TARGET,
    taskDirectory: directory,
    engineName: options.engine,
    model: options.model,
    rounds: options.rounds ? Number(options.rounds) : undefined,
    publish: Boolean(options.publish),
  });
}

// --- ls -------------------------------------------------------------------

function list(projectName) {
  const projects = projectName ? [{ name: projectName }] : registryProjects();
  for (const project of projects) {
    const configured = existsSync(join(hubRoot, "sprowi/projects", `${project.name}.json`));
    const taskRoot = join(hubRoot, "sprowi/tasks", project.name);
    const tasks = existsSync(taskRoot) ? readdirSync(taskRoot).filter((entry) => /^\d{3}-/.test(entry)) : [];
    if (!configured && tasks.length === 0 && !projectName) continue;
    console.log(`${project.name}${configured ? "" : "  (no sprowi config — run: scripts/sprowi.sh init " + project.name + ")"}`);
    for (const task of tasks.sort()) console.log(`  ${task}`);
  }
}

// --- doctor ---------------------------------------------------------------

function check(label, ok, hint) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !hint ? "" : `\n     ${hint}`}`);
  return ok;
}

function doctor(engineName) {
  let healthy = true;
  healthy &= check(
    "docker",
    spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0,
    "Start Docker Desktop 4.58 or newer.",
  );
  healthy &= check("sbx", spawnSync("sbx", ["version"], { stdio: "ignore" }).status === 0, "brew install sbx");
  healthy &= check("sbx supports isolated skills (--skills=off)", supportsSandboxSkillIsolation(), "brew upgrade --cask docker/tap/sbx (keep sandboxOptions.skills: off)");
  healthy &= check(
    "sbx is signed in",
    spawnSync("sbx", ["ls", "--json"], { stdio: "ignore" }).status === 0,
    "sbx login && sbx policy init balanced",
  );

  const defaults = readJson(join(hubRoot, "sprowi/config.default.json"));
  for (const name of engineName ? [engineName] : ENGINES) {
    const engine = resolveEngine(defaults, name);
    const { service, command } = engine.credential;
    healthy &= command
      ? check(
          `credential for ${name} (from its own command)`,
          spawnSync("bash", ["-lc", command], { stdio: "ignore" }).status === 0,
          `The command failed. For codex this reads ~/.codex/auth.json — run \`codex\` once and sign in.`,
        )
      : check(
          `credential ${service} (engine ${name})`,
          spawnSync("security", ["find-generic-password", "-s", service, "-w"], { stdio: "ignore" }).status === 0,
          `security add-generic-password -U -a "$USER" -s ${service} -T "" -w`,
        );
  }

  healthy &= check("gh", spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0, "gh auth login");

  // Only when an App is configured: without one, publishing falls back to a
  // token and a missing key is not a fault.
  const appId = process.env.SPROWI_GITHUB_APP_ID ?? defaults.publish?.app?.id;
  if (appId) {
    const keyService = defaults.publish?.app?.keyService ?? "SPROWI_GITHUB_KEY";
    healthy &= check(
      `private key for GitHub App ${appId} (${keyService})`,
      Boolean(process.env.SPROWI_GITHUB_APP_KEY) ||
        spawnSync("security", ["find-generic-password", "-s", keyService, "-w"], { stdio: "ignore" }).status === 0,
      "scripts/sprowi.sh github-setup, or point SPROWI_GITHUB_APP_KEY at the App's PEM file",
    );
  }

  process.exit(healthy ? 0 : 1);
}

// --- dispatch -------------------------------------------------------------

try {
  if (command === "discover") {
    const { discoveryCommand } = await import("./discovery.mjs");
    await discoveryCommand(rest);
  } else if (command === "init") {
    const { values, positionals } = parseArgs({ args: rest, options: { force: { type: "boolean" } }, allowPositionals: true });
    if (!positionals[0]) fail(USAGE);
    initProject(positionals[0], values.force);
  } else if (command === "new") {
    const { values, positionals } = parseArgs({ args: rest, options: { experiment: { type: "string" } }, allowPositionals: true });
    if (positionals.length !== 2) fail(USAGE);
    newTask(positionals[0], positionals[1], values.experiment);
  } else if (command === "select") {
    if (rest.length !== 2) fail(USAGE);
    const directory = selectIdea(rest[0], rest[1]);
    console.log(`Selected ${rest[0]} in ${directory}. Complete experiment.json before creating an implementation task.`);
  } else if (command === "evaluate") {
    if (rest.length !== 1) fail(USAGE);
    const result = evaluateSelectedIdea(rest[0]);
    console.log(JSON.stringify({ experiment: experimentDirectory(rest[0]), ...result }, null, 2));
  } else if (command === "ls") {
    list(rest[0]);
  } else if (command === "github-setup") {
    const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, org: { type: "string" } } });
    const { githubSetup } = await import("./github-setup.mjs");
    await githubSetup({ name: values.name, org: values.org });
  } else if (command === "test") {
    const result = spawnSync(process.execPath, ["--test", ...["publish", "experiment", "agent", "discovery"].map((name) => join(hubRoot, `sprowi/${name}.integration.test.mjs`))], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  } else if (command === "doctor") {
    const { values } = parseArgs({ args: rest, options: { engine: { type: "string" } } });
    doctor(values.engine);
  } else if (command === "ideas") {
    const { values } = parseArgs({
      args: rest,
      options: {
        for: { type: "string" },
        engine: { type: "string" },
        model: { type: "string" },
        rounds: { type: "string" },
        publish: { type: "boolean" },
      },
    });
    await ideas(values.for, values);
  } else if (command === "check") {
    if (!rest[0]) fail(USAGE);
    loadConfig(rest[0]);
    const { runLoop } = await import("./run-local.mjs");
    await runLoop({ projectName: rest[0], checkOnly: true });
  } else if (command === "run") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        engine: { type: "string" },
        model: { type: "string" },
        rounds: { type: "string" },
        publish: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const [projectName, task] = positionals;
    if (!projectName || !task) fail(USAGE);
    const taskDirectory = existsSync(task) ? resolve(task) : join(hubRoot, "sprowi/tasks", projectName, task);
    if (!existsSync(taskDirectory)) {
      fail(`No such task: ${taskDirectory}\nCreate one with: scripts/sprowi.sh new ${projectName} <slug>`);
    }
    // Fails early and loudly when the project has no configuration yet.
    loadConfig(projectName);
    const { runLoop } = await import("./run-local.mjs");
    await runLoop({
      projectName,
      taskDirectory,
      engineName: values.engine,
      model: values.model,
      rounds: values.rounds ? Number(values.rounds) : undefined,
      publish: Boolean(values.publish),
    });
  } else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  fail(`Sprowi failed: ${error instanceof Error ? error.message : String(error)}`);
}
