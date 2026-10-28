import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real CLI, Git, persistence, patch policy, agent adapters, reviewer and verifier.
// Only Docker Sandboxes and paid model executables are local external stand-ins;
// this does not establish VM isolation, live credentials or model quality.
function fixture(engine = "claude") {
  const root = mkdtempSync(join(tmpdir(), "factory-discovery-test-"));
  const factory = join(root, "factory"); mkdirSync(factory);
  const bin = join(root, "bin"); mkdirSync(bin);
  const source = new URL("../", import.meta.url);
  cpSync(new URL("sprowi", source), join(factory, "sprowi"), { recursive: true, filter: (path) => !/\/(state|tasks|runs|experiments)(\/|$)/.test(path) });
  mkdirSync(join(factory, "scripts"));
  for (const name of ["sprowi.sh", "check-ideas.mjs"]) cpSync(new URL(`scripts/${name}`, source), join(factory, "scripts", name));
  writeFileSync(join(factory, "projects.yaml"), "projects: []\ntooling: []\n");
  writeFileSync(join(factory, "VISION.md"), "Build a small web product, distribute it and learn from real use.\n");
  writeFileSync(join(factory, ".gitignore"), "/sprowi/runs/\n/sprowi/tasks/\n/sprowi/discovery/state/\n/projects/\n");
  mkdirSync(join(factory, "projects/startups/board-club/docs"), { recursive: true });
  writeFileSync(join(factory, "projects/startups/board-club/docs/product.md"), "# board-club product\n\n## What it is\n\nFriends draw one board game a month.\n");
  const configPath = join(factory, "sprowi/config.default.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.engine = engine;
  config.engines.codex.accountIdCommand = "printf synthetic-account";
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(factory, "sprowi/discovery/config.json"), JSON.stringify({
    timezone: "UTC", language: "English", rounds: 1, preferences: ["solo"], excludedIdeas: [],
    research: { hackerNews: false, storyLimit: 1, commentsPerStory: 0, urls: [] },
  }));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Discovery integration", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: factory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  git("init", "-q"); git("config", "commit.gpgsign", "false");
  git("add", "-A"); git("commit", "-qm", "fixture");
  const executable = (name, text) => writeFileSync(join(bin, name), `#!${process.execPath}\n${text}`, { mode: 0o755 });
  executable("npm", `console.log(${JSON.stringify(root)});`);
  executable("sbx", `
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), stateFile=${JSON.stringify(join(root, "sandboxes.json"))};
const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
if(args[0]==='version'){console.log('local external boundary');process.exit(0);}
if(args[0]==='create'&&args.includes('--help')){console.log(existsSync(${JSON.stringify(join(root, "old-sbx"))})?'old create flags':'--skills string');process.exit(0);}
if(args[0]==='ls'){if(existsSync(${JSON.stringify(join(root, "deny-sbx"))})){console.error('synthetic login unavailable');process.exit(1);}console.log('[]');process.exit(0);}
if(args[0]==='env'&&args[1]==='create'){
 // Match the current external CLI: deprecated flags must not pass silently.
 if(args.includes('--auto-approve')){console.error('error: unknown flag: --auto-approve');process.exit(2);}
 if(!args.includes('--force')){console.error('non-interactive create requires --force');process.exit(2);}
 const values={};for(let i=0;i<args.length;i++)if(args[i]==='--env-arg'){const [k,...v]=args[++i].split('=');values[k]=v.join('=');}
 state[values.name]=values;writeFileSync(stateFile,JSON.stringify(state));process.exit(0);
}
if(args[0]==='env'&&args[1]==='rm')process.exit(0);
if(args[0]==='exec'){
 const values=state[args[3]];if(!values)process.exit(97);
 const result=spawnSync(args[4],args.slice(5),{cwd:args[2],stdio:'inherit',env:{...process.env,
 SPROWI_ENGINE:values.engine||'',SPROWI_CONFIG:values.config,SPROWI_INPUT_DIR:values.input,
 SPROWI_OUTPUT_DIR:values.output,SPROWI_WORKSPACE:values.workspace,ANTHROPIC_AUTH_TOKEN:'synthetic-placeholder',OPENAI_API_KEY:'synthetic-placeholder'}});
 process.exit(result.status??1);
}
process.exit(98);
`);
  const provider = `
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const prompt=process.argv.slice(2).find(v=>v.includes('BEGIN TASK DOCUMENT'))||'';
appendFileSync(${JSON.stringify(join(root, "prompts.log"))}, prompt+'\\n');
if(prompt.startsWith('Review')){
 const path=/write your verdict as JSON to (.+)\\nand nothing/.exec(prompt)[1];
 mkdirSync(join(path,'..'),{recursive:true});
 writeFileSync(path,JSON.stringify({pass:true,findings:[],scenarios:[]}));
}else{
 mkdirSync('ideas',{recursive:true});
 const duplicate=existsSync(${JSON.stringify(join(root, "duplicate-rank"))});
 for(let i=1;i<=3;i++){
  let text='# Distinct customer problem '+i+'\\n';
  const headings=['Problem','Evidence','Distribution','Smallest test','Assumption','If validated','Why it might fail','Rationale'];
  if(!existsSync(${JSON.stringify(join(root, "paper-only"))}))headings.push('Web experiment');
  for(const h of headings){
   text+='\\n## '+h+'\\n\\n'+(h==='Web experiment'?'A small web app takes one input and returns a useful result. Use the supported Factory template and deploy with startup after owner approval, then share the URL through a permitted audience channel. Record core_action_completed for eligible visitors.':'If at least five of ten eligible visitors complete the core action in the web app within three days, test customer problem '+i+'. Source: https://example.invalid/evidence')+'\\n';
  }
  text+='\\n## Rank\\n\\n'+(duplicate?1:i)+'\\n';
  writeFileSync('ideas/00'+i+'-customer-'+i+'.md',text);
 }
}

if(process.argv[1].endsWith('codex'))console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:40,output_tokens:20}}));
else{
 console.log(JSON.stringify({type:'assistant',message:{usage:{input_tokens:40,output_tokens:20}}}));
 console.log(JSON.stringify({type:'result',num_turns:1,total_cost_usd:0}));
}
`;
  executable("claude", provider); executable("codex", provider);
  const research = join(root, "research.json");
  writeFileSync(research, JSON.stringify({ sources: [{ url: "https://example.invalid/evidence", title: "A real fixture complaint", text: "Operators repeatedly enter the same data manually and ask how to avoid the duplicated work.", observedAt: "2026-01-01T09:00:00Z" }] }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", TZ: "UTC" };
  for (const key of Object.keys(env)) if (key.startsWith("SPROWI_")) delete env[key];
  const invoke = (args, extra = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(factory, "sprowi/cli.mjs"), ...args], { cwd: factory, env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
  const run = (args, extra) => invoke(["discover", ...args], extra);
  return { root, factory, research, run, ideas: () => invoke(["ideas"]), git, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("GIVEN the ordinary ideas command WHEN it creates and runs a brief THEN the agent receives the same small web-build direction without deployment authority", async () => {
  const f = fixture();
  try {
    const result = await f.ideas();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const tasks = join(f.factory, "sprowi/tasks/startup-factory");
    const brief = readFileSync(join(tasks, readdirSync(tasks)[0], "task.md"), "utf8");
    assert.match(brief, /small website or web app/);
    assert.match(brief, /up to three days of building/);
    assert.match(brief, /grants no permission to build, contact or deploy/);
    assert.doesNotMatch(brief, /Anything needing new infrastructure, a new service/);
    assert.match(readFileSync(join(f.root, "prompts.log"), "utf8"), /actual use, return visits or payment/);
  } finally { f.close(); }
});

test("GIVEN proposals with no Web experiment WHEN discovery reviews and archives them THEN the host refuses a paper-only batch despite a passing model review", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "paper-only"), "omit the web experiment");
    const result = await f.run(["run", "--date", "2026-01-01", "--research-file", f.research]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /missing or thin Web experiment/);
    assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/history/2026-01-01/batch.json")), false);
    assert.equal(existsSync(join(f.factory, "discovery")), false);
    const attempts = join(f.factory, "sprowi/discovery/state/attempts");
    assert.equal(JSON.parse(readFileSync(join(attempts, readdirSync(attempts)[0], "attempt.json"), "utf8")).status, "failed");
  } finally { f.close(); }
});

for (const engine of ["claude", "codex"]) {
  test(`GIVEN ${engine} and current sbx create flags WHEN the real discovery CLI runs twice THEN one checked ranked batch is archived without changing source ideas`, async () => {
    const f = fixture(engine);
    try {
      const first = await f.run(["run", "--date", "2026-01-01", "--research-file", f.research]);
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const archive = join(f.factory, "sprowi/discovery/state/history/2026-01-01");
      const batch = JSON.parse(readFileSync(join(archive, "batch.json"), "utf8"));
      assert.equal(batch.engine, engine); assert.equal(batch.status, "complete");
      assert.deepEqual(batch.ideas.map((idea) => idea.rank), [1, 2, 3]);
      for (const name of ["research.json", "result.patch", "result.json", "usage.json", "summary.md"]) assert.ok(existsSync(join(archive, name)));
      assert.equal(readdirSync(join(archive, "ideas")).length, 3);
      assert.equal(existsSync(join(f.factory, "ideas")), false);
      assert.equal(f.git("status", "--porcelain"), "", "Daily inputs and results must all remain private and gitignored.");
      const calls = readFileSync(join(f.root, "prompts.log"), "utf8");
      assert.match(calls, /NEW markets are allowed/); assert.match(calls, /Provided research is supplied evidence/);
      assert.match(calls, /## Web experiment/);
      assert.match(calls, /build, instrument and ship/);
      assert.match(calls, /Reject a paper\/PDF checklist/);
      assert.match(calls, /eligible audience and time anchor/);
      assert.match(calls, /"project": "board-club"/); assert.match(calls, /Friends draw one board game a month/);
      const again = await f.run(["run", "--date", "2026-01-01", "--research-file", f.research]);
      assert.equal(again.status, 0); assert.match(again.stdout, /Already complete/);
      assert.equal(readFileSync(join(f.root, "prompts.log"), "utf8"), calls);
      const decision = await f.run(["feedback", "2026-01-01", batch.ideas[0].file, "rejected", "--reason", "Cannot reach these customers"]);
      assert.equal(decision.status, 0, decision.stderr);
      const invalid = await f.run(["feedback", "2026-01-01", "../escape", "test", "--reason", "bad"]);
      assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Unknown idea/);
      const next = await f.run(["run", "--date", "2026-01-02", "--research-file", f.research]);
      assert.equal(next.status, 1); assert.match(next.stderr, /duplicate archived idea/);
      const prompts = readFileSync(join(f.root, "prompts.log"), "utf8");
      assert.match(prompts, /Cannot reach these customers/); assert.match(prompts, /Distinct customer problem 1/);
      assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/run.lock")), false);
    } finally { f.close(); }
  });
}

test("GIVEN enabled reading export WHEN a new batch completes THEN the common run creates readable copies without changing the private archive", async () => {
  const f = fixture();
  try {
    const path = join(f.factory, "sprowi/discovery/config.json"), config = JSON.parse(readFileSync(path, "utf8"));
    config.reading = { enabled: true, publish: false };
    writeFileSync(path, JSON.stringify(config)); f.git("add", "-A"); f.git("commit", "-qm", "enable local reading");
    const result = await f.run(["run", "--date", "2026-01-01", "--research-file", f.research]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /DISCOVERY_READING/);
    assert.match(readFileSync(join(f.factory, "discovery/README.md"), "utf8"), /Distinct customer problem 1/);
    assert.match(readFileSync(join(f.factory, "discovery/README.md"), "utf8"), /\*\*Web experiment:\*\*/);
    assert.match(readFileSync(join(f.factory, "discovery/2026-01-01/README.md"), "utf8"), /core_action_completed/);
    const archive = join(f.factory, "sprowi/discovery/state/history/2026-01-01");
    assert.equal(JSON.parse(readFileSync(join(archive, "batch.json"), "utf8")).status, "complete");
    assert.equal(readFileSync(join(f.factory, "discovery/2026-01-01/ideas/001-customer-1.md"), "utf8"), readFileSync(join(archive, "ideas/001-customer-1.md"), "utf8"));
  } finally { f.close(); }
});

test("GIVEN a public source endpoint WHEN collecting research THEN retrieved text and source errors are archived and passed to the agent", async () => {
  const f = fixture();
  const server = createServer((_req, response) => response.end("<p>Owners complain about repeatedly copying the same information between incompatible tools.</p>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const configPath = join(f.factory, "sprowi/discovery/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const url = `http://127.0.0.1:${server.address().port}/complaint`;
    config.research.urls = [url, "http://127.0.0.1:1/unavailable"];
    writeFileSync(configPath, JSON.stringify(config)); f.git("add", "-A"); f.git("commit", "-qm", "source fixture");
    // The provider returns its fixed synthetic citation, so the host must reject
    // it even though the external reviewer reports pass.
    const result = await f.run(["run", "--date", "2026-01-01"]);
    assert.equal(result.status, 1); assert.match(result.stderr, /cite a supplied research URL/);
    const attempts = join(f.factory, "sprowi/discovery/state/attempts");
    const report = JSON.parse(readFileSync(join(attempts, readdirSync(attempts)[0], "research.json"), "utf8"));
    assert.equal(report.mode, "fetched"); assert.equal(report.sources[0].url, url);
    assert.match(report.sources[0].text, /Owners complain/); assert.equal(report.errors.length, 1);
    assert.match(readFileSync(join(f.root, "prompts.log"), "utf8"), /Owners complain/);
  } finally { server.close(); f.close(); }
});

test("GIVEN denied sandbox access or invalid research WHEN discovery runs THEN it records failure without a completed batch or provider switch", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "deny-sbx"), "denied");
    const denied = await f.run(["run", "--date", "2026-01-01", "--research-file", f.research]);
    assert.equal(denied.status, 1); assert.match(denied.stderr, /Sandboxes is not authenticated/);
    assert.equal(existsSync(join(f.root, "prompts.log")), false);
    const invalid = await f.run(["run", "--date", "../../escape"]);
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /real YYYY-MM-DD/);
    writeFileSync(f.research, JSON.stringify({ sources: [{ url: "file:///private", text: "invalid" }] }));
    const badSource = await f.run(["run", "--date", "2026-01-02", "--research-file", f.research]);
    assert.equal(badSource.status, 1); assert.match(badSource.stderr, /HTTP/);
    assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/history")), false);
    const attempts = join(f.factory, "sprowi/discovery/state/attempts");
    assert.ok(readdirSync(attempts).every((name) => JSON.parse(readFileSync(join(attempts, name, "attempt.json"), "utf8")).status === "failed"));
  } finally { f.close(); }
});

