# Built-in Pack Upgrades

The built-in operating-model pack is a starting point, not a source of destructive ownership over your `.ai` root.

Use normal install for a new root:

```bash
fclt templates init operating-model --global
fclt templates init operating-model --project
fclt templates init operating-model --root /path/to/.ai
```

By default, existing files are skipped. This is safe for first install and for adding newly introduced pack files.

## Non-Destructive Update

Use `--update` to refresh only files that still match the previously installed pack copy:

```bash
fclt templates init operating-model --global --update --dry-run
fclt templates init operating-model --global --update
```

`fclt` records a pack manifest under:

```text
.ai/.facult/packs/facult-operating-model.json
```

During `--update`, files are overwritten only when their current hash matches the last installed pack hash. If a user or agent edited a file locally, `fclt` skips it and reports it as a local edit.

Use `--force` only when you intentionally want to replace the selected root's pack files:

```bash
fclt templates init operating-model --global --force
```

## Legacy Installs

Older installs may not have a pack manifest. In that case, `--update` stays conservative:

- files that already match the current pack are recorded in the manifest
- missing files are added
- edited or unknown existing files are skipped

For a legacy root with many local changes, use an agent-assisted review:

```bash
fclt templates init operating-model --global --update --dry-run --json
fclt doctor --json --global
```

Review skipped files before deciding whether to merge changes manually, keep the local version, or replace with `--force`.

## AGENTS.global.md

The pack source stores the composed entry template at `snippets/templates/agents-global.md`. During install or update, `fclt` materializes that template as `AGENTS.global.md` in the target `.ai` root.

That installed `AGENTS.global.md` is not meant to hold every rule.

On a global first install, `fclt` can seed `AGENTS.global.md` from existing
global tool docs such as `~/.codex/AGENTS.md` and
`~/.claude/CLAUDE.md`, then append the Facult operating-model frame. Project
installs never seed from repo-local `AGENTS.md` or `CLAUDE.md`; those files
remain canonical repository guidance and require explicit reviewed
`fclt project init --guidance <path>` reference adoption.

Globally seeded files are user-owned. They are intentionally excluded from the
pack manifest so `--update` skips them unless you explicitly replace them with
`--force` or edit them manually.

Use:

- snippets for injected baseline blocks
- instructions for detailed doctrine
- skills for workflow execution
- agents for delegated review roles
- local/global config for private user-owned refs

This keeps global agent guidance small while still making the full operating model discoverable.
