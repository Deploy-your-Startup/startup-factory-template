import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { emptyUsage, resolvePinnedCli, sandboxProxyEnvironment } from "../lib.mjs";

// Codex reports cumulative token counts per turn rather than per step, and it
// reports no cost at all. maxTotalTokens is therefore the only budget that
// bites here; bound the spend at the provider as well.
function readTurnUsage(usage, reported) {
  if (!reported) return false;
  usage.steps += 1;
  usage.inputTokens = reported.input_tokens ?? usage.inputTokens;
  usage.outputTokens = reported.output_tokens ?? usage.outputTokens;
  usage.reasoningTokens =
    reported.reasoning_output_tokens ?? usage.reasoningTokens;
  usage.cachedInputTokens =
    reported.cached_input_tokens ?? usage.cachedInputTokens;
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.reasoningTokens +
    usage.cachedInputTokens;
  return true;
}

// Codex reaches the model through a custom provider rather than its built-in
// one: the built-in path expects either an API key or a ~/.codex/auth.json, and
// the sandbox has neither. A provider pointing at the same backend a
// subscription login uses takes the bearer from the environment, which is where
// the proxy placeholder sits.
export function writeRuntimeConfig(home, engine) {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    `${home}/config.toml`,
    [
      'model_provider = "sprowi"',
      "",
      "[model_providers.sprowi]",
      'name = "ChatGPT subscription through the sandbox proxy"',
      `base_url = "${engine.upstreamUrl}"`,
      `env_key = "${engine.credential.env}"`,
      'wire_api = "responses"',
      "",
      "[model_providers.sprowi.env_http_headers]",
      // The backend rejects a request without it, and it is not a secret.
      'ChatGPT-Account-ID = "SPROWI_CHATGPT_ACCOUNT_ID"',
      "",
    ].join("\n"),
  );
}

export async function run({ config, engine, prompt, workspace, outputDirectory }) {
  const home = "/tmp/codex-home";
  writeRuntimeConfig(home, engine);

  const eventsFile = createWriteStream(`${outputDirectory}/events.ndjson`, {
    flags: "wx",
  });
  const usage = emptyUsage(engine);

  const child = spawn(
    resolvePinnedCli("codex"),
    [
      "exec",
      "--json",
      "--model",
      engine.model,
      "--config",
      `model_reasoning_effort="${engine.reasoningEffort}"`,
      // The workspace is a fresh git repository created by the runner, but a
      // failed init must not turn into an interactive prompt.
      "--skip-git-repo-check",
      // Same boundary argument as the other engines: the microVM is the limit,
      // not an approval dialog nobody is there to answer.
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ],
    {
      cwd: workspace,
      env: {
        ...sandboxProxyEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [engine.credential.env]: process.env[engine.credential.env],
        CODEX_HOME: home,
        SPROWI_CHATGPT_ACCOUNT_ID: process.env.SPROWI_CHATGPT_ACCOUNT_ID,
        XDG_CONFIG_HOME: "/tmp/xdg-config",
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
      throw new Error("Codex emitted non-JSON output while usage accounting was enabled.");
    }

    // Two event shapes are in the wild: the typed `turn.completed` stream and
    // the older `msg.token_count` envelope. Reading both keeps the accounting
    // from silently reporting zero after a CLI update.
    const counted =
      readTurnUsage(usage, event.usage && event.type === "turn.completed" ? event.usage : null) ||
      readTurnUsage(usage, event.msg?.type === "token_count" ? (event.msg.info?.total_token_usage ?? event.msg.info) : null);

    if (!counted && (event.type === "item.completed" || event.type === "error")) {
      process.stdout.write(`${line}\n`);
    }

    if (usage.totalTokens > engine.limits.maxTotalTokens) {
      usage.limitReached = true;
      child.kill("SIGTERM");
    }
  }

  const [exitCode, signal] = await exitPromise;
  eventsFile.end();
  await once(eventsFile, "finish");

  return { usage, exitCode: exitCode ?? signal ?? 1 };
}
