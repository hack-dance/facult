# Command reference

This page groups the main `fclt` commands by job. Use `fclt --help` and `fclt <command> --help` for exact flags.

## Discovery

```bash
fclt setup [--include-project] [--no-codex-plugin] [--json]
fclt projects discover --root <path> [--root <path>] [--since <duration>] [--json]
fclt projects status [--root <path>] [--json]
fclt project init [--project-root <path>] [--guidance <path>] [--apply --plan-sha <sha>] [--json]
fclt project disable|ignore|inactive|remove [--project-root <path>] [--json]
fclt project rollback --receipt <id> [--apply] [--json]
fclt status [--json]
fclt doctor [--json] [--repair]
fclt paths [--json]
fclt scan [--from <path>] [--json] [--show-duplicates]
fclt inventory [--json] [--tool <name>] [--show-secrets]
fclt list [skills|mcp|agents|snippets|instructions|automations]
fclt show <selector>
fclt find <query>
```

Use `fclt setup` once after installation to bootstrap global capability,
review state, indexes, and optional Codex integration. It is idempotent and
does not initialize the current repository. `--include-project` adds an exact,
no-write enrollment plan. Use `projects discover` for bounded read-only
inventory, then `project init` preview/apply for one selected repository.
`doctor --json` is read-only and reports schema version 2 setup health, loop readiness, optional
integration degradation, legacy managed/autosync recovery coverage, and recommended actions.
`legacyRecovery.state` is `clear`, `contained`, `cleanup_required`, or `blocked`; cleanup is offered
only when config, launch-agent, and launchd ownership are proven for the selected root. Version 2
removes vendor-specific integration fields; external work systems participate through configured evidence exports. `paths --json`
reports canonical, generated, runtime, and review paths for agents and integrations.

Use `fclt doctor --repair` as the one-command self-heal path for local state.
It repairs legacy generated state, stale Codex authoring paths, explicit project
sync policy, invalid canonical global guidance, and missing Markdown review
artifacts. Destructive-looking canonical repairs keep a backup under
`.ai/.facult/backups/doctor/`.

`doctor` renders `AGENTS.global.md` in memory before judging it. That file is a
source template, so empty `fclty` blocks and `${refs.work_units}` placeholders
are valid when they render into filled, concrete tool guidance. `doctor` flags
the global docs only when the rendered output still has empty managed sections,
unresolved placeholders, or marker errors. It also checks direct-readable
instruction files for leaked `${refs.*}` placeholders and can repair known refs
there with backups.

## Graph

```bash
fclt graph show <selector>
fclt graph deps <selector>
fclt graph dependents <selector>
```

The graph explains how instructions, snippets, config refs, and rendered targets relate.

## Canonical Store

```bash
fclt templates list
fclt templates init operating-model [--global|--project|--root PATH] [--update] [--force]
fclt templates init project-ai [--project-root PATH|--root PATH] [--guidance PATH] [--apply --plan-sha SHA]
fclt templates init instruction <name>
fclt templates init snippet <marker>
fclt templates init skill <name>
fclt templates init agent <name>
fclt templates init mcp <name>
fclt templates init automation <template-id> --scope global|project|wide
fclt consolidate --auto keep-current --from <path>
fclt index [--force]
```

Use these to create or normalize canonical capability in `~/.ai` or
`<repo>/.ai`. `project-ai` is a compatibility alias for minimal, preview-first
`project init`; use `operating-model --project` only for an explicit full-pack
install.

## Hermetic project-tree planning

```bash
fclt project render-plan --root <repo>/.ai --project-root <repo> \
  [--manifest project-render.toml] --json
```

`project render-plan` reads `<repo>/.ai/project-render.toml` and only the canonical
inputs declared by that manifest. It emits a deterministic, content-addressed
desired-tree plan containing logical paths, normalized desired bytes, modes,
and hashes. It does not inspect repository targets, machine-local state,
`$HOME`, clocks, or the network, and it has no write path.

The version 1 manifest has an exact TOML schema:

```toml
schema_version = 1
exclusive_roots = [".agents/skills"]

[[targets]]
id = "codex-root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "codex-root-agents-md"
producer_version = 1
sources = ["fragments/header.md", "instructions/WORK.md"]

[[targets]]
id = "codex-review-skill"
tool = "codex"
destination = ".agents/skills/review/SKILL.md"
mode = "0644"
producer = "codex-skill-md"
producer_version = 1
sources = ["skills/review/SKILL.md"]
```

