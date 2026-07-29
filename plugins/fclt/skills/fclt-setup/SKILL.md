---
name: fclt-setup
description: Install, update, inspect, and initialize fclt from Codex.
tags: [fclt, setup, codex, onboarding]
---

# fclt-setup

## When To Use
Use this skill when a user wants Codex to install, update, configure, inspect, or repair fclt.

Use it for:

- checking whether `fclt` is installed and current
- initializing global `~/.ai`
- discovering repositories and enrolling a reviewed minimal project layer
- installing or refreshing the built-in operating-model pack
- checking setup health with `doctor`
- finding canonical, generated, runtime, and review paths

## Workflow

1. Bootstrap the global loop with one idempotent command:

```bash
fclt setup
```

This initializes or safely updates global capability, prepares writeback/evolution review state,
and installs the Codex plugin when Codex is available. It does not initialize the current
repository.

2. Inspect runtime selection and compatibility with `fclt_runtime` action
   `status`. Report the selected executable, version, source, protocol
   compatibility, and fresh-session state.

If no compatible runtime is available, use the staged lifecycle:

- `check` is read-only
- `stage` requires an explicit version and approval, but does not activate it
- `apply` requires approval plus the staged checksum precondition
- `rollback` verifies and restores the retained prior runtime

Never curl-pipe code, use an unverified mutable URL, or replace an existing
global installation silently.

3. Check current setup state and exact repair actions:

```bash
fclt --version
fclt paths --json
fclt doctor --json
```

Through MCP, call `fclt_setup` with an explicit `global` or
`global_and_project` scope. Project setup also requires the exact `cwd`.
Preview is the default; apply requires both `dryRun: false` and
`approve: true`. `global_and_project` returns a no-write project enrollment
plan; project application still uses the typed CLI plan-hash contract below.

4. For advanced manual recovery, initialize global capability when missing:

```bash
fclt templates init operating-model --global
```

5. Discover candidate repositories only beneath explicit roots:

```bash
fclt projects discover --root ~/dev --since 30d --json
```

Discovery is bounded and read-only. Review duplicate clone/worktree groups,
dirty state, existing guidance, and repository identity before selecting a
project. Never bulk-enroll the discovery result.

6. Preview the exact minimal project enrollment plan:

```bash
fclt project init --project-root /path/to/repo --json
```

The minimal layer is `.ai/.gitignore` plus `.ai/config.toml`. It does not
install the operating pack, enable managed rendering, schedule a loop, or copy
`AGENTS.md`/`CLAUDE.md`. Review every canonical, generated, and machine-local
write plus the rollback command.

If project guidance should be adopted, name each canonical file explicitly:

```bash
fclt project init --project-root /path/to/repo \
  --guidance AGENTS.md --json
```

Guidance adoption is reference-only. fclt previews the full content and hash,
and refuses untracked, modified, secret-shaped, or machine-path-bearing input.

7. Apply only the unchanged reviewed plan:

```bash
fclt project init --project-root /path/to/repo \
  --apply --plan-sha <sha-from-preview> --json
```

If options, source files, or preconditions change, discard the old hash and
preview again.

8. Inspect health, coverage, and lifecycle:

```bash
fclt projects status --root /path/to/repo --json
fclt project disable --project-root /path/to/repo --json
fclt project rollback --receipt <id> --json
```

Disable and remove decisions preserve canonical files, receipts, and review
history. Rollback previews by default and refuses drift.

9. Install the full operating pack only when explicitly requested:

```bash
fclt templates init operating-model --project --dry-run
fclt templates init operating-model --project
```

This is distinct from minimal enrollment and does not seed project
`AGENTS.global.md` from repository guidance.

10. Refresh global pack defaults non-destructively:

```bash
fclt templates init operating-model --global --update --dry-run
fclt templates init operating-model --global --update
```

11. Use `--force` only when the user explicitly wants to replace local edits.

## Rules

- Preserve existing `AGENTS.md`, `CLAUDE.md`, and `AGENTS.global.md` guidance.
- Never infer guidance adoption from filenames or copy repository guidance into
  `.ai/AGENTS.global.md`.
- Treat root `AGENTS.md` or `CLAUDE.md` as canonical repository guidance unless
  the user explicitly chooses another tracked, clean source.
- Write the protective `.ai/.gitignore` before generated state.
- Keep canonical project files separate from machine-local generated indexes,
  registries, receipts, and scheduling state.
- Keep minimal enrollment separate from the full operating pack and managed
  rendering.
- Treat `doctor --json` issues as setup facts, not user-facing blame.
- Treat Codex plugin registration as weaker evidence than fresh-session tool discovery.
- Treat external trackers as separate integrations. Core readiness depends only on configured local evidence coverage, not a vendor plugin or token.
- Prefer temp-root smoke tests for install/update behavior.
- Do not enable managed rendering unless the user wants fclt to write tool homes.
- Preview before mutation and state the exact global/project/plugin target.
- Do not report a staged runtime or installed plugin as active until the active
  handshake and fresh-session discovery have been verified.

## Output

- current installed version
- setup health
- paths that matter
- commands run
- what changed
- problem, evidence, reason, target, risk, and expected outcome
- verification performed and its actual result
- assumptions and fresh-session state
- exact undo or rollback path
- what still needs approval
