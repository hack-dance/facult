import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { isCancel, multiselect, select, text } from "@clack/prompts";
import { replaceVerifiedFileAt } from "./audit/safe-openat";
import {
  builtinOperatingModelInstallRelPath,
  facultBuiltinPackRoot,
} from "./builtin";
import {
  parseCliContextArgs,
  resolveCliContextRoot,
  resolveCliContextScope,
} from "./cli-context";
import {
  renderBullets,
  renderCatalog,
  renderCode,
  renderKeyValue,
  renderPage,
  renderTable,
} from "./cli-ui";
import { buildIndex } from "./index-builder";
import {
  assertLegacyManagedMutationAllowed,
  LEGACY_MANAGED_MUTATION_FLAG,
  legacyManagedMutationApproved,
} from "./legacy-mutation-policy";
import {
  facultRootDir,
  pathsPhysicallyEquivalent,
  projectRootFromAiRoot,
  readFacultConfig,
  withFacultRootScope,
} from "./paths";
import {
  assertManifestIntegrity,
  assertManifestSignature,
} from "./remote-manifest-integrity";
import { loadProviderManifest } from "./remote-providers";
import {
  assertSourceAllowed,
  evaluateSourceTrust,
  sourcesCommand as runSourcesCommand,
} from "./remote-source-policy";
import { readIndexSources, resolveKnownIndexSource } from "./remote-sources";
import {
  BUILTIN_INDEX_NAME,
  BUILTIN_INDEX_URL,
  CLAWHUB_INDEX_NAME,
  GLAMA_INDEX_NAME,
  type IndexSource,
  type LoadManifestHints,
  type RemoteAgentItem,
  type RemoteIndexItem,
  type RemoteIndexManifest,
  type RemoteInstructionItem,
  type RemoteItemType,
  type RemoteMcpItem,
  type RemoteSkillItem,
  type RemoteSnippetItem,
  SKILLS_SH_INDEX_NAME,
  SMITHERY_INDEX_NAME,
} from "./remote-types";
import { validateSnippetMarkerName } from "./snippets";
import { loadSourceTrustState, type SourceTrustLevel } from "./source-trust";
import { parseJsonLenient } from "./util/json";

const REMOTE_STATE_VERSION = 1;
const VERSION_TOKEN_RE = /[A-Za-z]+|[0-9]+/g;
// biome-ignore lint/suspicious/noBitwiseOperators: secure open flags require OS bitmask composition.
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const QUERY_SPLIT_RE = /\s+/;
const MD_EXT_RE = /\.md$/i;
const FILE_EXT_RE = /\.[A-Za-z0-9]+$/;
const TRAILING_SLASH_RE = /\/+$/;
const LEADING_SLASH_RE = /^\/+/;
const INSTRUCTION_TITLE_SPLIT_RE = /[-_.\s]+/;
const PROMPT_PATH_SPLIT_RE = /[,\n]/;
const GIT_WORKTREE_LINE_RE = /\r?\n/;
const AUTOMATION_STATUS_LINE_RE = /^status\s*=\s*"(?:ACTIVE|PAUSED)"\s*$/m;
const AUTOMATION_UPDATED_AT_LINE_RE = /^updated_at\s*=\s*\d+\s*$/m;

type BuiltinAutomationTemplateScope = "global" | "project" | "wide";

interface BuiltinAutomationTemplate {
  id: string;
  title: string;
  description: string;
  prompt: string;
  memory: string;
  defaultRRule: string;
  defaultStatus: "PAUSED" | "ACTIVE";
  defaultModel: string;
  defaultReasoningEffort: "low" | "medium" | "high";
  scope: BuiltinAutomationTemplateScope;
}

interface InstalledRemoteItem {
  ref: string;
  index: string;
  itemId: string;
  type: RemoteItemType;
  installedAs: string;
  path: string;
  version?: string;
  sourceUrl?: string;
  sourceTrustLevel?: SourceTrustLevel;
  installedAt: string;
}

interface AutomationCwdCandidate {
  value: string;
  label: string;
  hint?: string;
}

interface InstalledRemoteState {
  version: number;
  updatedAt: string;
  items: InstalledRemoteItem[];
}

interface RemoteCommandContext {
  homeDir?: string;
  rootDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
  strictSourceTrust?: boolean;
}

interface SearchResult {
  index: string;
  item: RemoteIndexItem;
  score: number;
}

interface InstallResult {
  ref: string;
  type: RemoteItemType;
  installedAs: string;
  path: string;
  sourceTrustLevel: SourceTrustLevel;
  dryRun: boolean;
  changedPaths: string[];
  skippedPaths?: string[];
}

interface UpdateCheckResult {
  installed: InstalledRemoteItem;
  latestVersion?: string;
  currentVersion?: string;
  status:
    | "up-to-date"
    | "outdated"
    | "missing-index"
    | "missing-item"
    | "blocked-source"
    | "review-source";
}

interface UpdateReport {
  checkedAt: string;
  checks: UpdateCheckResult[];
  applied: InstallResult[];
}

type VerifyCheckStatus =
  | "passed"
  | "failed"
  | "not-configured"
  | "not-applicable";

interface VerifySourceReport {
  checkedAt: string;
  source: {
    name: string;
    url: string;
    kind: IndexSource["kind"];
  };
  trust: {
    level: SourceTrustLevel;
    explicit: boolean;
    note?: string;
    updatedAt?: string;
  };
  checks: {
    fetch: VerifyCheckStatus;
    parse: VerifyCheckStatus;
    integrity: VerifyCheckStatus;
    signature: VerifyCheckStatus;
    items: number;
  };
  error?: string;
}

const BUILTIN_MANIFEST: RemoteIndexManifest = {
  name: BUILTIN_INDEX_NAME,
  url: BUILTIN_INDEX_URL,
  updatedAt: "2026-02-21T00:00:00.000Z",
  items: [
    {
      id: "skill-template",
      type: "skill",
      title: "Skill Template",
      description:
        "Production-ready SKILL.md scaffold with clear trigger, workflow, and output sections.",
      version: "1.0.0",
      tags: ["template", "dx", "skill"],
      skill: {
        name: "my-skill",
        files: {
          "SKILL.md": `---
description: "{{name}} workflow skill"
tags: [template, workflow]
---

# {{name}}

## When To Use
Use this skill when the task repeatedly follows a known workflow and you want consistent, reviewable outputs.

## Inputs
- Goal and expected outcome.
- Constraints (time, tooling, compatibility).
- Required artifacts (files, commands, links).

## Steps
1. Confirm scope and assumptions in one short summary.
2. Gather only the context needed to complete the task.
3. Execute the workflow incrementally and validate after each major change.
4. Report results with concrete file/command references and remaining risks.

## Output Contract
- Include what changed and why.
- Include validation evidence (tests/checks run).
- Include clear next steps when follow-up work exists.
`,
        },
      },
    },
    {
      id: "instruction-template",
      type: "instruction",
      title: "Instruction Template",
      description:
        "Reusable markdown instruction scaffold with ref and snippet composition examples.",
      version: "1.0.0",
      tags: ["template", "dx", "instruction"],
      instruction: {
        name: "WORKFLOW.md",
        content: `---
description: "{{name}} reusable instruction"
tags: [instruction, workflow]
---

# {{title}}

Use this instruction when the task needs repeatable guidance that should be discoverable, targetable by writeback, and composable into agent docs.

## Scope

- Applies to:
- Does not apply to:
- Project-specific overrides:

## Guidance

- Keep the rule concrete enough that another agent can follow it without chat context.
- Link deeper reusable guidance with canonical refs such as \`@ai/instructions/VERIFICATION.md\` or \`@project/instructions/TESTING.md\`.
- Reuse stable partials with snippet markers when the same block appears in more than one rendered doc.

## Composition

<!-- fclty:global/team/example -->
<!-- /fclty:global/team/example -->

## Writeback Targeting

Record durable friction against this instruction with:

\`\`\`bash
fclt ai writeback add --kind missing_context --summary "<what was missing>" --asset instruction:{{assetName}}
\`\`\`
`,
      },
    },
    {
      id: "mcp-stdio-template",
      type: "mcp",
      title: "MCP Stdio Template",
      description:
        "Safe starting MCP server entry with explicit command/args/env placeholders.",
      version: "1.0.0",
      tags: ["template", "dx", "mcp"],
      mcp: {
        name: "example-server",
        definition: {
          command: "node",
          args: ["./servers/{{name}}/index.js"],
          env: {
            API_KEY: "<set-me>",
          },
          enabledFor: [],
        },
      },
    },
    {
      id: "agent-template",
      type: "agent",
      title: "Canonical Agent Template",
      description:
        "Starter canonical subagent scaffold for focused, reviewable specialist behavior.",
      version: "1.0.0",
      tags: ["template", "dx", "agent"],
      agent: {
        fileName: "agent.toml",
        content: `name = "{{name}}"
description = "Describe the focused responsibility for {{name}}."

developer_instructions = """
You are {{name}}.

Operate with a tight scope.

Prioritize:
- one clear responsibility
- concrete evidence over vague summaries
- explicit assumptions and blockers
- outputs that are easy for the calling agent to apply

Return:
- what you changed or found
- what you verified
- what still needs a decision
"""
`,
      },
    },
    {
      id: "agents-md-template",
      type: "agent",
      title: "AGENTS.md Template",
      description:
        "Project-wide agent instruction template optimized for clarity, quality gates, and DX.",
      version: "1.0.0",
      tags: ["template", "dx", "instructions"],
      agent: {
        fileName: "AGENTS.md",
        content: `# Project Agent Instructions

## Mission
Ship reliable changes quickly while keeping behavior predictable.

## Working Rules
- Prefer small, reviewable diffs.
- Preserve existing style and architecture unless a refactor is explicitly requested.
- Validate behavior with tests/checks after meaningful changes.
- Avoid destructive actions unless explicitly approved.

## Engineering Quality
- Keep implementations simple and observable.
- Fail with actionable error messages.
- Prioritize backwards compatibility and data safety.

## Delivery Format
- Summarize what changed.
- Include file and command references.
- Call out open risks and next steps.
`,
      },
    },
    {
      id: "claude-md-template",
      type: "agent",
      title: "CLAUDE.md Template",
      description:
        "Agent-specific instruction template for consistent collaboration and output quality.",
      version: "1.0.0",
      tags: ["template", "dx", "instructions"],
      agent: {
        fileName: "CLAUDE.md",
        content: `# Claude Working Contract

## Default Mode
- Be concise, factual, and implementation-first.
- Prefer executable steps over abstract advice.

## Safety + Correctness
- Verify assumptions in code or tests before claiming completion.
- Surface uncertainties explicitly.
- Never leak secrets or include sensitive raw values in logs/output.

## Code Expectations
- Write readable code with clear intent.
- Add tests for behavior changes.
- Keep command usage reproducible.

## Response Expectations
- Lead with outcome.
- Include concrete references to files and validation.
- End with the smallest useful next-step list.
`,
      },
    },
    {
      id: "snippet-template",
      type: "snippet",
      title: "Snippet Template",
      description:
        "Reusable snippet block template for a compact quality checklist.",
      version: "1.0.0",
      tags: ["template", "dx", "snippet"],
      snippet: {
        marker: "team/quality-checklist",
        content: `## Quality Checklist
- Is behavior correct for edge cases?
- Are failure modes clear and actionable?
- Is the change minimal for the goal?
`,
      },
    },
  ],
};