Source paths are relative to the canonical root. Destinations are relative to
the project root. `copy-text` requires one source; `concat-text` preserves the
declared source order and joins normalized UTF-8 text with the declared
separator. Unknown fields, links, unsafe paths, unsupported versions, duplicate
IDs, overlapping exclusive roots, and portable destination collisions fail
closed. Exclusive roots are the only directories where a future check may
report undeclared files; an empty array claims no directory tree.

Codex producer version 1 fixes each semantic surface to the current project
destination:

- `codex-root-agents-md` composes one or more canonical instruction inputs into
  root `AGENTS.md` in declared order.
- `codex-skill-md` validates a single `SKILL.md` with matching `name` and a
  non-empty `description`, then writes `.agents/skills/<name>/SKILL.md`.
  Declare referenced scripts, templates, and other skill resources as explicit
  `copy-text` targets under the same exclusive skill root.
- `codex-agent-toml` validates required `name`, `description`, and
  `developer_instructions` fields and writes `.codex/agents/<name>.toml`.
  With Codex multi-agent V2 clients that default to a full-history fork, callers
  selecting an explicit custom role must use `fork_turns = "none"` or a positive
  bounded history. The fork mode is an invocation concern and is not rendered
  into the agent TOML.
- `codex-config-toml` composes valid TOML fragments into the single
  `.codex/config.toml` target. MCP `env_vars`, `bearer_token_env_var`, and
  `env_http_headers` remain runtime references. Literal MCP `env` tables,
  static HTTP headers, user-level provider settings, and plugin enablement are
  rejected with typed diagnostics instead of being committed to the project.

All Codex recipes require `tool = "codex"` and `producer_version = 1`. The
compiler does not generate the legacy `.codex/mcp.json`, `.codex/skills`, or a
project plugin-installation surface.

Claude producer version 1 fixes each semantic surface to the current project
destination:

- `claude-root-claude-md` emits exactly `@AGENTS.md` with a trailing newline.
  Its sole canonical input must contain only that import, and the manifest must
  also declare root `AGENTS.md`. This keeps the canonical project instructions
  owned once while making Claude's root entry point explicit.
- `claude-skill-md` validates a single `SKILL.md` with matching `name`, a
  non-empty `description`, and a body, then writes
  `.claude/skills/<name>/SKILL.md`. Declare referenced resources separately.
- `claude-agent-md` validates required YAML `name` and `description` fields, a
  non-empty body, and the supported project-agent frontmatter subset before
  writing `.claude/agents/<name>.md`. Agent `mcpServers` may reference declared
  server names; inline server definitions are rejected.
- `claude-mcp-json` composes disjoint `mcpServers` fragments into root
  `.mcp.json`. Stdio, HTTP, SSE, and WebSocket transports are validated. MCP
  environment and header values must be runtime references such as `${NAME}`
  or `Bearer ${NAME}`; literal values fail closed.
- `claude-settings-json` composes disjoint fragments into
  `.claude/settings.json`. Version 1 supports the instruction-agent selector,
  MCP allowlists, plugin enablement, GitHub marketplace declarations,
  co-author attribution, and string-array permission rules. Secret-bearing
  `env`, hooks, unknown settings, inline marketplace URLs, and overlapping
  fragment ownership are rejected rather than passed through.

All Claude recipes require `tool = "claude"` and `producer_version = 1`.
Rendering settings or plugin declarations does not install plugins, contact a
marketplace, approve an MCP server, or bypass the client's trust boundary.

### Compiler and input-pack lock

Create the committed lock with exact cached compiler artifacts:

```bash
fclt project lock --root <repo>/.ai --project-root <repo> \
  --pack-version <pack-version> \
  --pack-schema-version <schema-version> \
  --compiler-compatibility ">=2.28.0 <3.0.0" \
  --compiler-artifact darwin-arm64=/cache/fclt-darwin-arm64 \
  --compiler-artifact linux-x64=/cache/fclt-linux-x64 \
  --json
```

