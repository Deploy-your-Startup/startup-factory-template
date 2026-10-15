#!/usr/bin/env node

// The verifier for idea files. It cannot tell a good idea from a bad one —
// nothing can, mechanically. What it can do is refuse the shapes that make an
// idea impossible to judge: no stated problem, no cheapest way to find out, no
// assumption that could turn out false, or the same idea proposed twice.
//
// Everything it rejects, it rejects with the fix in the message, because that
// message becomes the agent's feedback for the next round.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIRECTORY = "ideas";
const FILENAME = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SECTIONS = ["Problem", "Smallest test", "Assumption"];

// Splitting on the headings beats a lookahead regex: JavaScript has no \Z, so
// the obvious pattern silently fails to match the last section of a file.
function sections(text) {
  const found = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      found.set(current, []);
      continue;
    }
    if (current) found.get(current).push(line);
  }
  return new Map([...found].map(([name, lines]) => [name, lines.join("\n").trim()]));
}

const problems = [];

// An empty directory is not an error here: a round that produced nothing is
// already rejected as an empty patch, and this check also runs on an untouched
// checkout, where there is legitimately nothing yet.
const files = existsSync(DIRECTORY)
  ? readdirSync(DIRECTORY).filter((name) => name.endsWith(".md") && name !== "README.md")
  : [];

const titles = new Map();

for (const file of files.sort()) {
  const path = join(DIRECTORY, file);
  const where = (message) => problems.push(`${path}: ${message}`);

  if (!FILENAME.test(file)) {
    where("the name must be <three digits>-<lower-case-slug>.md, for example 007-weekly-digest.md");
    continue;
  }

  const text = readFileSync(path, "utf8");
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!title) {
    where("the first line must be a `# ` heading naming the idea in one sentence");
    continue;
  }

  const seen = titles.get(title.toLowerCase());
  if (seen) {
    where(`the same idea already exists as ${seen}. Drop it or sharpen it into something the other one does not cover.`);
  } else {
    titles.set(title.toLowerCase(), path);
  }

  const parts = sections(text);
  for (const section of SECTIONS) {
    const body = parts.get(section);
    if (body === undefined) {
      where(`a \`## ${section}\` section is missing`);
    } else if (body.length < 40) {
      where(`\`## ${section}\` is too thin to judge: say it in a sentence or two, not a fragment`);
    }
  }

  // An assumption nobody could ever disprove is decoration, not an assumption.
  // This is a blunt proxy — it only catches the laziest phrasings.
  const assumption = parts.get("Assumption") ?? "";
  if (assumption && !/\b(if|unless|would|only|at least|fewer|more than|within|per)\b/i.test(assumption)) {
    where("`## Assumption` reads like a statement of intent. Name something that could turn out false, with a number or a condition in it.");
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}

console.log(`${files.length} idea file(s) in ${DIRECTORY}/ are well formed.`);
