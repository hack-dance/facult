# Project rendering work units

This program replaces deprecated broad managed rendering with an explicit,
repository-owned compiler contract. Work proceeds in dependency order, and a
unit advances only when its verification evidence is recorded here.

## Status

| ID | Work unit | Status | Depends on |
| --- | --- | --- | --- |
| FCLT-PR-01A | Hermetic desired-tree manifest and planner | Completed | - |
| FCLT-PR-01B | Read-only repository check mode | Completed | FCLT-PR-01A |
| FCLT-PR-01C | Transactional repository materializer | Completed | FCLT-PR-01B |
| FCLT-PR-02A | Codex project target adapter | Completed | FCLT-PR-01A |
| FCLT-PR-02B | Claude project target adapter | Completed | FCLT-PR-01A |
| FCLT-PR-03A | Compiler and pack lock contract | Completed | FCLT-PR-01A |
| FCLT-PR-03B | Release supply-chain completion | Completed | - |

Consumer-specific image, runner, and deployment integration remains in the
consumer project. fclt owns the compiler, target adapters, lock contract, and
release evidence that those integrations consume.

## FCLT-PR-01A - Hermetic desired-tree manifest and planner

Goal: compile a committed project-render manifest and its declared canonical
inputs into one deterministic desired-tree plan without reading live targets,
machine-local state, `$HOME`, clocks, or the network.

Acceptance:

- `fclt project render-plan --root <repo>/.ai --project-root <repo> --json` reads
  `<repo>/.ai/project-render.toml` by default.
- The manifest has an exact versioned schema. Unknown fields, unsupported
  producer versions, unsafe paths, missing inputs, symlinks, duplicate target
  IDs, and portable destination collisions fail closed.
- Every destination has one producer recipe. A recipe may compose multiple
  canonical inputs.
- Planning is read-only and emits no absolute paths, timestamps, environment
  values, or machine-local state.
- Target order, input order, serialization, content hashes, modes, line
  endings, and the overall plan ID are deterministic.
- Equivalent repositories under different homes and working directories
  produce byte-identical JSON.

Output artifact: a stable JSON plan containing compiler identity, manifest and
input hashes, exact desired bytes, target metadata, and a content-addressed plan
ID.

Verification:

- focused parser and CLI tests;
- golden deterministic plan fixture;
- different home, cwd, locale, timezone, and ambient environment test;
- read-only tree snapshot test;
- source order, target order, line-ending, collision, traversal, symlink,
  unknown-field, unsupported-version, and bounded-input tests;
- `bun run type-check`, `bun run check`, and `git diff --check`.

False-positive guard: a golden hash alone is insufficient. Tests must also
prove that ambient state is excluded and that the source tree is unchanged.

## FCLT-PR-01B - Read-only repository check mode

Goal: compare a 01A desired tree with declared repository outputs without
mutating either tree.

Acceptance:

- `fclt project render ... --check` is read-only.
- Human and JSON output use a bounded, stable path/hash diff contract.
- Unexpected files in explicitly owned directory roots are reported separately
  from missing, changed, and type-conflicting targets. Receipt-bound stale-file
  classification remains part of FCLT-PR-01C.
- Unowned collisions fail; they are never silently adopted or overwritten.

Verification: hostile output trees, empty outputs, exact matches, truncation,
exit codes, and before/after snapshots.

## FCLT-PR-01C - Transactional repository materializer

Goal: apply a previously verified desired tree with hash-bound preconditions,
recoverable writes, and receipt-bound stale removal.

Acceptance:

- Revalidate manifest, input, target, and plan hashes immediately before each
  mutation.
- Use per-file atomic replacement and a durable transaction/rollback receipt.
- Remove only paths owned by a prior valid receipt.
- Preserve unrelated and unowned files.
- Interrupted apply is recoverable and idempotent.
- Keep ownership, rollback snapshots, locks, and active transactions in
  machine-local project state rather than canonical `.ai` or rendered output.

Verification: interruption at every transaction boundary, target races,
rollback, recovery, stale-owned removal, unowned preservation, and repeated
apply.

## FCLT-PR-02A and FCLT-PR-02B - Client adapters

Goal: add versioned Codex and Claude producer recipes while retaining one
canonical semantic contract.

Each adapter is a separate work unit. Its manifest declares exact destinations;
there is no `and/or` target behavior. Unsupported capabilities produce typed
diagnostics. Secret-valued MCP environment is rejected while approved runtime
references remain declarative.