The command writes `.ai/project-render.lock.json` atomically. The stable lock
contains no timestamp or absolute path. It records the compiler package version,
one SHA-256 digest per declared platform artifact, render-manifest schema,
canonical input-pack digest, pack schema/version, and compiler compatibility
range. Supply every supported platform artifact when creating or updating the
lock; omitted platforms cannot render it.

When the default lock exists, `project render-plan` and `project render` verify it
before returning a plan or touching a target. `--require-lock` makes absence an
error, and `--lock <relative-path>` selects a non-default lock. Verification
hashes the running compiled executable itself. A source checkout, a package
version string, or discovery through `PATH` cannot substitute for the locked
artifact identity. Pack drift, compiler-version skew, incompatible ranges, and
artifact mismatch fail before render.

For offline use, cache the release binary and its `SHA256SUMS`, keep the
repository's canonical `.ai` inputs and lock together, and invoke the cached
binary by exact path. No network, home-directory capability, clock, or live
target content participates in lock verification or desired-tree compilation.
Rolling back means restoring the prior canonical inputs and their prior lock as
one revision.

Planning, checking, and mutation are separate boundaries. Compare declared
files and exclusive roots without mutation using:

```bash
fclt project render --root <repo>/.ai --project-root <repo> --check --json
```

The check exits zero for an exact tree, one for drift, and two for command or
validation errors. Its bounded result separates missing, changed,
type-conflict, and unexpected paths. Only declared target paths and
`exclusive_roots` are read.

Apply a checked manifest with receipt-bound ownership:

```bash
fclt project render --root <repo>/.ai --project-root <repo> --json
```

Apply stores its lock, ownership receipt, rollback snapshots, and any active
transaction under fclt's machine-local project state. It never stores runtime
state in canonical `.ai` or rendered targets. The first apply refuses existing
destinations and unexpected files in exclusive roots rather than adopting
them. Later applies overwrite or remove only files that still match the prior
ownership receipt. Manifest, input, target, and plan identities are rechecked
at each target commit. Atomic replacement, a durable pre-mutation transaction,
and automatic rollback recovery make a repeated apply idempotent after an
interruption.

Restore the previous receipt-bound target state with:

```bash
fclt project render --root <repo>/.ai --project-root <repo> --rollback --json
```

Rollback also uses the transaction/recovery path and refuses externally edited
owned targets. Receipts are machine-local: copying a repository to a new
machine does not transfer write authority. Use `--check` there, or perform a
fresh apply only against empty declared destinations.

## Release integrity and provenance

GitHub releases publish platform binaries, compatibility aliases, install
scripts, `SHA256SUMS`, and an SPDX JSON SBOM. The shell installer and npm
launcher download `SHA256SUMS` and verify the selected binary before making it
executable or moving it into the runtime cache. Homebrew formulas are generated
from those same release checksums.

The release workflow creates build-provenance attestations for the published
assets on a GitHub-hosted OIDC runner. npm publishing separately uses registry
provenance. A cached release binary plus its checksum, the committed canonical
inputs, and `project-render.lock.json` form the supported offline render bundle.

## Per-asset deployment planning

```bash
fclt deploy plan --asset instruction:<name>|snippet:<path> \
  --destination <relative-path> --tool codex --adapter-version v1 \
  --root <canonical-root> --target-root <tool-root> --state-root <state-root> \
  --scope global|project [--expected-source-hash sha256:<hex>] \
  [--expected-current-hash absent|sha256:<hex>] --json
```

This is a read-only, one-asset/one-destination planning boundary. It emits a deterministic,
content-addressed plan and has no executor. The planner scans canonical ownership records and
allows at most one claim for the exact tool and physical destination. Primary identity is a
lossless, platform-qualified encoding of the verified canonical path. The separate v2 portability
collision key applies slash normalization, NFC, and the full default Unicode case fold pinned by
`unicode-case-folding@1.1.1`: true aliases resolve to one physical identity, while distinct paths in
the same collision class fail closed. Older key contracts require explicit migration. The planner
recomputes both identities for every structurally safe state record before filtering or grouping,
and the persisted schema rejects unknown root, binding, and rollback fields. Canonical, target, and
rollback-snapshot files are limited to 16 MiB and read twice through a no-follow descriptor.
Deployment-state enumeration and record opens are anchored to one no-follow directory descriptor;
the scan allows at most 128 entries, 256 KiB per record, and 4 MiB in aggregate. Device/inode,
metadata, bytes, canonical identity, and physical-root containment must remain stable; platforms
without the required descriptor-relative primitives fail closed. Shared state roots may hold
records for multiple target roots. Persisted destination and rollback paths must be non-empty,
NUL-free, absolute, and normalized before they can be resolved or reused. Existing rollback targets
survive no-op and update replans; recorded snapshots are required and hash-verified. Asset or
adapter ownership transfer fails closed until a separate, explicitly reviewed migration command
exists. Use isolated roots while this boundary is being proven; broad managed apply remains
deprecated and contained. This slice has no executor. Any future executor must repeat the same safe
reads and reverify every recorded plan hash immediately before mutation.

