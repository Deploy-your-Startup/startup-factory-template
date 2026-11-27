// Run with node in the pilot image. Only the external model is simulated.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), "factory-t3-smoke-"));
const project = join(home, "fixture");
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  T3CODE_HOME: join(home, ".t3"),
};
const t3 = process.env.T3_SMOKE_BINARY || "t3";
const cli = (...args) => exec(t3, args, { env, cwd: project, timeout: 45000 });
const marker = randomUUID();
const toolCallId = "read_fixture";
const first = "Read fixture-marker.txt in this checkout and report the marker.";
const second = "Report SECOND_CHECKPOINT.";

// Request one real tool call. Only its correlated result can reveal the random marker.
let readRequested = false;
const model = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const part of request) body += part;
  const { input } = JSON.parse(body);
  const result = input.find(item => item.type === "custom_tool_call_output" && item.call_id === toolCallId);
  let item;
  if (!readRequested) {
    readRequested = true;
    item = {
      type: "custom_tool_call", id: "call_fixture", call_id: toolCallId, status: "completed",
      namespace: "functions", name: "exec", input: 'text(await tools.exec_command({cmd:"cat fixture-marker.txt"}))',
    };
  } else {
    let reply = "Fixture file read failed";
    if (JSON.stringify(result?.output ?? "").includes(marker)) reply = marker;
    if (body.includes(second)) reply = "fixture-two";
    item = { id: "msg_" + randomUUID(), type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: reply }] };
  }
  const responseId = "resp_" + randomUUID();
  const event = (type, fields) => response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...fields }) + "\n\n");
  response.writeHead(200, { "content-type": "text/event-stream" });
  event("response.created", { response: { id: responseId, status: "in_progress", output: [] } });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { id: responseId, status: "completed", output: [item] } });
  response.end();
});

let running;
async function start() {
  // Reserve an available loopback port and release it immediately before T3 binds.
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(t3, ["serve", "--host", "127.0.0.1", "--port", String(port), project], {
    env, cwd: project, stdio: "ignore", // T3 prints a one-time pairing link at startup.
  });
  running = { child, closed: new Promise(resolve => child.once("close", resolve)) };
  await once(child, "spawn");
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, "T3 exited before becoming ready");
    const response = await fetch("http://127.0.0.1:" + port + "/api/auth/websocket-ticket",
      { method: "POST", signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    if (response) {
      await response.body?.cancel();
      if (response.status === 401) {
        const { stdout } = await cli("auth", "session", "issue", "--token-only");
        const authorized = await fetch("http://127.0.0.1:" + port + "/api/auth/websocket-ticket", {
          method: "POST", headers: { Authorization: "Bearer " + stdout.trim() },
        });
        assert.equal(authorized.status, 200);
        assert.ok((await authorized.json()).ticket);
        return;
      }
      assert.equal(response.status, 503, "T3 must reject unauthenticated access");
    }
    await sleep(200);
  }
  throw new Error("T3 did not become ready within 30s");
}

async function stop() {
  if (!running) return;
  running.child.kill("SIGTERM");
  const force = setTimeout(() => running.child.kill("SIGKILL"), 5000);
  try { await running.closed; } finally { clearTimeout(force); running = undefined; }
}

try {
  // GIVEN an isolated project and a loopback model with no provider account.
  await mkdir(project);
  await mkdir(env.CODEX_HOME);
  await writeFile(join(project, "fixture-marker.txt"), marker + "\n");
  await exec("git", ["init", "-q", project], { env });
  await exec("git", ["add", "fixture-marker.txt"], { env, cwd: project });
  await exec("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid",
    "commit", "-qm", "fixture"], { env, cwd: project });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  await writeFile(join(env.CODEX_HOME, "config.toml"), [
    'model_provider = "test"',
    '[model_providers.test]',
    'name = "Local test model"',
    'base_url = "http://127.0.0.1:' + model.address().port + '/v1"',
    'wire_api = "responses"',
    'supports_websockets = false',
  ].join("\n"));

  // WHEN a real Codex turn completes, restart T3 with the same persistent home.
  await start();
  await cli("project", "add", project);
  const turn = JSON.parse((await cli("thread", "start", "--title", "Factory smoke", "--provider", "codex",
    "--model", "gpt-6.1-sol", "--wait", "--json", project, first)).stdout);
  assert.equal(turn.status, "completed");
  assert.equal(turn.reply, marker, "Codex must read the checkout through its shell tool");
  await stop();
  await start();

  // THEN a fresh client can continue the same thread and read both turns.
  const next = JSON.parse((await cli("thread", "send", "--wait", "--json", turn.threadId, second)).stdout);
  assert.equal(next.status, "completed");
  assert.equal(next.reply, "fixture-two");
  const history = JSON.parse((await cli("thread", "show", "--json", turn.threadId)).stdout);
  assert.equal(history.thread.threadId, turn.threadId);
  assert.deepEqual(history.messages.map(({ role, text }) => [role, text]), [
    ["user", first], ["assistant", marker], ["user", second], ["assistant", "fixture-two"],
  ]);
  console.log("PASS: Codex read the checkout; authenticated T3/Codex thread resumed after server restart; both test replies persisted.");
} finally {
  await stop();
  model.closeAllConnections();
  model.close();
  await rm(home, { recursive: true, force: true });
}
