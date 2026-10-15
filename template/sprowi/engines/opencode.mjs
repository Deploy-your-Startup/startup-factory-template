import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { emptyUsage, resolvePinnedCli, sandboxProxyEnvironment } from "../lib.mjs";

// The model id carries its provider prefix ("openrouter/anthropic/claude-…"),
// which is also how OpenCode names the provider to configure. Everything after
// the first segment is forwarded verbatim as the model id, so a gateway route
// has to be spelled the way that endpoint expects.
export function writeRuntimeConfig(path, config, engine) {
  const [providerName, ...modelParts] = engine.model.split("/");
  const modelId = modelParts.join("/");
  const useResponsesApi = engine.upstreamUrl.endsWith("/responses");
  const baseURL = engine.upstreamUrl.replace(/\/responses$/, "");
  const openaiStyle = providerName === "openai";

  writeFileSync(
    path,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      model: engine.model,
      small_model: engine.model,
      subagent_depth: 0,
      provider: {
        [providerName]: {
          ...(openaiStyle ? { npm: "@ai-sdk/openai" } : {}),
          options: { baseURL, ...(openaiStyle ? { useResponsesApi } : {}) },
          models: {
            [modelId]: {
              options: {
                reasoningEffort: engine.reasoningEffort,
                maxOutputTokens: engine.limits.maxOutputTokensPerRequest,
                ...(openaiStyle ? { useResponsesApi } : {}),
              },
            },
          },
        },
      },
      agent: {
        sprowi: {
          description: "Implements one bounded task without publishing it.",
          mode: "primary",
          model: engine.model,
          steps: config.limits.maxSteps,
          reasoningEffort: engine.reasoningEffort,
          maxOutputTokens: engine.limits.maxOutputTokensPerRequest,
          permission: {
            "*": "deny",
            read: "allow",
            edit: Object.fromEntries([
              ["*", "deny"],
              ...config.allowedPaths.map((path) => [path, "allow"]),
              ...config.protectedPaths.map((path) => [path, "deny"]),
            ]),
            glob: "allow",
            grep: "allow",
            list: "allow",
            bash: "allow",
            task: "deny",
            webfetch: "deny",
            websearch: "deny",
            external_directory: "deny",
          },
        },
      },
    }),
  );
}

export async function run({ config, engine, prompt, workspace, outputDirectory }) {
  const runtimeConfigPath = "/tmp/opencode.json";
  writeRuntimeConfig(runtimeConfigPath, config, engine);

  const eventsFile = createWriteStream(`${outputDirectory}/events.ndjson`, {
    flags: "wx",
  });
  const usage = emptyUsage(engine);
  const credentialEnv = engine.credential.env;

  const child = spawn(
    resolvePinnedCli("opencode"),
    [
      "run",
      "--title",
      "sprowi",
      "--model",
      engine.model,
      "--agent",
      "sprowi",
      "--format",
      "json",
      prompt,
    ],
    {
      cwd: workspace,
      env: {
        ...sandboxProxyEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [credentialEnv]: process.env[credentialEnv],
        OPENCODE_CONFIG: runtimeConfigPath,
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
    process.stdout.write(`${line}\n`);
    if (line.trim() === "") continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      child.kill("SIGTERM");
      throw new Error("OpenCode emitted non-JSON output while usage accounting was enabled.");
    }

    if (event.type !== "step_finish" || !event.part?.tokens) continue;
    const tokens = event.part.tokens;
    usage.steps += 1;
    usage.inputTokens += tokens.input ?? 0;
    usage.outputTokens += tokens.output ?? 0;
    usage.reasoningTokens += tokens.reasoning ?? 0;
    usage.cachedInputTokens += tokens.cache?.read ?? 0;
    usage.cacheWriteTokens += tokens.cache?.write ?? 0;
    usage.totalTokens +=
      tokens.total ??
      (tokens.input ?? 0) +
        (tokens.output ?? 0) +
        (tokens.reasoning ?? 0) +
        (tokens.cache?.read ?? 0);
    usage.costUsd += event.part.cost ?? 0;

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