## Legacy managed mode

```bash
fclt setup codex-plugin [--dry-run] [--json] [--no-codex-install]
fclt autosync status [tool]
fclt autosync cleanup --service <name> --expected-plan <id> --global|--project --root <path> --allow-legacy-managed-mutation --json
fclt manage <tool> --dry-run
fclt sync [tool] --dry-run
fclt managed
fclt unmanage <tool> --dry-run
```

`setup codex-plugin` is the narrow path for exposing the bundled fclt Codex
plugin without entering managed mode. It writes only `~/plugins/fclt`, the
local marketplace entry, and the Codex plugin install/cache when Codex is
available. Broad managed mutation is deprecated and contained by default; the explicit
`--allow-legacy-managed-mutation` escape hatch exists only for reviewed migrations. Read
[Managed mode](./managed-mode.md) before using it on an existing setup.

`autosync cleanup` is a runtime-only recovery transaction emitted by `doctor --json`. It requires
the exact service, root, scope, plan id, and command-line approval from that report. It unloads and
removes only a structurally validated root-owned launch agent, preserves canonical capability,
live tool state, managed records, backups, and autosync config, and writes an idempotency receipt.
The ambient legacy-approval environment variable does not authorize this command.

## Writeback and evolution

```bash
fclt ai writeback add --kind <kind> --summary <text> [--category <friction|opportunity|reusable-success>] [--details <text>] [--impact <text>] [--attempted-workaround <text>] [--desired-outcome <text>] [--sensitivity <public|internal|private>] --evidence <type:ref> --asset <selector>
fclt ai writeback list
fclt ai writeback show WB-00001
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind

fclt ai evolve assess --asset <selector> --json
fclt ai evolve propose
fclt ai evolve list
fclt ai evolve show EV-00001
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve reject EV-00001 --reason <text>
fclt ai evolve apply EV-00001
fclt ai evolve promote EV-00003 --to global --project

fclt ai review init [--dry-run] [--force] [--json]
fclt ai review status [--json]
fclt ai review reconcile --since <date> [--until <date>] [--source <id>] [--incremental] [--json]

fclt ai loop enable [--rrule <rrule>] [--source <id>] [--dry-run] [--json]
fclt ai loop disable [--dry-run] [--json]
fclt ai loop status [--json]
fclt ai loop activity [--all|--global|--project] [--json]
fclt ai loop resolve <activity-action-locator> [--json]
fclt ai loop history [--all|--global|--project] [--since <date>] [--until <date>] [--item <id>] [--scope-id <opaque-id>] [--event <type>] [--limit <1-200>] [--cursor <cursor>] [--json]
fclt ai loop run [--since <date>] [--until <date>] [--source <id>] [--dry-run] [--scheduled] [--json]
```

Use these to turn repeated work friction into reviewed capability changes.
Plain list output shows the active root and scope so an empty project queue is
not confused with the global queue. Use `--global`, `--project`, or `--root`
when reviewing a specific scope, and use `--json` for automation.

`review reconcile` is read-only with respect to configured sources and
canonical capability. It persists only machine-local cursors/window state and a
Markdown review mirror. JSON reports `checked`, `changed`, `stale`, or
`unavailable` coverage for every configured source plus extraction decisions,
correlated signals, linked work, exclusions, and mandatory dispositions.
Bounded windows always rescan their complete requested range. Use
`--incremental` only when advancing from the stored per-source watermarks is
intended. A source-filtered run cannot prove an empty review.

