import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ensureAiGraphPath } from "./ai-state";
import {
  parseCliContextArgs,
  resolveCliContextRoot,
  resolveCliContextScope,
} from "./cli-context";
import type { AssetScope, GraphNodeKind } from "./graph";
import { loadGraph, resolveGraphNode } from "./graph-query";
import {
  facultAiDraftDir,
  facultAiEvolutionReviewDir,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiStateDir,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  legacyFacultAiStateDirs,
  projectRootFromAiRoot,
  projectSlugFromAiRoot,
  withFacultRootScope,
} from "./paths";
import { redactReconciliationText } from "./reconciliation-adapters";
import { writeCliOutput } from "./util/cli-output";

const NEWLINE_RE = /\r?\n/;
const TRAILING_NEWLINE_RE = /\n$/;
const NUMERIC_SUFFIX_RE = /(\d+)$/;
const SLUG_SPLIT_RE = /[/_-]+/;
const SKILL_MD_SUFFIX_RE = /\/SKILL\.md$/;
const MARKDOWN_SUFFIX_RE = /\.md$/;
const SKILL_SUFFIX_RE = /SKILL$/;

export type WritebackStatus =
  | "suggested"
  | "recorded"
  | "grouped"
  | "promoted"
  | "resolved"
  | "dismissed"
  | "superseded";
export type ProposalStatus =
  | "proposed"
  | "drafted"
  | "in_review"
  | "accepted"
  | "rejected"
  | "applied"
  | "failed"
  | "superseded";
export type ConfidenceLevel = "low" | "medium" | "high";
export type WritebackCategory = "friction" | "opportunity" | "reusable-success";
export type WritebackSensitivity = "public" | "internal" | "private";
export interface WritebackCapture {
  category: WritebackCategory;
  details?: string;
  impact?: string;
  attemptedWorkaround?: string;
  desiredOutcome?: string;
  sensitivity: WritebackSensitivity;
}
export type WritebackDisposition =
  | "propose"
  | "apply-local"
  | "task"
  | "resolve-watch"
  | "defer";
export type EvolutionEffectiveness =
  | "improved"
  | "unchanged"
  | "regressed"
  | "inconclusive";
export type ProposalKind =
  | "update_asset"
  | "create_asset"
  | "create_instruction"
  | "update_instruction"
  | "create_agent"
  | "update_agent"
  | "extract_snippet"
  | "add_skill"
  | "promote_asset";

export interface WritebackEvidence {
  type: string;
  ref: string;
}

export interface AiJournalEvent {
  id: string;
  ts: string;
  kind: string;
  source: string;
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
  summary: string;
  refs?: string[];
  evidence?: WritebackEvidence[];
  tags?: string[];
}

export interface AiWritebackRecord {
  id: string;
  ts: string;
  updatedAt?: string;
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
  kind: string;
  summary: string;
  capture?: WritebackCapture;
  evidence: WritebackEvidence[];
  confidence: ConfidenceLevel;
  source: string;
  assetRef?: string;
  assetId?: string;
  assetType?: string;
  suggestedDestination?: string;
  domain?: string;
  tags: string[];
  status: WritebackStatus;
  issueLinks?: string[];
  disposition?: WritebackDisposition;
  dispositionTarget?: string;
  nextTrigger?: string;
  expectedOutcome?: string;
}

export interface ProposalReviewHistoryEntry {
  ts: string;
  action: string;
  actor: string;
  note?: string;
}

export interface ProposalReviewRecord {
  status?: "in_review" | "accepted" | "rejected" | "superseded";
  reviewer?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  supersededBy?: string;
  history: ProposalReviewHistoryEntry[];
}

export interface ProposalApplyResult {
  status: "applied" | "failed";
  appliedAt: string;
  appliedBy: string;
  changedFiles: string[];
  draftRefs: string[];
  message?: string;
}

export interface ProposalEffectivenessRecord {
  auditId?: string;
  effectiveness: EvolutionEffectiveness;
  verifiedAt: string;
  verifiedBy: string;
  evidence: WritebackEvidence[];
  note?: string;
}

export interface ProposalVerificationSchedule {
  scheduledAt: string;
  opensAt: string;
  dueAt: string;
  overdueAt: string;
  delayHours: number;
  graceHours: number;
  status: "pending" | "completed" | "reopened";
  baseline: string[];
  criteria: string[];
  attempts: ProposalEffectivenessRecord[];
}

export interface ProposalDraftHistoryEntry {
  ts: string;
  action: "generated" | "revised";
  actor: string;
  draftRefs: string[];
  note?: string;
}

export interface AiProposalRecord {
  id: string;
  ts: string;
  status: ProposalStatus;
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
  kind: ProposalKind;
  targets: string[];
  sourceWritebacks: string[];
  summary: string;
  rationale: string;
  confidence: ConfidenceLevel;
  reviewRequired: boolean;
  policyClass: string;
  draftRefs: string[];
  sourceProposals?: string[];
  draftHistory?: ProposalDraftHistoryEntry[];
  review?: ProposalReviewRecord;
  applyResult?: ProposalApplyResult;
  verification?: ProposalVerificationSchedule;
  effectiveness?: ProposalEffectivenessRecord;
  effectivenessHistory?: ProposalEffectivenessRecord[];
}

export interface AiWritebackGroup {
  by: "asset" | "kind" | "domain";
  key: string;
  count: number;
  writebackIds: string[];
  assetRefs: string[];
  kinds: string[];
  domains: string[];
  tags: string[];
  summary: string;
}

export type EvolutionAssessmentRecommendation =
  | "no_mutation"
  | "reconcile_sources"
  | "review_reconciled_signals"
  | "record_more_writeback"
  | "propose"
  | "review_existing_proposal";

export interface EvolutionAssessment {
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
  asset?: string;
  target?: string;
  recommendation: EvolutionAssessmentRecommendation;
  confidence: ConfidenceLevel;
  rationale: string;
  writebackCount: number;
  sourceWritebacks: string[];
  kinds: string[];
  statuses: string[];
  evidenceCount: number;
  activeProposalIds: string[];
  repeatedSignal: boolean;
  reconciliation: {
    configured: boolean;
    coverageState?: "complete" | "degraded";
    lastReviewId?: string;
    signalCount: number;
    matchingSignalIds: string[];
  };
  approvalRequired: boolean;
  suggestedCommands: {
    readOnly: string[];
    mutating: string[];
  };
  qualityChecklist: {
    item: string;
    pass: boolean;
    note: string;
  }[];
  nextAgentInstruction: string;
}

interface ScopeContext {
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
}

interface AddWritebackArgs {
  homeDir?: string;
  rootDir: string;
  kind: string;
  category?: WritebackCategory;
  summary: string;
  details?: string;
  impact?: string;
  attemptedWorkaround?: string;
  desiredOutcome?: string;
  sensitivity?: WritebackSensitivity;
  asset?: string;
  evidence?: WritebackEvidence[];
  allowEmptyEvidence?: boolean;
  confidence?: ConfidenceLevel;
  source?: string;
  suggestedDestination?: string;
  domain?: string;
  tags?: string[];
}

const WRITEBACK_CAPTURE_LIMITS = {
  details: 2000,
  impact: 1000,
  attemptedWorkaround: 1000,
  desiredOutcome: 1000,
} as const;

function normalizedCaptureText(
  value: string | undefined,
  field: keyof typeof WRITEBACK_CAPTURE_LIMITS
): string | undefined {
  const normalized = value ? redactReconciliationText(value).trim() : undefined;
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("\0")) {
    throw new Error(`${field} must not contain null bytes`);
  }
  const limit = WRITEBACK_CAPTURE_LIMITS[field];
  if (normalized.length > limit) {
    throw new Error(`${field} must be ${limit} characters or fewer`);
  }
  return normalized;
}

