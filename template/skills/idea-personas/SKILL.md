---
name: idea-personas
description: Use ONLY when working with startup-factory and the owner wants to judge an idea in ideas/ before testing it — "pressure-test this idea", "think in personas", "is this worth testing", or before `sprowi select`. Writes the idea's `## Personas` section and a verdict.
---

# Idea personas

Judge one idea from `ideas/` through the people it depends on before anyone
builds or tests it. The result is the idea's `## Personas` section, which
`scripts/sprowi.sh select` requires before it creates an experiment.

The point is not a better document. It is to drop weak ideas within minutes
and to make the smallest test name real people to contact. Keep the session
to about fifteen minutes.

## Personas are hypotheses, not evidence

Simulated people cannot tell you what real people will do. Never count a
persona's agreement as demand. A persona's objection is worth something: it
names what the smallest test must disprove. Only the experiment decides.

## The session

1. Read the idea. If the owner did not name one, ask which. When the idea is
   for an existing startup, read its `projects/startups/<name>/docs/product.md`
   first: argue from who it serves and what it does today, and say when the
   idea contradicts that description.
2. Name the three roles from `## Problem`. Keep them separate unless the idea
   truly makes them one person:
   - **User** — who has the problem and would use the product,
   - **Buyer** — who decides to adopt it,
   - **Payer** — whose money pays for it, or "nobody yet" if it is free.
3. Speak as each role in turn, in character and briefly. For each, settle:
   what they do today instead, the main reason they would say no, and where the
   owner can find six of them within three days.
4. Add one outside voice per round — the incumbent or status quo, a skeptic of
   the distribution route, or someone checking willingness to pay. Give it a
   name and turn its strongest objection into the next question for the owner.
5. Ask one question at a time. Do not praise the idea. Push on vague answers
   until they name a person, a place or a number.

Stop when the roles are settled or the idea falls apart, whichever comes first.

## The result

Write or replace this section in the idea file, in the owner's language:

```markdown
## Personas

- **User:** <who> — today: <current workaround> — no because: <main objection> — find them: <concrete place>
- **Buyer:** <same as user, or who> — …
- **Payer:** <who, or nobody yet> — …
- **Verdict:** test | sharpen | drop — <one sentence why>
```

- **test** — the roles are clear and reachable. Update `## Smallest test` so
  it recruits the user persona from the named place, and turn the strongest
  objection into the condition in `## Assumption` if it is not there yet.
- **sharpen** — a role is unclear or unreachable. Say what must change; the
  owner edits the idea and runs this again.
- **drop** — the idea does not survive. Say so plainly; that is a good
  outcome. Leave the file as a record unless the owner deletes it.

Run `node scripts/check-ideas.mjs` afterwards. With a `test` verdict, the next
step is `scripts/sprowi.sh select <idea> <slug>` and the experiment plan in
`docs/sprowi.md`; `select` copies the user persona into the plan's audience.
