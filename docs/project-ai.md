# Guided Project Onboarding

Project onboarding is preview-first and minimal. It creates only the canonical
files required to identify and configure one repository; installing the full
operating pack and rendering tool output remain separate decisions.

## Discover

Discovery is read-only, bounded, and restricted to explicit roots:

```bash
fclt projects discover --root ~/dev --since 30d --json
```

The result groups duplicate clones and worktrees by a stable repository
identity, reports dirty state and existing `.ai` coverage, and says when a
bound truncated the scan. Review and select repositories individually; the
command never enrolls its results.

## Preview And Apply

Preview the exact plan before any write:

```bash
fclt project init --project-root /path/to/repo --json
```

The plan distinguishes canonical, generated, and machine-local writes and
includes file preconditions, privacy findings, rollback behavior, and a plan
hash. Minimal enrollment writes:

```text
<repo>/.ai/
  .gitignore
  config.toml
```

The protective `.ai/.gitignore` is committed first and excludes `.facult/` and
`config.local.toml`. Generated indexes, the project registry, receipts, and
scheduling state stay under fclt's machine-local application-data root.

After reviewing the entire plan, apply that unchanged plan:

```bash
fclt project init --project-root /path/to/repo \
  --apply --plan-sha <sha-from-preview> --json
```

Apply refuses stale source hashes or changed destination preconditions. It does
not install the operating pack, enable managed rendering, schedule a loop, or
copy repository guidance.

`fclt templates init project-ai` remains a preview-first compatibility alias.
It has the same minimal contract and does not accept the old `--update` or
`--force` behavior.

## Existing Repository Guidance

Root `AGENTS.md` or `CLAUDE.md` remains the canonical repository rulebook.
fclt never copies either file automatically into `.ai/AGENTS.global.md`.

To adopt a reviewed reference, name each file explicitly:

```bash
fclt project init --project-root /path/to/repo \
  --guidance AGENTS.md --json
```

The plan previews the complete content and SHA-256 hash. Adoption is
reference-only and is refused when the source is untracked, modified, outside
the repository, secret-shaped, or contains a machine-local absolute path.
Reviewing and applying a plan therefore cannot turn a dirty checkout or a
machine-specific document into committed project capability.

If the full built-in operating pack is actually wanted, preview it separately:

```bash
fclt templates init operating-model --project --dry-run
fclt templates init operating-model --project
```

Project full-pack install also does not seed `AGENTS.global.md` from
`AGENTS.md` or `CLAUDE.md`.

## Status And Lifecycle

Inspect selected roots and registered projects:

```bash
fclt projects status --root /path/to/repo --json
fclt projects status --json
```

Status explains canonical coverage, protective-ignore health, generated-index
health, guidance references, scheduler state, pending review, and duplicate
locations without exposing private file contents.

Lifecycle decisions are non-destructive:

```bash
fclt project disable --project-root /path/to/repo --json
fclt project ignore --project-root /path/to/repo --json
fclt project remove --project-root /path/to/repo --json
```

They preserve canonical files, receipts, machine-local review history, and the
repository registry. Re-enroll an intentionally selected project with a newly
reviewed `fclt project init` plan.

Rollback also previews by default:

```bash
fclt project rollback --receipt <receipt-id> --json
fclt project rollback --receipt <receipt-id> --apply --json
```

Rollback removes only files created by that receipt when their hashes still
match. It refuses drift and preserves the receipt and review history.

## Scope And Verification

Project `.ai` stores repo-owned canonical capability. Do not place generated
state, local machine paths, secrets, writeback queues, or private review
artifacts there. Project-scoped writebacks and evolution proposals remain in
machine-local state with review mirrors under global
`~/.ai/writebacks/projects/` and `~/.ai/evolution/projects/`.

An environment-selected project root must declare
`FACULT_ROOT_SCOPE=project`; an unscoped `FACULT_ROOT_DIR` is global for safety.

After enrollment:

```bash
fclt projects status --root /path/to/repo --json
fclt status --project
fclt list skills --project
fclt sync codex --project --dry-run
```

Read [Concepts](./concepts.md) for the state model and [Managed
mode](./managed-mode.md) before opting into rendered tool output.