function inferredWritebackCategory(kind: string): WritebackCategory {
  const normalized = kind.toLowerCase().replaceAll("_", "-");
  if (
    normalized.includes("success") ||
    normalized.includes("pattern") ||
    normalized.includes("proof")
  ) {
    return "reusable-success";
  }
  if (
    normalized.includes("gap") ||
    normalized.includes("opportunity") ||
    normalized.includes("missing") ||
    normalized.includes("stale")
  ) {
    return "opportunity";
  }
  return "friction";
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await Bun.file(pathValue).stat();
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(pathValue: string) {
  await mkdir(dirname(pathValue), { recursive: true });
}

async function appendJsonLine(pathValue: string, value: unknown) {
  await ensureParentDir(pathValue);
  await appendFile(pathValue, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines<T>(pathValue: string): Promise<T[]> {
  if (!(await fileExists(pathValue))) {
    return [];
  }
  const text = await readFile(pathValue, "utf8");
  return text
    .split(NEWLINE_RE)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readJsonLinesFromPaths<T>(pathValues: string[]): Promise<T[]> {
  const entries: T[] = [];
  for (const pathValue of pathValues) {
    entries.push(...(await readJsonLines<T>(pathValue)));
  }
  return entries;
}

function aiRuntimeScopeName(rootDir: string, homeDir: string): AssetScope {
  return projectRootFromAiRoot(rootDir, homeDir) ? "project" : "global";
}

function legacyAiRuntimeScopeDirs(homeDir: string, rootDir: string): string[] {
  const scope = aiRuntimeScopeName(rootDir, homeDir);
  return uniqueStrings([
    join(facultAiStateDir(homeDir, rootDir), scope),
    ...legacyFacultAiStateDirs(homeDir, rootDir).map((dir) => join(dir, scope)),
  ]);
}

function aiWritebackQueueReadPaths(homeDir: string, rootDir: string): string[] {
  return [
    ...legacyAiRuntimeScopeDirs(homeDir, rootDir).map((dir) =>
      join(dir, "writeback", "queue.jsonl")
    ),
    facultAiWritebackQueuePath(homeDir, rootDir),
  ];
}

function aiJournalReadPaths(homeDir: string, rootDir: string): string[] {
  return [
    ...legacyAiRuntimeScopeDirs(homeDir, rootDir).map((dir) =>
      join(dir, "journal", "events.jsonl")
    ),
    facultAiJournalPath(homeDir, rootDir),
  ];
}

function aiProposalReadDirs(homeDir: string, rootDir: string): string[] {
  return uniqueStrings([
    facultAiProposalDir(homeDir, rootDir),
    ...legacyAiRuntimeScopeDirs(homeDir, rootDir).map((dir) =>
      join(dir, "evolution", "proposals")
    ),
  ]);
}

async function firstExistingFile(paths: string[]): Promise<string | null> {
  for (const pathValue of paths) {
    if (await fileExists(pathValue)) {
      return pathValue;
    }
  }
  return null;
}

function supportedDraftTarget(pathValue: string): boolean {
  return pathValue.toLowerCase().endsWith(".md");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return "null";
}

function renderFrontmatter(values: Record<string, unknown>): string {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yamlScalar(value)}`);
  return ["---", ...lines, "---"].join("\n");
}

function markdownList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

function renderEvidenceList(evidence: WritebackEvidence[]): string[] {
  return evidence.length > 0
    ? evidence.map((entry) => `- ${entry.type}: ${entry.ref}`)
    : ["- none"];
}

function writebackReviewPath(
  homeDir: string,
  rootDir: string,
  id: string
): string {
  return join(facultAiWritebackReviewDir(homeDir, rootDir), `${id}.md`);
}

function proposalReviewPath(
  homeDir: string,
  rootDir: string,
  id: string
): string {
  return join(facultAiEvolutionReviewDir(homeDir, rootDir), `${id}.md`);
}

async function writeWritebackReviewArtifact(args: {
  homeDir: string;
  rootDir: string;
  record: AiWritebackRecord;
}): Promise<void> {
  const pathValue = writebackReviewPath(
    args.homeDir,
    args.rootDir,
    args.record.id
  );
  await ensureParentDir(pathValue);
  const body = [
    renderFrontmatter({
      id: args.record.id,
      artifact: "writeback",
      status: args.record.status,
      scope: args.record.scope,
      kind: args.record.kind,
      category: args.record.capture?.category,
      confidence: args.record.confidence,
      sensitivity: args.record.capture?.sensitivity,
      source: args.record.source,
      assetRef: args.record.assetRef,
      assetId: args.record.assetId,
      assetType: args.record.assetType,
      suggestedDestination: args.record.suggestedDestination,
      domain: args.record.domain,
      tags: args.record.tags,
      projectSlug: args.record.projectSlug,
      projectRoot: args.record.projectRoot,
      cwd: args.record.projectRoot,
      rootDir: args.rootDir,
      createdAt: args.record.ts,
      updatedAt: args.record.updatedAt ?? args.record.ts,
    }),
    "",
    `# ${args.record.id}: ${args.record.summary}`,
    "",
    "## Summary",
    args.record.summary,
    "",
    "## Capture Context",
    `- category: ${args.record.capture?.category ?? inferredWritebackCategory(args.record.kind)}`,
    `- sensitivity: ${args.record.capture?.sensitivity ?? "internal"}`,
    ...(args.record.capture?.sensitivity === "private"
      ? ["- supplemental context: omitted from this review artifact"]
      : [
          `- details: ${args.record.capture?.details ?? "not provided"}`,
          `- impact: ${args.record.capture?.impact ?? "not provided"}`,
          `- attempted workaround: ${args.record.capture?.attemptedWorkaround ?? "not provided"}`,
          `- desired outcome: ${args.record.capture?.desiredOutcome ?? "not provided"}`,
        ]),
    "",
    "## Evidence",
    ...renderEvidenceList(args.record.evidence),
    "",
    "## Target",
    `- asset: ${args.record.assetRef ?? "unassigned"}`,
    `- destination: ${args.record.suggestedDestination ?? "unassigned"}`,
    "",
    "## Closed Loop",
    `- disposition: ${args.record.disposition ?? "unassigned"}`,
    `- disposition target: ${args.record.dispositionTarget ?? "unassigned"}`,
    `- expected outcome: ${args.record.expectedOutcome ?? "unassigned"}`,
    `- next trigger: ${args.record.nextTrigger ?? "unassigned"}`,
    `- issues: ${(args.record.issueLinks ?? []).join(", ") || "none"}`,
    "",
  ].join("\n");
  await Bun.write(pathValue, `${body.trimEnd()}\n`);
}

async function writeProposalReviewArtifact(args: {
  homeDir: string;
  rootDir: string;
  proposal: AiProposalRecord;
  writebacks?: AiWritebackRecord[];
  draftBody?: string | null;
}): Promise<void> {
  const pathValue = proposalReviewPath(
    args.homeDir,
    args.rootDir,
    args.proposal.id
  );
  await ensureParentDir(pathValue);
  const body = [
    renderFrontmatter({
      id: args.proposal.id,
      artifact: "evolution_proposal",
      status: args.proposal.status,
      scope: args.proposal.scope,
      kind: args.proposal.kind,
      confidence: args.proposal.confidence,
      policyClass: args.proposal.policyClass,
      reviewRequired: args.proposal.reviewRequired,
      targets: args.proposal.targets,
      sourceWritebacks: args.proposal.sourceWritebacks,
      sourceProposals: args.proposal.sourceProposals,
      draftRefs: args.proposal.draftRefs,
      projectSlug: args.proposal.projectSlug,
      projectRoot: args.proposal.projectRoot,
      cwd: args.proposal.projectRoot,
      rootDir: args.rootDir,
      createdAt: args.proposal.ts,
      updatedAt:
        args.proposal.effectiveness?.verifiedAt ??
        args.proposal.review?.reviewedAt ??
        args.proposal.applyResult?.appliedAt ??
        args.proposal.draftHistory?.at(-1)?.ts ??
        args.proposal.ts,
    }),
    "",
    `# ${args.proposal.id}: ${args.proposal.summary}`,
    "",
    "## Rationale",
    args.proposal.rationale,
    "",
    "## Targets",
    ...markdownList(args.proposal.targets),
    "",
    "## Source Writebacks",
    ...(args.writebacks && args.writebacks.length > 0
      ? args.writebacks.map(
          (entry) => `- ${entry.id} (${entry.kind}): ${entry.summary}`
        )
      : markdownList(args.proposal.sourceWritebacks)),
    "",
    "## Draft Refs",
    ...markdownList(args.proposal.draftRefs),
    "",
    "## Effectiveness",
    `- verification due: ${args.proposal.verification?.dueAt ?? "unscheduled"}`,
    `- verification status: ${args.proposal.verification?.status ?? "unscheduled"}`,
    `- grade: ${args.proposal.effectiveness?.effectiveness ?? "unverified"}`,
    `- verified at: ${args.proposal.effectiveness?.verifiedAt ?? "unverified"}`,
    `- note: ${args.proposal.effectiveness?.note ?? "none"}`,
    ...renderEvidenceList(args.proposal.effectiveness?.evidence ?? []),
    ...(args.proposal.effectivenessHistory &&
    args.proposal.effectivenessHistory.length > 1
      ? [
          "",
          "### Verification history",
          ...args.proposal.effectivenessHistory.map(
            (entry) =>
              `- ${entry.verifiedAt}: ${entry.effectiveness}${entry.note ? ` — ${entry.note}` : ""}`
          ),
        ]
      : []),
    "",
    ...(args.draftBody
      ? [
          "## Current Draft",
          "",
          "```markdown",
          args.draftBody.trimEnd(),
          "```",
          "",
        ]
      : []),
  ].join("\n");
  await Bun.write(pathValue, `${body.trimEnd()}\n`);
}

async function currentDraftBodyForProposal(
  proposal: AiProposalRecord
): Promise<string | null> {
  const draftPath = proposal.draftRefs.find((pathValue) =>
    pathValue.endsWith(".md")
  );
  if (!(draftPath && (await fileExists(draftPath)))) {
    return null;
  }
  return readFile(draftPath, "utf8");
}

function slugToTitle(value: string): string {
  return value
    .split(SLUG_SPLIT_RE)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function canonicalRefToPath(args: {
  ref: string;
  homeDir: string;
  rootDir: string;
}): string | null {
  if (args.ref.startsWith("@ai/")) {
    const globalRoot = projectRootFromAiRoot(args.rootDir, args.homeDir)
      ? resolveCliContextRoot({
          homeDir: args.homeDir,
          scope: "global",
        })
      : args.rootDir;
    return join(globalRoot, args.ref.slice("@ai/".length));
  }
  if (args.ref.startsWith("@project/")) {
    const relPath = args.ref.slice("@project/".length);
    const canonicalPath = join(args.rootDir, relPath);
    const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
    if (projectRoot) {
      const projectPath = join(projectRoot, relPath);
      if (existsSync(canonicalPath)) {
        return canonicalPath;
      }
      return existsSync(projectPath) ? projectPath : canonicalPath;
    }
    return canonicalPath;
  }
  return null;
}

function numericSuffix(id: string): number {
  const match = NUMERIC_SUFFIX_RE.exec(id);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function nextId(prefix: string, ids: string[]): string {
  const next = ids.reduce((max, id) => Math.max(max, numericSuffix(id)), 0) + 1;
  return `${prefix}-${String(next).padStart(5, "0")}`;
}

function resolveScopeContext(rootDir: string, homeDir: string): ScopeContext {
  const projectRoot = projectRootFromAiRoot(rootDir, homeDir);
  const projectSlug = projectSlugFromAiRoot(rootDir, homeDir);
  if (projectRoot && projectSlug) {
    return {
      scope: "project",
      projectRoot,
      projectSlug,
    };
  }
  return { scope: "global" };
}

async function latestWritebackMap(args: {
  homeDir: string;
  rootDir: string;
}): Promise<Map<string, AiWritebackRecord>> {
  const entries = await readJsonLinesFromPaths<AiWritebackRecord>(
    aiWritebackQueueReadPaths(args.homeDir, args.rootDir)
  );
  const latest = new Map<string, AiWritebackRecord>();
  for (const entry of entries) {
    latest.set(entry.id, entry);
  }
  return latest;
}

async function appendEvent(
  homeDir: string,
  rootDir: string,
  event: AiJournalEvent
): Promise<void> {
  const pathValue = facultAiJournalPath(homeDir, rootDir);
  const existing = await readJsonLinesFromPaths<AiJournalEvent>(
    aiJournalReadPaths(homeDir, rootDir)
  );
  const next = {
    ...event,
    id: nextId(
      "EVT",
      existing.map((entry) => entry.id)
    ),
  };
  await appendJsonLine(pathValue, next);
}

function proposalVerificationAuditId(
  proposalId: string,
  record: ProposalEffectivenessRecord,
  occurrence = 0
): string {
  const identity = JSON.stringify({
    proposalId,
    occurrence,
    effectiveness: record.effectiveness,
    verifiedAt: record.verifiedAt,
    evidence: [...record.evidence].sort(
      (left, right) =>
        left.type.localeCompare(right.type) || left.ref.localeCompare(right.ref)
    ),
    note: record.note ?? "",
  });
  return `EVT-VERIFY-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}-R`;
}

async function ensureProposalVerificationEvent(args: {
  homeDir: string;
  rootDir: string;
  proposal: AiProposalRecord;
  record: ProposalEffectivenessRecord;
  onBeforeAppend?: () => void | Promise<void>;
}): Promise<void> {
  const auditId =
    args.record.auditId ??
    proposalVerificationAuditId(args.proposal.id, args.record);
  const journalPath = facultAiJournalPath(args.homeDir, args.rootDir);
  const existing = await readJsonLinesFromPaths<AiJournalEvent>(
    aiJournalReadPaths(args.homeDir, args.rootDir)
  );
  if (existing.some((event) => event.id === auditId)) {
    return;
  }
  await args.onBeforeAppend?.();
  await appendJsonLine(journalPath, {
    id: auditId,
    ts: args.record.verifiedAt,
    kind: "proposal_verified",
    source: "facult:evolution",
    scope: args.proposal.scope,
    projectSlug: args.proposal.projectSlug,
    projectRoot: args.proposal.projectRoot,
    summary: `${args.proposal.id} effectiveness -> ${args.record.effectiveness}`,
    refs: [args.proposal.id, ...args.proposal.targets],
    evidence: args.record.evidence,
    tags: [],
  } satisfies AiJournalEvent);
}

async function withProposalVerificationLock<T>(args: {
  homeDir: string;
  rootDir: string;
  proposalId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const journalPath = facultAiJournalPath(args.homeDir, args.rootDir);
  const lockDir = join(dirname(journalPath), "verification-locks");
  const lockId = createHash("sha256")
    .update(args.proposalId)
    .digest("hex")
    .slice(0, 20);
  const lockPath = join(lockDir, `proposal-${lockId}.lock`);
  await mkdir(lockDir, { recursive: true });
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 200 && !lock; attempt += 1) {
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  if (!lock) {
    throw new Error(
      `Timed out waiting for proposal verification lock ${lockPath}. Inspect its owner before explicitly removing an abandoned lock.`
    );
  }
  const token = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex");
  await lock.writeFile(
    `${JSON.stringify({ pid: process.pid, token, proposalId: args.proposalId })}\n`
  );
  try {
    return await args.operation();
  } finally {
    await lock.close();
    const owner = await readFile(lockPath, "utf8").catch(() => "");
    if (owner.includes(`"token":"${token}"`)) {
      await rm(lockPath, { force: true });
    }
  }
}

function mapGraphNodeKind(kind: GraphNodeKind): string {
  switch (kind) {
    case "instruction":
    case "snippet":
    case "agent":
    case "skill":
    case "mcp":
    case "automation":
    case "doc":
    case "rendered-target":
      return kind;
    default:
      return "asset";
  }
}

async function resolveAssetSelection(args: {
  homeDir: string;
  rootDir: string;
  asset: string;
  repairGraph?: boolean;
}): Promise<{
  assetRef?: string;
  assetId?: string;
  assetType?: string;
}> {
  await ensureAiGraphPath({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    repair: args.repairGraph,
  });
  const graph = await loadGraph({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
  });
  const node = resolveGraphNode(graph, args.asset);
  if (!node) {
    const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
    if (projectRoot) {
      const resolvedPath = resolve(projectRoot, args.asset);
      const relPath = relative(projectRoot, resolvedPath);
      if (
        relPath &&
        !relPath.startsWith("..") &&
        !relPath.includes("\0") &&
        (await fileExists(resolvedPath))
      ) {
        const normalizedRef = relPath.replaceAll("\\", "/");
        return {
          assetRef: `@project/${normalizedRef}`,
          assetId: `file:project:${normalizedRef}`,
          assetType: "file",
        };
      }
    }
    throw new Error(
      `Asset not found in graph: ${args.asset}. Run "fclt graph show <selector>" to check indexed assets, or use a project-relative file path that exists.`
    );
  }
  return {
    assetRef: node.canonicalRef ?? node.id,
    assetId: node.id,
    assetType: mapGraphNodeKind(node.kind),
  };
}

export async function addWriteback(
  args: AddWritebackArgs
): Promise<AiWritebackRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const evidence = (args.evidence ?? []).map((entry) => ({
    type: redactReconciliationText(entry.type),
    ref: redactReconciliationText(entry.ref),
  }));
  if (evidence.length === 0 && !args.allowEmptyEvidence) {
    throw new Error(
      "writeback add requires at least one evidence item; pass --evidence <type:ref> or use --allow-empty-evidence for scratch/demo notes"
    );
  }
  const scopeContext = resolveScopeContext(args.rootDir, homeDir);
  const latest = await latestWritebackMap({
    homeDir,
    rootDir: args.rootDir,
  });
  const asset = args.asset
    ? await resolveAssetSelection({
        homeDir,
        rootDir: args.rootDir,
        asset: args.asset,
      })
    : {};
  const record: AiWritebackRecord = {
    id: nextId("WB", [...latest.keys()]),
    ts: nowIso(),
    scope: scopeContext.scope,
    projectSlug: scopeContext.projectSlug,
    projectRoot: scopeContext.projectRoot,
    kind: redactReconciliationText(args.kind).trim(),
    summary: redactReconciliationText(args.summary).trim(),
    capture: {
      category: args.category ?? inferredWritebackCategory(args.kind),
      details: normalizedCaptureText(args.details, "details"),
      impact: normalizedCaptureText(args.impact, "impact"),
      attemptedWorkaround: normalizedCaptureText(
        args.attemptedWorkaround,
        "attemptedWorkaround"
      ),
      desiredOutcome: normalizedCaptureText(
        args.desiredOutcome,
        "desiredOutcome"
      ),
      sensitivity: args.sensitivity ?? "internal",
    },
    evidence,
    confidence: args.confidence ?? "medium",
    source: args.source ?? "facult:manual",
    assetRef: asset.assetRef,
    assetId: asset.assetId,
    assetType: asset.assetType,
    suggestedDestination: args.suggestedDestination ?? asset.assetRef,
    domain: args.domain,
    tags: [
      ...new Set((args.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
    ],
    status: "recorded",
  };

  await appendJsonLine(
    facultAiWritebackQueuePath(homeDir, args.rootDir),
    record
  );
  await appendEvent(homeDir, args.rootDir, {
    id: nextId("EVT", []),
    ts: record.ts,
    kind: "writeback_recorded",
    source: record.source,
    scope: record.scope,
    projectSlug: record.projectSlug,
    projectRoot: record.projectRoot,
    summary: record.summary,
    refs: record.assetRef ? [record.assetRef] : undefined,
    evidence: record.evidence,
    tags: record.tags,
  });
  await writeWritebackReviewArtifact({
    homeDir,
    rootDir: args.rootDir,
    record,
  });
  return record;
}

export async function listWritebacks(args?: {
  homeDir?: string;
  rootDir: string;
}): Promise<AiWritebackRecord[]> {
  if (!args) {
    throw new Error("listWritebacks requires a rootDir");
  }
  const homeDir = args?.homeDir ?? process.env.HOME ?? "";
  const latest = await latestWritebackMap({
    homeDir,
    rootDir: args.rootDir,
  });
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function portableWritebackRecord(record: AiWritebackRecord): Omit<
  AiWritebackRecord,
  "capture"
> & {
  capture?:
    | WritebackCapture
    | {
        category: WritebackCategory;
        sensitivity: "private";
        contextOmitted: true;
      };
} {
  if (record.capture?.sensitivity !== "private") {
    return record;
  }
  return {
    ...record,
    capture: {
      category: record.capture.category,
      sensitivity: "private",
      contextOmitted: true,
    },
  };
}

export async function showWriteback(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord | null> {
  const latest = await latestWritebackMap({
    homeDir: args.homeDir ?? process.env.HOME ?? "",
    rootDir: args.rootDir,
  });
  return latest.get(id) ?? null;
}

async function updateWritebackStatus(
  id: string,
  status: WritebackStatus,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showWriteback(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Writeback not found: ${id}`);
  }
  const next: AiWritebackRecord = {
    ...current,
    status,
    updatedAt: nowIso(),
  };
  const eventTs = next.updatedAt ?? next.ts;
  await appendJsonLine(facultAiWritebackQueuePath(homeDir, args.rootDir), next);
  await appendEvent(homeDir, args.rootDir, {
    id: nextId("EVT", []),
    ts: eventTs,
    kind: "writeback_status_changed",
    source: "facult:manual",
    scope: next.scope,
    projectSlug: next.projectSlug,
    projectRoot: next.projectRoot,
    summary: `${id} -> ${status}`,
    refs: next.assetRef ? [next.assetRef] : undefined,
    tags: next.tags,
  });
  await writeWritebackReviewArtifact({
    homeDir,
    rootDir: args.rootDir,
    record: next,
  });
  return next;
}

async function updateWriteback(
  id: string,
  args: { homeDir?: string; rootDir: string },
  mutate: (record: AiWritebackRecord) => AiWritebackRecord
): Promise<AiWritebackRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showWriteback(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Writeback not found: ${id}`);
  }
  const next = { ...mutate(current), updatedAt: nowIso() };
  await appendJsonLine(facultAiWritebackQueuePath(homeDir, args.rootDir), next);
  await writeWritebackReviewArtifact({
    homeDir,
    rootDir: args.rootDir,
    record: next,
  });
  return next;
}

export function linkWritebackIssue(
  id: string,
  issue: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  return updateWriteback(id, args, (record) => ({
    ...record,
    issueLinks: uniqueStrings([...(record.issueLinks ?? []), issue.trim()]),
  }));
}

export async function linkWritebackEvidence(
  id: string,
  evidence: WritebackEvidence,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  const current = await showWriteback(id, args);
  if (!current) {
    throw new Error(`Writeback not found: ${id}`);
  }
  if (
    current.evidence.some(
      (entry) => entry.type === evidence.type && entry.ref === evidence.ref
    )
  ) {
    return current;
  }
  return await updateWriteback(id, args, (record) => ({
    ...record,
    evidence: [...record.evidence, evidence],
  }));
}

export function setWritebackDisposition(
  id: string,
  disposition: WritebackDisposition,
  args: {
    homeDir?: string;
    rootDir: string;
    target?: string;
    nextTrigger?: string;
    expectedOutcome?: string;
  }
): Promise<AiWritebackRecord> {
  return updateWriteback(id, args, (record) => ({
    ...record,
    disposition,
    dispositionTarget: args.target?.trim() || undefined,
    nextTrigger: args.nextTrigger?.trim() || undefined,
    expectedOutcome: args.expectedOutcome?.trim() || undefined,
  }));
}

export function dismissWriteback(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  return updateWritebackStatus(id, "dismissed", args);
}

export function promoteWriteback(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  return updateWritebackStatus(id, "promoted", args);
}

function summarizeGroup(
  by: "asset" | "kind" | "domain",
  key: string,
  entries: AiWritebackRecord[]
): string {
  if (by === "asset") {
    return `${key} has ${entries.length} writeback${entries.length === 1 ? "" : "s"} across ${uniqueStrings(entries.map((entry) => entry.kind)).join(", ")}.`;
  }
  if (by === "domain") {
    return `${key} appears in ${entries.length} writeback${entries.length === 1 ? "" : "s"} across ${uniqueStrings(entries.map((entry) => entry.kind)).join(", ")}.`;
  }
  return `${key} appears in ${entries.length} writeback${entries.length === 1 ? "" : "s"} across ${uniqueStrings(entries.map((entry) => entry.assetRef ?? "unscoped")).join(", ")}.`;
}

export async function groupWritebacks(args: {
  homeDir?: string;
  rootDir: string;
  by: "asset" | "kind" | "domain";
}): Promise<AiWritebackGroup[]> {
  const writebacks = await listWritebacks({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
  });
  const groups = new Map<string, AiWritebackRecord[]>();
  for (const entry of writebacks) {
    if (entry.status === "dismissed" || entry.status === "superseded") {
      continue;
    }
    const key =
      args.by === "asset"
        ? (entry.assetRef ?? entry.suggestedDestination ?? "unassigned")
        : args.by === "kind"
          ? entry.kind
          : (entry.domain ?? "unassigned");
    const next = groups.get(key) ?? [];
    next.push(entry);
    groups.set(key, next);
  }

  return [...groups.entries()]
    .map(([key, entries]) => ({
      by: args.by,
      key,
      count: entries.length,
      writebackIds: entries.map((entry) => entry.id).sort(),
      assetRefs: uniqueStrings(entries.map((entry) => entry.assetRef ?? "")),
      kinds: uniqueStrings(entries.map((entry) => entry.kind)),
      domains: uniqueStrings(entries.map((entry) => entry.domain ?? "")),
      tags: uniqueStrings(entries.flatMap((entry) => entry.tags)),
      summary: summarizeGroup(args.by, key, entries),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function summarizeWritebacks(args: {
  homeDir?: string;
  rootDir: string;
  by: "asset" | "kind" | "domain";
}): Promise<AiWritebackGroup[]> {
  return groupWritebacks(args);
}

function inferProposalKind(args: {
  target: string;
  targetPath: string | null;
  targetKind?: GraphNodeKind | null;
}): ProposalKind {
  if (args.targetKind === "skill" && args.targetPath) {
    return "update_asset";
  }
  if (args.target.includes("/skills/") || args.target.endsWith("/SKILL.md")) {
    return args.targetPath ? "update_asset" : "add_skill";
  }
  if (args.target.includes("/snippets/")) {
    return "extract_snippet";
  }
  if (args.targetKind === "agent" || args.target.includes("/agents/")) {
    return args.targetPath ? "update_agent" : "create_agent";
  }
  if (
    args.targetKind === "instruction" ||
    args.target.includes("/instructions/")
  ) {
    return args.targetPath ? "update_instruction" : "create_instruction";
  }
  if (!args.targetPath) {
    return "create_asset";
  }
  return "update_asset";
}

async function nextProposalId(
  homeDir: string,
  rootDir: string
): Promise<string> {
  const ids: string[] = [];
  for (const dir of aiProposalReadDirs(homeDir, rootDir)) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    ids.push(
      ...entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => basename(entry, ".json"))
    );
  }
  return nextId("EV", ids);
}

function policyProfileForProposal(
  scope: AssetScope,
  kind: ProposalKind
): { policyClass: string; reviewRequired: boolean } {
  if (scope === "global") {
    return {
      policyClass: "high-risk",
      reviewRequired: true,
    };
  }

  if (
    kind === "create_instruction" ||
    kind === "create_asset" ||
    kind === "extract_snippet" ||
    kind === "add_skill"
  ) {
    return {
      policyClass: "low-risk",
      reviewRequired: false,
    };
  }

  if (kind === "update_instruction" || kind === "update_asset") {
    return {
      policyClass: "medium-risk",
      reviewRequired: true,
    };
  }

  return {
    policyClass: "high-risk",
    reviewRequired: true,
  };
}

function isStandaloneProposalKind(kind: ProposalKind): boolean {
  return (
    kind === "create_asset" ||
    kind === "create_instruction" ||
    kind === "create_agent" ||
    kind === "extract_snippet" ||
    kind === "add_skill" ||
    kind === "promote_asset"
  );
}

function isAppendProposalKind(kind: ProposalKind): boolean {
  return !isStandaloneProposalKind(kind);
}

function isApplySupportedProposalKind(kind: ProposalKind): boolean {
  return isStandaloneProposalKind(kind) || isAppendProposalKind(kind);
}

async function writeProposalFile(
  homeDir: string,
  rootDir: string,
  proposal: AiProposalRecord
) {
  const dir = facultAiProposalDir(homeDir, rootDir);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, `${proposal.id}.json`),
    `${JSON.stringify(proposal, null, 2)}\n`
  );
  await writeProposalReviewArtifact({ homeDir, rootDir, proposal });
}

export async function proposeEvolution(args: {
  homeDir?: string;
  rootDir: string;
  asset?: string;
  writebackIds?: string[];
}): Promise<AiProposalRecord[]> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const writebacks = await listWritebacks({
    homeDir,
    rootDir: args.rootDir,
  });
  const scopeContext = resolveScopeContext(args.rootDir, homeDir);
  const graph = await loadGraph({
    homeDir,
    rootDir: args.rootDir,
  }).catch(() => null);
  const filterAsset = args.asset
    ? await resolveAssetSelection({
        homeDir,
        rootDir: args.rootDir,
        asset: args.asset,
      })
    : null;
  const selectedWritebacks = args.writebackIds?.length
    ? new Set(args.writebackIds)
    : null;

  const candidates = writebacks.filter((entry) => {
    if (selectedWritebacks && !selectedWritebacks.has(entry.id)) {
      return false;
    }
    if (
      entry.status === "dismissed" ||
      entry.status === "resolved" ||
      entry.status === "superseded"
    ) {
      return false;
    }
    if (entry.evidence.length === 0) {
      return false;
    }
    if (filterAsset) {
      return (
        entry.assetId === filterAsset.assetId ||
        entry.assetRef === filterAsset.assetRef
      );
    }
    return Boolean(entry.suggestedDestination ?? entry.assetRef);
  });

  const groups = new Map<string, AiWritebackRecord[]>();
  for (const entry of candidates) {
    const target = entry.suggestedDestination ?? entry.assetRef;
    if (!target) {
      continue;
    }
    const next = groups.get(target) ?? [];
    next.push(entry);
    groups.set(target, next);
  }

  const proposals: AiProposalRecord[] = [];
  for (const [target, entries] of groups) {
    if (entries.length === 0) {
      continue;
    }
    const id = await nextProposalId(homeDir, args.rootDir);
    const targetPath = canonicalRefToPath({
      ref: target,
      homeDir,
      rootDir: args.rootDir,
    });
    const targetNode = graph && (resolveGraphNode(graph, target) ?? undefined);
    const kind = inferProposalKind({
      target,
      targetKind: targetNode?.kind,
      targetPath:
        targetNode?.path ??
        ((targetPath && (await fileExists(targetPath)) && targetPath) || null),
    });
    const policy = policyProfileForProposal(scopeContext.scope, kind);
    const proposal: AiProposalRecord = {
      id,
      ts: nowIso(),
      status: "proposed",
      scope: scopeContext.scope,
      projectSlug: scopeContext.projectSlug,
      projectRoot: scopeContext.projectRoot,
      kind,
      targets: [target],
      sourceWritebacks: entries.map((entry) => entry.id),
      summary: `Update ${target} based on ${entries.length} writeback${entries.length === 1 ? "" : "s"}.`,
      rationale: `Generated from ${entries.length} writeback${entries.length === 1 ? "" : "s"}: ${entries
        .map((entry) => entry.kind)
        .join(", ")}.`,
      confidence: entries.length > 1 ? "high" : "medium",
      reviewRequired: policy.reviewRequired,
      policyClass: policy.policyClass,
      draftRefs: [],
    };
    await writeProposalFile(homeDir, args.rootDir, proposal);
    await writeProposalReviewArtifact({
      homeDir,
      rootDir: args.rootDir,
      proposal,
      writebacks: entries,
    });
    await appendEvent(homeDir, args.rootDir, {
      id: nextId("EVT", []),
      ts: proposal.ts,
      kind: "proposal_generated",
      source: "facult:evolution",
      scope: proposal.scope,
      projectSlug: proposal.projectSlug,
      projectRoot: proposal.projectRoot,
      summary: proposal.summary,
      refs: proposal.targets,
      tags: [],
    });
    proposals.push(proposal);
  }

  return proposals.sort((a, b) => a.id.localeCompare(b.id));
}

const ACTIVE_PROPOSAL_STATUSES: ProposalStatus[] = [
  "proposed",
  "drafted",
  "in_review",
  "accepted",
];

function writebackSupportsImmediateProposal(entry: AiWritebackRecord): boolean {
  return (
    entry.confidence === "high" &&
    [
      "capability_gap",
      "missing_capability",
      "missing_context",
      "stale_asset",
      "stale_canonical_asset",
    ].includes(entry.kind)
  );
}

function commandAssetArg(asset?: string, target?: string): string {
  const value = asset ?? target;
  return value ? ` --asset ${JSON.stringify(value)}` : "";
}

function assessTargetKey(entry: AiWritebackRecord): string | undefined {
  return entry.suggestedDestination ?? entry.assetRef;
}

export async function assessEvolution(args: {
  homeDir?: string;
  rootDir: string;
  asset?: string;
}): Promise<EvolutionAssessment> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const scopeContext = resolveScopeContext(args.rootDir, homeDir);
  const filterAsset = args.asset
    ? await resolveAssetSelection({
        homeDir,
        rootDir: args.rootDir,
        asset: args.asset,
        repairGraph: false,
      })
    : null;
  const target = filterAsset?.assetRef ?? args.asset;
  const writebacks = (await listWritebacks({ homeDir, rootDir: args.rootDir }))
    .filter((entry) => entry.status !== "dismissed")
    .filter((entry) => entry.status !== "resolved")
    .filter((entry) => entry.status !== "superseded")
    .filter((entry) => entry.evidence.length > 0)
    .filter((entry) => {
      if (!filterAsset) {
        return Boolean(assessTargetKey(entry));
      }
      return (
        entry.assetId === filterAsset.assetId ||
        entry.assetRef === filterAsset.assetRef ||
        entry.suggestedDestination === filterAsset.assetRef
      );
    });

  const groups = new Map<string, AiWritebackRecord[]>();
  for (const entry of writebacks) {
    const key = assessTargetKey(entry);
    if (!key) {
      continue;
    }
    const next = groups.get(key) ?? [];
    next.push(entry);
    groups.set(key, next);
  }
  const [selectedTarget, selectedWritebacks] =
    target && groups.has(target)
      ? ([target, groups.get(target)!] as const)
      : ([...groups.entries()].sort((a, b) => {
          if (b[1].length !== a[1].length) {
            return b[1].length - a[1].length;
          }
          return a[0].localeCompare(b[0]);
        })[0] ?? [target, []]);

  const proposals = await listProposals({ homeDir, rootDir: args.rootDir });
  const activeProposalIds = proposals
    .filter(
      (proposal) =>
        ACTIVE_PROPOSAL_STATUSES.includes(proposal.status) ||
        (proposal.status === "applied" &&
          proposal.effectiveness?.effectiveness !== "improved")
    )
    .filter((proposal) => {
      if (!selectedTarget) {
        return false;
      }
      return proposal.targets.includes(selectedTarget);
    })
    .map((proposal) => proposal.id)
    .sort();
  const sourceWritebacks = selectedWritebacks.map((entry) => entry.id).sort();
  const kinds = uniqueStrings(selectedWritebacks.map((entry) => entry.kind));
  const statuses = uniqueStrings(
    selectedWritebacks.map((entry) => entry.status)
  );
  const evidenceCount = selectedWritebacks.reduce(
    (count, entry) => count + entry.evidence.length,
    0
  );
  const repeatedSignal = selectedWritebacks.length >= 2;
  const hasStrongSingleSignal = selectedWritebacks.some(
    writebackSupportsImmediateProposal
  );
  const canPropose = selectedWritebacks.length > 0;
  const shouldPropose = repeatedSignal || hasStrongSingleSignal;
  const { latestReconciliationReview, reconciliationStatus } = await import(
    "./reconciliation"
  );
  const reconciliation = await reconciliationStatus({
    homeDir,
    rootDir: args.rootDir,
  });
  const latestReview =
    reconciliation.stateError || reconciliation.configurationState !== "ready"
      ? null
      : await latestReconciliationReview({
          homeDir,
          rootDir: args.rootDir,
        });
  const matchingSignals = (latestReview?.signals ?? []).filter((signal) => {
    if (!selectedTarget) {
      return true;
    }
    return signal.assetRefs.some((assetRef) => {
      const normalizedAssetRef = assetRef.toLowerCase();
      if (assetRef.startsWith("@")) {
        return normalizedAssetRef === selectedTarget.toLowerCase();
      }
      const scopedAssetRef = `@${scopeContext.scope === "project" ? "project" : "ai"}/${normalizedAssetRef}`;
      return scopedAssetRef === selectedTarget.toLowerCase();
    });
  });

  let recommendation: EvolutionAssessmentRecommendation = "no_mutation";
  let confidence: ConfidenceLevel = "high";
  let rationale =
    "No targetable evidenced writeback signal was found. Do not create a proposal yet.";

  if (activeProposalIds.length > 0) {
    recommendation = "review_existing_proposal";
    confidence = "high";
    rationale = `Existing active proposal${activeProposalIds.length === 1 ? "" : "s"} already cover ${selectedTarget}. Review or revise before creating another proposal.`;
  } else if (
    matchingSignals.length > 0 &&
    reconciliation.coverageState === "complete"
  ) {
    recommendation = "review_reconciled_signals";
    confidence = "high";
    rationale = `Reconciliation review ${latestReview?.reviewId} contains ${matchingSignals.length} correlated signal${matchingSignals.length === 1 ? "" : "s"}. Review their dispositions and linked work before concluding that nothing is pending.`;
  } else if (shouldPropose) {
    recommendation = "propose";
    confidence = repeatedSignal ? "high" : "medium";
    rationale = repeatedSignal
      ? `${selectedTarget} has repeated evidenced signal across ${selectedWritebacks.length} writebacks. A small proposal is justified if the target and scope are correct.`
      : `${selectedTarget} has one high-confidence writeback that points at a clearly missing or stale capability. A small proposal may be justified after inspecting the target asset.`;
  } else if (canPropose) {
    recommendation = "record_more_writeback";
    confidence = "medium";
    rationale = `${selectedTarget} has only ${selectedWritebacks.length} evidenced writeback. Prefer recording another concrete recurrence or narrowing the target before proposing evolution.`;
  } else if (
    !(
      reconciliation.configured &&
      reconciliation.coverageState === "complete" &&
      latestReview &&
      latestReview.coverageComplete
    )
  ) {
    recommendation = "reconcile_sources";
    confidence = "high";
    rationale = reconciliation.configured
      ? latestReview
        ? `Reconciliation review ${latestReview.reviewId} has degraded source coverage. Do not report an empty review.`
        : "Configured sources have not been reconciled yet. The writeback queue alone cannot prove an empty review window."
      : "Automatic source reconciliation is not configured. The writeback queue alone cannot prove an empty review window.";
  }

  const assetArg = commandAssetArg(args.asset, selectedTarget);
  const readOnly = [
    "fclt status --json",
    "fclt ai review status --json",
    "fclt ai review reconcile --since <window-start> --until <window-end> --json",
    "fclt ai writeback group --by asset --json",
    `fclt ai evolve assess${assetArg} --json`,
    ...(activeProposalIds.length > 0
      ? activeProposalIds.map((id) => `fclt ai evolve show ${id} --json`)
      : []),
  ];
  const mutating =
    recommendation === "propose"
      ? [`fclt ai evolve propose${assetArg} --json`]
      : recommendation === "reconcile_sources" ||
          recommendation === "review_reconciled_signals"
        ? []
        : canPropose
          ? [
              "fclt ai writeback add --kind <kind> --summary <summary> --asset <target> --evidence <type:ref>",
              `fclt ai evolve propose${assetArg} --json`,
            ]
          : [
              "fclt ai writeback add --kind <kind> --summary <summary> --asset <target> --evidence <type:ref>",
            ];

  const qualityChecklist = [
    {
      item: "configured source coverage",
      pass: Boolean(
        reconciliation.coverageState === "complete" &&
          latestReview?.coverageComplete
      ),
      note: latestReview
        ? `${latestReview.reviewId} coverage is ${reconciliation.coverageState === "complete" && latestReview.coverageComplete ? "complete" : "degraded"} with ${latestReview.signals.length} correlated signal(s).`
        : "No completed reconciliation review is available for this scope.",
    },
    {
      item: "targetable asset",
      pass: Boolean(selectedTarget),
      note: selectedTarget ?? "No asset or suggested destination was selected.",
    },
    {
      item: "evidence present",
      pass: evidenceCount > 0,
      note:
        evidenceCount > 0
          ? `${evidenceCount} evidence item${evidenceCount === 1 ? "" : "s"} across selected writebacks.`
          : "Writebacks without evidence are ignored for evolution.",
    },
    {
      item: "repeated or clearly missing capability",
      pass: repeatedSignal || hasStrongSingleSignal,
      note: repeatedSignal
        ? "Repeated signal is present."
        : hasStrongSingleSignal
          ? "Single high-confidence missing/stale capability signal is present."
          : "Signal is not repeated and does not yet prove a missing or stale capability.",
    },
    {
      item: "no duplicate active proposal",
      pass: activeProposalIds.length === 0,
      note:
        activeProposalIds.length === 0
          ? "No active proposal targets this asset."
          : `Active proposals: ${activeProposalIds.join(", ")}.`,
    },
    {
      item: "smallest safe next action",
      pass: true,
      note:
        recommendation === "propose"
          ? "Draft only the smallest target-specific proposal, then review before apply."
          : recommendation === "review_existing_proposal"
            ? "Review or revise the existing proposal instead of creating a duplicate."
            : recommendation === "record_more_writeback"
              ? "Record another concrete recurrence before proposing."
              : recommendation === "reconcile_sources"
                ? "Run a bounded read-only source reconciliation before concluding the review is empty."
                : recommendation === "review_reconciled_signals"
                  ? "Review correlated dispositions and linked work; do not create one proposal per ticket."
                  : "Do not mutate capability state yet.",
    },
  ];

  const nextAgentInstruction =
    recommendation === "propose"
      ? `Inspect ${selectedTarget}, confirm scope and proposal kind, then ask before running the proposal command. Draft only the smallest change supported by ${sourceWritebacks.join(", ")}.`
      : recommendation === "review_existing_proposal"
        ? `Review ${activeProposalIds.join(", ")} and decide whether to revise, accept, reject, or leave it. Do not create a duplicate proposal.`
        : recommendation === "record_more_writeback"
          ? "Do not propose yet. Inspect the target if useful, explain what recurrence would change the decision, and record a new writeback only if there is fresh concrete evidence."
          : recommendation === "reconcile_sources"
            ? "Run a bounded source reconciliation for the intended window. Treat unavailable or stale coverage as degraded, not empty."
            : recommendation === "review_reconciled_signals"
              ? `Review ${matchingSignals.map((signal) => signal.id).join(", ")} and preserve each disposition, exclusion reason, and linked implementation target before proposing any capability change.`
              : "Do not mutate fclt state. The completed reconciliation window and writeback queue contain no targetable signal.";

  return {
    scope: scopeContext.scope,
    projectSlug: scopeContext.projectSlug,
    projectRoot: scopeContext.projectRoot,
    asset: args.asset,
    target: selectedTarget,
    recommendation,
    confidence,
    rationale,
    writebackCount: selectedWritebacks.length,
    sourceWritebacks,
    kinds,
    statuses,
    evidenceCount,
    activeProposalIds,
    repeatedSignal,
    reconciliation: {
      configured: reconciliation.configured,
      coverageState: reconciliation.coverageState,
      lastReviewId: reconciliation.lastReviewId,
      signalCount: latestReview?.signals.length ?? 0,
      matchingSignalIds: matchingSignals.map((signal) => signal.id),
    },
    approvalRequired:
      recommendation === "propose" ||
      recommendation === "review_existing_proposal",
    suggestedCommands: {
      readOnly,
      mutating,
    },
    qualityChecklist,
    nextAgentInstruction,
  };
}

export async function listProposals(args?: {
  homeDir?: string;
  rootDir: string;
}): Promise<AiProposalRecord[]> {
  if (!args) {
    throw new Error("listProposals requires a rootDir");
  }
  const homeDir = args?.homeDir ?? process.env.HOME ?? "";
  const byId = new Map<string, AiProposalRecord>();
  for (const dir of [...aiProposalReadDirs(homeDir, args.rootDir)].reverse()) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const raw = await readFile(join(dir, entry), "utf8");
      const parsed = JSON.parse(raw) as AiProposalRecord;
      byId.set(parsed.id, parsed);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function refreshAiReviewArtifacts(args: {
  homeDir?: string;
  rootDir: string;
}): Promise<{
  writebackCount: number;
  proposalCount: number;
  writebackReviewDir: string;
  evolutionReviewDir: string;
}> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const writebacks = await listWritebacks({ homeDir, rootDir: args.rootDir });
  for (const record of writebacks) {
    await writeWritebackReviewArtifact({
      homeDir,
      rootDir: args.rootDir,
      record,
    });
  }

  const proposals = await listProposals({ homeDir, rootDir: args.rootDir });
  for (const proposal of proposals) {
    const sourceWritebacks = (
      await Promise.all(
        proposal.sourceWritebacks.map((id) =>
          showWriteback(id, { homeDir, rootDir: args.rootDir })
        )
      )
    ).filter((entry): entry is AiWritebackRecord => Boolean(entry));
    await writeProposalReviewArtifact({
      homeDir,
      rootDir: args.rootDir,
      proposal,
      writebacks: sourceWritebacks,
      draftBody: await currentDraftBodyForProposal(proposal),
    });
  }

  const writebackReviewDir = facultAiWritebackReviewDir(homeDir, args.rootDir);
  const evolutionReviewDir = facultAiEvolutionReviewDir(homeDir, args.rootDir);
  await mkdir(writebackReviewDir, { recursive: true });
  await mkdir(evolutionReviewDir, { recursive: true });

  return {
    writebackCount: writebacks.length,
    proposalCount: proposals.length,
    writebackReviewDir,
    evolutionReviewDir,
  };
}

export async function showProposal(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord | null> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  for (const dir of aiProposalReadDirs(homeDir, args.rootDir)) {
    const pathValue = join(dir, `${id}.json`);
    if (!(await fileExists(pathValue))) {
      continue;
    }
    const raw = await readFile(pathValue, "utf8");
    return JSON.parse(raw) as AiProposalRecord;
  }
  return null;
}

function promoteTargetRef(target: string, to: "global"): string {
  if (to !== "global") {
    throw new Error(`Unsupported promotion target: ${to}`);
  }
  if (target.startsWith("@project/")) {
    return `@ai/${target.slice("@project/".length)}`;
  }
  if (target.startsWith("@ai/")) {
    return target;
  }
  throw new Error(`Cannot promote non-canonical target: ${target}`);
}

async function saveProposal(
  proposal: AiProposalRecord,
  args: { homeDir?: string; rootDir: string }
): Promise<void> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  await writeProposalFile(homeDir, args.rootDir, proposal);
}

function proposalActor(): string {
  return "facult:manual";
}

function nextReviewHistory(
  proposal: AiProposalRecord,
  entry: ProposalReviewHistoryEntry
): ProposalReviewRecord {
  const review = proposal.review ?? { history: [] };
  return {
    ...review,
    history: [...(review.history ?? []), entry],
  };
}

async function updateProposal(
  id: string,
  args: { homeDir?: string; rootDir: string },
  mutate: (proposal: AiProposalRecord) => AiProposalRecord
): Promise<AiProposalRecord> {
  const current = await showProposal(id, args);
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  const next = mutate(current);
  await saveProposal(next, args);
  return next;
}

export async function linkProposalWriteback(
  id: string,
  writebackId: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const [proposal, writeback] = await Promise.all([
    showProposal(id, { homeDir, rootDir: args.rootDir }),
    showWriteback(writebackId, { homeDir, rootDir: args.rootDir }),
  ]);
  if (!proposal) {
    throw new Error(`Proposal not found: ${id}`);
  }
  if (!writeback) {
    throw new Error(`Writeback not found: ${writebackId}`);
  }
  if (proposal.sourceWritebacks.includes(writebackId)) {
    return proposal;
  }
  const linked = await updateProposal(
    id,
    { homeDir, rootDir: args.rootDir },
    (current) => ({
      ...current,
      sourceWritebacks: uniqueStrings([
        ...current.sourceWritebacks,
        writebackId,
      ]),
    })
  );
  const writebacks = (
    await Promise.all(
      linked.sourceWritebacks.map((sourceId) =>
        showWriteback(sourceId, { homeDir, rootDir: args.rootDir })
      )
    )
  ).filter((entry): entry is AiWritebackRecord => Boolean(entry));
  const draftPath = linked.draftRefs.find((ref) => ref.endsWith(".md"));
  const draftBody = draftPath
    ? await readFile(draftPath, "utf8").catch(() => undefined)
    : undefined;
  await writeProposalReviewArtifact({
    homeDir,
    rootDir: args.rootDir,
    proposal: linked,
    writebacks,
    draftBody,
  });
  return linked;
}

function draftRefForProposal(
  homeDir: string,
  rootDir: string,
  id: string
): string {
  return join(facultAiDraftDir(homeDir, rootDir), `${id}.md`);
}

function patchRefForProposal(
  homeDir: string,
  rootDir: string,
  id: string
): string {
  return join(facultAiDraftDir(homeDir, rootDir), `${id}.patch`);
}

function renderDraftBody(
  proposal: AiProposalRecord,
  writebacks: AiWritebackRecord[]
): string {
  if (proposal.kind === "add_skill") {
    const target = proposal.targets[0] ?? "";
    const skillSlug =
      target.split("/skills/")[1]?.replace(SKILL_MD_SUFFIX_RE, "") ??
      "new-skill";
    return [
      "---",
      `name: ${skillSlug}`,
      `description: ${proposal.summary}`,
      "---",
      "",
      `# ${slugToTitle(skillSlug)}`,
      "",
      "## Purpose",
      proposal.rationale,
      "",
      "## When to Use",
      ...writebacks.map((entry) => `- ${entry.summary}`),
      "",
    ].join("\n");
  }

  if (isStandaloneProposalKind(proposal.kind)) {
    const target = proposal.targets[0] ?? "";
    const leaf =
      target
        .split("/")
        .pop()
        ?.replace(MARKDOWN_SUFFIX_RE, "")
        .replace(SKILL_SUFFIX_RE, "") ?? proposal.id;
    return [
      `# ${slugToTitle(leaf)}`,
      "",
      proposal.summary,
      "",
      "## Rationale",
      proposal.rationale,
      "",
      "## Supporting Writebacks",
      ...writebacks.map(
        (entry) => `- ${entry.id} (${entry.kind}): ${entry.summary}`
      ),
      "",
    ].join("\n");
  }

  const additionLines = [
    `## Facult Evolution Applied: ${proposal.id}`,
    "",
    `Summary: ${proposal.summary}`,
    "",
    "Supporting writebacks:",
    ...writebacks.map(
      (entry) => `- ${entry.id} (${entry.kind}): ${entry.summary}`
    ),
  ];

  return [
    `# Generated Draft: ${proposal.id}`,
    "",
    `Target: ${proposal.targets.join(", ")}`,
    `Kind: ${proposal.kind}`,
    "",
    "## Rationale",
    proposal.rationale,
    "",
    "## Proposed Addition",
    `<!-- facult:evolution:${proposal.id}:start -->`,
    ...additionLines,
    `<!-- facult:evolution:${proposal.id}:end -->`,
    "",
  ].join("\n");
}

function renderAppliedContent(
  proposal: AiProposalRecord,
  writebacks: AiWritebackRecord[]
): string {
  if (isStandaloneProposalKind(proposal.kind)) {
    return renderDraftBody(proposal, writebacks).trimEnd();
  }
  return extractDraftAddition(
    proposal.id,
    renderDraftBody(proposal, writebacks)
  );
}

function renderPatchBody(args: {
  targetPath: string;
  currentText: string;
  nextText: string;
}): string {
  const oldLines = args.currentText
    .replace(TRAILING_NEWLINE_RE, "")
    .split("\n");
  const newLines = args.nextText.replace(TRAILING_NEWLINE_RE, "").split("\n");
  return [
    `--- ${args.targetPath}`,
    `+++ ${args.targetPath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function extractDraftAddition(proposalId: string, input: string): string {
  const startMarker = `<!-- facult:evolution:${proposalId}:start -->`;
  const endMarker = `<!-- facult:evolution:${proposalId}:end -->`;
  const start = input.indexOf(startMarker);
  const end = input.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Draft for ${proposalId} is missing apply markers`);
  }
  return input.slice(start, end + endMarker.length).trim();
}

function insertDraftRevision(
  proposalId: string,
  draft: string,
  revision: string
): string {
  const marker = `<!-- facult:evolution:${proposalId}:end -->`;
  const markerIndex = draft.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Draft for ${proposalId} is missing apply markers`);
  }
  return `${draft.slice(0, markerIndex).trimEnd()}\n\n## Proposed Revision\n${revision.trim()}\n${draft.slice(markerIndex)}`;
}

async function resolveProposalTargetNode(
  proposal: AiProposalRecord,
  args: { homeDir?: string; rootDir: string }
) {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const target = proposal.targets[0];
  if (!target) {
    throw new Error(`Proposal ${proposal.id} has no targets`);
  }
  const graph = await loadGraph({
    homeDir,
    rootDir: args.rootDir,
  }).catch(() => null);
  const node = graph ? resolveGraphNode(graph, target) : null;
  const fallbackPath = canonicalRefToPath({
    ref: target,
    homeDir,
    rootDir: args.rootDir,
  });
  const pathValue =
    node?.kind === "skill" && node.path
      ? join(node.path, "SKILL.md")
      : (node?.path ?? fallbackPath);
  if (!pathValue) {
    throw new Error(`Could not resolve target path for ${target}`);
  }
  if (!supportedDraftTarget(pathValue)) {
    throw new Error(
      `Apply currently supports markdown targets only: ${pathValue}`
    );
  }
  return {
    ...node,
    path: pathValue,
    canonicalRef: node?.canonicalRef ?? target,
  };
}

export async function draftProposal(
  id: string,
  args: { homeDir?: string; rootDir: string; append?: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showProposal(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  const writebacks = (
    await Promise.all(
      current.sourceWritebacks.map(async (writebackId) => {
        const entry = await showWriteback(writebackId, {
          homeDir,
          rootDir: args.rootDir,
        });
        return entry ?? null;
      })
    )
  ).filter((entry): entry is AiWritebackRecord => Boolean(entry));
  const targetNode = await resolveProposalTargetNode(current, {
    homeDir,
    rootDir: args.rootDir,
  });
  const draftPath = draftRefForProposal(homeDir, args.rootDir, id);
  const patchPath = patchRefForProposal(homeDir, args.rootDir, id);
  await mkdir(dirname(draftPath), { recursive: true });
  const generatedBody = renderDraftBody(current, writebacks);
  const existingDraftPath = await firstExistingFile([
    draftPath,
    ...current.draftRefs.filter((pathValue) => pathValue.endsWith(".md")),
  ]);
  const priorDraft =
    args.append && existingDraftPath
      ? await readFile(existingDraftPath, "utf8")
      : null;
  const baseDraft = priorDraft ?? generatedBody;
  const draftBody = args.append
    ? isAppendProposalKind(current.kind)
      ? insertDraftRevision(id, baseDraft, args.append)
      : `${baseDraft.trimEnd()}\n\n## Draft Revision\n${args.append.trim()}\n`
    : generatedBody;
  await Bun.write(draftPath, `${draftBody}\n`);
  const currentText = (await fileExists(targetNode.path!))
    ? await readFile(targetNode.path!, "utf8")
    : "";
  const appliedContent = isAppendProposalKind(current.kind)
    ? extractDraftAddition(id, draftBody)
    : draftBody.trimEnd();
  const nextText = currentText.includes(appliedContent)
    ? currentText
    : `${currentText.trimEnd()}\n\n${appliedContent}\n`;
  await Bun.write(
    patchPath,
    `${renderPatchBody({
      targetPath: targetNode.path!,
      currentText,
      nextText,
    })}\n`
  );

  const actor = proposalActor();
  const next = await updateProposal(
    id,
    { homeDir, rootDir: args.rootDir },
    (proposal) => ({
      ...proposal,
      status: "drafted",
      draftRefs: uniqueStrings([draftPath, patchPath, ...proposal.draftRefs]),
      draftHistory: [
        ...(proposal.draftHistory ?? []),
        {
          ts: nowIso(),
          action: args.append ? "revised" : "generated",
          actor,
          draftRefs: uniqueStrings([draftPath, patchPath]),
          note: args.append?.trim(),
        },
      ],
      review: nextReviewHistory(proposal, {
        ts: nowIso(),
        action: args.append ? "draft_revised" : "drafted",
        actor,
        note: targetNode.canonicalRef ?? targetNode.path,
      }),
    })
  );
  await writeProposalReviewArtifact({
    homeDir,
    rootDir: args.rootDir,
    proposal: next,
    writebacks,
    draftBody,
  });
  await appendEvent(homeDir, args.rootDir, {
    id: "",
    ts: nowIso(),
    kind: "proposal_drafted",
    source: actor,
    scope: next.scope,
    projectSlug: next.projectSlug,
    projectRoot: next.projectRoot,
    summary: `Drafted ${next.id}`,
    refs: [...next.targets, ...next.draftRefs],
    tags: [],
  });
  return next;
}

export function reviewProposal(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  return updateProposal(id, { homeDir, rootDir: args.rootDir }, (proposal) => {
    const reviewedAt = nowIso();
    return {
      ...proposal,
      status: "in_review",
      review: {
        ...nextReviewHistory(proposal, {
          ts: reviewedAt,
          action: "in_review",
          actor,
        }),
        status: "in_review",
        reviewer: actor,
        reviewedAt,
      },
    };
  });
}

export function acceptProposal(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  return updateProposal(id, { homeDir, rootDir: args.rootDir }, (proposal) => {
    const reviewedAt = nowIso();
    return {
      ...proposal,
      status: "accepted",
      review: {
        ...nextReviewHistory(proposal, {
          ts: reviewedAt,
          action: "accepted",
          actor,
        }),
        status: "accepted",
        reviewer: actor,
        reviewedAt,
        rejectionReason: undefined,
      },
    };
  });
}

export async function rejectProposal(
  id: string,
  args: { homeDir?: string; rootDir: string; reason: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  const rejected = await updateProposal(
    id,
    { homeDir, rootDir: args.rootDir },
    (proposal) => {
      const reviewedAt = nowIso();
      return {
        ...proposal,
        status: "rejected",
        review: {
          ...nextReviewHistory(proposal, {
            ts: reviewedAt,
            action: "rejected",
            actor,
            note: args.reason,
          }),
          status: "rejected",
          reviewer: actor,
          reviewedAt,
          rejectionReason: args.reason,
        },
      };
    }
  );
  for (const writebackId of rejected.sourceWritebacks) {
    const writeback = await showWriteback(writebackId, {
      homeDir,
      rootDir: args.rootDir,
    });
    if (writeback?.status === "promoted") {
      await updateWritebackStatus(writebackId, "recorded", {
        homeDir,
        rootDir: args.rootDir,
      });
    }
  }
  return rejected;
}

export function supersedeProposal(
  id: string,
  by: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  return updateProposal(id, { homeDir, rootDir: args.rootDir }, (proposal) => {
    const reviewedAt = nowIso();
    return {
      ...proposal,
      status: "superseded",
      review: {
        ...nextReviewHistory(proposal, {
          ts: reviewedAt,
          action: "superseded",
          actor,
          note: by,
        }),
        status: "superseded",
        reviewer: actor,
        reviewedAt,
        supersededBy: by,
      },
    };
  });
}

export async function applyProposal(
  id: string,
  args: {
    homeDir?: string;
    rootDir: string;
    verificationDelayHours?: number;
    verificationGraceHours?: number;
    now?: () => Date;
  }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showProposal(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  if (!isApplySupportedProposalKind(current.kind)) {
    throw new Error(`Unsupported proposal kind for apply: ${current.kind}`);
  }
  const requiresAcceptedReview = current.reviewRequired !== false;
  if (
    (requiresAcceptedReview && current.status !== "accepted") ||
    (!requiresAcceptedReview &&
      current.status !== "accepted" &&
      current.status !== "drafted")
  ) {
    throw new Error(`Proposal must be accepted before apply: ${id}`);
  }
  if (current.draftRefs.length === 0) {
    throw new Error(
      `Proposal ${id} has no draft refs. Run "fclt ai evolve draft ${id}" first.`
    );
  }

  const verificationDelayHours = args.verificationDelayHours ?? 168;
  if (!Number.isFinite(verificationDelayHours) || verificationDelayHours <= 0) {
    throw new Error("verificationDelayHours must be a positive number");
  }
  const appliedAtDate = args.now?.() ?? new Date();
  const appliedAt = appliedAtDate.toISOString();
  const verificationGraceHours = args.verificationGraceHours ?? 24;
  if (!Number.isFinite(verificationGraceHours) || verificationGraceHours < 0) {
    throw new Error("verificationGraceHours must be a non-negative number");
  }
  const verificationDueAt = new Date(
    appliedAtDate.getTime() + verificationDelayHours * 60 * 60 * 1000
  ).toISOString();
  const verificationOverdueAt = new Date(
    Date.parse(verificationDueAt) + verificationGraceHours * 60 * 60 * 1000
  ).toISOString();
  const sourceWritebacks = (
    await Promise.all(
      current.sourceWritebacks.map((writebackId) =>
        showWriteback(writebackId, { homeDir, rootDir: args.rootDir })
      )
    )
  ).filter((entry): entry is AiWritebackRecord => Boolean(entry));

  const targetNode = await resolveProposalTargetNode(current, {
    homeDir,
    rootDir: args.rootDir,
  });
  const draftPath = current.draftRefs[0];
  if (!draftPath) {
    throw new Error(`Proposal ${id} has no primary draft ref`);
  }
  const draftText = await readFile(draftPath, "utf8");
  const existingTarget = (await fileExists(targetNode.path!))
    ? await readFile(targetNode.path!, "utf8")
    : "";
  const nextText = isAppendProposalKind(current.kind)
    ? (() => {
        const addition = extractDraftAddition(id, draftText);
        return existingTarget.includes(addition)
          ? existingTarget
          : `${existingTarget.trimEnd()}\n\n${addition}\n`;
      })()
    : `${draftText.trimEnd()}\n`;
  await Bun.write(targetNode.path!, nextText);

  for (const writeback of sourceWritebacks) {
    await updateWritebackStatus(writeback.id, "promoted", {
      homeDir,
      rootDir: args.rootDir,
    });
  }

  const actor = proposalActor();
  const next = await updateProposal(
    id,
    { homeDir, rootDir: args.rootDir },
    (proposal) => ({
      ...proposal,
      status: "applied",
      review: nextReviewHistory(proposal, {
        ts: appliedAt,
        action: "applied",
        actor,
        note: targetNode.path,
      }),
      applyResult: {
        status: "applied",
        appliedAt,
        appliedBy: actor,
        changedFiles: [targetNode.path!],
        draftRefs: proposal.draftRefs,
        message: `Applied ${proposal.id} to ${targetNode.path}`,
      },
      verification: {
        scheduledAt: appliedAt,
        opensAt: verificationDueAt,
        dueAt: verificationDueAt,
        overdueAt: verificationOverdueAt,
        delayHours: verificationDelayHours,
        graceHours: verificationGraceHours,
        status: "pending",
        baseline: sourceWritebacks.map((entry) => entry.summary),
        criteria: uniqueStrings(
          sourceWritebacks.flatMap((entry) =>
            entry.expectedOutcome ? [entry.expectedOutcome] : []
          )
        ),
        attempts: [],
      },
    })
  );

  await appendEvent(homeDir, args.rootDir, {
    id: "",
    ts: appliedAt,
    kind: "proposal_applied",
    source: actor,
    scope: next.scope,
    projectSlug: next.projectSlug,
    projectRoot: next.projectRoot,
    summary: `Applied ${next.id}`,
    refs: [targetNode.path!, ...next.targets],
    tags: [],
  });

  return next;
}

interface VerifyProposalEffectivenessArgs {
  homeDir?: string;
  rootDir: string;
  effectiveness: EvolutionEffectiveness;
  evidence: WritebackEvidence[];
  note?: string;
  allowEarly?: boolean;
  now?: () => Date;
  onBeforeAuditAppend?: () => void | Promise<void>;
}

async function verifyProposalEffectivenessUnlocked(
  id: string,
  args: VerifyProposalEffectivenessArgs
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showProposal(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  if (current.status !== "applied") {
    throw new Error(`Proposal must be applied before verify: ${id}`);
  }
  if (args.evidence.length === 0) {
    throw new Error("evolve verify requires at least one --evidence");
  }

  const verifiedAtDate = args.now?.() ?? new Date();
  if (
    current.verification?.opensAt &&
    verifiedAtDate.getTime() < Date.parse(current.verification.opensAt) &&
    !args.allowEarly
  ) {
    throw new Error(
      `Verification window for ${id} opens at ${current.verification.opensAt}. Use --allow-early only with explicit outcome evidence.`
    );
  }
  const normalizedEvidence = [...args.evidence].sort(
    (left, right) =>
      left.type.localeCompare(right.type) || left.ref.localeCompare(right.ref)
  );
  const sourceStatus: WritebackStatus =
    args.effectiveness === "improved"
      ? "resolved"
      : args.effectiveness === "inconclusive"
        ? "promoted"
        : "recorded";
  const reconcileSourceStatuses = async () => {
    for (const writebackId of current.sourceWritebacks) {
      const writeback = await showWriteback(writebackId, {
        homeDir,
        rootDir: args.rootDir,
      });
      if (writeback?.status !== sourceStatus) {
        await updateWritebackStatus(writebackId, sourceStatus, {
          homeDir,
          rootDir: args.rootDir,
        });
      }
    }
  };
  const verificationHistory =
    current.effectivenessHistory ??
    (current.effectiveness ? [current.effectiveness] : []);
  const matchesVerification = (entry: ProposalEffectivenessRecord) =>
    entry.effectiveness === args.effectiveness &&
    (entry.note ?? "") === (args.note?.trim() ?? "") &&
    JSON.stringify(
      [...entry.evidence].sort(
        (left, right) =>
          left.type.localeCompare(right.type) ||
          left.ref.localeCompare(right.ref)
      )
    ) === JSON.stringify(normalizedEvidence);
  const latestDuplicate = verificationHistory.at(-1);
  if (latestDuplicate && matchesVerification(latestDuplicate)) {
    await reconcileSourceStatuses();
    await ensureProposalVerificationEvent({
      homeDir,
      rootDir: args.rootDir,
      proposal: current,
      record: latestDuplicate,
      onBeforeAppend: args.onBeforeAuditAppend,
    });
    return current;
  }
  const verifiedAt = verifiedAtDate.toISOString();
  const verifiedBy = proposalActor();
  const effectivenessRecord: ProposalEffectivenessRecord = {
    auditId: proposalVerificationAuditId(
      id,
      {
        effectiveness: args.effectiveness,
        verifiedAt,
        verifiedBy,
        evidence: normalizedEvidence,
        note: args.note?.trim() || undefined,
      },
      verificationHistory.length + 1
    ),
    effectiveness: args.effectiveness,
    verifiedAt,
    verifiedBy,
    evidence: normalizedEvidence,
    note: args.note?.trim() || undefined,
  };
  const next = await updateProposal(
    id,
    { homeDir, rootDir: args.rootDir },
    (proposal) => ({
      ...proposal,
      effectiveness: effectivenessRecord,
      effectivenessHistory: [
        ...(proposal.effectivenessHistory ??
          (proposal.effectiveness ? [proposal.effectiveness] : [])),
        effectivenessRecord,
      ],
      verification: proposal.verification
        ? {
            ...proposal.verification,
            status:
              args.effectiveness === "improved"
                ? "completed"
                : args.effectiveness === "inconclusive"
                  ? "pending"
                  : "reopened",
            attempts: [
              ...(proposal.verification.attempts ?? []),
              effectivenessRecord,
            ],
          }
        : proposal.verification,
    })
  );
  await reconcileSourceStatuses();
  await ensureProposalVerificationEvent({
    homeDir,
    rootDir: args.rootDir,
    proposal: next,
    record: effectivenessRecord,
    onBeforeAppend: args.onBeforeAuditAppend,
  });
  return next;
}

export async function verifyProposalEffectiveness(
  id: string,
  args: VerifyProposalEffectivenessArgs
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  return await withProposalVerificationLock({
    homeDir,
    rootDir: args.rootDir,
    proposalId: id,
    operation: async () => await verifyProposalEffectivenessUnlocked(id, args),
  });
}

export async function promoteProposal(
  id: string,
  args: {
    homeDir?: string;
    rootDir: string;
    to: "global";
  }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showProposal(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  if (current.scope !== "project") {
    throw new Error(`Only project-scoped proposals can be promoted: ${id}`);
  }
  const sourceWritebacks = (
    await Promise.all(
      current.sourceWritebacks.map(async (writebackId) => {
        return (
          (await showWriteback(writebackId, {
            homeDir,
            rootDir: args.rootDir,
          })) ?? null
        );
      })
    )
  ).filter((entry): entry is AiWritebackRecord => Boolean(entry));
  const targetRoot =
    args.to === "global"
      ? resolveCliContextRoot({ homeDir, scope: "global" })
      : args.rootDir;
  const nextIdValue = await nextProposalId(homeDir, targetRoot);
  const promoted: AiProposalRecord = {
    ...current,
    id: nextIdValue,
    ts: nowIso(),
    status: "proposed",
    scope: "global",
    projectSlug: undefined,
    projectRoot: undefined,
    kind: "promote_asset",
    targets: current.targets.map((target) => promoteTargetRef(target, args.to)),
    summary: sourceWritebacks[0]?.summary ?? current.summary,
    rationale: `Promoted from project proposal ${current.id} targeting ${current.targets.join(", ")}. ${current.rationale}`,
    policyClass: "high-risk",
    draftRefs: [],
    sourceProposals: uniqueStrings([
      ...(current.sourceProposals ?? []),
      current.id,
    ]),
    review: {
      history: [
        {
          ts: nowIso(),
          action: "promoted",
          actor: proposalActor(),
          note: `from ${current.scope} to ${args.to}`,
        },
      ],
    },
    applyResult: undefined,
  };
  await writeProposalFile(homeDir, targetRoot, promoted);
  await writeProposalReviewArtifact({
    homeDir,
    rootDir: targetRoot,
    proposal: promoted,
    writebacks: sourceWritebacks,
  });
  await appendEvent(homeDir, targetRoot, {
    id: "",
    ts: promoted.ts,
    kind: "proposal_promoted",
    source: proposalActor(),
    scope: promoted.scope,
    summary: `Promoted ${current.id} -> ${promoted.id}`,
    refs: [...promoted.targets, current.id],
    tags: [],
  });
  return promoted;
}

function aiHelp(): string {
  return `fclt ai — writeback and evolution workflows

Usage:
  fclt ai writeback <add|list|show|link|disposition|dismiss|promote> [args...]
  fclt ai evolve <assess|propose|list|show|draft|review|accept|reject|supersede|apply|verify> [args...]
  fclt ai review <init|status|reconcile> [args...]
  fclt ai loop <enable|disable|status|report|activity|history|resolve|decide|run> [args...]
`;
}

function loopHelp(): string {
  return `fclt ai loop

Usage:
  fclt ai loop enable [--rrule <RRULE>] [--source <configured-id>] [--dry-run] [--json]
  fclt ai loop disable [--dry-run] [--json]
  fclt ai loop status [--json]
  fclt ai loop report [--json]
  fclt ai loop activity [--all|--global|--project] [--json]
  fclt ai loop resolve <activity-action-locator> [--json]
  fclt ai loop decide <activity-action-locator> --decision <accept|redirect|reject|defer> --expected-revision <n> --actor <id> (--approval-ref <ref>|--note <text>) [--redirect-target <target>] --approve [--json]
  fclt ai loop history [--all|--global|--project] [--since <date>] [--until <date>] [--item <id>] [--scope-id <opaque-id>] [--event <type>] [--limit <1-200>] [--cursor <cursor>] [--json]
  fclt ai loop run [--since <date>] [--until <date>] [--source <configured-id>] [--dry-run] [--scheduled] [--json]

The loop keeps a full machine-local review queue and emits a delta for
notifications. Scheduler enablement is explicit. Canonical auto-apply remains
plan-only until a hash-bound transaction and rollback receipt are available.
`;
}

function reviewHelp(): string {
  return `fclt ai review

Usage:
  fclt ai review init [--dry-run] [--force] [--json]
  fclt ai review status [--json]
  fclt ai review reconcile --since <date> [--until <date>] [--source <id>] [--incremental] [--config <path>] [--json]

Reconciliation reads configured sources and writes machine-local cursors plus a
human-readable review artifact. It never mutates external sources or applies a
proposal.
`;
}

function writebackHelp(): string {
  return `fclt ai writeback

Usage:
  fclt ai writeback add --kind <kind> --summary <text> [--category <friction|opportunity|reusable-success>] [--details <text>] [--impact <text>] [--attempted-workaround <text>] [--desired-outcome <text>] [--sensitivity <public|internal|private>] [--asset <selector>] [--tag <tag>] [--evidence <type:ref>] [--allow-empty-evidence]
  fclt ai writeback list [--json]
  fclt ai writeback show <id> [--json]
  fclt ai writeback link <id> --issue <issue-id>
  fclt ai writeback disposition <id> --type <propose|apply-local|task|resolve-watch|defer> [--target <ref>] [--next-trigger <text>] [--expected-outcome <text>]
  fclt ai writeback group --by <asset|kind|domain> [--json]
  fclt ai writeback summarize [--by <asset|kind|domain>] [--json]
  fclt ai writeback dismiss <id>
  fclt ai writeback promote <id>
`;
}

function evolveHelp(): string {
  return `fclt ai evolve

Usage:
  fclt ai evolve assess [--asset <selector>] [--json]
  fclt ai evolve propose [--asset <selector>] [--json]
  fclt ai evolve list [--json]
  fclt ai evolve show <id> [--json]
  fclt ai evolve draft <id> [--append <text>]
  fclt ai evolve review <id>
  fclt ai evolve accept <id>
  fclt ai evolve reject <id> --reason <text>
  fclt ai evolve supersede <id> --by <proposal-id>
  fclt ai evolve apply <id>
  fclt ai evolve verify <id> --effectiveness <improved|unchanged|regressed|inconclusive> --evidence <type:ref> [--note <text>] [--allow-early]
  fclt ai evolve promote <id> --to global
`;
}

function parseStringFlag(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    }
  }
  return undefined;
}

function parseRepeatedFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      values.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      values.push(value);
    }
  }
  return values;
}

function parseIntegerFlag(argv: string[], flag: string): number | undefined {
  const raw = parseStringFlag(argv, flag);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} requires an integer`);
  }
  return parsed;
}

async function loopCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  const [sub, ...commandArgs] = parsed.argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(loopHelp());
    return;
  }
  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    console.log(loopHelp());
    return;
  }
  if (sub === "resolve") {
    if (parsed.rootArg || parsed.scope !== "merged") {
      throw new Error(
        "Activity locator resolution does not accept caller-supplied root or scope authority"
      );
    }
    const locatorArgs = commandArgs.filter((arg) => arg !== "--json");
    const locator = locatorArgs[0];
    if (
      locatorArgs.length !== 1 ||
      !locator ||
      locator.startsWith("-") ||
      commandArgs.some((arg) => arg.startsWith("-") && arg !== "--json")
    ) {
      throw new Error(
        "loop resolve accepts exactly one opaque locator and optional --json"
      );
    }
    const { renderActivityActionResolution, resolveActivityActionLocator } =
      await import("./activity-action");
    const result = await resolveActivityActionLocator({
      homeDir: process.env.HOME ?? "",
      locator,
    });
    console.log(
      commandArgs.includes("--json")
        ? JSON.stringify(result, null, 2)
        : renderActivityActionResolution(result)
    );
    if (result.status === "rejected") {
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "decide") {
    if (parsed.rootArg || parsed.scope !== "merged") {
      throw new Error(
        "Activity decision recording does not accept caller-supplied root or scope authority"
      );
    }
    const valueFlags = new Set([
      "--decision",
      "--expected-revision",
      "--actor",
      "--approval-ref",
      "--note",
      "--redirect-target",
    ]);
    const values = new Map<string, string>();
    const booleans = new Set<string>();
    const positional: string[] = [];
    for (let index = 0; index < commandArgs.length; index += 1) {
      const argument = commandArgs[index];
      if (!argument) {
        continue;
      }
      if (argument === "--json" || argument === "--approve") {
        if (booleans.has(argument)) {
          throw new Error(`loop decide received duplicate ${argument}`);
        }
        booleans.add(argument);
        continue;
      }
      const equalsIndex = argument.indexOf("=");
      const flag = equalsIndex > 0 ? argument.slice(0, equalsIndex) : argument;
      if (valueFlags.has(flag)) {
        if (values.has(flag)) {
          throw new Error(`loop decide received duplicate ${flag}`);
        }
        const value =
          equalsIndex > 0
            ? argument.slice(equalsIndex + 1)
            : commandArgs[++index];
        if (!value) {
          throw new Error(`${flag} requires a value`);
        }
        values.set(flag, value);
        continue;
      }
      if (argument.startsWith("-")) {
        throw new Error(`loop decide received unsupported option ${argument}`);
      }
      positional.push(argument);
    }
    if (positional.length !== 1) {
      throw new Error(
        "loop decide accepts exactly one opaque locator and closed decision fields"
      );
    }
    const decision = values.get("--decision");
    const expectedRevision = Number(values.get("--expected-revision"));
    const actor = values.get("--actor");
    if (
      !(
        decision &&
        ["accept", "redirect", "reject", "defer"].includes(decision) &&
        Number.isSafeInteger(expectedRevision) &&
        actor
      )
    ) {
      throw new Error(
        "loop decide requires --decision, --expected-revision, and --actor"
      );
    }
    const { decideActivityAction, renderActivityDecisionResult } = await import(
      "./activity-action"
    );
    const result = await decideActivityAction({
      homeDir: process.env.HOME ?? "",
      locator: positional[0]!,
      decision: decision as "accept" | "redirect" | "reject" | "defer",
      expectedRevision,
      actor,
      approvalReference: values.get("--approval-ref"),
      note: values.get("--note"),
      redirectTarget: values.get("--redirect-target"),
      approve: booleans.has("--approve"),
    });
    console.log(
      booleans.has("--json")
        ? JSON.stringify(result, null, 2)
        : renderActivityDecisionResult(result)
    );
    if (result.status === "rejected") {
      process.exitCode = 1;
    }
    return;
  }
  const rootDir = resolveCliContextRoot({
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });
  const homeDir = process.env.HOME ?? "";
  const loopScope =
    parsed.scope === "global" || parsed.scope === "project"
      ? parsed.scope
      : projectRootFromAiRoot(rootDir, homeDir)
        ? "project"
        : "global";
  const json = commandArgs.includes("--json");
  const {
    disableEvolutionLoop,
    enableEvolutionLoop,
    evolutionLoopStatus,
    latestEvolutionLoopReport,
    runEvolutionLoop,
  } = await import("./evolution-loop");
  try {
    if (sub === "enable") {
      const result = await enableEvolutionLoop({
        homeDir,
        rootDir,
        scope: loopScope,
        rrule: parseStringFlag(commandArgs, "--rrule"),
        sourceIds: parseRepeatedFlag(commandArgs, "--source"),
        dryRun: commandArgs.includes("--dry-run"),
      });
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : `${result.dryRun ? "Would enable" : "Enabled"} evolution loop at ${result.automationPath}`
      );
      return;
    }
    if (sub === "disable") {
      const result = await disableEvolutionLoop({
        homeDir,
        rootDir,
        scope: loopScope,
        dryRun: commandArgs.includes("--dry-run"),
      });
      if (!(result.dryRun || result.scheduler?.paused || !result.config)) {
        process.exitCode = 1;
      }
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : result.config
            ? result.scheduler?.paused
              ? `${result.dryRun ? "Would pause" : "Paused"} evolution loop`
              : `Disabled evolution loop configuration, but the scheduler was not paused: ${result.scheduler?.error ?? "unknown scheduler error"}`
            : "Evolution loop is not configured"
      );
      return;
    }
    if (sub === "status") {
      const result = await evolutionLoopStatus({
        homeDir,
        rootDir,
        scope: loopScope,
      });
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : [
              `loop: ${result.health}`,
              `configured: ${result.configured}`,
              `queue: ${Object.keys(result.state.queue).length}`,
              `last run: ${result.state.lastRunAt ?? "never"}`,
            ].join("\n")
      );
      return;
    }
    if (sub === "report") {
      const result = await latestEvolutionLoopReport({
        homeDir,
        rootDir,
        scope: loopScope,
      });
      if (!result) {
        throw new Error("No evolution loop report has been recorded");
      }
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : [
              `loop report: ${result.runId}`,
              `status: ${result.status}`,
              `coverage: ${result.coverageComplete ? "complete" : "degraded"}`,
              `freshness: ${result.freshness.state}`,
              `queue: ${result.queue.length}`,
              `notifiable: ${result.delta.notifiable.length}`,
              `artifact: ${result.artifactPath}`,
            ].join("\n")
      );
      return;
    }
    if (sub === "activity") {
      const {
        latestActivityFeed,
        latestActivitySet,
        renderActivityFeed,
        renderActivitySet,
      } = await import("./activity");
      const explicitAllScopes = commandArgs.includes("--all");
      const allScopes = explicitAllScopes || parsed.scope === "merged";
      if (explicitAllScopes && parsed.scope !== "merged") {
        throw new Error("Conflicting scope flags");
      }
      if (allScopes) {
        const globalRootDir = resolveCliContextRoot({
          homeDir,
          cwd: process.cwd(),
          rootArg: parsed.rootArg,
          scope: "global",
        });
        if (
          !explicitAllScopes &&
          projectRootFromAiRoot(globalRootDir, homeDir)
        ) {
          throw new Error(
            "All-scope activity accepts only a global --root; use --project for one project"
          );
        }
        const result = await latestActivitySet({
          homeDir,
          globalRootDir,
        });
        await writeCliOutput(
          json ? JSON.stringify(result, null, 2) : renderActivitySet(result)
        );
        return;
      }
      const result = await latestActivityFeed({
        homeDir,
        rootDir,
        scope: loopScope,
      });
      if (!result) {
        throw new Error("No evolution loop report has been recorded");
      }
      await writeCliOutput(
        json ? JSON.stringify(result, null, 2) : renderActivityFeed(result)
      );
      return;
    }
    if (sub === "history") {
      const { queryActivityHistory, renderActivityHistory } = await import(
        "./activity-history"
      );
      const explicitAllScopes = commandArgs.includes("--all");
      const allScopes = explicitAllScopes || parsed.scope === "merged";
      if (explicitAllScopes && parsed.scope !== "merged") {
        throw new Error("Conflicting scope flags");
      }
      const historyRootDir = allScopes
        ? resolveCliContextRoot({
            homeDir,
            cwd: process.cwd(),
            rootArg: parsed.rootArg,
            scope: "global",
          })
        : rootDir;
      if (
        allScopes &&
        !explicitAllScopes &&
        projectRootFromAiRoot(historyRootDir, homeDir)
      ) {
        throw new Error(
          "All-scope history accepts only a global --root; use --project for one project"
        );
      }
      const eventTypes = parseRepeatedFlag(commandArgs, "--event");
      const allowedEventTypes = new Set([
        "run",
        "discovery",
        "observation",
        "correlation",
        "disposition",
        "proposal",
        "review",
        "application",
        "verification",
        "effectiveness",
        "regression",
        "supersession",
        "resolution",
      ]);
      const invalidEventType = eventTypes.find(
        (value) => !allowedEventTypes.has(value)
      );
      if (invalidEventType) {
        throw new Error(
          `Unknown activity history event type: ${invalidEventType}`
        );
      }
      const queryArgs = {
        homeDir,
        rootDir: historyRootDir,
        scope: allScopes ? "all" : loopScope,
        since: parseStringFlag(commandArgs, "--since"),
        until: parseStringFlag(commandArgs, "--until"),
        item: parseStringFlag(commandArgs, "--item"),
        scopeId: parseStringFlag(commandArgs, "--scope-id"),
        eventTypes:
          eventTypes as import("./activity-history").ActivityHistoryEventType[],
        limit: parseIntegerFlag(commandArgs, "--limit"),
        cursor: parseStringFlag(commandArgs, "--cursor"),
      } as const;
      const result = await withFacultRootScope(
        {
          rootDir: historyRootDir,
          scope: allScopes ? "global" : loopScope,
        },
        async () => await queryActivityHistory(queryArgs)
      );
      await writeCliOutput(
        json ? JSON.stringify(result, null, 2) : renderActivityHistory(result)
      );
      return;
    }
    if (sub === "run") {
      const result = await runEvolutionLoop({
        homeDir,
        rootDir,
        scope: loopScope,
        since: parseStringFlag(commandArgs, "--since"),
        until: parseStringFlag(commandArgs, "--until"),
        sourceIds: parseRepeatedFlag(commandArgs, "--source"),
        dryRun: commandArgs.includes("--dry-run"),
        trigger: commandArgs.includes("--scheduled") ? "scheduled" : "manual",
      });
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : [
              `loop run: ${result.runId}`,
              `status: ${result.status}`,
              `queue: ${result.queue.length}`,
              `notifiable: ${result.delta.notifiable.length}`,
              `artifact: ${result.artifactPath}`,
            ].join("\n")
      );
      if (result.status === "failed") {
        process.exitCode = 1;
      }
      return;
    }
    throw new Error(`Unknown loop command: ${sub}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseEvidence(argv: string[]): WritebackEvidence[] {
  return parseRepeatedFlag(argv, "--evidence").map((entry) => {
    const [type, ...rest] = entry.split(":");
    const ref = rest.join(":").trim();
    if (!(type?.trim() && ref)) {
      throw new Error(`Invalid evidence reference: ${entry}`);
    }
    return { type: type.trim(), ref };
  });
}

async function writebackCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  const [sub, ...commandArgs] = parsed.argv;

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(writebackHelp());
    return;
  }

  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    console.log(writebackHelp());
    return;
  }

  const rootDir = resolveCliContextRoot({
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });

  try {
    if (sub === "add") {
      const kind = parseStringFlag(commandArgs, "--kind");
      const summary = parseStringFlag(commandArgs, "--summary");
      if (!(kind && summary)) {
        throw new Error("writeback add requires --kind and --summary");
      }
      const category = parseStringFlag(commandArgs, "--category") as
        | WritebackCategory
        | undefined;
      const sensitivity = parseStringFlag(commandArgs, "--sensitivity") as
        | WritebackSensitivity
        | undefined;
      if (
        category &&
        !(["friction", "opportunity", "reusable-success"] as const).includes(
          category
        )
      ) {
        throw new Error(`Unsupported writeback category: ${category}`);
      }
      if (
        sensitivity &&
        !(["public", "internal", "private"] as const).includes(sensitivity)
      ) {
        throw new Error(`Unsupported writeback sensitivity: ${sensitivity}`);
      }
      const record = await addWriteback({
        rootDir,
        kind,
        category,
        summary,
        details: parseStringFlag(commandArgs, "--details"),
        impact: parseStringFlag(commandArgs, "--impact"),
        attemptedWorkaround: parseStringFlag(
          commandArgs,
          "--attempted-workaround"
        ),
        desiredOutcome: parseStringFlag(commandArgs, "--desired-outcome"),
        sensitivity,
        asset: parseStringFlag(commandArgs, "--asset"),
        allowEmptyEvidence: commandArgs.includes("--allow-empty-evidence"),
        confidence:
          (parseStringFlag(commandArgs, "--confidence") as
            | ConfidenceLevel
            | undefined) ?? undefined,
        suggestedDestination: parseStringFlag(
          commandArgs,
          "--suggested-destination"
        ),
        tags: parseRepeatedFlag(commandArgs, "--tag"),
        evidence: parseEvidence(commandArgs),
      });
      if (commandArgs.includes("--json")) {
        console.log(JSON.stringify(portableWritebackRecord(record), null, 2));
        return;
      }
      console.log(`Recorded writeback ${record.id}`);
      console.log(JSON.stringify(portableWritebackRecord(record), null, 2));
      return;
    }

    if (sub === "list") {
      const rows = await listWritebacks({ rootDir });
      if (commandArgs.includes("--json")) {
        console.log(JSON.stringify(rows.map(portableWritebackRecord), null, 2));
        return;
      }
      console.log(`writebacks root: ${rootDir}`);
      console.log(
        `writebacks scope: ${projectRootFromAiRoot(rootDir, process.env.HOME ?? "") ? "project" : "global"}`
      );
      if (rows.length === 0) {
        console.log("No writebacks found for this scope.");
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}\t${row.kind}\t[${row.status}]\t${row.summary}`);
      }
      return;
    }

    if (sub === "group" || sub === "summarize") {
      const byValue = parseStringFlag(commandArgs, "--by") ?? "asset";
      if (byValue !== "asset" && byValue !== "kind" && byValue !== "domain") {
        throw new Error(`Unsupported writeback grouping: ${byValue}`);
      }
      const rows =
        sub === "group"
          ? await groupWritebacks({ rootDir, by: byValue })
          : await summarizeWritebacks({ rootDir, by: byValue });
      if (commandArgs.includes("--json")) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(
          `${row.key}\tcount=${row.count}\t${sub === "group" ? row.writebackIds.join(",") : row.summary}`
        );
      }
      return;
    }

    if (sub === "show") {
      const id = commandArgs.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error("writeback show requires an id");
      }
      const row = await showWriteback(id, { rootDir });
      if (!row) {
        throw new Error(`Writeback not found: ${id}`);
      }
      console.log(JSON.stringify(portableWritebackRecord(row), null, 2));
      return;
    }

    if (sub === "link") {
      const id = commandArgs.find((arg) => !arg.startsWith("-"));
      const issue = parseStringFlag(commandArgs, "--issue");
      if (!(id && issue)) {
        throw new Error("writeback link requires an id and --issue");
      }
      const row = await linkWritebackIssue(id, issue, { rootDir });
      console.log(`Linked ${row.id} to ${issue}`);
      console.log(JSON.stringify(portableWritebackRecord(row), null, 2));
      return;
    }

    if (sub === "disposition") {
      const id = commandArgs.find((arg) => !arg.startsWith("-"));
      const disposition = parseStringFlag(commandArgs, "--type") as
        | WritebackDisposition
        | undefined;
      const allowed: WritebackDisposition[] = [
        "propose",
        "apply-local",
        "task",
        "resolve-watch",
        "defer",
      ];
      if (!(id && disposition && allowed.includes(disposition))) {
        throw new Error(
          "writeback disposition requires an id and valid --type"
        );
      }
      const row = await setWritebackDisposition(id, disposition, {
        rootDir,
        target: parseStringFlag(commandArgs, "--target"),
        nextTrigger: parseStringFlag(commandArgs, "--next-trigger"),
        expectedOutcome: parseStringFlag(commandArgs, "--expected-outcome"),
      });
      console.log(`Updated disposition for ${row.id}`);
      console.log(JSON.stringify(portableWritebackRecord(row), null, 2));
      return;
    }

    if (sub === "dismiss" || sub === "promote") {
      const id = commandArgs.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error(`writeback ${sub} requires an id`);
      }
      const row =
        sub === "dismiss"
          ? await dismissWriteback(id, { rootDir })
          : await promoteWriteback(id, { rootDir });
      console.log(`${sub === "dismiss" ? "Dismissed" : "Promoted"} ${row.id}`);
      console.log(JSON.stringify(portableWritebackRecord(row), null, 2));
      return;
    }

    throw new Error(`Unknown writeback command: ${sub}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function evolveCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  const [sub, ...commandArgs] = parsed.argv;

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(evolveHelp());
    return;
  }

  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    console.log(evolveHelp());
    return;
  }

  const rootDir = resolveCliContextRoot({
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });

  try {
    if (sub === "assess") {
      const assessment = await assessEvolution({
        rootDir,
        asset: parseStringFlag(commandArgs, "--asset"),
      });
      if (commandArgs.includes("--json")) {
        console.log(JSON.stringify(assessment, null, 2));
        return;
      }
      console.log(`recommendation: ${assessment.recommendation}`);
      console.log(`target: ${assessment.target ?? "none"}`);
      console.log(`confidence: ${assessment.confidence}`);
      console.log(`rationale: ${assessment.rationale}`);
      console.log(
        `writebacks: ${assessment.writebackCount}${
          assessment.sourceWritebacks.length > 0
            ? ` (${assessment.sourceWritebacks.join(", ")})`
            : ""
        }`
      );
      console.log(`approval required: ${assessment.approvalRequired}`);
      console.log(`next: ${assessment.nextAgentInstruction}`);
      return;
    }

    if (sub === "propose") {
      const proposals = await proposeEvolution({
        rootDir,
        asset: parseStringFlag(commandArgs, "--asset"),
      });
      if (commandArgs.includes("--json")) {
        console.log(JSON.stringify(proposals, null, 2));
        return;
      }
      for (const proposal of proposals) {
        console.log(
          `${proposal.id}\t${proposal.targets.join(", ")}\t${proposal.summary}`
        );
      }
      return;
    }

    if (sub === "list") {
      const rows = await listProposals({ rootDir });
      if (commandArgs.includes("--json")) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}\t[${row.status}]\t${row.targets.join(", ")}`);
      }
      return;
    }

    if (sub === "show") {
      const id = commandArgs.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error("evolve show requires an id");
      }
      const row = await showProposal(id, { rootDir });
      if (!row) {
        throw new Error(`Proposal not found: ${id}`);
      }
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    if (sub === "verify") {
      const id = commandArgs.find((arg) => !arg.startsWith("-"));
      const effectiveness = parseStringFlag(commandArgs, "--effectiveness") as
        | EvolutionEffectiveness
        | undefined;
      const allowed: EvolutionEffectiveness[] = [
        "improved",
        "unchanged",
        "regressed",
        "inconclusive",
      ];
      if (!(id && effectiveness && allowed.includes(effectiveness))) {
        throw new Error(
          "evolve verify requires an id and valid --effectiveness"
        );
      }
      const row = await verifyProposalEffectiveness(id, {
        rootDir,
        effectiveness,
        evidence: parseEvidence(commandArgs),
        note: parseStringFlag(commandArgs, "--note"),
        allowEarly: commandArgs.includes("--allow-early"),
      });
      console.log(`Verified ${row.id} as ${effectiveness}`);
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    if (
      sub === "draft" ||
      sub === "review" ||
      sub === "accept" ||
      sub === "reject" ||
      sub === "supersede" ||
      sub === "apply" ||
      sub === "promote"
    ) {
      const id = commandArgs.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error(`evolve ${sub} requires an id`);
      }
      const row =
        sub === "draft"
          ? await draftProposal(id, {
              rootDir,
              append: parseStringFlag(commandArgs, "--append"),
            })
          : sub === "review"
            ? await reviewProposal(id, { rootDir })
            : sub === "accept"
              ? await acceptProposal(id, { rootDir })
              : sub === "reject"
                ? await rejectProposal(id, {
                    rootDir,
                    reason:
                      parseStringFlag(commandArgs, "--reason") ??
                      (() => {
                        throw new Error("evolve reject requires --reason");
                      })(),
                  })
                : sub === "supersede"
                  ? await supersedeProposal(
                      id,
                      parseStringFlag(commandArgs, "--by") ??
                        (() => {
                          throw new Error("evolve supersede requires --by");
                        })(),
                      { rootDir }
                    )
                  : sub === "promote"
                    ? await promoteProposal(id, {
                        rootDir,
                        to:
                          (parseStringFlag(commandArgs, "--to") as
                            | "global"
                            | undefined) ??
                          (() => {
                            throw new Error("evolve promote requires --to");
                          })(),
                      })
                    : await applyProposal(id, { rootDir });
      const verb =
        sub === "draft"
          ? "Drafted"
          : sub === "review"
            ? "Reviewed"
            : sub === "accept"
              ? "Accepted"
              : sub === "reject"
                ? "Rejected"
                : sub === "supersede"
                  ? "Superseded"
                  : sub === "promote"
                    ? "Promoted"
                    : "Applied";
      console.log(`${verb} ${row.id}`);
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    throw new Error(`Unknown evolve command: ${sub}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function reviewCommand(argv: string[]): Promise<void> {
  const parsed = parseCliContextArgs(argv);
  const [sub, ...commandArgs] = parsed.argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(reviewHelp());
    return;
  }
  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    console.log(reviewHelp());
    return;
  }
  const rootDir = resolveCliContextRoot({
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });
  const homeDir = process.env.HOME ?? "";
  const json = commandArgs.includes("--json");
  try {
    if (sub === "init") {
      const { initializeReconciliationConfig } = await import(
        "./reconciliation-config"
      );
      const result = await initializeReconciliationConfig({
        homeDir,
        rootDir,
        scope:
          parsed.scope === "global" || parsed.scope === "project"
            ? parsed.scope
            : undefined,
        dryRun: commandArgs.includes("--dry-run"),
        force: commandArgs.includes("--force"),
      });
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : `${result.created ? "Initialized" : "Using"} reconciliation config ${result.path}`
      );
      return;
    }
    if (sub === "status") {
      const { reconciliationStatus } = await import("./reconciliation");
      const result = await reconciliationStatus({ homeDir, rootDir });
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : `reconciliation: ${result.configured ? (result.coverageState ?? "not-run") : "not-configured"}\nconfig: ${result.configPath}\nstate: ${result.statePath}`
      );
      return;
    }
    if (sub === "reconcile") {
      const since = parseStringFlag(commandArgs, "--since");
      if (!since) {
        throw new Error("review reconcile requires --since");
      }
      const { reconcileSources } = await import("./reconciliation");
      const result = await reconcileSources({
        homeDir,
        rootDir,
        since,
        until: parseStringFlag(commandArgs, "--until"),
        configPath: parseStringFlag(commandArgs, "--config"),
        sourceIds: parseRepeatedFlag(commandArgs, "--source"),
        incremental: commandArgs.includes("--incremental"),
      });
      console.log(
        json
          ? JSON.stringify(result, null, 2)
          : [
              `review: ${result.reviewId}`,
              `coverage: ${result.coverageComplete ? "complete" : "degraded"}`,
              `freshness: ${result.freshness.state}`,
              `signals: ${result.signals.length}`,
              `artifact: ${result.artifactPath}`,
            ].join("\n")
      );
      return;
    }
    throw new Error(`Unknown review command: ${sub}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function aiCommand(
  argv: string[],
  rootScopeActive = false
): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(aiHelp());
    return;
  }

  if (!rootScopeActive) {
    const parsed = parseCliContextArgs(rest);
    const homeDir = process.env.HOME ?? "";
    const rootDir = resolveCliContextRoot({
      homeDir,
      rootArg: parsed.rootArg,
      scope: parsed.scope,
      cwd: process.cwd(),
    });
    const scope = resolveCliContextScope({
      homeDir,
      rootDir,
      scope: parsed.scope,
    });
    await withFacultRootScope({ rootDir, scope }, async () =>
      aiCommand(argv, true)
    );
    return;
  }

  if (sub === "writeback") {
    await writebackCommand(rest);
    return;
  }

  if (sub === "evolve") {
    await evolveCommand(rest);
    return;
  }
  if (sub === "review" || sub === "reconcile") {
    await reviewCommand(sub === "reconcile" ? ["reconcile", ...rest] : rest);
    return;
  }
  if (sub === "loop") {
    await loopCommand(rest);
    return;
  }

  console.error(`Unknown ai command: ${sub}`);
  process.exitCode = 1;
}