const BUILTIN_AUTOMATION_TEMPLATES: BuiltinAutomationTemplate[] = [
  {
    id: "learning-review",
    title: "Learning Review Loop",
    description:
      "Daily/weekly Codex session review that converts repeated signals into fclt writebacks and evolution candidates.",
    defaultRRule: "RRULE:FREQ=DAILY;BYHOUR=19;BYMINUTE=0",
    defaultStatus: "PAUSED",
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "high",
    scope: "wide",
    memory: `# Learning Review Loop

Use this memory for pattern continuity:

- Primary goal: convert repeated, evidence-backed session signal into durable writeback or evolution, not chat-only summary.
- For wide reviews, partition evidence by cwd first; do not let one repo's evidence stand in for another.
- Grounding: prefer evidence from session messages, tool calls, shell commands, diffs, tests, commits, and touched files.
- Threshold: only encode signal when you can name what was learned, why it matters, and the most plausible destination.
- Scope: default to project writeback only when the repo has a project-local \`.ai\` root for capability context. If a local writable repo is missing one, preview baseline project AI state with \`fclt project init --json\`, review the exact plan, and apply it with the returned plan hash only when authorized. Writeback/evolution review artifacts still belong under global \`~/.ai/writebacks/projects/...\` and \`~/.ai/evolution/projects/...\`, not inside the repo-local \`.ai\`. If enrollment is not authorized, fails, or the repo is not writable, treat that as the blocker instead of silently falling back to global runtime state.
- Promote to global only when the same signal appears across multiple repos or clearly targets shared doctrine, shared agents, or shared skills.
- Verification: distinguish one-off friction from a repeated pattern before escalating it.
- If available, use [$feedback-loop-setup]({{feedbackLoopSkill}}) when the review needs stronger feedback loops or verification framing.
- If available, use [$capability-evolution]({{capabilityEvolutionSkill}}) when repeated signal should become a concrete proposal.
- If available, delegate bounded review slices to \`learning-extractor\`, \`writeback-curator\`, \`scope-promoter\`, \`evolution-planner\`, or \`verification-auditor\` when that materially improves the review.
`,
    prompt: `Goal: review recent Codex work in the configured CWDs and convert durable, evidence-backed signal into writebacks or reviewable evolution proposals.

Before producing output:
- Treat [AGENTS.md]({{codexAgents}}) as the rendered operating-model baseline for this Codex environment.
- Use [LEARNING_AND_WRITEBACK.md]({{aiLearningAndWriteback}}) and [EVOLUTION.md]({{aiEvolution}}) as the durable doctrine for writeback and capability change decisions.
- Use [FEEDBACK_LOOPS.md]({{aiFeedbackLoops}}) and [VERIFICATION.md]({{aiVerification}}) when you need stronger loop design or more defensible proof.
- If available, use [$feedback-loop-setup]({{feedbackLoopSkill}}) when you need stronger feedback loops, success criteria, or verification framing.
- If available, use [$capability-evolution]({{capabilityEvolutionSkill}}) when repeated signal appears strong enough to become a durable capability proposal.
- If it will materially improve quality, explicitly ask Codex to spawn narrow subagents such as \`learning-extractor\`, \`writeback-curator\`, \`scope-promoter\`, \`evolution-planner\`, or \`verification-auditor\`. Only use them for bounded, non-overlapping review slices.

Grounding rules:
- Work only from evidence in Codex sessions and nearby repo artifacts for the configured CWDs.
- Partition the review by cwd first. Name which configured cwds had real evidence this run and which did not.
- Prefer evidence from session messages, tool calls, shell commands, diffs, tests, commits, and touched files.
- Do not speculate about intent or propose changes that are not anchored in evidence.
- Distinguish one-off friction from repeated signal. Escalate only when the signal is durable enough to matter.

Decision rules:
- Use \`fclt ai writeback add\` when the signal, target asset, and scope are clear.
- Before attempting project-scoped writeback, verify the cwd has a repo-local \`.ai\` root for capability context. If it does not and the cwd is a local writable repo, run \`fclt project init --json\`, review its exact writes, and apply the unchanged plan with \`--apply --plan-sha <sha>\` only when authorized. Do not write writeback/evolution review artifacts into the repo-local \`.ai\`; fclt mirrors them under global \`~/.ai/writebacks/projects/...\` and \`~/.ai/evolution/projects/...\` with cwd/project metadata. If enrollment is not authorized, fails, or the repo is not writable, report the writeback as blocked by missing project AI state rather than falling back to merged/global runtime state.
- Before passing \`--asset\`, verify the target resolves in the Facult graph. If the destination is a raw file path or otherwise not graph-backed, report that as a missing-asset blocker instead of retrying blind.
- Use \`fclt ai evolve\` only when repeated signal is strong enough to justify a reviewable capability change.
- Prefer project scope unless the learning clearly belongs in shared global doctrine, shared agents, shared skills, or other cross-project capability.
- For wide automations, require repeated evidence across more than one cwd before recommending a global/shared capability change unless the target is obviously global.
- Skip weak, speculative, or purely anecdotal observations.

Verification:
- Verify every claim against at least one concrete artifact.
- Call out residual uncertainty instead of overstating confidence.
- Separate missing context, weak verification, failed execution, and reusable pattern; do not collapse them together.

Output:
- Coverage: which cwds had concrete evidence, and which were effectively idle for this run.
- Recorded writebacks: what you recorded, why, and the target asset or command used.
- Evolution candidates: only the strongest repeated signals, with rationale and likely scope.
- Watch list: promising signals not yet strong enough to encode.
- Gaps in current operating model or verification harness: only if evidence supports them.

Keep the result concise, high-signal, and operational. If nothing crosses the threshold, say what you reviewed and why no writeback or evolution was justified.`,
  },
  {
    id: "evolution-review",
    title: "Evolution Review Loop",
    description:
      "Weekly Codex review of open evolution proposals and strong writeback clusters, with suggested next actions for review, acceptance, rejection, promotion, or apply.",
    defaultRRule: "RRULE:FREQ=WEEKLY;BYHOUR=16;BYMINUTE=0;BYDAY=FR",
    defaultStatus: "PAUSED",
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "high",
    scope: "wide",
    memory: `# Evolution Review Loop

Use this memory for continuity:

- Primary goal: keep proposal review moving so durable changes do not stall after writeback.
- Review continuity matters: track which proposals were already seen, what changed since the last review, and which action was previously recommended.
- Prefer reviewing existing proposal and writeback state over rediscovering the entire history from scratch.
- Scope: default to project evolution unless the proposal clearly belongs in shared doctrine, shared agents, shared skills, or another cross-project capability.
- For wide reviews, partition by cwd first and only recommend shared/global promotion when evidence truly spans multiple repos or the target asset is obviously shared.
- Recommend actions, do not silently apply high-risk changes.
- If available, use [$capability-evolution]({{capabilityEvolutionSkill}}) when proposal shaping or promotion decisions need stronger structure.
- If available, use [$feedback-loop-setup]({{feedbackLoopSkill}}) when proposal validity depends on weak or stale verification.
- If available, delegate bounded slices to \`evolution-planner\`, \`scope-promoter\`, \`writeback-curator\`, or \`verification-auditor\` when that materially improves rigor.
`,
    prompt: `Goal: review current evolution state in the configured CWDs, keep proposal continuity intact, and suggest the highest-signal next actions for draft, review, accept, reject, promote, supersede, or apply.

Before producing output:
- Treat [AGENTS.md]({{codexAgents}}) as the rendered operating-model baseline for this Codex environment.
- Use [EVOLUTION.md]({{aiEvolution}}), [LEARNING_AND_WRITEBACK.md]({{aiLearningAndWriteback}}), and [VERIFICATION.md]({{aiVerification}}) as the doctrine for proposal quality, thresholding, and proof.
- Use [FEEDBACK_LOOPS.md]({{aiFeedbackLoops}}) when a proposal depends on a weak or gameable verification loop.
- If available, use [$capability-evolution]({{capabilityEvolutionSkill}}) when you need stronger proposal-shaping or promotion judgment.
- If available, use [$feedback-loop-setup]({{feedbackLoopSkill}}) when proposal validity depends on missing or stale verification.
- If it will materially improve quality, explicitly ask Codex to spawn narrow subagents such as \`evolution-planner\`, \`scope-promoter\`, \`writeback-curator\`, or \`verification-auditor\`. Only use them for bounded, non-overlapping review slices.

Grounding rules:
- Work from concrete proposal and writeback artifacts first, then confirm with nearby repo evidence when needed.
- Preserve continuity: compare this run against the automation memory and note what is actually new, unchanged, strengthened, weakened, accepted, rejected, or stale.
- Partition the review by cwd first. Name which configured cwds had real proposal or writeback state this run and which did not.
- Do not speculate about intent or recommend advancing a proposal without citing the evidence that still supports it.
- Distinguish proposal quality problems from execution gaps, stale evidence, missing verification, and simple lack of reviewer attention.

Decision rules:
- Prefer suggesting the next operator action over narrating the whole proposal history.
- Recommend \`draft\` when a proposal exists but is under-specified.
- Recommend \`review\` or \`accept\` only when the rationale, scope, and evidence are strong enough.
- Recommend \`apply\` only for already-accepted proposals whose evidence still looks valid and whose risk is appropriate.
- Recommend \`reject\` or \`supersede\` when the proposal is stale, contradicted, duplicated, or too weak.
- Recommend \`promote --to global\` only when a project-scoped proposal now clearly belongs in shared doctrine, shared agents, shared skills, or another cross-project surface.
- For wide automations, require repeated evidence across more than one cwd before recommending shared/global promotion unless the target is obviously global.

Verification:
- Verify every recommendation against at least one concrete artifact.
- Call out residual uncertainty instead of overstating confidence.
- If a proposal should move forward but the proof is weak, say exactly what verification is missing.

Output:
- Coverage: which cwds had concrete proposal/writeback evidence, and which were effectively idle for this run.
- Proposal queue: the strongest active proposals or proposal-worthy clusters, with what changed since the last review.
- Recommended actions: for each important item, the next operator action and why.
- Hold or reject: proposals that should stay parked, be rejected, or be superseded.
- Verification gaps: only the missing proof that materially blocks a recommendation.

Keep the result concise, continuity-aware, and operational. If nothing is ready to move, say what you reviewed and why no proposal should advance this run.`,
  },
  {
    id: "closed-loop-review",
    title: "Closed-Loop Evolution Review",
    description:
      "Runs incremental source reconciliation, maintains the full review queue, and emits only decision-relevant deltas.",
    defaultRRule: "RRULE:FREQ=DAILY;BYHOUR=19;BYMINUTE=0",
    defaultStatus: "PAUSED",
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "high",
    scope: "project",
    memory: `# Closed-Loop Evolution Review

- Treat \`fclt ai loop run --json\` as the source of truth for the current queue and run delta.
- Preserve the full queue in the report. Suppress unchanged carry-forward only in notifications.
- Surface only new or changed decisions, degraded coverage, approval needs, overdue verification, recurrence, or regression.
- Never mark an applied proposal successful before effectiveness evidence is recorded.
- Never mutate an external tracker. Linked work is evidence and a target for an authorized operator.
- Project-local automatic apply remains plan-only until the CLI returns a hash-bound transaction and rollback receipt.
- Global instructions, skills, plugins, and shared capability remain proposal-only.
`,
    prompt: `Goal: run the configured fclt closed-loop evolution review for this cwd and report only decision-relevant changes.

Run \`fclt ai loop run {{loopScopeFlag}} {{loopRootArg}} --scheduled --json\` exactly once from the configured cwd. The rendered command uses the native shell contract: PowerShell on Windows and POSIX shell syntax elsewhere.

Use the returned full queue for current truth, but keep the user-facing notification delta-only:
- report new or changed decisions,
- report degraded or unavailable source coverage,
- report approval needs,
- report verification that is due or overdue,
- report recurrence, unchanged outcomes, or regressions,
- report any mutation applied under the explicit project-local policy.

Do not repeat unchanged queue items. Do not create one proposal per linked ticket. Do not mutate external systems. If the run fails, report the recorded attempts and exact recovery action from the JSON result.`,
  },
  {
    id: "tool-call-audit",
    title: "Tool Call Audit",
    description:
      "Checks whether repeated Codex tool usage looks repetitive or missing guardrails and proposes operating-model adjustments.",
    defaultRRule: "RRULE:FREQ=WEEKLY;BYHOUR=10;BYMINUTE=0;BYDAY=MO,WE,FR",
    defaultStatus: "PAUSED",
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "high",
    scope: "wide",
    memory: `# Tool Call Audit

Use this memory for continuity:

- Focus on repeated tool failures, retries, shallow-success loops, and missing operating-model guardrails.
- Distinguish whether the root issue is instruction quality, missing verification, missing skill usage, missing subagent delegation, or a real tool limitation.
- Prefer reusable operating-model changes over one-off commentary.
- If available, use [$feedback-loop-setup]({{feedbackLoopSkill}}) when the audit reveals weak or gameable verification loops.
- If available, use [$capability-evolution]({{capabilityEvolutionSkill}}) when the same pattern should become a lasting capability change.
- If available, delegate bounded slices to \`verification-auditor\`, \`writeback-curator\`, or \`evolution-planner\` when that improves rigor.
`,
    prompt: `Goal: audit recent Codex tool and agent usage in the configured CWDs, find repeated high-cost patterns, and turn strong evidence into operating-model improvements.

Before producing output:
- Treat [AGENTS.md]({{codexAgents}}) as the rendered operating-model baseline for this Codex environment.
- Use [LEARNING_AND_WRITEBACK.md]({{aiLearningAndWriteback}}), [EVOLUTION.md]({{aiEvolution}}), and [VERIFICATION.md]({{aiVerification}}) when deciding whether a repeated operational pattern deserves durable change.
- Use [FEEDBACK_LOOPS.md]({{aiFeedbackLoops}}) when the audit exposes weak, stale, or gameable loops.
- If available, use [$feedback-loop-setup]({{feedbackLoopSkill}}) when the audit exposes weak, stale, or gameable verification loops.
- If available, use [$capability-evolution]({{capabilityEvolutionSkill}}) when repeated operational pain should become a durable capability proposal.
- If it will materially improve rigor, explicitly ask Codex to spawn focused subagents such as \`verification-auditor\`, \`writeback-curator\`, \`scope-promoter\`, or \`evolution-planner\`.

Grounding rules:
- Anchor findings in concrete evidence from session messages, tool calls, shell commands, diffs, tests, commits, and touched files.
- Focus on repeated misses, repeated retries, expensive dead ends, missing skill use, missing delegation, or weak proof of correctness.
- Do not report style-only observations unless they hide a real operational problem.

For each candidate pattern, determine:
- what tool, agent, or command pattern recurred,
- what the actual failure mode or inefficiency was,
- what evidence supports the pattern,
- whether the better fix is instruction, skill usage, subagent usage, verification, or a capability change.

Decision rules:
- Use \`fclt ai writeback add\` when the signal and target destination are clear.
- Use \`fclt ai evolve\` only when the pattern is repeated enough to justify a durable capability change.
- Prefer project scope unless the problem clearly generalizes across projects or global doctrine.
- Skip isolated incidents that do not justify durable change.

Output:
- Recorded writebacks.
- Evolution candidates.
- Watch list.
- Operational gaps: the most important missing skill, missing instruction, weak loop, or missing guardrail revealed by the audit.

Keep the output concise, evidence-backed, and biased toward durable improvement rather than narration.`,
  },
];

