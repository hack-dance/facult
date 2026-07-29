# Writeback and Evolution

This is the core fclt loop. Writeback preserves useful signal from real work. Reconciliation proves
which configured sources were checked. Evolution turns repeated evidence into reviewable changes,
and outcome verification decides whether those changes worked.

Use this when normal work exposes the same problem more than once: shallow tests, missing context, stale guidance, a slow tool path, or a missing skill. Ignore it for one-off preferences and vague complaints.

It is not a ticket generator. Implementation tickets can remain linked evidence, targets, and
outcome proof without becoming one capability proposal per ticket. External work systems are
optional inputs; the loop remains useful with local writebacks, Git, logs, and Markdown alone.

For a new CLI or Codex-plugin install, initialize the whole loop first:

```bash
fclt setup
fclt doctor --json
```

The doctor report's `loop` object is the readiness contract. Optional external
integrations never count as successful source coverage unless their exported
evidence is explicitly configured and checked.

## Scheduled closed loop

Scheduling is explicit opt-in:

```bash
fclt ai loop enable --project
fclt ai loop status --project --json
fclt ai loop run --project --json
```

The controller owns only the Codex automation it creates. It keeps a
machine-local full queue and append-only audit log, while its notification
delta includes only new, changed, and resolved items. A registered scheduler
does not prove execution; status reports whether a successful loop run has
never been observed, is healthy, or is stale. Disable scheduling without
deleting history with `fclt ai loop disable --project`.

The loop can turn complete, correlated source evidence into targeted
writebacks and reviewable proposals. It does not apply canonical changes or
mutate external trackers. Project auto-apply is reported as plan-only until
fclt has hash-bound preconditions, validation, atomic rollback, and a durable
receipt. Global and plugin changes always remain proposal-only.

## Automatic source reconciliation

Manual writeback remains useful, but it is no longer the only source of review
signal. Setup creates `reconciliation.json` in the selected canonical root.
Run a bounded review window before deciding that nothing is pending:

```bash
fclt ai review status --json
fclt ai review reconcile \
  --since 2026-07-03T00:00:00Z \
  --until 2026-07-10T23:59:59Z \
  --json
```

The adapter contract supports explicit writebacks, Git commits and canonical
asset changes, vendor-neutral evidence exports, automation memory/log files,
and configured Markdown logs, runbooks, or research. Defaults are read-only:
reconciliation does not edit issue trackers, Git, automation state, canonical assets,
writebacks, or proposals.

A project configuration can opt into additional sources without storing
credentials:

```json
{
  "version": 1,
  "sources": [
    { "id": "writebacks", "type": "writebacks", "scope": "global" },
    {
      "id": "git",
      "type": "git",
      "repository": "project",
      "defaultBranch": "main",
      "freshnessThresholdHours": 168,
      "paths": [".ai", "AGENTS.md", "docs"]
    },
    {
      "id": "external-work",
      "type": "evidence-export",
      "path": "reconciliation/evidence.json"
    },
    {
      "id": "runbooks",
      "type": "markdown",
      "root": "project",
      "paths": ["notes/capability-review-log.md", "research/agent-findings.md"]
    },
    {
      "id": "automation-memory",
      "type": "automation",
      "root": "home",
      "paths": [".codex/automations/**/memory.md"]
    }
  ]
}
```

Evidence exports use a versioned manifest whose coverage window must contain
the requested review window:

```json
{
  "version": 1,
  "producer": "example-tracker-exporter",
  "generatedAt": "2026-07-11T00:05:00Z",
  "coverage": {
    "since": "2026-07-03T00:00:00Z",
    "until": "2026-07-10T23:59:59Z",
    "complete": true
  },
  "events": [
    {
      "id": "event-123",
      "kind": "status-change",
      "observedAt": "2026-07-08T14:30:00Z",
      "body": "Implementation completed",
      "refs": ["EXAMPLE-123"],
      "status": "done"
    }
  ]
}
```

File patterns must stay inside the selected project or home root; symlink and
path traversal escapes are rejected. The evidence adapter reads only a local
file and performs no network or credential access. A separate plugin or
user-owned exporter can produce that file from any external system.
Missing exports, missing logs, stale sources, and adapter failures produce
degraded coverage instead of a false empty result.

Coverage and cursor freshness are separate contracts. `coverageComplete`
means every configured source proved the requested window; it does not mean a
stored source cursor is current. JSON, persisted reports, and readable review
artifacts expose a typed `freshness` state independently for each source and
for the review overall. A cursor becomes stale only when its configured
`freshnessThresholdHours` is exceeded (168 hours by default) or a bounded Git
check finds newer activity on the configured default branch. Newer repository
activity is checked independently of `paths`, so a complete path-filtered scan
cannot mask a frozen Git cursor. An unchanged stale queue item is suppressed
after its first notification.

