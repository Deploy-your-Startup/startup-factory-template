import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { emptyUsage, resolvePinnedCli, sandboxProxyEnvironment } from "../lib.mjs";

// One AI credit is one US cent. The CLI reports credits in nano units.
const NANO_CREDITS_PER_CREDIT = 1_000_000_000;
const USD_PER_CREDIT = 0.01;

function bucket(details, name) {
  return details?.[name]?.tokenCount ?? 0;
}

// The CLI writes this file once, after the session ends. Its token buckets are
// disjoint, so they map onto the shared usage shape without correction.
export function readReportedUsage(path, engine) {
  const usage = emptyUsage(engine);
  if (!existsSync(path)) return usage;
  const reported = JSON.parse(readFileSync(path, "utf8"));
  const details = reported.tokenDetails;

  usage.inputTokens = bucket(details, "input");
  usage.outputTokens = bucket(details, "output");
  usage.cachedInputTokens = bucket(details, "cache_read");
  usage.cacheWriteTokens = bucket(details, "cache_write");
  usage.reasoningTokens = Object.values(reported.modelMetrics ?? {}).reduce(
    (total, metrics) => total + (metrics.usage?.reasoningTokens ?? 0),
    0,
  );
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.reasoningTokens +
    usage.cachedInputTokens +
    usage.cacheWriteTokens;
  usage.steps = Object.values(reported.modelMetrics ?? {}).reduce(
    (total, metrics) => total + (metrics.requests?.count ?? 0),
    0,
  );

  const credits = (reported.totalNanoAiu ?? 0) / NANO_CREDITS_PER_CREDIT;
  usage.costUsd = credits * USD_PER_CREDIT;
  usage.limitReached = credits >= engine.limits.maxAiCredits;
  return usage;
}

export async function run({ engine, prompt, workspace, outputDirectory }) {
  const usagePath = `${outputDirectory}/copilot-usage.json`;
  const eventsFile = createWriteStream(`${outputDirectory}/events.ndjson`, {
    flags: "wx",
  });

  const child = spawn(
    resolvePinnedCli("copilot"),
    [
      "--prompt",
      prompt,
      "-C",
      workspace,
      "--model",
      engine.model,
      "--effort",
      engine.reasoningEffort,
      "--max-ai-credits",
      String(engine.limits.maxAiCredits),
      "--allow-all-tools",
      // Without the GitHub MCP server the token buys model requests and
      // nothing else, and the session never leaves the sandbox.
      "--disable-builtin-mcps",
      "--no-remote",
      "--no-remote-export",
      "--no-ask-user",
      "--secret-env-vars=GH_TOKEN,GITHUB_TOKEN,COPILOT_GITHUB_TOKEN",
      "--no-auto-update",
      "--no-color",
      "--output-format",
      "json",
      "--usage-output-file",
      usagePath,
      "--log-level",
      "error",
      // Logs are the most likely place for a credential to surface, so they
      // stay out of the output directory. events.ndjson holds the session.
      "--log-dir",
      "/tmp/copilot-logs",
    ],
    {
      cwd: workspace,
      env: {
        ...sandboxProxyEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [engine.credential.env]: process.env[engine.credential.env],
        COPILOT_HOME: "/tmp/copilot",
        XDG_CONFIG_HOME: "/tmp/xdg-config",
        XDG_DATA_HOME: "/tmp/xdg-data",
        XDG_CACHE_HOME: "/tmp/xdg-cache",
        CI: "true",
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exitPromise = once(child, "exit");

  for await (const line of createInterface({ input: child.stdout })) {
    eventsFile.write(`${line}\n`);
    if (line.trim() === "") continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      child.kill("SIGTERM");
      throw new Error("Copilot CLI emitted non-JSON output while usage accounting was enabled.");
    }
    if (event.type === "assistant.message" || event.type === "result") {
      process.stdout.write(`${line}\n`);
    }
  }

  const [exitCode, signal] = await exitPromise;
  eventsFile.end();
  await once(eventsFile, "finish");

  return { usage: readReportedUsage(usagePath, engine), exitCode: exitCode ?? signal ?? 1 };
}