function isSafePathString(p: string): boolean {
  return !p.includes("\0");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function parseSourceTrustLevel(raw: unknown): SourceTrustLevel | undefined {
  if (raw === "trusted" || raw === "review" || raw === "blocked") {
    return raw;
  }
  return undefined;
}

function renderTemplate(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function automationTemplateValues(homeDir: string): Record<string, string> {
  const codexRoot = join(homeDir, ".codex");
  const aiRoot = join(homeDir, ".ai");
  return {
    codexAgents: join(codexRoot, "AGENTS.md"),
    aiLearningAndWriteback: join(
      aiRoot,
      "instructions",
      "LEARNING_AND_WRITEBACK.md"
    ),
    aiEvolution: join(aiRoot, "instructions", "EVOLUTION.md"),
    aiFeedbackLoops: join(aiRoot, "instructions", "FEEDBACK_LOOPS.md"),
    aiVerification: join(aiRoot, "instructions", "VERIFICATION.md"),
    feedbackLoopSkill: join(
      codexRoot,
      "skills",
      "feedback-loop-setup",
      "SKILL.md"
    ),
    capabilityEvolutionSkill: join(
      codexRoot,
      "skills",
      "capability-evolution",
      "SKILL.md"
    ),
  };
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

export function quoteAutomationShellArg(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteTomlStringArray(values: string[]): string {
  return `[${values.map(quoteTomlString).join(", ")}]`;
}

async function atomicWriteFile(pathValue: string, body: string): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  const temporaryPath = `${pathValue}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(temporaryPath, body);
  await rename(temporaryPath, pathValue);
}

function normalizeCwdList(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isInteractiveOutputRequested(args: string[]): boolean {
  return (
    !(
      args.includes("--json") ||
      args.includes("--yes") ||
      args.includes("--non-interactive")
    ) &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  );
}

function parseAutomationScope(
  raw: string | null
): BuiltinAutomationTemplateScope | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "global" ||
    normalized === "project" ||
    normalized === "wide"
  ) {
    return normalized;
  }
  return null;
}

function expandPathForUserHome(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/")) {
    return join(home, p.slice(2));
  }
  return p;
}

function normalizeCwdInput(
  raw: string,
  cwd: string,
  homeDir: string
): string[] {
  return normalizeCwdList(raw)
    .map((entry) => {
      const expanded = expandPathForUserHome(entry, homeDir);
      return resolve(cwd, expanded);
    })
    .filter((entry) => isSafePathString(entry));
}

function normalizePromptPath(
  raw: string,
  cwd: string,
  homeDir: string
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return resolve(cwd, expandPathForUserHome(trimmed, homeDir));
}

function normalizePromptPathList(
  raw: string,
  cwd: string,
  homeDir: string
): string[] {
  return raw
    .split(PROMPT_PATH_SPLIT_RE)
    .map((entry) => normalizePromptPath(entry, cwd, homeDir))
    .filter((value): value is string => Boolean(value));
}

function runGitCommand(
  cwd: string,
  args: string[]
): { stdout: string; status: number } | null {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    if (!result || result.status === null || result.status === undefined) {
      return null;
    }
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      status: result.status,
    };
  } catch {
    return null;
  }
}

export function findGitRootFromPath(cwd: string): string | null {
  const result = runGitCommand(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result || result.status !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root || null;
}

function parseGitWorktreeList(raw: string): string[] {
  const lines = raw.split(GIT_WORKTREE_LINE_RE);
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const value = line.slice("worktree ".length).trim();
    if (value) {
      out.push(value);
    }
  }
  return out;
}

async function addGitWorkspaceCandidatesFromDirectory(
  root: string,
  out: Map<string, AutomationCwdCandidate>,
  homeDir: string
) {
  const gitRootPath = resolve(root);
  const direct = normalizePromptPath(root, gitRootPath, homeDir);
  if (direct) {
    const gitFile = join(gitRootPath, ".git");
    try {
      await Bun.file(gitFile).stat();
      out.set(gitRootPath, {
        value: gitRootPath,
        label: `${basename(gitRootPath)} (root)`,
        hint: `Git root: ${gitRootPath}`,
      });
    } catch {
      // Not a git root at this path.
    }
  }

  const dirEntries = await readdir(root, { withFileTypes: true }).catch(
    () => []
  );
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(root, entry.name);
    const gitDir = join(candidate, ".git");
    try {
      await Bun.file(gitDir).stat();
      const abs = resolve(candidate);
      const existing = out.get(abs);
      if (!existing) {
        out.set(abs, {
          value: abs,
          label: `${entry.name} (candidate)`,
          hint: `Git workspace: ${abs}`,
        });
      }
    } catch {
      // Not a git directory.
    }
  }
}

async function collectKnownAutomationCwdCandidates(
  homeDir: string,
  cwd: string
): Promise<AutomationCwdCandidate[]> {
  const discovered = new Map<string, AutomationCwdCandidate>();
  const cwdResolved = resolve(cwd);

  const gitRoot = findGitRootFromPath(cwdResolved);
  if (gitRoot) {
    const worktreeResult = runGitCommand(gitRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    if (worktreeResult && worktreeResult.status === 0) {
      for (const pathValue of parseGitWorktreeList(worktreeResult.stdout)) {
        const abs = resolve(pathValue);
        if (!discovered.has(abs)) {
          discovered.set(abs, {
            value: abs,
            label: `${basename(abs)} (git worktree)`,
            hint: abs,
          });
        }
      }
    }

    if (discovered.size === 0) {
      const abs = resolve(gitRoot);
      discovered.set(abs, {
        value: abs,
        label: `${basename(abs)} (project root)`,
        hint: abs,
      });
    }
  }

  const cfg = readFacultConfig(homeDir);
  for (const rawPath of cfg?.scanFrom ?? []) {
    const scanRoot = expandPathForUserHome(rawPath, homeDir);
    await addGitWorkspaceCandidatesFromDirectory(scanRoot, discovered, homeDir);
  }

  const automationRoot = join(homeDir, ".codex", "automations");
  const entries = await readdir(automationRoot, { withFileTypes: true }).catch(
    () => []
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const tomlPath = join(automationRoot, entry.name, "automation.toml");
    try {
      const rawToml = await Bun.file(tomlPath).text();
      const parsed = Bun.TOML.parse(rawToml) as Record<string, unknown>;
      const cwds = parsed.cwds;
      if (!Array.isArray(cwds)) {
        continue;
      }
      for (const rawValue of cwds) {
        if (typeof rawValue !== "string") {
          continue;
        }
        const normalized = normalizePromptPath(rawValue, cwdResolved, homeDir);
        if (!normalized) {
          continue;
        }
        const label = basename(normalized);
        if (!discovered.has(normalized)) {
          discovered.set(normalized, {
            value: normalized,
            label: `${label} (from Codex automation)`,
            hint: normalized,
          });
        }
      }
    } catch {
      // Ignore malformed or missing automation files.
    }
  }

  return Array.from(discovered.values()).sort((a, b) =>
    a.label.localeCompare(b.label, "en-US")
  );
}

async function resolveAutomationScopeInputs(opts: {
  template: BuiltinAutomationTemplate;
  requestedScope: string | null;
  requestedProjectRoot: string | null;
  requestedCwdsRaw: string | null;
  requestedCwdsArray?: string[];
  homeDir: string;
  cwd: string;
  interactive: boolean;
}): Promise<{
  scope: string | null;
  projectRoot: string | null;
  cwds: string[] | null;
}> {
  const parsedRequestedScope = parseAutomationScope(opts.requestedScope);
  if (opts.requestedScope && !parsedRequestedScope) {
    throw new Error(`Unsupported automation scope: ${opts.requestedScope}`);
  }

  const requestedCwds = opts.requestedCwdsArray?.length
    ? opts.requestedCwdsArray
    : normalizeCwdInput(opts.requestedCwdsRaw ?? "", opts.cwd, opts.homeDir);
  const requestedProjectRoot = opts.requestedProjectRoot
    ? normalizePromptPath(opts.requestedProjectRoot, opts.cwd, opts.homeDir)
    : null;

  if (
    !opts.interactive ||
    (parsedRequestedScope &&
      (parsedRequestedScope === "global" || parsedRequestedScope === "wide") &&
      requestedCwds.length > 0) ||
    (parsedRequestedScope === "project" && requestedProjectRoot)
  ) {
    return {
      scope: parsedRequestedScope,
      projectRoot:
        parsedRequestedScope === "project" ? requestedProjectRoot : null,
      cwds:
        parsedRequestedScope === "global" || parsedRequestedScope === "wide"
          ? requestedCwds
          : [],
    };
  }

  const candidates = await collectKnownAutomationCwdCandidates(
    opts.homeDir,
    opts.cwd
  );
  const scopeDefault: BuiltinAutomationTemplateScope =
    parsedRequestedScope ?? opts.template.scope;

  let scope: BuiltinAutomationTemplateScope = scopeDefault;
  if (parsedRequestedScope) {
    scope = parsedRequestedScope;
  } else {
    const chosen = await select({
      message: "Choose automation scope",
      options: [
        { value: "project", label: "project", hint: "Track one project root" },
        {
          value: "wide",
          label: "wide",
          hint: "Track many explicit project roots",
        },
        {
          value: "global",
          label: "global",
          hint: "Create a global/default scaffold",
        },
      ],
      initialValue: scopeDefault,
    });
    if (isCancel(chosen)) {
      process.exit(1);
    }
    scope = chosen;
  }

  if (scope === "project" && !requestedProjectRoot) {
    if (!candidates.length) {
      const txt = await text({
        message: "Project root path",
        placeholder: opts.cwd,
      });
      if (isCancel(txt) || !txt || typeof txt !== "string") {
        process.exit(1);
      }
      return {
        scope,
        projectRoot: normalizePromptPath(txt, opts.cwd, opts.homeDir),
        cwds: [],
      };
    }

    const choices = [
      ...candidates.map((c) => ({
        value: c.value,
        label: c.label,
        hint: c.hint,
      })),
      {
        value: "__custom__",
        label: "Custom project path",
        hint: "Enter a different absolute or relative path",
      },
    ];
    const chosen = await select({
      message: "Select project scope root",
      options: choices,
      initialValue: candidates[0]?.value ?? "__custom__",
    });
    if (isCancel(chosen)) {
      process.exit(1);
    }
    if (chosen === "__custom__") {
      const txt = await text({
        message: "Project root path",
        placeholder: opts.cwd,
      });
      if (isCancel(txt) || !txt || typeof txt !== "string") {
        process.exit(1);
      }
      return {
        scope,
        projectRoot: normalizePromptPath(txt, opts.cwd, opts.homeDir),
        cwds: [],
      };
    }
    return { scope, projectRoot: chosen, cwds: [] };
  }

  if (scope === "global" || scope === "wide") {
    if (requestedCwds.length > 0) {
      return { scope, projectRoot: null, cwds: requestedCwds };
    }

    if (!candidates.length) {
      const txt = await text({
        message: "Workspace paths (comma-separated or leave blank for none)",
        placeholder: "",
      });
      if (isCancel(txt) || typeof txt !== "string") {
        process.exit(1);
      }
      const parsed = normalizePromptPathList(txt, opts.cwd, opts.homeDir);
      return { scope, projectRoot: null, cwds: parsed };
    }

    const chosen = await multiselect({
      message: "Select workspaces",
      options: [
        ...candidates.map((c) => ({
          value: c.value,
          label: c.label,
          hint: c.hint,
        })),
        {
          value: "__manual__",
          label: "Add custom paths",
          hint: "Comma-separated absolute or relative paths",
        },
      ],
      required: false,
    });
    if (isCancel(chosen) || !Array.isArray(chosen)) {
      process.exit(1);
    }

    const base = chosen.filter((value) => value !== "__manual__");
    if (!chosen.includes("__manual__")) {
      return { scope, projectRoot: null, cwds: base };
    }

    const manual = await text({
      message: "Additional workspace paths (comma-separated)",
      placeholder: "",
    });
    if (isCancel(manual) || typeof manual !== "string") {
      process.exit(1);
    }
    const manualList = normalizePromptPathList(manual, opts.cwd, opts.homeDir);
    return {
      scope,
      projectRoot: null,
      cwds: uniqueSorted([...base, ...manualList]),
    };
  }

  return {
    scope,
    projectRoot: null,
    cwds: requestedCwds,
  };
}

function sanitizeAutomationName(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) {
    throw new Error("Invalid automation name");
  }
  return safe;
}

function pickScopeTemplateCwds(opts: {
  template: BuiltinAutomationTemplate;
  requestedScope: string | null;
  providedCwds: string[];
  projectRoot: string | null;
  cwd: string;
}): string[] {
  const requested = (opts.requestedScope ?? "global").trim().toLowerCase();
  if (!["global", "project", "wide"].includes(requested)) {
    throw new Error(`Unsupported automation scope: ${opts.requestedScope}`);
  }

  if (requested === "project") {
    if (opts.projectRoot) {
      return [resolve(opts.projectRoot)];
    }
    return [resolve(opts.cwd)];
  }

  if (opts.providedCwds.length) {
    return opts.providedCwds.map((pathValue) => resolve(pathValue));
  }

  if (opts.template.scope === "project") {
    return [resolve(opts.cwd)];
  }

  return [];
}

export async function scaffoldCodexAutomationTemplate(args: {
  homeDir?: string;
  cwd?: string;
  templateId: string;
  force?: boolean;
  dryRun?: boolean;
  name?: string;
  scope?: string | null;
  projectRoot?: string | null;
  rootDir?: string | null;
  cwds?: string[] | null;
  cwdsRaw?: string | null;
  rrule?: string | null;
  status?: string | null;
}): Promise<{
  installedAs: string;
  path: string;
  dryRun: boolean;
  changedPaths: string[];
}> {
  const home = args.homeDir ?? homedir();
  const cwd = resolve(args.cwd ?? process.cwd());
  const template = BUILTIN_AUTOMATION_TEMPLATES.find(
    (candidate) => candidate.id === args.templateId
  );
  if (!template) {
    throw new Error(`Unknown automation template: ${args.templateId}`);
  }

  const safeName = sanitizeAutomationName(args.name ?? template.id);
  const requestedCwds = Array.isArray(args.cwds)
    ? args.cwds
    : normalizeCwdList(args.cwdsRaw ?? "");
  const normalizedScope = (args.scope ?? template.scope).trim().toLowerCase();
  const cwds = pickScopeTemplateCwds({
    template,
    requestedScope: args.scope ?? null,
    providedCwds: requestedCwds,
    projectRoot: args.projectRoot ?? null,
    cwd,
  });
  if (template.id === "closed-loop-review" && normalizedScope === "wide") {
    throw new Error(
      "closed-loop-review supports one explicit project or global root; wide scope is not supported"
    );
  }

  const scopeStatus =
    args.status === "active" || args.status === "ACTIVE"
      ? "ACTIVE"
      : args.status === "paused" || args.status === "PAUSED"
        ? "PAUSED"
        : template.defaultStatus;
  const rrule = args.rrule?.trim() || template.defaultRRule;
  const model = template.defaultModel;
  const reasoningEffort = template.defaultReasoningEffort;
  const usesProjectLoopRoot = normalizedScope === "project";
  const selectedProjectLoopRoot = join(
    args.projectRoot ?? cwds[0] ?? cwd,
    ".ai"
  );
  if (
    template.id === "closed-loop-review" &&
    usesProjectLoopRoot &&
    args.rootDir &&
    resolve(args.rootDir) !== resolve(selectedProjectLoopRoot)
  ) {
    throw new Error(
      `Project closed-loop root ${resolve(args.rootDir)} must match the selected project root ${resolve(selectedProjectLoopRoot)}`
    );
  }
  const loopRootDir =
    args.rootDir ??
    (args.projectRoot
      ? join(args.projectRoot, ".ai")
      : usesProjectLoopRoot
        ? selectedProjectLoopRoot
        : facultRootDir(home));
  const templateValues = {
    ...automationTemplateValues(home),
    loopScopeFlag: normalizedScope === "global" ? "--global" : "--project",
    loopRootArg: `--root ${quoteAutomationShellArg(loopRootDir)}`,
  };
  const renderedPrompt = renderTemplate(template.prompt.trim(), templateValues);
  const renderedMemory = renderTemplate(template.memory.trim(), templateValues);

  const timestamp = String(Date.now());
  const automationPath = join(home, ".codex", "automations", safeName);
  const automationTomlPath = join(automationPath, "automation.toml");
  const memoryPath = join(automationPath, "memory.md");
  await assertSafeAutomationTarget({ home, safeName });

  const automationToml = `version = 1
id = ${quoteTomlString(safeName)}
name = ${quoteTomlString(template.title)}
${template.id === "closed-loop-review" ? 'managed_by = "fclt-evolution-loop"\n' : ""}prompt = ${quoteTomlString(renderedPrompt)}
status = ${quoteTomlString(scopeStatus)}
rrule = ${quoteTomlString(rrule)}
model = ${quoteTomlString(model)}
reasoning_effort = ${quoteTomlString(reasoningEffort)}
cwds = ${quoteTomlStringArray(cwds)}
created_at = ${timestamp}
updated_at = ${timestamp}
`;

  const memory = `${renderedMemory}\n`;
  const changedPaths: string[] = [];

  const automationTomlExists = await fileExists(automationTomlPath);
  if (!automationTomlExists || args.force) {
    changedPaths.push(automationTomlPath);
    if (!args.dryRun) {
      await atomicWriteFile(automationTomlPath, `${automationToml}\n`);
    }
  }

  const memoryExists = await fileExists(memoryPath);
  if (!memoryExists || args.force) {
    changedPaths.push(memoryPath);
    if (!args.dryRun) {
      await atomicWriteFile(memoryPath, memory);
    }
  }

  return {
    installedAs: safeName,
    path: automationPath,
    dryRun: Boolean(args.dryRun),
    changedPaths: uniqueSorted(changedPaths),
  };
}

export async function setCodexAutomationStatus(args: {
  homeDir?: string;
  name: string;
  status: "ACTIVE" | "PAUSED";
  dryRun?: boolean;
}): Promise<{
  path: string;
  status: "ACTIVE" | "PAUSED";
  changed: boolean;
  dryRun: boolean;
}> {
  const home = args.homeDir ?? homedir();
  const safeName = sanitizeAutomationName(args.name);
  await assertSafeAutomationTarget({ home, safeName });
  const pathValue = join(
    home,
    ".codex",
    "automations",
    safeName,
    "automation.toml"
  );
  if (!(await fileExists(pathValue))) {
    throw new Error(`Codex automation not found: ${safeName}`);
  }
  const current = await readFile(pathValue, "utf8");
  const parsed = Bun.TOML.parse(current) as Record<string, unknown>;
  if (parsed.id !== safeName) {
    throw new Error(`Codex automation id mismatch at ${pathValue}`);
  }
  if (parsed.managed_by !== "fclt-evolution-loop") {
    throw new Error(
      `Refusing to change an automation not owned by the fclt evolution loop: ${pathValue}`
    );
  }
  const currentStatus = parsed.status;
  if (currentStatus !== "ACTIVE" && currentStatus !== "PAUSED") {
    throw new Error(`Codex automation has an invalid status at ${pathValue}`);
  }
  const changed = currentStatus !== args.status;
  if (changed && !args.dryRun) {
    if (
      !(
        AUTOMATION_STATUS_LINE_RE.test(current) &&
        AUTOMATION_UPDATED_AT_LINE_RE.test(current)
      )
    ) {
      throw new Error(
        `Codex automation status or updated_at line is missing at ${pathValue}`
      );
    }
    const timestamp = String(Date.now());
    const next = current
      .replace(AUTOMATION_STATUS_LINE_RE, `status = "${args.status}"`)
      .replace(AUTOMATION_UPDATED_AT_LINE_RE, `updated_at = ${timestamp}`);
    const temporaryPath = `${pathValue}.${process.pid}.${timestamp}.tmp`;
    await Bun.write(temporaryPath, next);
    await rename(temporaryPath, pathValue);
  }
  return {
    path: pathValue,
    status: args.status,
    changed,
    dryRun: Boolean(args.dryRun),
  };
}

async function assertSafeAutomationTarget(args: {
  home: string;
  safeName: string;
}): Promise<void> {
  const root = join(args.home, ".codex", "automations");
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo) {
    return;
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`Codex automation root is not a directory: ${root}`);
  }
  const rootReal = await realpath(root);
  const target = join(root, args.safeName);
  const targetInfo = await lstat(target).catch(() => null);
  if (!targetInfo) {
    return;
  }
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new Error(`Refusing unsafe Codex automation directory: ${target}`);
  }
  const targetReal = await realpath(target);
  const targetRelative = relative(rootReal, targetReal);
  if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
    throw new Error(`Codex automation path escapes its root: ${target}`);
  }
  for (const leaf of ["automation.toml", "memory.md"]) {
    const leafPath = join(target, leaf);
    const leafInfo = await lstat(leafPath).catch(() => null);
    if (leafInfo?.isSymbolicLink()) {
      throw new Error(`Refusing symlinked Codex automation file: ${leafPath}`);
    }
  }
}

export async function assertSafeCodexAutomationTarget(args: {
  homeDir?: string;
  name: string;
}): Promise<void> {
  const home = args.homeDir ?? homedir();
  await assertSafeAutomationTarget({
    home,
    safeName: sanitizeAutomationName(args.name),
  });
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await Bun.file(pathValue).stat();
    return true;
  } catch {
    return false;
  }
}

async function ensurePackDirectory(pathValue: string): Promise<void> {
  try {
    const entry = await lstat(pathValue);
    if (entry.isSymbolicLink()) {
      try {
        await stat(pathValue);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          await rm(pathValue, { force: true });
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(pathValue, { recursive: true });
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => [] as import("node:fs").Dirent[]
    );
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  return out.sort();
}

interface BuiltinPackManifest {
  version: 1;
  pack: string;
  updatedAt: string;
  files: Record<string, { sha256: string }>;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function builtinPackManifestPath(rootDir: string): string {
  return join(rootDir, ".facult", "packs", "facult-operating-model.json");
}

async function readBuiltinPackManifest(
  rootDir: string
): Promise<BuiltinPackManifest | null> {
  const pathValue = builtinPackManifestPath(rootDir);
  if (!(await pathExists(pathValue))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await Bun.file(pathValue).text());
    if (
      parsed?.version === 1 &&
      parsed.pack === "facult-operating-model" &&
      isPlainObject(parsed.files)
    ) {
      return parsed as BuiltinPackManifest;
    }
  } catch {
    return null;
  }
  return null;
}

function serializeBuiltinPackManifest(manifest: BuiltinPackManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const PROJECT_AI_PROTECTIVE_IGNORE = `# fclt machine-local and generated state
/.facult/
/config.local.toml
`;

function appendProjectAiProtectiveIgnore(existing: string): string {
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const protections = PROJECT_AI_PROTECTIVE_IGNORE.trimEnd().split("\n");
  const protectedLines = new Set(protections);
  const out = lines.filter((line) => !protectedLines.has(line));
  while (out.at(-1) === "") {
    out.pop();
  }
  if (out.length > 0) {
    out.push("");
  }
  out.push(...protections);
  return `${out.join("\n")}\n`;
}

interface ProjectAiIgnoreSnapshot {
  content: string;
  identity: {
    dev: number;
    ino: number;
  } | null;
  mode: number | null;
}

function assertSafeProjectAiIgnoreEntry(
  pathValue: string,
  entry: Awaited<ReturnType<typeof lstat>>
): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error(`Refusing unsafe project ignore file: ${pathValue}`);
  }
}

async function assertSafeProjectAiIgnoreParent(
  pathValue: string
): Promise<void> {
  const parent = dirname(pathValue);
  const entry = await lstat(parent);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Refusing unsafe project ignore directory: ${parent}`);
  }
  if (!pathsPhysicallyEquivalent(await realpath(parent), resolve(parent))) {
    throw new Error(`Refusing unsafe project ignore directory: ${parent}`);
  }
}

async function readProjectAiIgnore(
  pathValue: string
): Promise<ProjectAiIgnoreSnapshot> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(pathValue);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", identity: null, mode: null };
    }
    throw error;
  }
  assertSafeProjectAiIgnoreEntry(pathValue, entry);
  const handle = await open(pathValue, NOFOLLOW_READ_FLAGS);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    ) {
      throw new Error(`Refusing unsafe project ignore file: ${pathValue}`);
    }
    return {
      content: await handle.readFile("utf8"),
      identity: { dev: opened.dev, ino: opened.ino },
      mode: opened.mode % 0o1000,
    };
  } finally {
    await handle.close();
  }
}

