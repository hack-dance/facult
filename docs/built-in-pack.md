# Built-in Pack

`fclt` ships an operating-model pack:

```text
assets/packs/facult-operating-model/
```

It provides default guidance for agents that use `fclt`: define the work, verify it, record durable feedback, and turn repeated signal into reviewed changes.

## Included Assets

Instructions:

- `WORK_UNITS.md`
- `CAPABILITY_COMPOSITION.md`
- `LEARNING_AND_WRITEBACK.md`
- `EVOLUTION.md`
- `PROJECT_CAPABILITY.md`
- `INTEGRATION.md`

Skills:

- `capability-evolution`
- `fclt-writeback`
- `project-operating-layer-design`

Agents:

- `writeback-curator`
- `evolution-planner`
- `scope-promoter`
- `integration-auditor`

Entry template:

- `snippets/templates/agents-global.md`

The template materializes as `AGENTS.global.md` when installed into a canonical `.ai` root. The source lives under snippets/templates so the pack itself models composition instead of treating the root global doc as a special hand-maintained asset. The installed `AGENTS.global.md` should stay small and point to snippets and instructions rather than becoming the only place where guidance lives.

On first install, `fclt` preserves existing guidance when it can:

- global installs seed `AGENTS.global.md` from existing global agent docs such as `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`
- project installs seed from the repo's existing `AGENTS.md` or `CLAUDE.md`
- the packaged template is only the fallback when no existing guidance is found

Seeded `AGENTS.global.md` files are treated as user-owned. They are not marked as pack-owned in the update manifest, so future `--update` runs skip them instead of replacing them with the fallback template.

## When It Becomes Active

The built-in pack is always available as a built-in source:

```text
@builtin/facult-operating-model/...
```

Install a concrete copy into a canonical root without managing any tool:

```bash
fclt templates init operating-model --global
fclt templates init operating-model --project
fclt templates init operating-model --root /path/to/.ai
```

That writes the pack into the selected `.ai` root and rebuilds its index. It does not render files into Codex, Claude, or any other tool home.

For normal onboarding, prefer `fclt setup`. The lower-level template commands remain available for
advanced scope selection, dry-runs, and recovery.

Refresh an existing root non-destructively:

```bash
fclt templates init operating-model --global --update --dry-run
fclt templates init operating-model --global --update
```

`--update` refreshes only files that still match the last installed pack manifest and skips local edits. See [Built-in pack upgrades](./pack-upgrades.md).

Use guided onboarding when the target needs only a minimal project layer:

```bash
cd /path/to/repo
fclt project init --json
fclt project init --apply --plan-sha <sha-from-preview> --json
```

This writes the protective `.ai/.gitignore` before generated state and does
not install this full pack or copy repo guidance. Use
`fclt templates init project-ai` only as the equivalent preview-first legacy
alias.

Legacy managed mode is a deprecated rendering layer. Inspect its plan without changing tool state:

```bash
fclt manage codex --dry-run
fclt sync codex --dry-run
```

Broad managed mutation is contained by default while transaction-safe per-asset deployment is built.
Use narrow native setup such as `fclt setup codex-plugin` when available. Existing global managed
tools receive the built-in writeback/evolution guidance only when an explicitly reviewed legacy
sync is approved. Project-local `.ai` roots do not render the built-in operating model into
repo-local tool outputs unless project sync policy explicitly allows it. Installing the pack and
rendering it into a tool are separate decisions.

Disable built-in default sync for a canonical root:

```toml
version = 1

[builtin]
sync_defaults = false
```

## Design Rule

The built-in pack should stay small. It teaches:

- work-unit discipline
- composable refs, snippets, instructions, skills, agents, MCP, and automations
- verification
- writeback
- evolution proposal review
- project/global scope decisions
- managed-mode ownership boundaries

Keep project-specific behavior in project `.ai`. Promote it only when repeated evidence shows it is reusable outside that project.

## Next

- Read [Composable Capability](./composable-capability.md) for refs, snippets, and instruction templates.
- Read [Work Units](./work-units.md) for the general work-unit model.
- Read [Built-in pack upgrades](./pack-upgrades.md) before refreshing an existing root.
- Read [Writeback and evolution](./writeback-evolution.md) for the feedback loop.
- Read [Managed mode](./managed-mode.md) before rendering the pack into a tool home.
