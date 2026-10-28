# Ideas

The one collection of ideas: one file per idea, `NNN-slug.md`, written by hand
or by `scripts/sprowi.sh ideas` and its daily schedule, which add three
proposals under the next free numbers and commit them. The format is
enforced by `scripts/check-ideas.mjs`, which is also what verifies a Sprowi run:

- `# ` heading — the idea in one sentence
- `## Problem` — whose problem, from their side
- `## Smallest test` — the cheapest thing that would tell you, in days
- `## Assumption` — what could turn out false, with a number or a condition

Before an idea becomes an experiment, the `idea-personas` skill judges it
through its user, buyer and payer and adds a `## Personas` section ending in a
verdict. `scripts/sprowi.sh select` only accepts ideas whose verdict is `test`.
Personas are hypotheses that sharpen the test, never evidence of demand.

Nothing here is a commitment. An idea earns a spike by having an assumption
worth testing, not by being written down.