function sameProjectAiIgnoreSnapshot(
  left: ProjectAiIgnoreSnapshot,
  right: ProjectAiIgnoreSnapshot
): boolean {
  return (
    left.content === right.content &&
    left.identity?.dev === right.identity?.dev &&
    left.identity?.ino === right.identity?.ino &&
    left.mode === right.mode
  );
}

async function writeProjectAiIgnore(
  pathValue: string,
  content: string,
  expected: ProjectAiIgnoreSnapshot,
  beforeCommit: (() => Promise<void>) | undefined,
  safeRoot: string
): Promise<void> {
  await assertSafeProjectAiIgnoreParent(pathValue);
  const current = await readProjectAiIgnore(pathValue);
  if (!sameProjectAiIgnoreSnapshot(current, expected)) {
    throw new Error(`Project ignore file changed before commit: ${pathValue}`);
  }
  await replaceVerifiedFileAt({
    beforeExchange: beforeCommit,
    contents: content,
    directoryPath: dirname(pathValue),
    expected:
      expected.identity === null
        ? null
        : {
            contents: expected.content,
            identity: expected.identity,
            mode: expected.mode ?? 0o644,
          },
    fileName: basename(pathValue),
    maxBytes: Math.max(
      Buffer.byteLength(content),
      Buffer.byteLength(expected.content)
    ),
    mode: expected.mode ?? 0o644,
    safeRoot,
  });
}

const OPERATING_MODEL_SNIPPET_FRAME = `## Working mode

<!-- fclty:global/baseline -->
<!-- /fclty:global/baseline -->

<!-- fclty:global/core/work-units -->
<!-- /fclty:global/core/work-units -->

<!-- fclty:global/core/feedback-loops -->
<!-- /fclty:global/core/feedback-loops -->

<!-- fclty:global/core/verification -->
<!-- /fclty:global/core/verification -->

<!-- fclty:global/core/writeback -->
<!-- /fclty:global/core/writeback -->

## Shared instruction sources

- For work-unit definition and scope clarification, read \${refs.work_units}.
- For identifying, improving, and validating feedback loops, read \${refs.feedback_loops}.
- For verification and anti-false-positive checks, read \${refs.verification}.
- For checking integration boundaries, read \${refs.integration}.
- For learning, decisions, and writeback, read \${refs.learning_writeback}.
- For capability evolution, proposal kinds, and \`facult ai\` workflow, read \${refs.evolution}.
- For deciding whether something belongs in global or project scope, read \${refs.project_capability}.
- Add private language, coding, or writing refs in local config only when they belong to the user's own operating layer.
`;

function appendOperatingModelFrame(seedText: string): string {
  const normalized = seedText.trimEnd();
  if (normalized.includes("<!-- fclty:global/baseline -->")) {
    return `${normalized}\n`;
  }
  return `${normalized}\n\n## Facult Operating Model\n\n${OPERATING_MODEL_SNIPPET_FRAME}`;
}

async function firstExistingFileText(
  candidates: string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return await Bun.file(candidate).text();
    }
  }
  return null;
}

async function seedAgentsGlobalText(args: {
  homeDir?: string;
  fallbackText: string;
}): Promise<{ text: string; seededFromExisting: boolean }> {
  const home = args.homeDir ?? homedir();
  const seedText = await firstExistingFileText([
    join(home, ".codex", "AGENTS.md"),
    join(home, ".claude", "CLAUDE.md"),
    join(home, ".cursor", "AGENTS.md"),
  ]);
  if (!seedText?.trim()) {
    return { text: args.fallbackText, seededFromExisting: false };
  }
  return {
    text: appendOperatingModelFrame(seedText),
    seededFromExisting: true,
  };
}