`loop activity` defaults to one aggregate read model across Global and every
configured project loop. The aggregate reports which scopes are available and
keeps each portable per-scope feed intact so consumers can filter or label by
origin. Use `--global` or `--project` for one scope. Project discovery is owned
by fclt's machine-local loop state; project roots and state keys never appear in
the activity JSON. Use `loop report --json` when you need machine-local
technical paths and the full controller record for one explicit scope.

Single-scope activity feeds retain contract version 1. The aggregate is the
distinct version 2 `activity-set` contract: each feed is joined to a stable
opaque `scopeId`, and `truncation` reports any bounded omissions. Aggregate
responses are capped before they reach CLI or plugin consumers; incomplete or
truncated coverage is never presented as complete.

Actionable items may include an optional opaque `actionLocator`. Resolve it
with `loop resolve` to obtain a read-only, plain-language plan for the exact
verified current scope and resource. Resolution accepts no root or scope flag,
performs no mutation, and fails closed when the activity run, queue revision,
resource lifecycle, allowed action class, or project/runtime identity changed.
Older or non-actionable items without a locator remain handoff-only. See
[Activity action locators](./activity-action-locators.md) for versioning and
error semantics.

`loop history` is the bounded version 1 multi-run timeline and lineage
contract. It stores immutable per-run event segments in machine-local runtime
state and returns delta events rather than copying current activity items.
Queries are newest first and cursor-paginated. Scope, time, item, and event-type
filters are explicit. Missing pre-history, retention pruning, corruption, and
bounded omissions remain visible in `coverage` and `truncation`. See
[Activity history](./activity-history.md) for the schema, identity, retention,
and privacy contract.

`loop enable` is an explicit opt-in that installs an fclt-owned Codex
automation. The loop persists the full current queue, emits a delta for
notifications, retries bounded reconciliation failures, reports scheduler
observation separately from registration, and tracks proposal verification as
pending, due, overdue, improved, unchanged, or regressed. `loop disable`
pauses only the owned automation and preserves history. `loop run --dry-run`
scans configured sources for a current incremental preview without advancing
cursors or writing reconciliation or loop state. Canonical apply and external
tracker mutation are not performed by the loop.

## Sources, Audit, And Updates

```bash
fclt search <query>
fclt install <source:item> [--as <name>] [--strict-source-trust]
fclt update [--apply]
fclt verify-source <name> [--json]
fclt sources list
fclt sources trust <source> [--note <text>]
fclt sources review <source> [--note <text>]
fclt sources block <source> [--note <text>]
fclt sources clear <source>
fclt audit [--non-interactive] [--report-root <absolute-directory>] [--update-index]
fclt self-update
```

Audit evaluation is read-only across library, CLI, interactive initial scan,
and typed MCP entry points. `--report-root` explicitly persists a
content-addressed report-and-receipt envelope only to a pre-existing,
non-symlinked root that does not overlap any evaluated source. `audit safe`
requires `--report <exact-report.json> --yes`; legacy latest reports and
detached pre-revision-9 pairs are never trusted for mutation. `audit fix`
uses `--dry-run` for zero-write inspection. With explicit `--yes`, supported
inline MCP secrets are moved only from the exact report-bound canonical source
to its bound owner-only local overlay. The descriptor-relative transaction
revalidates source, destination, ancestors, permissions, and identity at the
final commit boundary, and refuses Git-worktree destinations.
`--update-index` is a separate explicit canonical generated-state mutation.

`self-update` detects release-script, npm/Bun, and mise-managed npm installs.
For mise installs it updates the global `npm:facult` pin and verifies the
resolved `fclt` version through mise. After a successful non-dry update, the exact verified new
executable runs read-only `doctor --global --json` plus `doctor --project --json` when the current
Git repository has a `.ai` root. It prints any contained recovery action and never applies cleanup
automatically.

Use `--strict-source-trust` when installing or updating remote capability from catalogs.

## Root Selection

Most commands accept the same root controls:

- `--global`: use `~/.ai`
- `--project`: use the nearest repo-local `.ai`
- `--root /path/to/.ai`: use an explicit canonical root
- `--scope merged|global|project`: choose a discovery view
- `--source builtin|global|project`: filter provenance in list/find/show/graph flows
