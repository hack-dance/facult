# Activity action locators

Aggregate activity can contain identical proposal, writeback, or signal ids in
more than one scope. An `actionLocator` lets a consumer ask fclt which exact
current target an item refers to without guessing a canonical root.

The CLI/JSON contract is authoritative:

```bash
fclt ai loop activity --json
fclt ai loop resolve <activity-action-locator> --json
fclt ai loop decide <activity-action-locator> \
  --decision accept \
  --expected-revision <queue-revision> \
  --actor <actor-id> \
  --approval-ref <source-approval-ref> \
  --approve --json
```

The Codex plugin exposes the read-only resolver as `fclt_registry` action
`activity_resolve` and the signal decision command as `activity_decide`. Both
use closed schemas. Neither accepts caller-supplied scope, cwd, root, path,
argv, endpoint, token, token-env, credential, or external mutation fields.

## Version 1 contract

`ActivityItem.actionLocator` is optional. Consumers must treat a missing
locator as read-only, handoff-only activity. This preserves compatibility with
older reports and with items for which fclt cannot issue a safe current action.

Version 1 locators use this opaque form:

```text
fclt-act-v1.<identity-digest>.<binding-digest>
```

Consumers must not decode, synthesize, alter, or route on either digest. The
identity digest binds the opaque aggregate scope id plus resource kind and
identity. The binding digest additionally binds the verified machine-local
runtime identity, latest activity run, queue revision, current resource
lifecycle revision, and one allowed action class.

The runtime identity is an opaque UUID persisted in the machine-local loop
configuration. fclt pairs it with a hash of the verified canonical root's
realpath and filesystem instance identity. Replacing a checkout at the same
path, copying runtime state, or redirecting an ancestor through a symlink does
not preserve that binding.

The locator contains no root, path, command arguments, URL, endpoint, token,
token environment variable, credential, or external-system authority.

## Resolution and expiration

Resolution is read-only. fclt searches its preferred machine-local Global and
project runtime registry, verifies the canonical root and runtime-state relationship,
and recomputes the locator from current state. A project state directory cannot
redirect a locator to another clone, worktree, moved root, or project merely by
reusing an internal proposal id.

A locator is state-bound rather than time-bound. It expires when any bound
fact changes, including:

- the latest activity run or queue revision
- proposal or resource lifecycle state
- the allowed action class
- project/runtime identity or canonical-root registration
- locator schema compatibility

Alternate caller-configured Global roots are not discoverable without accepting
caller authority, so their items intentionally omit locators and remain
handoff-only.

Always resolve immediately before presenting an action plan, and resolve again
before any later lifecycle command. Refresh aggregate activity after any
rejection; never repair a locator or guess a root.

## Resolution result

A successful version 1 response returns:

- exact opaque scope id and safe Global/project context
- resource kind and id
- activity run id and queue revision
- the one currently allowed action class
- a plain-language plan
- an explicit statement that no mutation was performed
- an explicit `available: false` mutation state
- the requirements the separate signal decision command must satisfy: explicit
  approval and an atomic expected-binding revision check

The action classes are `review`, `decide`, `apply`, `verify`, and `handoff`.
They describe the safe next workflow class; they do not grant permission to
execute it.

## Signal decision lifecycle

`loop decide` records one decision for one currently issued signal-family
activity revision. It supports `accept`, `redirect`, `reject`, and `defer`.
The command requires all of these in one call:

- the unchanged opaque locator
- the exact current queue revision from resolution
- an explicit `--approve`
- a bounded actor identifier
- exactly one portable `--approval-ref` or bounded `--note`
- one `--redirect-target` only when the decision is `redirect`

fclt revalidates the locator, root identity, runtime identity, activity run,
queue revision, resource identity, and issued activity item under the
evolution-loop lock. It then atomically appends one machine-local version 1
receipt. Replaying the same binding is rejected. A later decision for the same
family requires a genuinely newer queue revision and advances the lifecycle
revision without rewriting prior history.

The durable receipt contains the exact opaque scope and signal-family id,
decision, actor, approval reference or note, previous and new lifecycle
revisions, activity run and queue revision, binding revision, and timestamp.
It contains no root or absolute private path. Accepted output also preserves
the activity item's bounded targets, evidence summary, linked work, expected
outcome, verification state, and next action so an external orchestrator can
construct a work unit.

Recording a decision does not edit canonical capability, update Git or a task
tracker, apply a proposal, spawn work, or grant implementation authority. In
particular, `accept` is a durable approval/handoff receipt, not execution.

## Fail-closed errors

| Code | Meaning | Recovery |
| --- | --- | --- |
| `invalid_locator` | The locator is malformed. | Refresh activity and use the returned locator unchanged. |
| `incompatible_locator` | The locator version is unsupported. | Update fclt or refresh with a compatible producer. |
| `locator_not_found` | No verified current scope/resource identity matches. This includes removed resources, missing state, moved or renamed roots, and cross-project replay. | Repair registration/state if appropriate, then refresh activity. |
| `stale_revision` | The activity run, queue revision, resource lifecycle, runtime identity, or allowed action class changed. | Refresh activity and resolve the new locator. |
| `duplicate_identity` | More than one verified current target matched. | Repair duplicate registration; fclt will not choose one. |
| `locator_not_issued` | Current state matches, but the current aggregate snapshot did not issue that locator. | Refresh activity and use only the returned locator. |
| `approval_required` | Explicit approval was omitted. | Obtain approval for the exact current signal and retry with `--approve`. |
| `invalid_decision_input` | Decision fields are malformed, unsafe, incompatible, or unbounded. | Use the closed command shape and one portable approval source. |
| `not_signal_family` | The locator identifies a proposal or coverage item. | Use the proposal lifecycle or source reconciliation instead. |
| `replayed_decision` | This binding or an equal/older queue revision already has a receipt. | Read the existing receipt or wait for a newer signal revision. |
| `malformed_history` | The bounded machine-local decision journal is corrupt or incompatible. | Inspect and repair that journal before retrying. |
| `decision_conflict` | The loop lock or journal changed during commit. | Refresh activity after the competing operation completes. |

## Mutation boundary

Resolution never reviews, accepts, rejects, applies, verifies, edits canonical
capability, writes project or tool-home files, changes workflow state, or
mutates an external system. Signal decision recording is the one narrow
locator-bound review mutation: it writes only the append-only machine-local
decision journal after explicit approval and stale-binding checks. Proposal
lifecycle, canonical apply, cross-scope mutation, task creation, Git, and
external systems remain separate and are never inferred from a locator.