export async function scaffoldBuiltinOperatingModelPack(args: {
  rootDir: string;
  homeDir?: string;
  dryRun?: boolean;
  force?: boolean;
  update?: boolean;
  installedAs?: string;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeProjectIgnoreCommit?: () => Promise<void>;
}): Promise<InstallResult> {
  const rootDir = resolve(args.rootDir);
  const packRoot = facultBuiltinPackRoot("facult-operating-model");
  const files = await listFilesRecursive(packRoot);
  const changedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const existingManifest = await readBuiltinPackManifest(rootDir);
  const manifestFiles: BuiltinPackManifest["files"] = {
    ...(existingManifest?.files ?? {}),
  };
  const projectRoot = projectRootFromAiRoot(rootDir, args.homeDir);

  if (projectRoot) {
    const ignorePath = join(rootDir, ".gitignore");
    const existingIgnore = await readProjectAiIgnore(ignorePath);
    const protectiveIgnore = appendProjectAiProtectiveIgnore(
      existingIgnore.content
    );
    if (protectiveIgnore !== existingIgnore.content) {
      changedPaths.push(ignorePath);
      if (!args.dryRun) {
        await ensurePackDirectory(dirname(ignorePath));
        await writeProjectAiIgnore(
          ignorePath,
          protectiveIgnore,
          existingIgnore,
          args.beforeProjectIgnoreCommit,
          projectRoot
        );
      }
    }
  }

  for (const sourcePath of files) {
    const relPath = relative(packRoot, sourcePath);
    if (!relPath || relPath.startsWith("..")) {
      continue;
    }
    const targetRelPath = builtinOperatingModelInstallRelPath(relPath);
    const targetPath = join(rootDir, targetRelPath);
    const rawSourceText = await Bun.file(sourcePath).text();
    const targetExists = await pathExists(targetPath);
    const seed =
      targetRelPath === "AGENTS.global.md" &&
      !targetExists &&
      projectRoot === null
        ? await seedAgentsGlobalText({
            homeDir: args.homeDir,
            fallbackText: rawSourceText,
          })
        : null;
    const sourceText = seed?.text ?? rawSourceText;
    const trackInManifest = !seed?.seededFromExisting;
    const sourceHash = sha256Text(sourceText);
    let shouldWrite = !targetExists || Boolean(args.force);

    if (targetExists && !shouldWrite) {
      const targetText = await Bun.file(targetPath).text();
      const targetHash = sha256Text(targetText);
      if (targetHash === sourceHash) {
        if (trackInManifest) {
          manifestFiles[targetRelPath] = { sha256: sourceHash };
        }
      } else if (
        args.update &&
        existingManifest?.files[targetRelPath]?.sha256 === targetHash
      ) {
        shouldWrite = true;
      } else if (args.update) {
        skippedPaths.push(targetPath);
      }
    }

    if (!shouldWrite) {
      continue;
    }
    changedPaths.push(targetPath);
    if (trackInManifest) {
      manifestFiles[targetRelPath] = { sha256: sourceHash };
    } else {
      delete manifestFiles[targetRelPath];
    }
    if (!args.dryRun) {
      await ensurePackDirectory(dirname(targetPath));
      await Bun.write(targetPath, sourceText);
    }
  }

  const configPath = join(rootDir, "config.toml");
  const configRelPath = "config.toml";
  const configText = "version = 1\n";
  const configHash = sha256Text(configText);
  const configExists = await pathExists(configPath);
  let shouldWriteConfig = !configExists || Boolean(args.force);
  if (configExists && !shouldWriteConfig) {
    const targetText = await Bun.file(configPath).text();
    const targetHash = sha256Text(targetText);
    if (targetHash === configHash) {
      manifestFiles[configRelPath] = { sha256: configHash };
    } else if (
      args.update &&
      existingManifest?.files[configRelPath]?.sha256 === targetHash
    ) {
      shouldWriteConfig = true;
    } else if (args.update) {
      skippedPaths.push(configPath);
    }
  }
  if (shouldWriteConfig) {
    changedPaths.push(configPath);
    manifestFiles[configRelPath] = { sha256: configHash };
    if (!args.dryRun) {
      await ensurePackDirectory(dirname(configPath));
      await Bun.write(configPath, configText);
    }
  }

  const manifestPath = builtinPackManifestPath(rootDir);
  const sortedManifestFiles = Object.fromEntries(
    Object.entries(manifestFiles).sort(([a], [b]) => a.localeCompare(b))
  );
  const stableManifest = serializeBuiltinPackManifest({
    version: 1,
    pack: "facult-operating-model",
    updatedAt: existingManifest?.updatedAt ?? "",
    files: sortedManifestFiles,
  });
  const existingManifestText = (await pathExists(manifestPath))
    ? await Bun.file(manifestPath).text()
    : null;
  if (existingManifestText !== stableManifest) {
    const nextManifest = serializeBuiltinPackManifest({
      version: 1,
      pack: "facult-operating-model",
      updatedAt: new Date().toISOString(),
      files: sortedManifestFiles,
    });
    changedPaths.push(manifestPath);
    if (!args.dryRun) {
      await ensurePackDirectory(dirname(manifestPath));
      await Bun.write(manifestPath, nextManifest);
    }
  }

  if (!args.dryRun) {
    await buildIndex({
      homeDir: args.homeDir,
      rootDir,
      force: false,
    });
  }

  return {
    ref: `${BUILTIN_INDEX_NAME}:facult-operating-model`,
    type: "skill",
    installedAs: args.installedAs ?? "operating-model",
    path: rootDir,
    sourceTrustLevel: "trusted",
    dryRun: Boolean(args.dryRun),
    changedPaths: uniqueSorted(changedPaths),
    skippedPaths: uniqueSorted(skippedPaths),
  };
}

function compareVersions(a: string, b: string): number {
  const aTokens = (a.match(VERSION_TOKEN_RE) ?? []).map((t) => t.toLowerCase());
  const bTokens = (b.match(VERSION_TOKEN_RE) ?? []).map((t) => t.toLowerCase());
  const n = Math.max(aTokens.length, bTokens.length);
  for (let i = 0; i < n; i += 1) {
    const av = aTokens[i];
    const bv = bTokens[i];
    if (av === undefined && bv === undefined) {
      return 0;
    }
    if (av === undefined) {
      return -1;
    }
    if (bv === undefined) {
      return 1;
    }

    const an = Number(av);
    const bn = Number(bv);
    const aIsNum = Number.isFinite(an) && `${an}` === av;
    const bIsNum = Number.isFinite(bn) && `${bn}` === bv;
    if (aIsNum && bIsNum) {
      if (an < bn) {
        return -1;
      }
      if (an > bn) {
        return 1;
      }
      continue;
    }

    const cmp = av.localeCompare(bv);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return 0;
}

function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || isAbsolute(relPath) || !isSafePathString(relPath)) {
    return false;
  }
  const normalized = relPath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    return false;
  }
  if (parts.includes(".") || parts.includes("..")) {
    return false;
  }
  return true;
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

function parseRef(ref: string): { index: string; itemId: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0 || i >= ref.length - 1) {
    return null;
  }
  return {
    index: ref.slice(0, i).trim(),
    itemId: ref.slice(i + 1).trim(),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function defaultFetchJson(url: string, cwd: string): Promise<unknown> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    }
    return (await res.json()) as unknown;
  }

  let path = url;
  if (url.startsWith("file://")) {
    const parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
  } else if (!isAbsolute(url)) {
    path = resolve(cwd, url);
  }

  const raw = await readFile(path, "utf8");
  return parseJsonLenient(raw);
}

async function defaultFetchText(url: string, cwd: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    }
    return await res.text();
  }

  let path = url;
  if (url.startsWith("file://")) {
    const parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
  } else if (!isAbsolute(url)) {
    path = resolve(cwd, url);
  }

  return await readFile(path, "utf8");
}

function parseIndexItem(raw: unknown): RemoteIndexItem | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  if (!id) {
    return null;
  }
  if (
    type !== "skill" &&
    type !== "mcp" &&
    type !== "agent" &&
    type !== "snippet" &&
    type !== "instruction"
  ) {
    return null;
  }
  const title = typeof obj.title === "string" ? obj.title : undefined;
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  const version = typeof obj.version === "string" ? obj.version : undefined;
  const sourceUrl =
    typeof obj.sourceUrl === "string" ? obj.sourceUrl : undefined;
  const tags = Array.isArray(obj.tags)
    ? uniqueSorted(
        obj.tags
          .filter((v) => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      )
    : undefined;

  if (type === "skill") {
    const skillRaw = obj.skill;
    if (!isPlainObject(skillRaw)) {
      return null;
    }
    const name =
      typeof skillRaw.name === "string" ? skillRaw.name.trim() : "new-skill";
    const filesRaw = skillRaw.files;
    if (!isPlainObject(filesRaw)) {
      return null;
    }
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(filesRaw)) {
      if (!isSafeRelativePath(k) || typeof v !== "string") {
        continue;
      }
      files[k] = v;
    }
    if (!Object.keys(files).length) {
      files["SKILL.md"] = "# {{name}}\n";
    }
    return {
      id,
      type,
      title,
      description,
      version,
      sourceUrl,
      tags,
      skill: { name, files },
    };
  }

  if (type === "mcp") {
    const mcpRaw = obj.mcp;
    if (!isPlainObject(mcpRaw)) {
      return null;
    }
    const name =
      typeof mcpRaw.name === "string" ? mcpRaw.name.trim() : "example-server";
    const defRaw = mcpRaw.definition;
    if (!isPlainObject(defRaw)) {
      return null;
    }
    return {
      id,
      type,
      title,
      description,
      version,
      sourceUrl,
      tags,
      mcp: { name, definition: defRaw },
    };
  }

  if (type === "agent") {
    const agentRaw = obj.agent;
    if (!isPlainObject(agentRaw)) {
      return null;
    }
    const fileName =
      typeof agentRaw.fileName === "string" ? agentRaw.fileName.trim() : "";
    const content =
      typeof agentRaw.content === "string" ? agentRaw.content : "";
    if (!(fileName && content)) {
      return null;
    }
    return {
      id,
      type,
      title,
      description,
      version,
      sourceUrl,
      tags,
      agent: { fileName, content },
    };
  }

  if (type === "instruction") {
    const instructionRaw = obj.instruction;
    if (!isPlainObject(instructionRaw)) {
      return null;
    }
    const name =
      typeof instructionRaw.name === "string" ? instructionRaw.name.trim() : "";
    const content =
      typeof instructionRaw.content === "string" ? instructionRaw.content : "";
    if (!(name && content)) {
      return null;
    }
    return {
      id,
      type,
      title,
      description,
      version,
      sourceUrl,
      tags,
      instruction: { name, content },
    };
  }

  const snippetRaw = obj.snippet;
  if (!isPlainObject(snippetRaw)) {
    return null;
  }
  const marker =
    typeof snippetRaw.marker === "string" ? snippetRaw.marker.trim() : "";
  const content =
    typeof snippetRaw.content === "string" ? snippetRaw.content : "";
  if (!(marker && content)) {
    return null;
  }
  return {
    id,
    type,
    title,
    description,
    version,
    sourceUrl,
    tags,
    snippet: { marker, content },
  };
}

function parseManifest(source: IndexSource, raw: unknown): RemoteIndexManifest {
  const base: RemoteIndexManifest = {
    name: source.name,
    url: source.url,
    items: [],
  };

  if (Array.isArray(raw)) {
    base.items = raw
      .map(parseIndexItem)
      .filter((v): v is RemoteIndexItem => !!v);
    return base;
  }

  if (!isPlainObject(raw)) {
    return base;
  }

  const obj = raw as Record<string, unknown>;
  const updatedAt =
    typeof obj.updatedAt === "string" ? obj.updatedAt : undefined;
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  return {
    ...base,
    updatedAt,
    items: itemsRaw
      .map(parseIndexItem)
      .filter((v): v is RemoteIndexItem => !!v),
  };
}

async function loadManifest(
  source: IndexSource,
  ctx: Required<Pick<RemoteCommandContext, "cwd">> & {
    homeDir: string;
    fetchJson: (url: string) => Promise<unknown>;
    fetchText: (url: string) => Promise<string>;
  },
  hints: LoadManifestHints = {}
): Promise<RemoteIndexManifest> {
  if (source.kind === "builtin") {
    return BUILTIN_MANIFEST;
  }
  if (source.kind !== "manifest") {
    return await loadProviderManifest({
      source,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      hints,
    });
  }
  const rawText = await ctx.fetchText(source.url);
  if (source.integrity) {
    assertManifestIntegrity({
      sourceName: source.name,
      sourceUrl: source.url,
      integrity: source.integrity,
      manifestText: rawText,
    });
  }
  if (source.signature) {
    await assertManifestSignature({
      sourceName: source.name,
      sourceUrl: source.url,
      signature: source.signature,
      signatureKeys: source.signatureKeys,
      manifestText: rawText,
      cwd: ctx.cwd,
      homeDir: ctx.homeDir,
    });
  }
  const raw = parseJsonLenient(rawText);
  return parseManifest(source, raw);
}

