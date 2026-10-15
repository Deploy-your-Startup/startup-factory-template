// What one round hands to the next: the problems it found, in the shape the
// agent reads, plus the bookkeeping that decides whether another round is
// worth paying for.

const OUTPUT_TAIL_LINES = 80;

export function outputTail(output, lines = OUTPUT_TAIL_LINES) {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

// A round either broke the patch policy, failed a check, or came back from the
// reviewer with findings. All three become the same document.
export function feedbackDocument(round, maxRounds, problems) {
  const header = `# Feedback from round ${round} of ${maxRounds}\n\nYour changes are still in the workspace. Fix what is listed below and finish\nthe task; do not start over.\n`;

  if (problems.patchErrors) {
    return `${header}\n## The patch was rejected\n\n${problems.patchErrors.map((error) => `- ${error}`).join("\n")}\n\nRevert whatever touches a path you may not change, then implement the task\nwithin the allowed paths.\n`;
  }

  if (problems.checkFailure) {
    const { check, command, output } = problems.checkFailure;
    return `${header}\n## The check \`${check}\` failed\n\nCommand: \`${command}\`\n\nIts last ${OUTPUT_TAIL_LINES} lines:\n\n\`\`\`\n${output}\n\`\`\`\n\nThe check ran against a clean checkout with your patch applied, so it reflects\nyour change and nothing else.\n`;
  }

  if (problems.findings) {
    return `${header}\n## The checks passed, the review did not\n\n${problems.findings
      .map(
        (finding) =>
          `- **${finding.rule ?? "Finding"}**${finding.file ? ` (\`${finding.file}\`)` : ""}: ${finding.problem}\n  Fix: ${finding.fix}`,
      )
      .join("\n")}\n`;
  }

  return `${header}\nNo machine-readable problems were recorded.\n`;
}

// Two rounds that fail the same way will keep failing that way. The signature
// is coarse on purpose: the same check failing on a different line is still
// the same problem.
export function problemSignature(problems) {
  if (problems.patchErrors) return `patch:${problems.patchErrors.join("|")}`;
  if (problems.checkFailure) return `check:${problems.checkFailure.check}`;
  if (problems.findings) {
    return `review:${problems.findings.map((finding) => `${finding.rule}:${finding.file ?? ""}`).sort().join("|")}`;
  }
  return "unknown";
}

export function problemSummary(problems) {
  if (problems.patchErrors) return "the patch policy";
  if (problems.checkFailure) return `the check \`${problems.checkFailure.check}\``;
  if (problems.findings) return `${problems.findings.length} review finding(s)`;
  return "an unknown problem";
}

// The reviewer writes JSON. A reviewer that writes something else does not
// block the run: model reviews are not reliable enough to gate on their own.
export function parseReview(text) {
  if (!text) return null;
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof report?.pass !== "boolean" || !Array.isArray(report.findings)) {
    return null;
  }
  const findings = report.findings.filter(
    (finding) => finding?.problem && finding?.fix,
  );
  return {
    pass: report.pass && findings.length === 0,
    findings,
    scenarios: Array.isArray(report.scenarios) ? report.scenarios : [],
  };
}

export function sumUsage(engine, usages) {
  const total = {
    engine: engine.name,
    model: engine.model,
    reasoningEffort: engine.reasoningEffort ?? null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    steps: 0,
    calls: usages.length,
    limitReached: usages.some((usage) => usage.limitReached),
  };
  for (const usage of usages) {
    for (const key of [
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "totalTokens",
      "costUsd",
      "steps",
    ]) {
      total[key] += usage[key] ?? 0;
    }
  }
  return total;
}

// The limits cover a whole run, so every call gets what the earlier calls left
// over. Returns null once nothing is left.
export function remainingEngine(engine, usages) {
  const spent = sumUsage(engine, usages);
  const limits = { ...engine.limits };
  for (const [key, used] of [
    ["maxTotalTokens", spent.totalTokens],
    ["maxCostUsd", spent.costUsd],
  ]) {
    if (limits[key] === undefined) continue;
    limits[key] -= used;
    if (limits[key] <= 0) return null;
  }
  if (limits.maxAiCredits !== undefined) {
    limits.maxAiCredits -= Math.round(spent.costUsd * 100);
    if (limits.maxAiCredits <= 0) return null;
  }
  return { ...engine, limits };
}
