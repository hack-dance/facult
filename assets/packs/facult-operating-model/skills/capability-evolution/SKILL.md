---
description: Convert repeated writeback into concrete fclt capability proposals.
tags: [facult, evolution, writeback]
---

# capability-evolution

## When To Use
Use this skill when the same missing guidance, weak loop, or recurring win appears often enough that the AI system itself should probably change.

Do not wait for a human operator by default if the signal is already clear and the environment permits local AI runtime state to be updated.

Use writeback first when the signal is useful but not yet repeated. Use evolution when accumulated writebacks, repeated tool friction, or a clearly missing capability point at a specific target asset or new capability.

The goal is a governed feedback loop: work creates evidence, evidence produces writeback, repeated writeback becomes a small reviewed proposal, and accepted proposals change future agent behavior.

## Scope Decision

Choose `project` when the behavior depends on repo-local architecture or workflow.

Choose `global` when the behavior is broadly reusable.

If unsure, start at project scope and promote later with evidence.

Reject global scope when the proposal depends on private examples, one repo's architecture, a single user's temporary preference, or a workflow that has not repeated.

## Working Flow

1. Harvest the review window from work logs, commits, runbooks, tool notes, and task-system changes.
2. Reconcile each source signal to a writeback, implementation task, local asset, or explicit exclusion.
3. Group or summarize repeated signal by asset, kind, and scope.
4. Run a read-only evolution assessment for the target when possible.
5. Check the current target asset before proposing a change.
6. Choose the smallest valid proposal kind and draft it.
7. Accept only after the target and scope are correct.
8. Apply only when the markdown target is the intended canonical asset.
9. Verify the producing loop and grade effectiveness before resolving source writebacks.

Use:

```bash
fclt ai review reconcile --since <window-start> --until <window-end> --json
fclt ai writeback add ...
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
fclt ai evolve assess --asset <selector> --json
fclt ai evolve propose
fclt ai evolve draft EV-00001
fclt ai evolve draft EV-00001 --append "tighten the rule with a concrete verification step"
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
fclt ai writeback link WB-00001 --issue TEAM-123
fclt ai writeback disposition WB-00001 --type task --target TEAM-123
fclt ai evolve verify EV-00001 --effectiveness improved --evidence test:post-apply
fclt ai loop activity --json
fclt ai loop resolve <activity-action-locator> --json
fclt ai loop decide <activity-action-locator> --decision accept \
  --expected-revision <queue-revision> --actor <actor-id> \
  --approval-ref <source-approval-ref> --approve --json
```

For an explicitly enabled scheduled loop, use:

```bash
fclt ai loop enable --project
fclt ai loop status --project --json
fclt ai loop run --project --json
fclt ai loop disable --project
```

Treat the durable full queue as the source of truth and the notification delta
as a noise-control view. Scheduler registration alone is not proof of a run;
check observed execution health. The loop may prepare writebacks and proposals,
but canonical apply remains plan-only and external task mutation remains a
separate approved integration.

For a signal-family activity item, resolve its opaque locator before recording
an operator decision. Record `accept`, `redirect`, `reject`, or `defer` only
with explicit source approval and the exact current queue revision. The receipt
is durable handoff evidence, not implementation authority: accepted work still
belongs in the external task/orchestration system, and fclt must not edit Git,
trackers, canonical capability, or spawn work on the receipt's behalf. Refresh
activity after any stale, replayed, moved-root, or duplicate-identity refusal.

The writeback queue alone cannot prove an empty window. Run configured source
reconciliation first and preserve its coverage, exclusions, correlations,
linked work, and dispositions. If any source is stale or unavailable, report a
degraded review rather than "nothing pending." Implementation tickets remain
evidence and task targets; do not turn each ticket into a capability proposal.

Applying is not completion. Preserve baseline friction, expected behavior, the producing loop,
implementation tickets, verification evidence, and an effectiveness grade. A recurrence after
apply is `unchanged` or `regressed` evidence for the same evolution, not a new singleton.

For manually scaffolded background review templates, use:

```bash
fclt templates init automation learning-review
fclt templates init automation evolution-review
fclt templates init automation tool-call-audit
```

If there is not yet enough repeated signal for evolution, do not stop at a bare "no". Explain what evidence would change the decision, whether another writeback should be recorded, and the smallest future target if the pattern repeats.

Do not create a proposal only to preserve an idea. Preserve the idea as writeback, notes, or task tracking unless it has enough evidence to change capability.

## Proposal Kind Selection

- `update_asset` for tightening existing guidance
- `create_asset` for missing instructions or docs
- `extract_snippet` for reusable partial guidance
- `add_skill` for reusable workflow instruction
- `promote_asset` for project-to-global promotion

Use task tracking instead of evolution when the main work is an executable tool or product fix that needs an owner, priority, state, or delivery plan. Use evolution for the reusable instruction, skill, or operating-model change that should survive that fix.

## Review Criteria

Before accept/apply, verify:

- evidence is repeated or the missing capability is obvious
- the proposal targets the smallest affected unit
- project/global scope is correct
- private or project-specific examples are not leaking into global assets
- the patch changes canonical markdown assets, not generated runtime state
- the resulting behavior can be verified by reading, rendering, indexing, or running the relevant command

## Output Contract
- repeated signal
- proposed asset change
- target scope
- evidence
- smallest useful next step
- approval or no-op rationale
- next evidence to collect when no proposal is justified
- exact read-only and mutating commands, with approval boundaries