function matchScore(item: RemoteIndexItem, query: string): number {
  if (!query.trim()) {
    return 1;
  }
  const haystack = [
    item.id,
    item.title ?? "",
    item.description ?? "",
    ...(item.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of query
    .toLowerCase()
    .split(QUERY_SPLIT_RE)
    .filter(Boolean)) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

async function loadInstalledState(
  rootDir: string
): Promise<InstalledRemoteState> {
  const path = join(rootDir, "remote", "installed.json");
  if (!(await fileExists(path))) {
    return {
      version: REMOTE_STATE_VERSION,
      updatedAt: new Date(0).toISOString(),
      items: [],
    };
  }
  try {
    const parsed = parseJsonLenient(await readFile(path, "utf8"));
    if (!isPlainObject(parsed)) {
      return {
        version: REMOTE_STATE_VERSION,
        updatedAt: new Date(0).toISOString(),
        items: [],
      };
    }
    const version =
      typeof parsed.version === "number"
        ? parsed.version
        : REMOTE_STATE_VERSION;
    const updatedAt =
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date(0).toISOString();
    const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
    const items: InstalledRemoteItem[] = [];
    for (const raw of itemsRaw) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const ref = typeof raw.ref === "string" ? raw.ref : "";
      const index = typeof raw.index === "string" ? raw.index : "";
      const itemId = typeof raw.itemId === "string" ? raw.itemId : "";
      const type = typeof raw.type === "string" ? raw.type : "";
      const installedAs =
        typeof raw.installedAs === "string" ? raw.installedAs : "";
      const pathValue = typeof raw.path === "string" ? raw.path : "";
      if (!(ref && index && itemId && installedAs && pathValue)) {
        continue;
      }
      if (
        type !== "skill" &&
        type !== "mcp" &&
        type !== "agent" &&
        type !== "snippet" &&
        type !== "instruction"
      ) {
        continue;
      }
      items.push({
        ref,
        index,
        itemId,
        type,
        installedAs,
        path: pathValue,
        version: typeof raw.version === "string" ? raw.version : undefined,
        sourceUrl:
          typeof raw.sourceUrl === "string" ? raw.sourceUrl : undefined,
        sourceTrustLevel: parseSourceTrustLevel(raw.sourceTrustLevel),
        installedAt:
          typeof raw.installedAt === "string"
            ? raw.installedAt
            : new Date(0).toISOString(),
      });
    }
    return { version, updatedAt, items };
  } catch {
    return {
      version: REMOTE_STATE_VERSION,
      updatedAt: new Date(0).toISOString(),
      items: [],
    };
  }
}

async function saveInstalledState(
  rootDir: string,
  state: InstalledRemoteState
): Promise<void> {
  const path = join(rootDir, "remote", "installed.json");
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function loadCanonicalMcpContainer(rootDir: string): Promise<{
  path: string;
  parsed: Record<string, unknown>;
  getServers: () => Record<string, unknown>;
  setServers: (servers: Record<string, unknown>) => void;
}> {
  const serversPath = join(rootDir, "mcp", "servers.json");
  const mcpPath = join(rootDir, "mcp", "mcp.json");

  let path = serversPath;
  if (await fileExists(serversPath)) {
    path = serversPath;
  } else if (await fileExists(mcpPath)) {
    path = mcpPath;
  }

  let parsed: Record<string, unknown> = {};
  if (await fileExists(path)) {
    const raw = await readFile(path, "utf8");
    const obj = parseJsonLenient(raw);
    if (isPlainObject(obj)) {
      parsed = { ...obj };
    }
  }

  const getServers = () => {
    if (isPlainObject(parsed.servers)) {
      return parsed.servers as Record<string, unknown>;
    }
    if (isPlainObject(parsed.mcpServers)) {
      return parsed.mcpServers as Record<string, unknown>;
    }
    if (
      isPlainObject(parsed.mcp) &&
      isPlainObject((parsed.mcp as Record<string, unknown>).servers)
    ) {
      return (parsed.mcp as Record<string, unknown>).servers as Record<
        string,
        unknown
      >;
    }
    parsed.servers = {};
    return parsed.servers as Record<string, unknown>;
  };

  const setServers = (servers: Record<string, unknown>) => {
    if (isPlainObject(parsed.servers)) {
      parsed.servers = servers;
      return;
    }
    if (isPlainObject(parsed.mcpServers)) {
      parsed.mcpServers = servers;
      return;
    }
    if (
      isPlainObject(parsed.mcp) &&
      isPlainObject((parsed.mcp as Record<string, unknown>).servers)
    ) {
      (parsed.mcp as Record<string, unknown>).servers = servers;
      return;
    }
    parsed.servers = servers;
  };

  return { path, parsed, getServers, setServers };
}

function snippetMarkerToPath(rootDir: string, marker: string): string {
  const parts = marker.split("/").filter(Boolean);
  if (parts[0] === "global" && parts.length >= 2) {
    return join(
      rootDir,
      "snippets",
      "global",
      `${parts.slice(1).join("/")}.md`
    );
  }
  if (parts.length >= 2) {
    const project = parts[0] ?? "project";
    const name = parts.slice(1).join("/");
    return join(rootDir, "snippets", "projects", project, `${name}.md`);
  }
  return join(rootDir, "snippets", "global", `${marker}.md`);
}

function assertInstallPath(path: string, parent: string): void {
  if (!(isSafePathString(path) && isSubpath(parent, path))) {
    throw new Error(`Refusing unsafe install path: ${path}`);
  }
}

async function installSkillItem(args: {
  item: RemoteSkillItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const installedAs = (args.installAs ?? args.item.skill.name).trim();
  if (!installedAs) {
    throw new Error("Skill install target cannot be empty.");
  }
  const skillDir = join(args.rootDir, "skills", installedAs);
  assertInstallPath(skillDir, join(args.rootDir, "skills"));

  if ((await fileExists(skillDir)) && !args.force) {
    throw new Error(
      `Skill already exists: ${installedAs} (use --force to overwrite)`
    );
  }

  const changedPaths: string[] = [];
  const files = Object.entries(args.item.skill.files);
  if (files.length === 0) {
    throw new Error(`Skill template ${args.item.id} has no files.`);
  }

  if (!args.dryRun) {
    if (args.force && (await fileExists(skillDir))) {
      await rm(skillDir, { recursive: true, force: true });
    }
    await mkdir(skillDir, { recursive: true });
  }

  for (const [relPath, rawContent] of files) {
    if (!isSafeRelativePath(relPath)) {
      throw new Error(`Unsafe skill template file path: ${relPath}`);
    }
    const outPath = join(skillDir, relPath);
    assertInstallPath(outPath, skillDir);
    const content = renderTemplate(rawContent, { name: installedAs });
    changedPaths.push(outPath);
    if (!args.dryRun) {
      await mkdir(dirname(outPath), { recursive: true });
      await Bun.write(outPath, content);
    }
  }

  return { installedAs, path: skillDir, changedPaths };
}

async function installMcpItem(args: {
  item: RemoteMcpItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const installedAs = (args.installAs ?? args.item.mcp.name).trim();
  if (!installedAs) {
    throw new Error("MCP server name cannot be empty.");
  }

  const container = await loadCanonicalMcpContainer(args.rootDir);
  const servers = { ...container.getServers() };
  if (servers[installedAs] && !args.force) {
    throw new Error(
      `MCP server already exists: ${installedAs} (use --force to overwrite)`
    );
  }

  const rendered = JSON.parse(
    JSON.stringify(args.item.mcp.definition).replaceAll("{{name}}", installedAs)
  ) as Record<string, unknown>;
  servers[installedAs] = rendered;
  container.setServers(servers);

  if (!args.dryRun) {
    await mkdir(dirname(container.path), { recursive: true });
    await Bun.write(
      container.path,
      `${JSON.stringify(container.parsed, null, 2)}\n`
    );
  }

  return {
    installedAs,
    path: container.path,
    changedPaths: [container.path],
  };
}

function deriveAgentTemplateName(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  const base = basename(normalized);
  if (base.toLowerCase() === "agent.toml") {
    const parent = basename(dirname(normalized));
    if (parent && parent !== ".") {
      return parent;
    }
  }
  return base.replace(FILE_EXT_RE, "");
}

async function installAgentItem(args: {
  item: RemoteAgentItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const fileName = (args.installAs ?? args.item.agent.fileName).trim();
  if (!fileName) {
    throw new Error("Agent instruction file name cannot be empty.");
  }
  if (!isSafeRelativePath(fileName)) {
    throw new Error(`Unsafe agent instruction file name: ${fileName}`);
  }
  const filePath = join(args.rootDir, "agents", fileName);
  assertInstallPath(filePath, join(args.rootDir, "agents"));

  if ((await fileExists(filePath)) && !args.force) {
    throw new Error(
      `Agent instruction already exists: ${fileName} (use --force to overwrite)`
    );
  }

  const agentName = deriveAgentTemplateName(fileName);

  if (!args.dryRun) {
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(
      filePath,
      renderTemplate(args.item.agent.content, {
        name: agentName,
      })
    );
  }
  return { installedAs: fileName, path: filePath, changedPaths: [filePath] };
}

async function installSnippetItem(args: {
  item: RemoteSnippetItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const marker = (args.installAs ?? args.item.snippet.marker).trim();
  const markerErr = validateSnippetMarkerName(marker);
  if (markerErr) {
    throw new Error(`Invalid snippet marker "${marker}": ${markerErr}`);
  }
  const snippetPath = snippetMarkerToPath(args.rootDir, marker);
  assertInstallPath(snippetPath, join(args.rootDir, "snippets"));
  if ((await fileExists(snippetPath)) && !args.force) {
    throw new Error(
      `Snippet already exists: ${marker} (use --force to overwrite)`
    );
  }
  if (!args.dryRun) {
    await mkdir(dirname(snippetPath), { recursive: true });
    await Bun.write(
      snippetPath,
      renderTemplate(args.item.snippet.content, { name: marker })
    );
  }
  return {
    installedAs: marker,
    path: snippetPath,
    changedPaths: [snippetPath],
  };
}

function normalizeInstructionName(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(LEADING_SLASH_RE, "");
  if (!normalized) {
    throw new Error("Instruction name is required");
  }
  const withExt = MD_EXT_RE.test(normalized) ? normalized : `${normalized}.md`;
  if (!isSafeRelativePath(withExt)) {
    throw new Error(`Invalid instruction name: ${value}`);
  }
  return withExt;
}

function instructionTitleFromFileName(fileName: string): string {
  const base = basename(fileName).replace(MD_EXT_RE, "");
  return base
    .split(INSTRUCTION_TITLE_SPLIT_RE)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function instructionAssetName(fileName: string): string {
  return basename(fileName).replace(MD_EXT_RE, "");
}

async function installInstructionItem(args: {
  item: RemoteInstructionItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const fileName = normalizeInstructionName(
    args.installAs ?? args.item.instruction.name
  );
  const instructionPath = join(args.rootDir, "instructions", fileName);
  assertInstallPath(instructionPath, join(args.rootDir, "instructions"));
  if ((await fileExists(instructionPath)) && !args.force) {
    throw new Error(
      `Instruction already exists: ${fileName} (use --force to overwrite)`
    );
  }
  if (!args.dryRun) {
    await mkdir(dirname(instructionPath), { recursive: true });
    await Bun.write(
      instructionPath,
      renderTemplate(args.item.instruction.content, {
        name: fileName,
        title: instructionTitleFromFileName(fileName),
        assetName: instructionAssetName(fileName),
      })
    );
  }
  return {
    installedAs: fileName,
    path: instructionPath,
    changedPaths: [instructionPath],
  };
}

async function installParsedItem(args: {
  parsedRef: { index: string; itemId: string };
  item: RemoteIndexItem;
  sourceTrustLevel: SourceTrustLevel;
  installAs?: string;
  dryRun: boolean;
  force: boolean;
  homeDir: string;
  rootDir: string;
  now?: () => Date;
}): Promise<InstallResult> {
  let writeResult: {
    installedAs: string;
    path: string;
    changedPaths: string[];
  } | null = null;

  if (args.item.type === "skill") {
    writeResult = await installSkillItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  } else if (args.item.type === "mcp") {
    writeResult = await installMcpItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  } else if (args.item.type === "agent") {
    writeResult = await installAgentItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  } else if (args.item.type === "snippet") {
    writeResult = await installSnippetItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  } else {
    writeResult = await installInstructionItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  }

  const result: InstallResult = {
    ref: `${args.parsedRef.index}:${args.item.id}`,
    type: args.item.type,
    installedAs: writeResult.installedAs,
    path: writeResult.path,
    sourceTrustLevel: args.sourceTrustLevel,
    dryRun: args.dryRun,
    changedPaths: writeResult.changedPaths,
  };

  if (args.dryRun) {
    return result;
  }

  const state = await loadInstalledState(args.rootDir);
  const next: InstalledRemoteItem = {
    ref: result.ref,
    index: args.parsedRef.index,
    itemId: args.item.id,
    type: args.item.type,
    installedAs: result.installedAs,
    path: result.path,
    version: args.item.version,
    sourceUrl: args.item.sourceUrl,
    sourceTrustLevel: args.sourceTrustLevel,
    installedAt: nowIso(args.now),
  };
  const dedup = state.items.filter(
    (existing) =>
      !(
        existing.ref === next.ref &&
        existing.installedAs === next.installedAs &&
        existing.type === next.type
      )
  );
  dedup.push(next);
  await saveInstalledState(args.rootDir, {
    version: REMOTE_STATE_VERSION,
    updatedAt: nowIso(args.now),
    items: dedup.sort((a, b) => a.ref.localeCompare(b.ref)),
  });
  await buildIndex({
    rootDir: args.rootDir,
    homeDir: args.homeDir,
    force: false,
  });
  return result;
}

async function resolveIndexSourcesAndManifests(args: {
  homeDir: string;
  cwd: string;
  fetchJson: (url: string) => Promise<unknown>;
  fetchText: (url: string) => Promise<string>;
  onlyIndex?: string;
  hints?: LoadManifestHints;
  throwOnSourceError?: boolean;
}): Promise<Map<string, RemoteIndexManifest>> {
  const sources = await readIndexSources(args.homeDir, args.cwd);
  if (
    args.onlyIndex &&
    !sources.some((source) => source.name === args.onlyIndex)
  ) {
    const known = resolveKnownIndexSource(args.onlyIndex);
    if (known) {
      sources.push(known);
    }
  }
  const filtered = args.onlyIndex
    ? sources.filter((source) => source.name === args.onlyIndex)
    : sources;
  const manifests = new Map<string, RemoteIndexManifest>();
  for (const source of filtered) {
    try {
      const manifest = await loadManifest(
        source,
        {
          homeDir: args.homeDir,
          cwd: args.cwd,
          fetchJson: args.fetchJson,
          fetchText: args.fetchText,
        },
        args.hints
      );
      manifests.set(source.name, manifest);
    } catch (err) {
      if (args.throwOnSourceError) {
        throw err;
      }
    }
  }
  return manifests;
}

export async function searchRemoteItems(args: {
  query: string;
  limit?: number;
  index?: string;
  homeDir?: string;
  cwd?: string;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<SearchResult[]> {
  const home = args.homeDir ?? homedir();
  const cwd = args.cwd ?? process.cwd();
  const fetchJson =
    args.fetchJson ?? (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args.fetchText ?? (async (url: string) => await defaultFetchText(url, cwd));
  const manifests = await resolveIndexSourcesAndManifests({
    homeDir: home,
    cwd,
    fetchJson,
    fetchText,
    onlyIndex: args.index,
    hints: { query: args.query },
    throwOnSourceError: Boolean(args.index),
  });

  const rows: SearchResult[] = [];
  for (const [index, manifest] of manifests.entries()) {
    for (const item of manifest.items) {
      const score = matchScore(item, args.query);
      if (score <= 0) {
        continue;
      }
      rows.push({ index, item, score });
    }
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.index !== b.index) {
      return a.index.localeCompare(b.index);
    }
    return a.item.id.localeCompare(b.item.id);
  });
  const limit = args.limit && args.limit > 0 ? args.limit : 50;
  return rows.slice(0, limit);
}

export async function installRemoteItem(args: {
  ref: string;
  as?: string;
  dryRun?: boolean;
  force?: boolean;
  allowLegacyManagedMutation?: boolean;
  strictSourceTrust?: boolean;
  homeDir?: string;
  rootDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<InstallResult> {
  if (args.force) {
    assertLegacyManagedMutationAllowed({
      action: "fclt install --force",
      approved: args.allowLegacyManagedMutation,
      dryRun: args.dryRun,
    });
  }
  const parsedRef = parseRef(args.ref);
  if (!parsedRef) {
    throw new Error(`Invalid ref "${args.ref}". Use <index>:<item>.`);
  }
  const home = args.homeDir ?? homedir();
  const root = args.rootDir ?? facultRootDir(home);
  const cwd = args.cwd ?? process.cwd();
  const strictSourceTrust = Boolean(args.strictSourceTrust);
  const fetchJson =
    args.fetchJson ?? (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args.fetchText ?? (async (url: string) => await defaultFetchText(url, cwd));
  const manifests = await resolveIndexSourcesAndManifests({
    homeDir: home,
    cwd,
    fetchJson,
    fetchText,
    onlyIndex: parsedRef.index,
    hints: { itemId: parsedRef.itemId },
    throwOnSourceError: true,
  });
  const manifest = manifests.get(parsedRef.index);
  if (!manifest) {
    throw new Error(`Index not found: ${parsedRef.index}`);
  }
  const item = manifest.items.find(
    (candidate) => candidate.id === parsedRef.itemId
  );
  if (!item) {
    throw new Error(`Item not found: ${args.ref}`);
  }
  const trustState = await loadSourceTrustState({ homeDir: home });
  const sourceTrustLevel = assertSourceAllowed({
    sourceName: parsedRef.index,
    trustState,
    strictSourceTrust,
  });
  return await installParsedItem({
    parsedRef,
    item,
    sourceTrustLevel,
    installAs: args.as,
    dryRun: Boolean(args.dryRun),
    force: Boolean(args.force),
    homeDir: home,
    rootDir: root,
    now: args.now,
  });
}

export async function checkRemoteUpdates(args?: {
  apply?: boolean;
  force?: boolean;
  allowLegacyManagedMutation?: boolean;
  strictSourceTrust?: boolean;
  homeDir?: string;
  rootDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<UpdateReport> {
  if (args?.apply) {
    assertLegacyManagedMutationAllowed({
      action: "fclt update --apply",
      approved: args.allowLegacyManagedMutation,
      safeAlternative: "fclt update without --apply",
    });
  }
  const home = args?.homeDir ?? homedir();
  const root = args?.rootDir ?? facultRootDir(home);
  const cwd = args?.cwd ?? process.cwd();
  const fetchJson =
    args?.fetchJson ??
    (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args?.fetchText ??
    (async (url: string) => await defaultFetchText(url, cwd));
  const strictSourceTrust = Boolean(args?.strictSourceTrust);
  const sourceTrustState = await loadSourceTrustState({ homeDir: home });

  const installed = await loadInstalledState(root);
  const checks: UpdateCheckResult[] = [];
  const applied: InstallResult[] = [];
  if (!installed.items.length) {
    return { checkedAt: nowIso(args?.now), checks, applied };
  }

  const configuredSources = await readIndexSources(home, cwd);
  const sourceByName = new Map<string, IndexSource>();
  for (const source of configuredSources) {
    sourceByName.set(source.name, source);
  }
  for (const item of installed.items) {
    if (sourceByName.has(item.index)) {
      continue;
    }
    const known = resolveKnownIndexSource(item.index);
    if (known) {
      sourceByName.set(known.name, known);
    }
  }
  const manifestCache = new Map<string, RemoteIndexManifest>();

  for (const entry of installed.items) {
    const trust = evaluateSourceTrust({
      sourceName: entry.index,
      trustState: sourceTrustState,
    });
    if (trust.level === "blocked") {
      checks.push({
        installed: entry,
        status: "blocked-source",
      });
      continue;
    }
    if (strictSourceTrust && trust.level === "review") {
      checks.push({
        installed: entry,
        status: "review-source",
      });
      continue;
    }

    const source = sourceByName.get(entry.index);
    if (!source) {
      checks.push({ installed: entry, status: "missing-index" });
      continue;
    }
    const cacheKey = `${source.name}:${entry.itemId}`;
    let manifest = manifestCache.get(cacheKey);
    if (!manifest) {
      try {
        manifest = await loadManifest(
          source,
          { homeDir: home, cwd, fetchJson, fetchText },
          { itemId: entry.itemId }
        );
      } catch {
        checks.push({ installed: entry, status: "missing-index" });
        continue;
      }
      manifestCache.set(cacheKey, manifest);
    }

    const item = manifest.items.find(
      (candidate) => candidate.id === entry.itemId
    );
    if (!item) {
      checks.push({ installed: entry, status: "missing-item" });
      continue;
    }
    const latestVersion = item.version;
    const currentVersion = entry.version;
    if (!(latestVersion && currentVersion)) {
      checks.push({
        installed: entry,
        status: "up-to-date",
        latestVersion,
        currentVersion,
      });
      continue;
    }
    const cmp = compareVersions(currentVersion, latestVersion);
    if (cmp < 0) {
      checks.push({
        installed: entry,
        status: "outdated",
        latestVersion,
        currentVersion,
      });
      if (args?.apply) {
        const next = await installRemoteItem({
          ref: entry.ref,
          as: entry.installedAs,
          dryRun: false,
          force: args.force ?? true,
          allowLegacyManagedMutation: true,
          strictSourceTrust,
          homeDir: home,
          rootDir: root,
          cwd,
          now: args.now,
          fetchJson,
          fetchText,
        });
        applied.push(next);
      }
      continue;
    }
    checks.push({
      installed: entry,
      status: "up-to-date",
      latestVersion,
      currentVersion,
    });
  }

  return { checkedAt: nowIso(args?.now), checks, applied };
}

async function verifySource(args: {
  sourceName: string;
  homeDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<VerifySourceReport> {
  const home = args.homeDir ?? homedir();
  const cwd = args.cwd ?? process.cwd();
  const fetchJson =
    args.fetchJson ?? (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args.fetchText ?? (async (url: string) => await defaultFetchText(url, cwd));
  const configured = await readIndexSources(home, cwd);
  const source =
    configured.find((candidate) => candidate.name === args.sourceName) ??
    resolveKnownIndexSource(args.sourceName);
  if (!source) {
    throw new Error(`Source not found: ${args.sourceName}`);
  }

  const trustState = await loadSourceTrustState({ homeDir: home });
  const trust = evaluateSourceTrust({
    sourceName: source.name,
    trustState,
  });

  const report: VerifySourceReport = {
    checkedAt: nowIso(args.now),
    source: {
      name: source.name,
      url: source.url,
      kind: source.kind,
    },
    trust,
    checks: {
      fetch: "not-applicable",
      parse: "not-applicable",
      integrity: "not-applicable",
      signature: "not-applicable",
      items: 0,
    },
  };

  try {
    if (source.kind === "builtin") {
      report.checks.parse = "passed";
      report.checks.items = BUILTIN_MANIFEST.items.length;
      return report;
    }

    if (source.kind === "manifest") {
      const rawText = await fetchText(source.url);
      report.checks.fetch = "passed";

      if (source.integrity) {
        assertManifestIntegrity({
          sourceName: source.name,
          sourceUrl: source.url,
          integrity: source.integrity,
          manifestText: rawText,
        });
        report.checks.integrity = "passed";
      } else {
        report.checks.integrity = "not-configured";
      }

      if (source.signature) {
        await assertManifestSignature({
          sourceName: source.name,
          sourceUrl: source.url,
          signature: source.signature,
          signatureKeys: source.signatureKeys,
          manifestText: rawText,
          cwd,
          homeDir: home,
        });
        report.checks.signature = "passed";
      } else {
        report.checks.signature = "not-configured";
      }

      const parsed = parseJsonLenient(rawText);
      const manifest = parseManifest(source, parsed);
      report.checks.parse = "passed";
      report.checks.items = manifest.items.length;
      return report;
    }

    const manifest = await loadProviderManifest({
      source,
      fetchJson,
      fetchText,
      hints: {},
    });
    report.checks.fetch = "passed";
    report.checks.parse = "passed";
    report.checks.items = manifest.items.length;
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.error = message;
    if (report.checks.fetch === "not-applicable") {
      report.checks.fetch = "failed";
    }
    if (report.checks.parse === "not-applicable") {
      report.checks.parse = "failed";
    }
    if (
      report.checks.integrity === "not-applicable" &&
      source.kind === "manifest"
    ) {
      report.checks.integrity = source.integrity ? "failed" : "not-configured";
    }
    if (
      report.checks.signature === "not-applicable" &&
      source.kind === "manifest"
    ) {
      report.checks.signature = source.signature ? "failed" : "not-configured";
    }
    return report;
  }
}

function printSearchHelp() {
  console.log(
    renderPage({
      title: "fclt search",
      subtitle: "Search configured remote indices.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode(
              "fclt search <query> [--index <name>] [--limit <n>] [--json]"
            ),
          ]),
        },
        {
          title: "Notes",
          lines: renderBullets([
            `Builtin index ${renderCode(BUILTIN_INDEX_NAME)} is always available.`,
            `Builtin provider aliases: ${SMITHERY_INDEX_NAME}, ${GLAMA_INDEX_NAME}, ${SKILLS_SH_INDEX_NAME}, ${CLAWHUB_INDEX_NAME}.`,
            "Optional custom indices can be configured in ~/.ai/.facult/indices.json.",
          ]),
        },
      ],
    })
  );
}

function printInstallHelp() {
  console.log(
    renderPage({
      title: "fclt install",
      subtitle: "Install an item from a remote index into canonical state.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode(
              `fclt install <index:item> [--as <name>] [--dry-run] [--force] [${LEGACY_MANAGED_MUTATION_FLAG}] [--strict-source-trust] [--json]`
            ),
          ]),
        },
        {
          title: "Examples",
          lines: renderBullets([
            renderCode("fclt install facult:skill-template --as my-skill"),
            renderCode(
              "fclt install facult:agent-template --as reviewer/agent.toml"
            ),
            renderCode("fclt install facult:mcp-stdio-template --as github"),
            renderCode("fclt install smithery:github"),
          ]),
        },
      ],
    })
  );
}

function printUpdateHelp() {
  console.log(
    renderPage({
      title: "fclt update",
      subtitle: "Check for updates to remotely installed items.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode(
              `fclt update [--apply] [${LEGACY_MANAGED_MUTATION_FLAG}] [--strict-source-trust] [--json]`
            ),
          ]),
        },
        {
          title: "Options",
          lines: renderTable({
            headers: ["Option", "Meaning"],
            rows: [
              ["--apply", "Install available updates"],
              [
                "--strict-source-trust",
                "Block review-level sources unless explicitly trusted",
              ],
            ],
          }),
        },
      ],
    })
  );
}

function printTemplatesHelp() {
  console.log(
    renderPage({
      title: "fclt templates",
      subtitle:
        "Scaffold canonical skills, MCP, agents, snippets, docs, and automation.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode("fclt templates list [--json]"),
            renderCode(
              "fclt templates init skill <name> [--force] [--dry-run]"
            ),
            renderCode("fclt templates init mcp <name> [--force] [--dry-run]"),
            renderCode(
              "fclt templates init agent <name> [--force] [--dry-run]"
            ),
            renderCode(
              "fclt templates init instruction <name> [--force] [--dry-run]"
            ),
            renderCode(
              "fclt templates init snippet <marker> [--force] [--dry-run]"
            ),
            renderCode("fclt templates init agents [--force] [--dry-run]"),
            renderCode(
              "fclt templates init operating-model [--global|--project|--root PATH] [--update] [--force] [--dry-run]"
            ),
            renderCode(
              "fclt templates init project-ai [--project-root PATH|--root PATH] [--guidance PATH] [--apply --plan-sha SHA]"
            ),
            renderCode(
              "fclt templates init automation <template-id> [--scope global|project|wide] [--name <name>] [--project-root <path>] [--cwds <path1,path2>] [--rrule <RRULE>] [--status PAUSED|ACTIVE] [--yes] [--dry-run]"
            ),
          ]),
        },
        {
          title: "Notes",
          lines: renderBullets([
            `Templates are powered by the builtin ${renderCode(BUILTIN_INDEX_NAME)} index.`,
            `${renderCode("templates init project-ai")} is a preview-first alias for minimal ${renderCode("project init")}; use ${renderCode("operating-model --project")} only for an explicit full-pack install.`,
            "Automation templates scaffold Codex automation files under ~/.codex/automations/.",
            `${renderCode("--yes")} and ${renderCode("--non-interactive")} skip scope prompts and use inferred defaults when possible.`,
            "Use project scope for one repo root, wide/global scope for many explicit roots.",
          ]),
        },
      ],
    })
  );
}

