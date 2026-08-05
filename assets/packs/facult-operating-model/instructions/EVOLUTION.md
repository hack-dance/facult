---
description: Turn repeated signal into concrete capability changes.
tags: [facult, evolution, writeback]
---

# Evolution

Use writeback and evolution to improve the AI operating layer itself.

Evolution is the synthesis and change side of the feedback loop. It turns accumulated writebacks, repeated tool friction, stale canonical assets, or clearly missing capability into small reviewable changes to instructions, skills, snippets, agents, or other markdown canonical assets.

Use capability composition when choosing the target. Instructions, snippets, skills, agents, MCP/tool config, and automations are separate units. Target the smallest unit that actually needs to change instead of rewriting a broad agent doc.

## When To Record Writeback

Record writeback when one of these is true:

- the same failure repeats
- the same success pattern repeats
- guidance is stale or missing
- a prompt or loop has to be restated often
- a project-specific pattern looks reusable

Do not record low-signal noise:

- one-off annoyance with no reuse value
- generic "could be better" commentary
- duplicate observations with no new evidence

The intended default is that agents record strong writebacks themselves when the signal is clear enough, rather than only recommending that a user do it manually later.

Do not wait for a weekly review to preserve high-signal evidence. Do wait for repeated evidence or a clearly missing capability before drafting a proposal.

## Scope

Choose `project` scope when the learning depends on:

- repo architecture
- team workflow
- project tooling
- local testing or verification behavior

Choose `global` scope when the learning is reusable across projects.

Promote from project to global only after repeated reuse or strong evidence.

## Writeback Kinds

Common kinds:

- `weak_verification`
- `false_positive`
- `missing_context`
- `reusable_pattern`
- `capability_gap`
- `bad_default`

Every good writeback should try to include:

- a concrete summary
- the best target asset if known
- the right scope
- domain or tags when useful

Good target examples:

- `instruction:LANGUAGE` when shared language/tooling guidance is stale or missing
- `@project/instructions/TESTING.md` when repo test policy needs project-scoped evolution
- `snippet:global/policy/review` when a repeated rendered block should be fixed or extracted
- `skill:capability-evolution` when a workflow skill is missing steps or examples
- `automation:evolution-review` when the scheduled review loop is noisy or incomplete

## Operator Flow

Typical workflow:

```bash
fclt ai writeback add --kind weak_verification --summary "Checks were too shallow" --asset instruction:VERIFICATION
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
fclt ai evolve assess --asset instruction:VERIFICATION --json
fclt ai evolve propose
fclt ai evolve draft EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
```

Use `fclt ai evolve draft <id> --append "..."` to revise a draft while preserving draft history.

Review surfaces:

- open `~/.ai/writebacks/` and `~/.ai/evolution/` in a Markdown editor for frontmatter-rich global and project-scoped review artifacts
- `fclt status --json` for queue/proposal paths, review artifact paths, counts, and active scope
- `fclt ai writeback list|show|group|summarize` for raw and clustered signal
- `fclt ai evolve assess` for read-only proposal readiness and the safest next action
- `fclt ai evolve list|show|review` for proposal state without applying changes
- `fclt templates init automation learning-review` for recurring capture/review
- `fclt templates init automation evolution-review` for recurring proposal review
- `fclt templates init automation tool-call-audit` for repeated tool-friction review

An operator may explicitly enable the coordinated closed loop with `fclt ai
loop enable --project` or `--global`. Use `fclt ai loop status --json` to check
both scheduler registration and observed successful execution. The durable
queue must retain unchanged and temporarily unobserved items; only the
notification delta should suppress noise.

Evolution proposal metadata, markdown drafts, patch artifacts, writeback queues,
and journals are runtime state. `fclt` stores JSON queues, proposal records,
draft refs, patches, and journals in machine-local `fclt` state. It mirrors
human-readable review artifacts into global `~/.ai/writebacks/...` and
`~/.ai/evolution/...`, including project-scoped artifacts under
`projects/<slug-hash>/` with cwd/project metadata in frontmatter. Canonical
assets in `~/.ai` or `<repo>/.ai` should only change when a proposal is applied.

## Default Agent Behavior

Use the smallest action that fits the signal:

1. record one strong writeback when there is a clear durable learning
2. use `writeback-curator` when the target, kind, or scope is ambiguous
3. run `fclt ai evolve assess --asset <selector> --json` before proposing when a target is known
4. use `capability-evolution` or `evolution-planner` when repeated signal should become a proposal
5. do not draft or apply proposals just because a writeback exists; require repeated evidence or a clearly missing capability

When assessment recommends no mutation or more writeback, agents should still produce a useful review: state the current target, evidence grade, missing signal, exact recurrence that would justify evolution, and any read-only follow-up. Do not end with only "no proposal".

Avoid creating writeback/evolution noise for one-off nits, vague preferences, or speculative ideas without evidence.

When the friction is executable product/tooling work that needs ownership,
priority, state, or implementation follow-through, create or update a real task
system item instead of forcing it into capability evolution. Use evolution for
the reusable operating-layer change.

## Proposal Kinds

Current supported proposal kinds:

- `update_asset`
- `create_asset`
- `extract_snippet`
- `add_skill`
- `promote_asset`

Use the smallest durable change that fits the evidence.

Examples:

- `update_asset`: fix a stale instruction, snippet, agent, or automation markdown asset.
- `create_asset`: add a missing instruction such as `LANGUAGE.md` or `REVIEW.md`.
- `extract_snippet`: move repeated guidance out of several docs into one snippet.
- `add_skill`: create a workflow when instructions are not enough.
- `promote_asset`: move a proven project instruction/snippet/skill toward global reuse.

## Review And Apply Rules

- draft before apply
- accept before apply
- prefer the smallest safe change
- keep reviewable evidence tied to source writebacks
- do not globalize project behavior too early
- do not apply high-risk global instruction, skill, plugin, or shared-tool changes without explicit review/approval

Apply is for markdown canonical assets only. If the target is wrong, revise the proposal rather than forcing it through.

Scheduled review does not weaken the approval boundary. It may reconcile
read-only sources, record targeted writebacks, draft proposals, and report a
vendor-neutral request to reopen linked implementation work. It must not
mutate an external tracker or automatically apply canonical changes. Treat
project auto-apply as plan-only until a hash-bound transaction, validation,
rollback, and durable receipt exist; keep global and plugin changes
proposal-only.

Signal-family decisions are a separate machine-local lifecycle. Resolve the
current opaque activity locator, then record `accept`, `redirect`, `reject`, or
`defer` only with explicit approval and the exact queue revision. The append-only
receipt preserves bounded work-unit context but does not apply capability,
mutate Git or an external tracker, spawn a task, or grant authority beyond the
recorded decision. Current-source completion may close already-landed families;
hold/defer remains visible and unimplemented. Treat coverage completeness and
cursor freshness as independent review facts.