Verification combines golden desired trees with fresh-client loading, root
instruction precedence, semantic inventory comparison, MCP startup/schema
checks, and secret-leak tests. Golden trees do not substitute for real-client
loading.

## FCLT-PR-03A - Compiler and pack lock contract

Goal: bind a repository render to an exact compiler artifact and input-pack
identity.

The lock records compiler version and artifact digest, render-manifest schema,
pack schema/version/digest, and compatibility range. Render verifies the lock;
discovering a binary through `PATH` does not waive identity verification.

Verification includes deliberate source/binary skew, pack drift, offline use,
and rollback to a prior lock.

## FCLT-PR-03B - Release supply-chain completion

Goal: complete release evidence independently of any one consumer.

Acceptance includes binary checksums that installers actually verify, an SBOM,
package/binary provenance, and an offline-cache contract. Cross-environment
consumer image comparison belongs to that consumer's integration work unit.

## Evidence log

Record commands, results, known gaps, and the commit or pull request that
completed each unit. A green source test is not installed-binary, packaged,
real-client, or consumer-image proof.

### 2026-09-01 - FCLT-PR-01A and FCLT-PR-01B

- Focused source verification: `./scripts/test-safe.sh
  src/project-render.test.ts src/project-render-check.test.ts
  src/deployment-plan.test.ts` passed with 46 tests and 191 assertions.
- Static verification: `bun run check`, `bun run type-check`, and `git diff
  --check` passed.
- Compiled-binary verification: `bun run build && bun run build:verify`
  passed. The verifier exercises deterministic planning, drift detection, and
  an exact-tree check using the compiled `dist/fclt` artifact on non-Windows
  hosts.
- Package-surface verification: `bun run pack:dry-run` passed and included the
  new CLI implementation and public documentation in the `facult@2.28.0`
  tarball inventory.
- Full source suite: `./scripts/test-safe.sh` exited 1 only because the
  pre-existing edited
  `assets/packs/facult-operating-model/skills/project-operating-layer-design/SKILL.md`
  does not match its generated `src/builtin-assets.ts` snapshot. The edited
  asset was preserved and the generated snapshot was not refreshed as part of
  these work units.
- Residual platform gap: the compiled project-render smoke is skipped on
  Windows, where descriptor-bound no-follow behavior still needs an explicit
  compatibility decision and dedicated CI proof before claiming parity.
- Not yet proven by FCLT-PR-01A/01B: transactional writes, installed-package
  behavior, real Claude/Codex client loading, release provenance, or a consumer
  image comparison. FCLT-PR-01C records the transactional evidence below.

### 2026-09-01 - FCLT-PR-01C

- Implemented receipt-bound apply and explicit rollback. First apply refuses
  pre-existing destinations and unexpected files under exclusive roots; later
  mutation requires the target to match its prior receipt.
- Each target mutation rebuilds and compares the plan, rechecks the target and
  bound parent directory, stages and syncs replacement bytes, and commits with
  atomic rename or unlink. A non-blocking advisory lock serializes mutations.
- A durable pre-mutation transaction contains bounded before/after snapshots.
  Retry rolls an incomplete apply or rollback back before proceeding, while
  external edits during recovery fail closed.
- Focused verification: `./scripts/test-safe.sh src/project-render.test.ts
  src/project-render-check.test.ts src/project-render-apply.test.ts
  src/deployment-plan.test.ts` passed with 60 tests and 235 assertions. It
  covers initial apply, idempotence, owned updates, stale removal, unowned-file
  preservation/refusal, source and target races, parent replacement,
  interruption before and after target commits, interruption before receipt
  commit, malformed state, concurrency, rollback, and interrupted rollback.
- Static verification: `bun run check`, `bun run type-check`, and `git diff
  --check` passed.
- Compiled-binary verification: `bun run build && bun run build:verify`
  passed and now exercises plan, drift, transactional apply, exact check,
  rollback to an absent tree, and reapply using compiled `dist/fclt`.
- Package-surface verification: `bun run pack:dry-run` passed and includes the
  materializer and updated public docs.
- Full source suite: `./scripts/test-safe.sh` exited 1 only at the same
  pre-existing edited built-in skill versus generated embedded-asset snapshot
  mismatch recorded for FCLT-PR-01A/01B. The user edit remains untouched.
- Residual platform gap: project mutation uses the POSIX advisory-lock and
  descriptor safety layer and remains unverified on Windows. The compiled
  renderer smoke continues to be skipped there.