Terminal evidence-export statuses (`done`, `completed`, `canceled`,
`obsolete`, `duplicate`, and their supported aliases) resolve a linked signal
family when the bounded export proves all linked work terminal. Git evidence
resolves a family only when the exact commit or equivalent patch is contained
on the configured default branch. Both paths preserve source provenance and
remain read-only; they do not close tracker work, edit Git, or apply proposals.

Configure file sources narrowly around append-only logs, dated runbooks, or
research streams that represent review evidence. Date section headings as
`## YYYY-MM-DD ...` so one file can prove which observations belong to the
requested window. For an undated Markdown file, fclt must use the file's
modification time for every section; broad patterns such as `notes/**/*.md`
can therefore surface old material whenever any matched document is edited.
Symlinks that leave the configured root and files above the safety limit
degrade coverage rather than being silently skipped.

Machine-local state stores per-source watermarks/cursors, dedupe history,
extraction decisions, and deterministic review-window JSON. Human-readable
mirrors live under `~/.ai/reconciliation/global/` or
`~/.ai/reconciliation/projects/<slug-hash>/`. Exact reruns reuse the completed
window; overlapping windows resume from source watermarks with a tie overlap.

Every discovered signal is classified as `implementation-only`,
`capability-source`, `capability-implementation`, `outcome-proof`, or `noise`.
Included signals receive exactly one disposition: `propose`, `apply-local`,
`task`, `resolve-watch`, or `defer`. Tickets remain linked evidence and task
targets rather than becoming one capability proposal per ticket.

Use this loop when a task exposes durable friction:

1. record one targeted writeback
2. group or summarize related writebacks
3. propose only when the evidence repeats or a missing capability is obvious
4. draft the smallest valid proposal
5. review, accept, and apply when the change is safe
6. verify whether the producing loop improved before resolving the source signal

## Writeback

Record writeback when the signal is durable and targetable:

```bash
fclt ai writeback add \
  --kind weak_verification \
  --summary "Checks were too shallow" \
  --category friction \
  --details "The source check did not exercise the installed launcher" \
  --impact "Packaging could fail after a source-only green result" \
  --attempted-workaround "Ran the built launcher directly" \
  --desired-outcome "The supported check covers the installed path" \
  --sensitivity internal \
  --evidence test:installed-launcher \
  --asset instruction:VERIFICATION
```

Use the structured fields only for concise, observable context:

- `category`: `friction`, `opportunity`, or `reusable-success`
- `details`: what happened and in what bounded context
- `impact`: why it mattered
- `attempted-workaround`: what was tried, if anything
- `desired-outcome`: what better behavior looks like
- `sensitivity`: `public`, `internal`, or `private`

This is not a reasoning transcript. Never record hidden chain-of-thought, raw
session transcripts, unbounded logs, secrets, tokens, or credential-bearing
payloads. Keep logs in their source system and store a small redacted evidence
reference. Secret-shaped content is redacted at capture regardless of
sensitivity. `private` retains the actionable summary while omitting
supplemental context from portable review surfaces.

Useful kinds:

- `weak_verification`
- `false_positive`
- `missing_context`
- `reusable_pattern`
- `capability_gap`
- `bad_default`

Avoid writeback for one-off preferences, vague complaints, or speculative ideas.

Link implementation work and preserve the review disposition:

```bash
fclt ai writeback link WB-00021 --issue TICKET-791
fclt ai writeback disposition WB-00021 \
  --type task \
  --target TICKET-791 \
  --expected-outcome "The producing loop stops repeating unchanged blocker prose" \
  --next-trigger "Implementation ships and the next review window completes"
```

Issue links are evidence and routing destinations, not capability assets. Group tickets by the
underlying friction or reusable success rather than creating one writeback per ticket.

## Activity

Read the latest completed loop in plain language:

```bash
fclt ai loop activity
fclt ai loop activity --json
fclt ai loop activity --project --json
```

