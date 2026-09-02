---
name: project-operating-layer-design
description: Design or improve a repo-local .ai operating layer.
---

# project-operating-layer-design

## When To Use
Use this skill when a project needs its own `.ai/` structure, repo-specific instructions, or local bootstrap guidance.

Use it when:

- a repo has recurring agent friction that should not become global doctrine
- setup or verification steps are repeatedly rediscovered
- project skills, agents, MCP definitions, or snippets need a stable source of truth
- a repo needs policy for what may be rendered into tool homes
- a project should contribute writeback/evolution evidence without committing private review artifacts

Do not use it to copy a user's private global preferences into a public repo.

## Design Rules

- Start from the repo's real workflows, commands, and risk boundaries.
- Keep project-specific guidance in `<repo>/.ai`.
- Keep generated state, queues, review artifacts, and local machine config out of the repo.
- Prefer a few high-leverage instructions or skills over a large generic dump.
- Use snippets only for blocks that are reused or independently evolvable.
- Make verification and integration paths explicit enough for future agents to run.
- Add sync policy only for assets that should render into repo-local tool outputs.

## Working Flow

1. Inventory existing repo guidance and tool files.
2. Identify repeated friction from recent work, issues, reviews, or writebacks.
3. Separate project-specific behavior from global/user-owned behavior.
4. Propose a minimal `.ai` layout.
5. Add or update the smallest useful assets.
6. Verify the graph/index and any rendered output.
7. Record writeback for reusable learnings that should evolve later.

## Output Contract
- recommended `.ai/` layout
- what stays project-local
- what stays global
- what should remain generated runtime output only
- sync/rendering policy
- verification path
- privacy or commit-safety risks