### 2026-09-01 - FCLT-PR-02A

- Added version 1 Codex recipes for root `AGENTS.md`,
  `.agents/skills/<name>/SKILL.md`, `.codex/agents/<name>.toml`, and the single
  project `.codex/config.toml`. Exact destinations and `tool = "codex"` are
  validated before a desired tree is emitted.
- Codex skills and custom agents receive semantic inventory validation. Config
  fragments are parsed as one TOML document. Project-ineligible provider and
  plugin state produces `FCLT_PR_CODEX_UNSUPPORTED_CAPABILITY`; invalid targets
  and secret-bearing MCP config produce their own typed codes.
- MCP values under `env` and `http_headers` are rejected. Runtime references
  through `env_vars`, `bearer_token_env_var`, and `env_http_headers` remain
  declarative. Remote stdio environment references require the matching remote
  execution declaration.
- Focused verification: `./scripts/test-safe.sh
  src/project-render-codex.test.ts src/project-render.test.ts
  src/project-render-check.test.ts src/project-render-apply.test.ts` passed with
  34 tests and 113 assertions. `bun run check`, `bun run type-check`, and `git
  diff --check` passed.
- Compiled and package verification: `bun run build && bun run build:verify`
  passed with all four Codex recipes in the transactional compiled-binary smoke;
  `bun run pack:dry-run` included `src/project-render-codex.ts` and the public
  contract.
- Fresh-client proof used the exact installed Codex 0.146.1 native binary. Its
  read-only prompt renderer loaded the project `AGENTS.md` after global guidance
  and discovered the fixture skill from `.agents/skills`. Its MCP config parser
  reported both streamable HTTP `bearer_token_env_var` and stdio `env_vars`
  references without resolving or printing values.
- The full source suite still fails only on the pre-existing edited
  `project-operating-layer-design/SKILL.md` versus generated built-in snapshot;
  the isolated `src/builtin.test.ts` run confirms two passing tests and that one
  exact mismatch. The user edit and generated snapshot remain untouched.
- The first explicitly approved model-turn probe exposed a Codex 0.146.1
  invocation constraint: an explicit custom `agent_type` cannot use the default
  full-history fork. A stronger retry also caught a generic `reviewer` fixture
  name colliding with an unrelated user-level role. Neither result was counted
  as specialist execution.
- Final fresh-client proof used a uniquely named fixture role, disabled private
  user configuration, registered only the exact rendered agent file for the
  ephemeral run, and selected it with `fork_turns = "none"`. The expected token
  existed only in that agent's `developer_instructions`; the parent was told not
  to inspect files or answer on its behalf. Codex 0.146.1 spawned the role and
  returned `FCLT_REVIEWER_PROFILE_ACTIVE_7D39`, proving the rendered profile was
  parsed, selected, executed, and applied under a read-only sandbox.
- Evidence boundary: `--ignore-user-config` also suppresses automatic project
  role discovery in Codex 0.146.1, so the hermetic proof registered the rendered
  file through invocation-only config overrides. Ordinary project discovery is
  supported by Codex's documented `.codex/agents` contract. MCP evidence remains
  schema/load validation; no credential-bearing live server startup was claimed.

### 2026-09-02 - FCLT-PR-02B

- Added version 1 Claude recipes for an import-only root `CLAUDE.md`,
  `.claude/skills/<name>/SKILL.md`, `.claude/agents/<name>.md`, root `.mcp.json`,
  and `.claude/settings.json`. Exact destinations, producer versions, tool
  identity, source ownership, and the root `AGENTS.md` dependency fail closed.
- Skill and agent frontmatter is validated against explicit supported subsets.
  Agent `mcpServers` accepts configured server-name references but rejects inline
  definitions. Settings support a conservative project subset; secret-bearing
  `env`, hooks, unknown capabilities, and overlapping fragment ownership emit
  typed diagnostics.
- MCP stdio, HTTP, SSE, and WebSocket server schemas are validated. Environment
  and header values must remain `${NAME}` runtime references (with an optional
  `Bearer ` prefix for headers); literal values are rejected and never emitted.
- Focused verification: `./scripts/test-safe.sh
  src/project-render-claude.test.ts src/project-render-codex.test.ts
  src/project-render.test.ts src/project-render-check.test.ts
  src/project-render-apply.test.ts` passed with 40 tests and 132 assertions.
  `bun run check` and `bun run type-check` passed.