The default versioned JSON is a portable, read-only activity set across Global
and every configured project loop. It includes aggregate counts and scope
health, then keeps the per-scope feeds intact for filtering and origin labels.
Use `--global` or `--project` for a single feed. It contains source coverage,
new/changed/resolved counts, correlated observations, decisions, linked work,
approvals, verification state, and the next action.
The aggregate is contract version 2 and joins each version 1 feed to a stable
opaque scope id. Check its `truncation` object before treating the returned item
list as exhaustive.
Actionable items may include an opaque `actionLocator`. Resolve it with
`fclt ai loop resolve <locator> --json` to obtain a read-only plan for the
verified current scope and resource. Missing locators remain handoff-only;
consumers must never infer roots from scope labels or internal ids.
Each item also identifies its global or project context, typed capability
targets such as an instruction, skill, prompt, or automation, the reason for
the decision, and bounded HTTP(S) evidence links when the source supplied one.
Private evidence, credential-bearing or query-bearing URLs, and URL fragments
are omitted. It does not invent tracker links or contain absolute machine
paths. Each
plain-language item keeps the same context visible:

```text
Activity — example-service
- Setup guidance missed the isolated test harness
  friction · approval_needed · propose
  Why: Repeated evidence points to one project setup gap.
  Target: instruction · SETUP (@project/instructions/SETUP.md)
  Source: example.com · https://example.com/reviews/123
  Next: Review the proposed capability direction; approve, redirect, or defer it explicitly.
```

Each activity snapshot is embedded in its loop report, so a later writeback or
proposal transition cannot rewrite an
older run. Unchanged queue items are suppressed from change counts, while stale
or unavailable sources remain visible. A complete empty run means configured
coverage was checked; degraded or failed empty runs never claim that nothing is
pending.

## Evolution

Review accumulated signal:

```bash
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind
fclt ai evolve assess --asset instruction:VERIFICATION --json
fclt ai evolve propose
fclt ai evolve list
```

Use `assess` as the read-only gate for agent-led review UI. It returns a
recommendation (`reconcile_sources`, `review_reconciled_signals`,
`no_mutation`, `record_more_writeback`, `propose`, or
`review_existing_proposal`), source writeback ids, reconciliation coverage and
signal ids, active proposal ids, a quality checklist, suggested commands, and
the next agent instruction.

For a single weak or medium-confidence writeback, the right answer is usually more evidence, not a proposal. A useful no-op still explains what recurrence would change the decision and where the next writeback should land.

Draft and review:

```bash
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
fclt ai evolve verify EV-00001 \
  --effectiveness improved \
  --evidence test:post-apply-regression \
  --note "The producing loop no longer repeats the failure"
```

Applying a proposal moves its source writebacks into an awaiting-verification state. Verification
then records one of `improved`, `unchanged`, `regressed`, or `inconclusive`. Improved evidence
resolves the writebacks; unchanged or regressed evidence returns them to the pending queue;
inconclusive evidence keeps them under watch.

Apply also records a verification window, baseline, expected criteria, due
date, grace period, and attempt history. The scheduled loop marks verification
as pending, due, or overdue. Unchanged or regressed evidence reopens the same
proposal family and can request that linked implementation work be reopened;
it does not create a duplicate proposal or directly update the task system.

Proposal creation does not promote source writebacks. Rejecting a proposal restores any legacy
promoted source writebacks to pending. Draft revisions for append-style proposals are included in
the actual target patch, not only in review history.

Supported durable proposal kinds include:

- `update_asset`
- `create_asset`
- `extract_snippet`
- `add_skill`
- `promote_asset`

Use the smallest kind that solves the repeated problem.

## Scope

Use project scope for repo-specific tooling, tests, architecture, and workflows.

Use global scope for shared doctrine, reusable skills, shared agents, or cross-project capability gaps.

Promote project proposals to global only after repeated reuse:

```bash
fclt ai evolve promote EV-00003 --to global --project
```

## Review Artifacts

Runtime JSON queues, proposal metadata, draft patches, and journals stay in machine-local `fclt` state.

Human-readable Markdown mirrors live under global `~/.ai`:

```text
~/.ai/writebacks/global/
~/.ai/writebacks/projects/<slug-hash>/
~/.ai/evolution/global/
~/.ai/evolution/projects/<slug-hash>/
~/.ai/reconciliation/global/
~/.ai/reconciliation/projects/<slug-hash>/
```

Project-scoped artifacts include project metadata in frontmatter. They do not get written into repo-local `<repo>/.ai/writebacks` or `<repo>/.ai/evolution`.

## Approval Rule

Global instructions, skills, plugins, and other high-risk shared surfaces require explicit review before apply. Project-scoped additive markdown changes can be lower risk, but still need evidence and a clear target.

Executable product or tooling work belongs in the task system. Use evolution for the reusable instruction, skill, prompt, or operating-model change that should survive that work.

## Next

- Read [Composable Capability](./composable-capability.md) to choose the smallest target.
- Read [Automations](./automations.md) to schedule recurring review loops.
- Read [Security and trust](./security-trust.md) before applying global changes.
