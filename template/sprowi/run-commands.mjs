#!/usr/bin/env node

// Runs one group of trusted commands from the configuration, in order, and
// stops at the first failure. Used twice: once to prepare a workspace
// (setupCommands) and once to verify a patch (acceptanceCommands). The
// commands come from the hub configuration, never from the agent.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { outputTail } from "./feedback.mjs";
import { readJson } from "./lib.mjs";

const { values: options } = parseArgs({
  options: {
    config: { type: "string" },
    group: { type: "string", default: "acceptanceCommands" },
    report: { type: "string" },
  },
});

const config = readJson(options.config);
// Enough to hold the tail the feedback keeps, without buffering a whole run.
const CAPTURED_CHARACTERS = 64_000;

function runCheck(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "true",
        NODE_ENV: process.env.NODE_ENV ?? "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (stream) => (chunk) => {
      stream.write(chunk);
      output = (output + chunk).slice(-CAPTURED_CHARACTERS);
    };
    child.stdout.on("data", capture(process.stdout));
    child.stderr.on("data", capture(process.stderr));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

for (const [check, [command, ...args]] of Object.entries(config[options.group] ?? {})) {
  console.log(`--- ${check}: ${[command, ...args].join(" ")}`);
  const { status, output } = await runCheck(command, args);
  if (status !== 0) {
    if (options.report) {
      mkdirSync(dirname(options.report), { recursive: true });
      writeFileSync(
        options.report,
        `${JSON.stringify(
          { check, command: [command, ...args].join(" "), output: outputTail(output) },
          null,
          2,
        )}\n`,
      );
    }
    process.exit(status ?? 1);
  }
}