- Compiled verification: `bun run build && bun run build:verify` passed. The
  transactional compiled-binary smoke now renders, checks, rolls back, and
  reapplies a combined nine-target Codex and Claude project tree.
- Package and broad verification: `bun run pack:dry-run`, the public-surface
  privacy scan, and `git diff --check` passed. The full source suite failed only
  at the pre-existing edited `project-operating-layer-design/SKILL.md` versus
  generated embedded-asset snapshot mismatch; that user edit and generated
  snapshot remain untouched.
- An isolated repository rendered by compiled `dist/fclt` produced six exact
  Claude/project outputs, and compiled `--check` matched all six. The installed
  Claude Code 2.1.223 client recognized `.mcp.json` as shared project config and
  reported the intentionally absent `FCLT_FIXTURE_TOKEN` reference without
  resolving or printing a value.
- Claude Code 2.1.223 live-client proof used the user's explicitly approved
  authenticated session with `--setting-sources project`, plan permission mode,
  no session persistence, and an isolated fixture repository. Three independent
  model turns returned `FCLT_CLAUDE_ROOT_MARKER` through the rendered root
  `CLAUDE.md` import, `FCLT_CLAUDE_AGENT_MARKER` through explicit selection of
  the rendered `fclt-claude-proof` project agent, and
  `FCLT_CLAUDE_SKILL_MARKER` through explicit invocation of the rendered
  project skill. All completed in one turn with no permission denials.
- Evidence boundary: Claude Code 2.1.223 predates directory-level agent/skill
  validation added to newer clients, so the direct load-and-execute probes are
  the stronger evidence for those surfaces. No credential-bearing MCP
  connection was attempted; MCP evidence remains project discovery, schema
  acceptance, and unresolved runtime-reference handling.

### 2026-09-02 - FCLT-PR-03A and FCLT-PR-03B

- Added atomic `.ai/project-render.lock.json` creation and automatic lock
  verification for plan, check, and apply. The lock records compiler version,
  platform artifact digests, manifest schema, input-pack digest, pack
  schema/version, and an explicit compiler compatibility range without absolute
  paths or timestamps.
- Locked rendering hashes the running compiled executable. Source execution,
  missing platform artifacts, artifact drift, pack drift, compiler-version skew,
  and incompatible ranges fail before a plan can authorize mutation. Lock
  creation requires explicit absolute artifact paths rather than `PATH`
  discovery.
- Lock verification tests cover deterministic bytes across different roots,
  deliberate source/lock compiler identity skew, pack and artifact drift, source-mode
  rejection, compatibility bounds, and offline rollback to a prior input/lock
  pair. The compiled-binary verifier creates and consumes a real lock before its
  nine-target transactional render/check/rollback/reapply smoke.
- Regenerated `src/builtin-assets.ts` from the approved canonical built-in skill
  edit. `src/builtin.test.ts` now passes all three tests, removing the only known
  full-suite failure from the earlier work-unit runs.
- Both release installers now verify the selected binary against the published
  `SHA256SUMS` before installation. Functional tests cover successful shell
  installation, checksum rejection before mutation, npm-launcher verification,
  and missing checksum entries. The shell installer repository URL was corrected
  from the stale `hack-dance/facult` path to `hack-dance/fclt`.
- The release workflow now generates an SPDX JSON SBOM, checksums the SBOM and
  binaries, and creates GitHub build-provenance attestations on a GitHub-hosted
  OIDC runner before uploading release assets. A parsed workflow contract test
  fixes the required ordering and permissions; npm provenance and Homebrew
  checksum consumption remain independently enforced.
- Final repository verification passed: `./scripts/test-safe.sh` completed with
  875 tests, 3,913 assertions, and zero failures; `bun run check`, `bun run
  type-check`, `git diff --check`, `bun run build`, `bun run build:verify`, `bun
  run pack:dry-run`, and `bun run bootstrap:verify` also passed.
- The full-suite run exposed and verified a macOS lexical-versus-physical path
  mismatch in exact audit remediation receipts (`/var` versus `/private/var`).
  Receipt authorization now binds physical snapshot identities while CLI
  results preserve requested paths. The focused adversarial audit-fix suite
  passed all 23 tests, including replay, drift, ancestor-swap, FIFO,
  interruption, and rollback cases.
- Evidence boundary: local tests prove generation, rejection, compiled offline
  use, and workflow structure. The first actual SBOM upload and GitHub
  attestation can only be observed when the release workflow runs after merge;
  that post-merge readback remains release evidence, not source-code evidence.
