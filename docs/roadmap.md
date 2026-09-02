# Roadmap

This roadmap tracks remaining product direction for `fclt`.

## Already Shipped

- `fclt status` with root, managed-tool, generated-state, writeback, and evolution review paths.
- Generated-only project `.ai` detection and sync skip.
- Machine-local project generated state.
- Global Markdown review artifacts for writebacks and evolution proposals.
- Project-scoped writeback/evolution artifacts mirrored under global `~/.ai`.
- Built-in operating-model pack.
- Independent built-in operating-model pack install with `templates init operating-model`.
- Read-only setup discovery with `doctor --json` and `paths --json`.
- Cleaner built-in canonical refs.
- JSON-first `inventory`.
- `sync --adopt-live` for explicit promotion of live tool edits.
- Managed sync local-edit protection for rendered docs, config, MCP, and skills.
- Initial first-party Codex plugin with setup/writeback/evolution/capability-review skills and a CLI-backed MCP wrapper.
- Automatic, incremental reconciliation across explicit writebacks, canonical Git changes,
  vendor-neutral evidence exports, automation logs, and configured Markdown.
- Deterministic coverage, correlation, disposition, provenance, dedupe, and review artifacts for
  bounded source windows.
- An opt-in scheduled evolution loop with durable queues, delta notifications, scheduler health,
  retries, and outcome-verification state.
- Typed Codex reconciliation and loop-preview tools that keep external mutation and unsafe argv
  outside the MCP surface.
- Desktop-safe plugin runtime binding that does not depend on a GUI app inheriting the user's shell
  `PATH`.
- Default containment for deprecated whole-tool managed mutation, while preserving inventory and
  dry-run planning for legacy installations.
- Hermetic project planning, read-only checks, receipt-bound transactional apply/rollback, exact
  Codex and Claude adapters, compiler/input-pack locks, and release supply-chain verification.

## Current Priorities

1. Finish transaction-safe capability apply.
   - Bind every apply to an expected source hash and validated target patch.
   - Write an atomic rollback receipt before enabling any canonical auto-apply path.
   - Keep global instructions, shared skills, and plugins proposal-only.

2. Make loop status and review artifacts more explanatory.
   - Show policy summaries.
   - Surface top recommended next action.
   - Explain degraded source coverage and stale verification windows without reading runtime files.

3. Improve source-adapter configuration and diagnostics.
   - Add safe init/doctor helpers for narrow Git, Markdown, automation, and evidence-export sources.
   - Keep vendor integrations export-based and optional rather than adding credentials to core.
   - Make renamed-source and unavailable-source recovery easier to understand.

4. Extend immutable per-asset deployment planning beyond the completed project-tree compiler.
   - Add an explicit destination ownership migration/transfer contract before allowing asset or
     adapter claims to move.
   - Keep deprecated broad managed mutation contained.

5. Improve project onboarding.
   - Add a primary `fclt init project` flow.
   - Explain default-deny project sync during setup.
   - Offer safe adoption, detach, and restore choices.

6. Make policy inspectable.
   - Add `policy show`.
   - Add `policy explain`.
   - Hide TOML details behind user-facing commands where possible.

7. Make templates, plugins, automations, sources, reviews, and rendered targets first-class inventory objects.
   - List and show them consistently.
   - Add graph visibility.
   - Include them in status and sync plans.

8. Expand the first-party Codex plugin and MCP surface.
   - Add richer setup planning tools beyond the initial CLI wrapper.
   - Keep the CLI and canonical `.ai` roots as the source of truth.
   - Gate high-risk global changes behind explicit review.
   - Add more focused agent-facing skills for automation setup, capability search, and upgrade flows.

9. Tighten selector consistency.
   - Use one selector grammar across `list`, `show`, `graph`, `enable`, `disable`, `trust`, `audit`, writeback, and evolution.
   - Return useful ambiguity errors with candidates.

## Non-Goals

- Do not make managed mode the default way to inspect existing AI tool state.
- Do not store project writeback/evolution review artifacts in repo-local `.ai`.
- Do not silently adopt live tool edits during ordinary sync.
- Do not turn the built-in pack into a general preference archive.
- Do not require users to inspect machine-local state files to understand normal CLI behavior.
