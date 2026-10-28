// A small, auditable contract for testing one startup idea. Product events may
// come from any source; Sprowi records the aggregate and its evidence here.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hubRoot } from "./lib.mjs";

const root = join(hubRoot, "sprowi/experiments");

export function experimentDirectory(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Experiment slug must contain lowercase letters, digits and hyphens.");
  }
  return join(root, slug);
}

// The idea-personas skill writes this section. An idea becomes an experiment
// only once its user, buyer and payer are named and the verdict is "test".
const ROLES = ["User", "Buyer", "Payer", "Verdict"];

// Parses the section without judging it; discovery accepts "sharpen" drafts.
export function parsePersonas(text) {
  const section = /^## Personas[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1];
  if (section === undefined) {
    throw new Error("The idea has no `## Personas` section. Judge it with the idea-personas skill first.");
  }
  const personas = {};
  for (const role of ROLES) {
    const value = new RegExp(`^- \\*\\*${role}:\\*\\*(.*)$`, "m").exec(section)?.[1]?.trim();
    if (!value) throw new Error(`\`## Personas\` needs a \`- **${role}:**\` line.`);
    personas[role.toLowerCase()] = value;
  }
  const verdict = /^(test|sharpen|drop)\b/i.exec(personas.verdict)?.[1]?.toLowerCase();
  if (!verdict) throw new Error("The persona verdict must start with test, sharpen or drop.");
  return { ...personas, verdict, reason: personas.verdict };
}

export function readPersonas(text) {
  const { verdict, reason, ...personas } = parsePersonas(text);
  personas.verdict = reason;
  if (verdict !== "test") throw new Error(`The persona verdict is "${verdict}", not "test": ${personas.verdict}`);
  return personas;
}

export function selectIdea(source, slug) {
  const idea = resolve(source);
  if (!existsSync(idea)) throw new Error(`Idea file does not exist: ${idea}`);
  const personas = readPersonas(readFileSync(idea, "utf8"));
  const directory = experimentDirectory(slug);
  if (existsSync(directory)) throw new Error(`Experiment already exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  copyFileSync(idea, join(directory, "idea.md"));
  writeFileSync(join(directory, "experiment.json"), `${JSON.stringify({
    hypothesis: "",
    audience: personas.user,
    distribution: "",
    window: { start: null, end: null },
    primaryKpi: {
      name: "",
      event: "",
      unit: "count",
      source: "",
      minimumSample: 0,
      successAtLeast: null,
      failureBelow: null,
    },
  }, null, 2)}\n`);
  writeFileSync(join(directory, "observation.json"), `${JSON.stringify({
    eventCount: null,
    sampleSize: null,
    source: "",
    recordedAt: null,
  }, null, 2)}\n`);
  return directory;
}

export function readExperiment(slug) {
  const directory = experimentDirectory(slug);
  const spec = JSON.parse(readFileSync(join(directory, "experiment.json"), "utf8"));
  const idea = readFileSync(join(directory, "idea.md"), "utf8");
  return { directory, spec, idea };
}

export function validatePlan(spec) {
  const missing = [];
  for (const field of ["hypothesis", "audience", "distribution"]) {
    if (typeof spec[field] !== "string" || !spec[field].trim()) missing.push(field);
  }
  const kpi = spec.primaryKpi ?? {};
  for (const field of ["name", "event", "source"]) {
    if (typeof kpi[field] !== "string" || !kpi[field].trim()) missing.push(`primaryKpi.${field}`);
  }
  if (!["count", "ratio"].includes(kpi.unit)) missing.push("primaryKpi.unit");
  if (!Number.isInteger(kpi.minimumSample) || kpi.minimumSample < 0) missing.push("primaryKpi.minimumSample");
  if (typeof kpi.successAtLeast !== "number" || !Number.isFinite(kpi.successAtLeast)) missing.push("primaryKpi.successAtLeast");
  if (typeof kpi.failureBelow !== "number" || !Number.isFinite(kpi.failureBelow)) missing.push("primaryKpi.failureBelow");
  if (missing.length === 0 && kpi.failureBelow > kpi.successAtLeast) missing.push("primaryKpi.failureBelow must not exceed successAtLeast");
  if (missing.length === 0 && kpi.unit === "ratio" && (kpi.failureBelow < 0 || kpi.successAtLeast > 1)) missing.push("ratio thresholds must be between 0 and 1");
  return missing;
}

export function makeIdeaTask(slug) {
  const { spec, idea } = readExperiment(slug);
  const missing = validatePlan(spec);
  if (missing.length) throw new Error(`Complete the experiment plan before implementation:\n- ${missing.join("\n- ")}`);
  const kpi = spec.primaryKpi;
  return `# Task\n\nImplement the smallest test of this startup idea for ${spec.audience}.\n\n## Idea\n\n${idea.trim()}\n\n## Experiment\n\n- Hypothesis: ${spec.hypothesis}\n- Distribution: ${spec.distribution}\n- Primary KPI: ${kpi.name} (${kpi.unit}); success >= ${kpi.successAtLeast}, failure < ${kpi.failureBelow}, minimum sample ${kpi.minimumSample}.\n- Record action: ${kpi.event}. Source: ${kpi.source}.\n- Capture the numerator and denominator when the KPI is a ratio. Exclude test traffic.\n- Make the measured action observable through the product's existing data store or an analytics export. Do not invent results.\n\n## Out of scope\n\n- A generic analytics platform or growth automation.\n- Deployment and paid acquisition.\n`;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function evaluateExperiment(spec, observation, today = new Date().toISOString().slice(0, 10)) {
  const missing = validatePlan(spec);
  if (missing.length) return { verdict: "incomplete", reasons: missing };
  const { start, end } = spec.window ?? {};
  if (!validDate(start) || !validDate(end) || start > end) {
    return { verdict: "incomplete", reasons: ["Set a valid measurement window (start and end)."] };
  }
  if (today < end) return { verdict: "pending", reasons: [`Measurement window ends on ${end}.`] };
  if (!Number.isInteger(observation.eventCount) || observation.eventCount < 0 ||
      !Number.isInteger(observation.sampleSize) || observation.sampleSize < 0 ||
      !observation.source?.trim() || !validDate(observation.recordedAt) || observation.recordedAt < end || observation.recordedAt > today) {
    return { verdict: "incomplete", reasons: ["Record an event count, sample size, source and date in observation.json."] };
  }
  if (spec.primaryKpi.unit === "ratio" && (observation.sampleSize === 0 || observation.eventCount > observation.sampleSize)) {
    return { verdict: "incomplete", reasons: ["A ratio needs a nonzero sample and an event count no larger than that sample."] };
  }
  if (observation.sampleSize < spec.primaryKpi.minimumSample) {
    return { verdict: "inconclusive", reasons: [`Sample ${observation.sampleSize} is below ${spec.primaryKpi.minimumSample}.`] };
  }
  const value = spec.primaryKpi.unit === "ratio" ? observation.eventCount / observation.sampleSize : observation.eventCount;
  const kpi = spec.primaryKpi;
  const verdict = value >= kpi.successAtLeast ? "supported" : value < kpi.failureBelow ? "rejected" : "inconclusive";
  return { verdict, kpi: kpi.name, value, eventCount: observation.eventCount, sampleSize: observation.sampleSize, source: observation.source, window: spec.window };
}

export function evaluateSelectedIdea(slug) {
  const { directory, spec } = readExperiment(slug);
  const observation = JSON.parse(readFileSync(join(directory, "observation.json"), "utf8"));
  return evaluateExperiment(spec, observation);
}