test("GIVEN an old sbx without skills isolation WHEN discovery runs THEN it requests an upgrade before creating a sandbox", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "old-sbx"), "unsupported");
    const result = await f.run(["run", "--date", "2026-01-01", "--research-file", f.research]);
    assert.equal(result.status, 1); assert.match(result.stderr, /lacks --skills=off support/);
    assert.match(result.stderr, /Do not remove sandboxOptions.skills: off/);
    assert.equal(existsSync(join(f.root, "sandboxes.json")), false);
    assert.equal(existsSync(join(f.root, "prompts.log")), false);
  } finally { f.close(); }
});

test("GIVEN duplicate ranks or concurrent execution WHEN discovery runs THEN invalid completion and parallel model runs are refused", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "duplicate-rank"), "duplicate");
    const bad = await f.run(["run", "--date", "2026-01-01", "--research-file", f.research]);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /each rank exactly once/);
    mkdirSync(join(f.factory, "sprowi/discovery/state/run.lock"));
    const locked = await f.run(["run", "--date", "2026-01-02", "--research-file", f.research]);
    assert.equal(locked.status, 1); assert.match(locked.stderr, /already running/);
  } finally { f.close(); }
});

test("GIVEN a chosen engine WHEN previewing the schedule THEN a portable invocation is written without enabling a job", async () => {
  const f = fixture("codex");
  try {
    const preview = await f.run(["schedule", "--at", "09:17", "--timezone", "UTC"]);
    assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /Nothing installed/);
    const xml = readFileSync(join(f.factory, "sprowi/discovery/state/schedule.plist"), "utf8");
    assert.match(xml, /<string>codex<\/string>/); assert.match(xml, /<integer>9<\/integer>/); assert.match(xml, /<integer>17<\/integer>/);
    assert.match(xml, /<string>run<\/string>/); assert.doesNotMatch(xml, /token|secret|publish/i);
    assert.equal(existsSync(join(f.factory, "sprowi/discovery/state/schedule.json")), false);
    const invalid = await f.run(["schedule", "--at", "25:00"]);
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /24-hour/);
    const zone = await f.run(["schedule", "--timezone", "Europe/Berlin"]);
    assert.equal(zone.status, 1); assert.match(zone.stderr, /machine timezone/);
  } finally { f.close(); }
});