function printVerifySourceHelp() {
  console.log(
    renderPage({
      title: "fclt verify-source",
      subtitle: "Verify source trust, integrity, and signature status.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode("fclt verify-source <name> [--json]"),
          ]),
        },
        {
          title: "Examples",
          lines: renderBullets([
            renderCode("fclt verify-source facult"),
            renderCode("fclt verify-source smithery"),
            renderCode("fclt verify-source local-index --json"),
          ]),
        },
      ],
    })
  );
}

function parseLongFlag(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      return argv[i + 1] ?? null;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return null;
}

function parseLongFlags(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      const value = argv[i + 1];
      if (value) {
        values.push(value);
      }
      i += 1;
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

const TEMPLATE_INIT_VALUE_FLAGS = new Set([
  "--automation-status",
  "--cadence",
  "--cwds",
  "--guidance",
  "--name",
  "--plan-sha",
  "--project-root",
  "--root",
  "--rrule",
  "--scope",
  "--source",
  "--status",
]);

function parseTemplateInitArgs(argv: string[]): {
  positional: string[];
  rootArg?: string;
  projectRootArg?: string;
} {
  const positional: string[] = [];
  let rootArg: string | undefined;
  let projectRootArg: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--root requires a path value");
      }
      rootArg = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      rootArg = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--project-root requires a path value");
      }
      projectRootArg = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      projectRootArg = arg.slice("--project-root=".length);
      continue;
    }
    if (TEMPLATE_INIT_VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    const equalFlag = arg.startsWith("--") ? arg.split("=", 1)[0] : "";
    if (equalFlag && TEMPLATE_INIT_VALUE_FLAGS.has(equalFlag)) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    positional.push(arg);
  }
  return { positional, rootArg, projectRootArg };
}

function expandHomePath(pathValue: string, homeDir: string): string {
  if (pathValue === "~") {
    return homeDir;
  }
  if (pathValue.startsWith("~/")) {
    return `${homeDir}/${pathValue.slice(2)}`;
  }
  return pathValue;
}

function projectAiRootFromProjectArg(value: string, homeDir?: string): string {
  const resolved = resolve(expandHomePath(value, homeDir ?? homedir()));
  return basename(resolved) === ".ai" ? resolved : join(resolved, ".ai");
}

export async function sourcesCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  await runSourcesCommand({
    argv,
    ctx: {
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      now: ctx.now,
    },
    readIndexSources,
    builtinIndexName: BUILTIN_INDEX_NAME,
  });
}

