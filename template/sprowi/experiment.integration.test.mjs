import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubRoot } from "./lib.mjs";

// Sprowi resolves its hub from its own location, so a copy of the hub's Sprowi
// files runs the real CLI against a throwaway registry and experiment folder.
function throwawayHub() {
  const hub = mkdtempSync(join(tmpdir(), "sprowi-experiment-test-"));
  for (const path of ["sprowi", "scripts/sprowi.sh", "scripts/registry.sh"]) {
    cpSync(join(hubRoot, path), join(hub, path), {
      recursive: true,
      filter: (source) => !/\/sprowi\/(runs|tasks|experiments|projects)(\/|$)/.test(source),
    });
  }
  writeFileSync(join(hub, "projects.yaml"), "projects:\n  - name: demo-startup\n    repo: git@github.com:example/demo-startup.git\n");
  mkdirSync(join(hub, "projects/startups/demo-startup"), { recursive: true });
  mkdirSync(join(hub, "ideas"));
  writeFileSync(join(hub, "ideas/001-demo.md"), "# Demo idea\n\n## Problem\n\nCreators lose track of shared links.\n");
  return hub;
}

function sprowi(hub, ...args) {
  return spawnSync("bash", [join(hub, "scripts/sprowi.sh"), ...args], { cwd: hub, encoding: "utf8" });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const plan = {
  hypothesis: "Creators come back to create a second link.",
  audience: "newsletter creators",
  distribution: "invite 20 creators directly",
  window: { start: "2026-01-01", end: "2026-01-15" },
  primaryKpi: {
    name: "returning creators",
    event: "second_link_created",
    unit: "ratio",
    source: "application event export",
    minimumSample: 20,
    successAtLeast: 0.25,
    failureBelow: 0.1,
  },
};

function observed(eventCount, sampleSize) {
  return { eventCount, sampleSize, source: "export-2026-01-16.csv", recordedAt: "2026-01-16" };
}

test("GIVEN a selected idea WHEN its experiment plan is incomplete THEN Sprowi refuses to create an implementation task", () => {
  const hub = throwawayHub();
  try {
    const selected = sprowi(hub, "select", "ideas/001-demo.md", "demo");
    assert.equal(selected.status, 0, selected.stderr);
    const experiment = join(hub, "sprowi/experiments/demo");
    assert.match(readFileSync(join(experiment, "idea.md"), "utf8"), /Creators lose track/);

    writeJson(join(experiment, "experiment.json"), { ...plan, distribution: "" });
    const refused = sprowi(hub, "new", "demo-startup", "measure-links", "--experiment", "demo");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /distribution/);
  } finally {
    rmSync(hub, { recursive: true, force: true });
  }
});

test("GIVEN a complete plan WHEN creating the task THEN the agent receives the measurement contract", () => {
  const hub = throwawayHub();
  try {
    assert.equal(sprowi(hub, "select", "ideas/001-demo.md", "demo").status, 0);
    writeJson(join(hub, "sprowi/experiments/demo/experiment.json"), plan);

    const created = sprowi(hub, "new", "demo-startup", "measure-links", "--experiment", "demo");
    assert.equal(created.status, 0, created.stderr);
    const [taskDirectory] = readdirSync(join(hub, "sprowi/tasks/demo-startup"));
    const task = readFileSync(join(hub, "sprowi/tasks/demo-startup", taskDirectory, "task.md"), "utf8");
    assert.match(task, /Record action: second_link_created/);
    assert.match(task, /success >= 0\.25, failure < 0\.1, minimum sample 20/);
    assert.match(task, /Exclude test traffic/);
  } finally {
    rmSync(hub, { recursive: true, force: true });
  }
});

test("GIVEN recorded observations WHEN evaluating THEN the verdict follows the window, sample and thresholds", () => {
  const hub = throwawayHub();
  const evaluate = (spec, observation) => {
    writeJson(join(hub, "sprowi/experiments/demo/experiment.json"), spec);
    writeJson(join(hub, "sprowi/experiments/demo/observation.json"), observation);
    const result = sprowi(hub, "evaluate", "demo");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(sprowi(hub, "select", "ideas/001-demo.md", "demo").status, 0);

    const running = { ...plan, window: { start: "2026-01-01", end: "2999-01-01" } };
    assert.equal(evaluate(running, observed(5, 20)).verdict, "pending");
    assert.equal(evaluate(plan, observed(4, 19)).verdict, "inconclusive");
    assert.equal(evaluate(plan, observed(1, 20)).verdict, "rejected");
    assert.equal(evaluate(plan, observed(3, 20)).verdict, "inconclusive");
    assert.equal(evaluate(plan, observed(21, 20)).verdict, "incomplete");

    const supported = evaluate(plan, observed(5, 20));
    assert.equal(supported.verdict, "supported");
    assert.equal(supported.value, 0.25);
    assert.equal(supported.source, "export-2026-01-16.csv");
  } finally {
    rmSync(hub, { recursive: true, force: true });
  }
});
