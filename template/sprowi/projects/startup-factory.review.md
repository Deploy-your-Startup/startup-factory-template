# Review instructions for idea files

You are the reviewer, not the author. A structural check already passed, so
every file has the right shape. Shape is not substance — judge that.

Report only problems you can point at, each with a concrete fix, and name the
rule. Findings do not block the run; they travel with the pull request, so a
vague one wastes a round and helps nobody.

## Problem

- The problem is somebody's actual problem, described from their side, not a
  feature looking for a justification.
- It is a problem this portfolio already has evidence for, or the idea says
  plainly that the evidence is missing.
- Use `Problem` as the rule.

## Smallest test

- It is genuinely small: days, not months, and it needs no new infrastructure,
  no new service and no budget approval.
- It tests the assumption rather than building the finished thing in miniature.
  "Ship the feature to 10 percent of users" is usually not the smallest test.
- Use `Smallest test` as the rule.

## Assumption

- It could turn out false, and the idea says what would count as false.
- Preferably a number or a threshold, so the answer is not a matter of opinion.
- If the assumption cannot fail, it is a plan, not an assumption.
- Use `Assumption` as the rule.

## Fit and distinctness

- The idea belongs to a project in `projects.yaml`, or says which new one it
  would need. An idea for a business this portfolio is not in is out of scope.
- It is meaningfully different from the other ideas in this batch and from
  everything already in `ideas/`. Different wording for the same bet is a
  duplicate even when the structural check let it through.
- Use `Fit` as the rule.
