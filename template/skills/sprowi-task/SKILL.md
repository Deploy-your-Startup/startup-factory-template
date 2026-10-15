---
name: sprowi-task
description: Use ONLY when working with startup-factory and the user wants Sprowi to do the work — write a task for a startup, generate ideas, or set a project up for the loop. Covers what makes a task worth running and when to do it by hand instead.
---

# Sprowi tasks

This skill is specific to the `startup-factory` hub repo. It is about writing
the *input* for Sprowi, not about running it: the commands are in `AGENTS.md`,
the mechanics in `docs/sprowi.md`. Read `docs/sprowi.md` before changing anything
about how the loop works.

Sprowi turns a task document into a verified patch. The agent works in a Docker
Sandbox microVM; a second sandbox with no credentials applies the patch to a
clean checkout and runs the project's own checks. A run costs real money and
several minutes, so a bad task document is the expensive mistake here.

## When not to use it

Say so plainly instead of running the loop:

- A change you could make in a minute. Setup alone takes longer.
- Anything under `deployment/`, `.github/`, `make.sh`, `mise.toml`, lockfiles
  or Dockerfiles. Those are protected paths; the patch is rejected whole.
- Work that needs a running service, a browser, a real database with real data,
  or credentials. The verifier sandbox has none of that.
- Anything where you cannot say what "done" looks like as a command.

## Before the first run on a project

```bash
scripts/sprowi.sh init <project>     # derives checks from the project's mise tasks
scripts/sprowi.sh check <project>    # do they pass on an untouched checkout?
```

`acceptanceCommands` in `sprowi/projects/<project>.json` is the **only** thing
that decides whether a patch counts as verified. Read what `init` wrote before
trusting it:

- It only sees tasks declared in the project's `mise.toml`. A service whose
  `make.sh` answers `lint` without a matching task stays unchecked.
- A thin set makes "verified" mean very little. a project without frontend tests
  verifies a frontend change through lint alone — say that to the user
  rather than letting the green result imply more than it means.
- Run `check` before the first real run. A command that already fails on an
  untouched checkout burns a round on something the agent did not cause.

## Writing the task

`task.md` is the only required document. Write it for someone who has never
seen the conversation that produced it.

- One sentence that says what should be true afterwards, then the details.
- An **Out of scope** section. It is what keeps a small change small, and the
  reviewer checks the change against it.
- Name the files or areas involved when you know them. The agent has the whole
  checkout, but a task that says where to look converges in fewer rounds.
- Do not describe the solution step by step unless the approach is the point.
  The verifier decides correctness; over-specifying wastes the model's judgement.

Add `acceptance-tests.md` when behaviour is being changed. That is the
difference between a feature and an idea:

- With it, each scenario is `- GIVEN …`, `- WHEN …`, `- THEN …` and the
  reviewer checks that every scenario has a test covering it.
- Without it, only the project's checks decide, and the reviewer judges scope
  and the project's own rules.

## Choosing engine and model

- `--model` matters more than `--engine`. The default is Haiku, which is right
  for mechanical work. Pass `--model claude-sonnet-5` when the task needs
  judgement — anything open-ended, and every idea run.
- `--engine codex` runs on the ChatGPT subscription rather than per-token
  billing, and reports no cost at all. Prefer it when the plan quota is the
  cheaper resource; prefer claude when the user wants to see what a run cost.
- `--rounds 1` for a smoke test. Leave the default for real work: round two is
  where the feedback from a failed check gets used.

## Ideas

```bash
scripts/sprowi.sh ideas                  # startups the portfolio does not have yet
scripts/sprowi.sh ideas --for <project>  # ideas for one that exists
```

The brief is generated, so this is one command. Idea runs always target the hub
because the files land in `ideas/`, and `scripts/check-ideas.mjs` replaces the
project's checks: it refuses ideas without a stated problem, without a cheapest
way to find out, or without an assumption that could turn out false.

Nothing verifies that an idea is *good*. Present the result as a shortlist to
judge, never as a decision.

## After a run

`sprowi/runs/<project>/<timestamp>/` holds `result.json`, `result.patch` and
`usage.json`. Without `--publish` nothing leaves that directory: the patch is
not applied, so tell the user where it is or apply it for them.

Report the outcome as it is. `verified-with-findings` means the checks passed
and the reviewer still objected — the findings belong in the summary, not
buried. A run that ended because the budget ran out is not a verdict on the
change.
