# Codex Plugin

`fclt` ships a first-party Codex plugin at:

```text
plugins/fclt/
```

The plugin is for agent-led operation. After install, Codex gets focused skills for setup, writeback, evolution, and capability review, plus an MCP server wrapper that exposes common `fclt` CLI actions as tools.

## What It Includes

- `fclt-setup`: install, update, inspect, initialize, and repair fclt setup.
- `fclt-writeback`: record and review durable writebacks from real work.
- `fclt-evolution`: turn repeated writeback into reviewed capability proposals.
- `fclt-capability-review`: inspect global/project capability roots and scope changes.
- `fclt` MCP server: stdio wrapper around the installed `fclt` CLI.

The MCP wrapper intentionally delegates to the local `fclt` binary instead of duplicating core logic. Set `FCLT_BIN` if Codex should call a specific binary.

The runtime discovery, verified bootstrap/update lifecycle, safety tiers, and
release-proof requirements are documented in [Codex Plugin Runtime and Safety
Contract](./codex-plugin-runtime.md). The complete machine-readable CLI
disposition is in
[codex-plugin-capability-matrix.json](./codex-plugin-capability-matrix.json).

## MCP Tools

The plugin exposes:

- `fclt_setup`
- `fclt_runtime`: discover, check, stage, atomically activate, or roll back a verified runtime
- `fclt_capability`: typed capability, provenance, template, snippet, adapter, and managed-state reads
- `fclt_workflow`: typed writeback and evolution read/review/lifecycle operations
- `fclt_sync`: managed-state inspection and dry-run sync preview
- `fclt_registry`: source search/verification, strict-trust install/update preview,
  bounded reconciliation status/review through a closed scope/window/source-id schema,
  read-only resolution of one opaque activity action locator, and atomic
  recording of one revision-bound signal-family decision
- `fclt_audit`: structured, redacted, non-interactive security audit with zero report or index writes
- `fclt_automation`: read-only autosync status plus scheduled evolution-loop status and preview
- `fclt_status`
- `fclt_doctor`
- `fclt_paths`
- `fclt_init_operating_model`
- `fclt_writeback_add`
- `fclt_writeback_review`
- `fclt_evolve`

The typed routers use closed schemas, reject unknown fields, require explicit
scope and approval for review-producing or reversible workflow changes, and do
not expose arbitrary argv or shell passthrough. Canonical apply, live adoption,
trust-policy mutation, destructive migration, and background-service mutation
remain deliberately withheld until their CLI APIs provide transaction-safe
preview, precondition, verification, and rollback contracts.

`fclt_registry` action `activity_decide` is a narrow review-producing
exception to the otherwise read-only registry surface. It requires one issued
locator, `accept|redirect|reject|defer`, the exact expected queue revision, a
bounded actor, exactly one approval reference or note, and `approve: true`.
It records only a machine-local receipt. It cannot select a root, mutate
canonical capability or external systems, apply proposals, or spawn tasks.

The evolution-loop actions exposed through `fclt_automation` are
`loop_status`, `loop_activity`, and `loop_preview`. `loop_activity` defaults to
`all` and returns one portable activity set across Global and every configured
project loop; callers may filter it to `global` or `project`. Status and preview
still require one explicit scope. `loop_preview` performs a fresh incremental
scan of configured sources without advancing cursors or writing reconciliation
or loop state. Enabling, disabling, or manually running the scheduler remains a
CLI-only operation. The router accepts no raw argv, credentials, endpoints, or
external mutation fields.

Calling `loop_activity` without a scope deliberately selects the portable
cross-project view. It does not return project roots, machine state keys, raw
reports, or local file URLs. The version 2 set is size-bounded and reports
unavailable or truncated scopes explicitly.

## Install In Codex

For a new install, prefer the complete one-command bootstrap:

```bash
fclt setup
```

It prepares global capability, review state, indexes, and the plugin. The same
command is available to Codex through `fclt_setup`, so a plugin-led install
does not require the user to know global state paths. The MCP form requires an
explicit `global` or `global_and_project` scope and defaults to dry-run.
`global_and_project` requires an explicit project `cwd` and returns the exact
no-write minimal enrollment plan. Applying that project plan remains a
separate CLI action requiring its returned plan hash.

Use the narrow plugin-only command when the CLI loop is already healthy:

```bash
fclt setup codex-plugin
```

That updates only the local `fclt` plugin payload under `~/plugins/fclt`
and merges an entry into `~/.agents/plugins/marketplace.json`. The default
marketplace name is `hack-local`; if the marketplace file already has a
non-empty `name`, fclt preserves it and installs from that name. The generated
entry uses Codex schema-valid policy values, including
`installation: "AVAILABLE"` and `authentication: "ON_INSTALL"`.

Setup also binds the machine-local MCP payload to absolute JavaScript and fclt
runtime paths and carries the runtime directories into the MCP `PATH`. This is
required because a desktop app launched from the GUI does not necessarily
inherit the shell that contains Node, Bun, mise, or a package-manager shim.

When the `codex` command is available, setup runs
`codex plugin add fclt@<marketplace> --json`. Codex installs the plugin cache
under `~/.codex/plugins/cache/<marketplace>/fclt/` using its own version
directory. The safe project-onboarding contract ships in plugin `0.1.3`; its
version bump prevents Codex from selecting the pre-onboarding `0.1.2` cached
wrapper after an upgrade. Setup fails closed unless Codex's install result, installed
payload hash, and post-install plugin list all select the bundled version as
installed and enabled.

It does not enter managed mode, adopt Codex state, render
`~/.codex/AGENTS.md`, or touch existing Codex skills/rules/config.

Useful flags:

```bash
fclt setup codex-plugin --dry-run --json
fclt setup codex-plugin --no-codex-install
```

Broad managed sync is deprecated and contained by default. Preview it only when inspecting a
legacy installation:

```bash
fclt manage codex --global --dry-run
fclt sync codex --global --dry-run
```

For local plugin development, run the lightweight checks that ship with the repository:

```bash
node plugins/fclt/scripts/fclt-mcp.cjs --self-test
bun run bootstrap:verify
bun run check
```

`codex plugin list --json` proves registration, and the MCP self-test proves the packaged server
declares its tools. Neither proves a running task has refreshed its tool registry. After plugin
installation, start a fresh Codex task and confirm `fclt_setup` and `fclt_status` are discoverable;
`doctor --json` reports this boundary as `requires_fresh_session` instead of inferring success.
Reopening or resuming a task that existed before installation does not refresh that task's tool
registry. If a genuinely new desktop task reports `MCP startup failed: No such file or directory`,
rerun `fclt setup codex-plugin` from the installed release, then create another new task.

## Recommended Agent Use

Use the plugin skills as the first interface. Use MCP tools when a Codex workflow benefits from structured calls for status, doctor, paths, writeback, or evolution review.

For proposal triage, call `fclt_evolve` with `action: "assess"` before proposing when a target is known. Assessment is read-only and returns the recommendation, source writebacks, active proposal ids, quality checklist, suggested commands, and the next agent instruction.

Do not create writeback/evolution noise. Record strong signal, group repeated signal, assess readiness, then propose the smallest concrete capability change only when evidence repeats or the missing capability is clear.
