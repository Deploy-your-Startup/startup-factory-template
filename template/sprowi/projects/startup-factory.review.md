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

- It is a useful website or web app with one core flow that a solo owner can
  build and instrument within three days, using the Factory's supported
  templates and proposed deployment path. Avoid substantial infrastructure or
  a large service; state unknown costs/setup rather than assuming a budget.
- The plan explains how eligible users would receive its URL and what real
  use, return visits or payment would test the assumption. Paper/PDF checklists,
  consulting or interviews alone are not the main test; an interactive
  checklist can be a product feature. A landing page needs a clear offer/action
  and must acknowledge weaker evidence than actual use or payment.
- Plans describe future work. This run does not authorize implementation,
  deployment, outreach or spending.
- Use `Smallest test` as the rule.

## Assumption

- It could turn out false, and the idea says what would count as false.
- Preferably a number or a threshold, so the answer is not a matter of opinion.
- If the assumption cannot fail, it is a plan, not an assumption.
- Use `Assumption` as the rule.

## Fit and distinctness

- The idea belongs to an existing project or names a new one the owner could
  build and operate alone with a supported Factory stack. New markets are
  allowed; do not assume customer access, infrastructure or a budget.
- It is meaningfully different from the other ideas in this batch and from
  everything already in `ideas/`. Different wording for the same bet is a
  duplicate even when the structural check let it through.
- Use `Fit` as the rule.