test("GIVEN explicit schedule installation WHEN using the CLI THEN only its own LaunchAgent is enabled and conflicting replacements are refused", async () => {
  const f = fixture("claude");
  try {
    const home = join(f.root, "home"); mkdirSync(home);
    const serviceState = join(f.root, "launchctl-loaded");
    writeFileSync(join(f.root, "bin/launchctl"), `#!${process.execPath}\n
import {existsSync,writeFileSync} from 'node:fs';
if(process.argv[2]==='print')process.exit(existsSync(${JSON.stringify(serviceState)})?0:1);
if(process.argv[2]==='bootstrap'){writeFileSync(${JSON.stringify(serviceState)},'loaded');process.exit(0);}
process.exit(95);\n`, { mode: 0o755 });
    const result = await f.run(["schedule", "--at", "08:00", "--timezone", "UTC", "--install"], { HOME: home });
    if (process.platform !== "darwin") {
      assert.equal(result.status, 1); assert.match(result.stderr, /requires macOS/);
      assert.equal(existsSync(serviceState), false); return;
    }
    assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(serviceState, "utf8"), "loaded");
    const agents = join(home, "Library/LaunchAgents");
    assert.equal(readdirSync(agents).length, 1);
    const installed = join(agents, readdirSync(agents)[0]);
    const valid = spawnSync("plutil", ["-lint", installed], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    const again = await f.run(["schedule", "--at", "08:00", "--timezone", "UTC", "--install"], { HOME: home });
    assert.equal(again.status, 0, again.stderr);
    const conflict = await f.run(["schedule", "--at", "09:00", "--timezone", "UTC", "--install"], { HOME: home });
    assert.equal(conflict.status, 1); assert.match(conflict.stderr, /different schedule exists/);
    assert.match(readFileSync(installed, "utf8"), /<integer>8<\/integer>/);
  } finally { f.close(); }
});