export async function searchCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (
    !argv.length ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printSearchHelp();
    return;
  }
  const query = argv.find((arg) => arg && !arg.startsWith("-"));
  if (!query) {
    console.error("search requires a query");
    process.exitCode = 1;
    return;
  }
  const index = parseLongFlag(argv, "--index") ?? undefined;
  const limitRaw = parseLongFlag(argv, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
    console.error(`Invalid --limit value: ${limitRaw}`);
    process.exitCode = 1;
    return;
  }
  const json = argv.includes("--json");

  try {
    const results = await searchRemoteItems({
      query,
      index,
      limit,
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
    });
    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (!results.length) {
      console.log(
        renderPage({
          title: "fclt search",
          subtitle: `No remote results for "${query}".`,
          sections: [],
        })
      );
      return;
    }
    console.log(
      renderPage({
        title: "fclt search",
        subtitle: `${results.length} remote match${results.length === 1 ? "" : "es"} for "${query}"`,
        sections: [
          {
            title: "Results",
            lines: renderCatalog(
              results.map((row) => ({
                title: `${row.index}:${row.item.id}`,
                meta: `${row.item.type} • v${row.item.version ?? "-"}`,
                description:
                  row.item.title ?? row.item.description ?? "No title.",
              }))
            ),
          },
        ],
      })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function installCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (
    !argv.length ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printInstallHelp();
    return;
  }
  const ref = argv.find((arg) => arg && !arg.startsWith("-"));
  if (!ref) {
    console.error("install requires a ref like <index:item>");
    process.exitCode = 1;
    return;
  }
  const as = parseLongFlag(argv, "--as") ?? undefined;
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const strictSourceTrust =
    argv.includes("--strict-source-trust") || Boolean(ctx.strictSourceTrust);
  const json = argv.includes("--json");
  try {
    const result = await installRemoteItem({
      ref,
      as,
      dryRun,
      force,
      strictSourceTrust,
      allowLegacyManagedMutation: legacyManagedMutationApproved({ argv }),
      homeDir: ctx.homeDir,
      rootDir: ctx.rootDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      now: ctx.now,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const action = dryRun ? "Would install" : "Installed";
    console.log(
      renderPage({
        title: "fclt install",
        subtitle: `${action} ${result.ref} as ${result.installedAs}`,
        sections: [
          {
            title: "Result",
            lines: renderKeyValue([
              ["type", result.type],
              [
                "source trust",
                result.sourceTrustLevel === "trusted"
                  ? "trusted"
                  : result.sourceTrustLevel,
              ],
              ["path", result.path],
            ]),
          },
          {
            title: "Changed Paths",
            lines: renderBullets(result.changedPaths),
          },
        ],
        footer:
          result.sourceTrustLevel === "review" && !strictSourceTrust
            ? [
                "Source policy is review. Use --strict-source-trust to require explicit trust.",
              ]
            : undefined,
      })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function updateCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printUpdateHelp();
    return;
  }
  const apply = argv.includes("--apply");
  const allowLegacyManagedMutation = legacyManagedMutationApproved({ argv });
  const strictSourceTrust =
    argv.includes("--strict-source-trust") || Boolean(ctx.strictSourceTrust);
  const json = argv.includes("--json");
  try {
    const report = await checkRemoteUpdates({
      apply,
      allowLegacyManagedMutation,
      strictSourceTrust,
      homeDir: ctx.homeDir,
      rootDir: ctx.rootDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      now: ctx.now,
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!report.checks.length) {
      console.log(
        renderPage({
          title: "fclt update",
          subtitle: "No remotely installed items found.",
          sections: [],
        })
      );
      return;
    }
    console.log(
      renderPage({
        title: "fclt update",
        subtitle: `${report.checks.length} installed item${report.checks.length === 1 ? "" : "s"} checked`,
        sections: [
          {
            title: "Checks",
            lines: renderCatalog(
              report.checks.map((check) => ({
                title: check.installed.ref,
                meta: check.status,
                description: check.installed.installedAs,
                details: [
                  `Version ${check.currentVersion ?? "-"} -> ${check.latestVersion ?? "-"}`,
                ],
              }))
            ),
          },
        ],
        footer: apply
          ? [`Applied ${report.applied.length} update(s).`]
          : undefined,
      })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function verifySourceCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (
    !argv.length ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printVerifySourceHelp();
    return;
  }

  const sourceName = argv.find((arg) => arg && !arg.startsWith("-"));
  if (!sourceName) {
    console.error("verify-source requires a source name");
    process.exitCode = 1;
    return;
  }
  const json = argv.includes("--json");

  try {
    const report = await verifySource({
      sourceName,
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      now: ctx.now,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const trustOrigin = report.trust.explicit ? "explicit" : "default";
      console.log(
        renderPage({
          title: `fclt verify-source ${report.source.name}`,
          subtitle: report.source.url,
          sections: [
            {
              title: "Source",
              lines: renderKeyValue([
                ["kind", report.source.kind],
                ["trust", `${report.trust.level} (${trustOrigin})`],
                ["items", String(report.checks.items)],
              ]),
            },
            {
              title: "Checks",
              lines: renderKeyValue([
                ["fetch", report.checks.fetch],
                ["parse", report.checks.parse],
                ["integrity", report.checks.integrity],
                ["signature", report.checks.signature],
              ]),
            },
          ],
          footer: report.error ? [`error: ${report.error}`] : undefined,
        })
      );
    }

    if (report.error) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function templatesCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printTemplatesHelp();
    return;
  }
  if (sub === "list") {
    const json = rest.includes("--json");
    const rows = [
      ...BUILTIN_MANIFEST.items.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title ?? "",
        description: item.description ?? "",
        version: item.version ?? "",
      })),
      {
        id: "operating-model",
        type: "pack",
        title: "Operating Model Pack",
        description:
          "Install the built-in Facult operating-model pack into the active canonical root.",
        version: "1.0.0",
      },
      {
        id: "project-ai",
        type: "pack",
        title: "Project AI Pack",
        description:
          "Seed a repo-local .ai with the built-in Facult operating-model pack.",
        version: "1.0.0",
      },
      ...BUILTIN_AUTOMATION_TEMPLATES.map((item) => ({
        id: item.id,
        type: "automation",
        title: item.title,
        description: item.description,
        version: "wide",
      })),
    ];
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(
      renderPage({
        title: "fclt templates list",
        subtitle: `${rows.length} available scaffold${rows.length === 1 ? "" : "s"}`,
        sections: [
          {
            title: "Templates",
            lines: renderCatalog(
              rows.map((row) => ({
                title: row.id,
                meta: `${row.type} • ${row.version}`,
                description: row.description || row.title,
              }))
            ),
          },
        ],
      })
    );
    return;
  }
  if (sub !== "init") {
    console.error(`Unknown templates command: ${sub}`);
    process.exitCode = 2;
    return;
  }

  const [kind, ...args] = rest;
  if (!kind) {
    console.error(
      "templates init requires a kind (skill|mcp|agent|instruction|snippet|agents|claude|operating-model|project-ai|automation)"
    );
    process.exitCode = 2;
    return;
  }
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    printTemplatesHelp();
    return;
  }
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const update = args.includes("--update");
  const json = args.includes("--json");
  const parsedArgs = parseTemplateInitArgs(args);
  const positional = parsedArgs.positional;

  if (kind === "project-ai") {
    try {
      if (force || update) {
        throw new Error(
          "project-ai is now a minimal preview-first enrollment alias; use operating-model --project for an explicit full-pack install"
        );
      }
      if (args.includes("--schedule")) {
        throw new Error(
          "Minimal project enrollment does not install scheduling; enroll first, then enable a reviewed project loop separately"
        );
      }
      const selectedRoot = parsedArgs.projectRootArg
        ? resolve(
            expandHomePath(parsedArgs.projectRootArg, ctx.homeDir ?? homedir())
          )
        : parsedArgs.rootArg
          ? dirname(
              projectAiRootFromProjectArg(parsedArgs.rootArg, ctx.homeDir)
            )
          : ctx.rootDir
            ? dirname(resolve(ctx.rootDir))
            : resolve(ctx.cwd ?? process.cwd());
      const forwarded = ["init", "--project-root", selectedRoot];
      for (const flag of ["--guidance", "--source"]) {
        for (const value of parseLongFlags(args, flag)) {
          forwarded.push(flag, value);
        }
      }
      for (const flag of ["--cadence", "--plan-sha"]) {
        const value = parseLongFlag(args, flag);
        if (value) {
          forwarded.push(flag, value);
        }
      }
      for (const flag of ["--apply", "--dry-run", "--json"]) {
        if (args.includes(flag)) {
          forwarded.push(flag);
        }
      }
      await import("./projects").then(({ projectCommand }) =>
        projectCommand(forwarded, {
          cwd: ctx.cwd,
          homeDir: ctx.homeDir,
        })
      );
      return;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  if (kind === "operating-model") {
    try {
      const context = parseCliContextArgs(args, { allowScope: false });
      const cwd = resolve(ctx.cwd ?? process.cwd());
      const rootDir = ctx.rootDir
        ? resolve(ctx.rootDir)
        : context.scope === "project" && !context.rootArg
          ? join(findGitRootFromPath(cwd) ?? cwd, ".ai")
          : resolveCliContextRoot({
              rootArg: context.rootArg,
              scope: context.scope,
              homeDir: ctx.homeDir,
              cwd,
            });
      const homeDir = ctx.homeDir ?? process.env.HOME?.trim() ?? homedir();
      const scope = resolveCliContextScope({
        homeDir,
        rootDir,
        scope: context.scope,
      });
      const result = await withFacultRootScope({ rootDir, scope }, async () =>
        scaffoldBuiltinOperatingModelPack({
          rootDir,
          homeDir,
          dryRun,
          force,
          update,
        })
      );
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const action = dryRun ? "Would install" : "Installed";
      console.log(
        renderPage({
          title: `fclt templates init ${kind}`,
          subtitle: `${action} ${result.installedAs} into ${result.path}`,
          sections: [
            {
              title: "Changed Paths",
              lines: renderBullets(result.changedPaths),
            },
            ...(result.skippedPaths?.length
              ? [
                  {
                    title: "Skipped Local Edits",
                    lines: renderBullets(result.skippedPaths),
                  },
                ]
              : []),
          ],
        })
      );
      return;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  let ref = "";
  let as: string | undefined;
  if (kind === "skill") {
    ref = `${BUILTIN_INDEX_NAME}:skill-template`;
    as = positional[0];
    if (!as) {
      console.error("templates init skill requires a <name>");
      process.exitCode = 2;
      return;
    }
  } else if (kind === "mcp") {
    ref = `${BUILTIN_INDEX_NAME}:mcp-stdio-template`;
    as = positional[0];
    if (!as) {
      console.error("templates init mcp requires a <name>");
      process.exitCode = 2;
      return;
    }
  } else if (kind === "agent") {
    ref = `${BUILTIN_INDEX_NAME}:agent-template`;
    const rawName = positional[0];
    if (!rawName) {
      console.error("templates init agent requires a <name>");
      process.exitCode = 2;
      return;
    }
    const normalizedName = rawName
      .replaceAll("\\", "/")
      .replace(TRAILING_SLASH_RE, "");
    as = normalizedName.endsWith(".toml")
      ? normalizedName
      : `${normalizedName}/agent.toml`;
  } else if (kind === "instruction") {
    ref = `${BUILTIN_INDEX_NAME}:instruction-template`;
    as = positional[0];
    if (!as) {
      console.error("templates init instruction requires a <name>");
      process.exitCode = 2;
      return;
    }
  } else if (kind === "snippet") {
    ref = `${BUILTIN_INDEX_NAME}:snippet-template`;
    as = positional[0];
    if (!as) {
      console.error("templates init snippet requires a <marker>");
      process.exitCode = 2;
      return;
    }
  } else if (kind === "agents") {
    ref = `${BUILTIN_INDEX_NAME}:agents-md-template`;
    as = positional[0];
  } else if (kind === "claude") {
    ref = `${BUILTIN_INDEX_NAME}:claude-md-template`;
    as = positional[0];
  } else if (kind === "automation") {
    const templateId = positional[0];
    if (!templateId) {
      console.error(
        "templates init automation requires a <template-id> (learning-review|evolution-review|tool-call-audit)"
      );
      process.exitCode = 2;
      return;
    }
    const template = BUILTIN_AUTOMATION_TEMPLATES.find(
      (candidate) => candidate.id === templateId
    );
    if (!template) {
      console.error(`Unknown automation template: ${templateId}`);
      process.exitCode = 1;
      return;
    }
    const status =
      parseLongFlag(args, "--status") ??
      parseLongFlag(args, "--automation-status");
    const scope = parseLongFlag(args, "--scope");
    const projectRoot = parseLongFlag(args, "--project-root");
    const cwdsRaw = parseLongFlag(args, "--cwds");
    const rrule = parseLongFlag(args, "--rrule");
    const name = parseLongFlag(args, "--name");
    const cwd = resolve(ctx.cwd ?? process.cwd());
    const home = ctx.homeDir ?? homedir();
    const normalizedCwds = normalizeCwdInput(cwdsRaw ?? "", cwd, home);
    const resolved = await resolveAutomationScopeInputs({
      template,
      requestedScope: scope,
      requestedProjectRoot: projectRoot,
      requestedCwdsRaw: cwdsRaw,
      requestedCwdsArray: normalizedCwds,
      homeDir: home,
      cwd,
      interactive: isInteractiveOutputRequested(args),
    });
    try {
      const result = await scaffoldCodexAutomationTemplate({
        homeDir: ctx.homeDir,
        cwd,
        templateId,
        force,
        dryRun,
        name: name ?? undefined,
        scope: resolved.scope,
        projectRoot: resolved.projectRoot,
        rootDir: parsedArgs.rootArg
          ? resolveCliContextRoot({
              rootArg: parsedArgs.rootArg,
              scope: resolved.scope === "project" ? "project" : "global",
              homeDir: home,
              cwd,
            })
          : undefined,
        cwds: resolved.cwds,
        rrule,
        status,
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const action = dryRun ? "Would scaffold" : "Scaffolded";
      console.log(
        renderPage({
          title: "fclt templates init automation",
          subtitle: `${action} ${result.installedAs}`,
          sections: [
            {
              title: "Automation",
              lines: renderKeyValue([
                ["name", result.installedAs],
                ["path", result.path],
              ]),
            },
            {
              title: "Changed Paths",
              lines: renderBullets(result.changedPaths),
            },
          ],
        })
      );
      return;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  } else {
    console.error(`Unknown template kind: ${kind}`);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await installRemoteItem({
      ref,
      as,
      dryRun,
      force,
      allowLegacyManagedMutation: legacyManagedMutationApproved({ argv: args }),
      homeDir: ctx.homeDir,
      rootDir: parsedArgs.rootArg ?? ctx.rootDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      now: ctx.now,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const action = dryRun ? "Would scaffold" : "Scaffolded";
    console.log(
      renderPage({
        title: `fclt templates init ${kind}`,
        subtitle: `${action} ${result.installedAs}`,
        sections: [
          {
            title: "Changed Paths",
            lines: renderBullets(result.changedPaths),
          },
        ],
      })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
