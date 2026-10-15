import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { emptyUsage, resolvePinnedCli, sandboxProxyEnvironment } from "../lib.mjs";

// Claude Code streams one JSON object per line and closes with a "result"
// event carrying the authoritative totals. The per-message usage is summed as
// it arrives so a runaway session can be stopped before that final event.
function addMessageUsage(usage, reported) {
  if (!reported) return;
  usage.steps += 1;
  usage.inputTokens += reported.input_tokens ?? 0;
  usage.outputTokens += reported.output_tokens ?? 0;
  usage.cachedInputTokens += reported.cache_read_input_tokens ?? 0;
  usage.cacheWriteTokens += reported.cache_creation_input_tokens ?? 0;
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cachedInputTokens +
    usage.cacheWriteTokens;
}

export async function run({ config, engine, prompt, workspace, outputDirectory }) {
  const eventsFile = createWriteStream(`${outputDirectory}/events.ndjson`, {
    flags: "wx",
  });
  const usage = emptyUsage(engine);

  const child = spawn(
    resolvePinnedCli("claude"),
    [
      "--print",
      prompt,
      "--output-format",
      "stream-json",
      // stream-json without --verbose prints only the final event, which would
      // leave the round without progress output and without per-turn usage.
      "--verbose",
      "--model",
      engine.model,
      "--max-turns",
      String(config.limits.maxSteps),
      // The microVM is the command boundary, exactly as it is for the other
      // engines. A permission prompt in a non-interactive run is a deadlock.
      "--dangerously-skip-permissions",
    ],
    {
      cwd: workspace,
      env: {
        ...sandboxProxyEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Whatever the kit put here is a placeholder; sbx swaps it for the
        // real token in the outbound request on the host. The name comes from
        // the config so it cannot drift from what the kit sets.
        [engine.credential.env]: process.env[engine.credential.env],
        CLAUDE_CONFIG_DIR: "/tmp/claude",
        XDG_CONFIG_HOME: "/tmp/xdg-config",
        XDG_CACHE_HOME: "/tmp/xdg-cache",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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
      throw new Error("Claude Code emitted non-JSON output while usage accounting was enabled.");
    }

    if (event.type === "assistant") {
      addMessageUsage(usage, event.message?.usage);
      const text = (event.message?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) process.stdout.write(`${text.trim()}\n`);
    }

    if (event.type === "result") {
      process.stdout.write(`${line}\n`);
      if (typeof event.total_cost_usd === "number") {
        usage.costUsd = event.total_cost_usd;
      }
      if (typeof event.num_turns === "number" && event.num_turns > usage.steps) {
        usage.steps = event.num_turns;
      }
    }

    if (
      usage.totalTokens > engine.limits.maxTotalTokens ||
      usage.costUsd > engine.limits.maxCostUsd
    ) {
      usage.limitReached = true;
      child.kill("SIGTERM");
    }
  }

  const [exitCode, signal] = await exitPromise;
  eventsFile.end();
  await once(eventsFile, "finish");

  return { usage, exitCode: exitCode ?? signal ?? 1 };
}
