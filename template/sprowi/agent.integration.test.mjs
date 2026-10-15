import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

  test(`GIVEN SPROWI runtime settings WHEN the real agent runner invokes a local provider THEN it records usage and completes`, () => {
    const directory = mkdtempSync(join(tmpdir(), "sprowi-agent-"));
    try {
      const bin = join(directory, "bin"); mkdirSync(bin);
      const input = join(directory, "input"); mkdirSync(input);
      const output = join(directory, "output");
      writeFileSync(join(input, "task.md"), "Implement the local test task.\n");
      const config = JSON.parse(readFileSync(new URL("config.default.json", import.meta.url), "utf8"));
      config.engine = "claude";
      const configPath = join(directory, "config.json");
      writeFileSync(configPath, JSON.stringify(config));
      // Only the external provider executable and npm discovery are local stand-ins.
      writeFileSync(join(bin, "npm"), `#!${process.execPath}\nconsole.log(${JSON.stringify(directory)});\n`, { mode: 0o755 });
      writeFileSync(join(bin, "claude"), `#!${process.execPath}
if (!process.argv.includes('--print')) process.exit(90);
console.log(JSON.stringify({type:'assistant',message:{usage:{input_tokens:20,output_tokens:10},content:[{type:'text',text:'Local provider completed'}]}}));
console.log(JSON.stringify({type:'result',num_turns:1,total_cost_usd:0}));
`, { mode: 0o755 });
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_AUTH_TOKEN: "synthetic-placeholder" };
      for (const key of Object.keys(env)) if (key.startsWith("SPROWI_")) delete env[key];
      Object.assign(env, {
        [`SPROWI_CONFIG`]: configPath,
        [`SPROWI_INPUT_DIR`]: input,
        [`SPROWI_OUTPUT_DIR`]: output,
        [`SPROWI_WORKSPACE`]: directory,
      });
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("run-agent.mjs", import.meta.url)), "--mode", "implement"], { cwd: directory, env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Sprowi: claude/);
      const usage = JSON.parse(readFileSync(join(output, "usage.json"), "utf8"));
      assert.equal(usage.complete, true);
      assert.equal(usage.totalTokens, 30);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-placeholder/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
