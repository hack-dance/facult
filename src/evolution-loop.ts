import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { activityActionRootIdentity } from "./activity-action-contract";
import {
  type AiProposalRecord,
  type AiWritebackRecord,
  addWriteback,
  draftProposal,
  linkProposalWriteback,
  linkWritebackEvidence,
  linkWritebackIssue,
  listProposals,
  listWritebacks,
  proposeEvolution,
} from "./ai";
import {
  facultAiEvolutionLoopAuditPath,
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopLockPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionLoopStatePath,
  facultAiEvolutionReviewDir,
  machineStateProjectKey,
  projectRootFromAiRoot,
  withFacultRootScope,
} from "./paths";
import {
  processStartIdentity,
  processStartIdentityMatches,
} from "./process-identity";
import { reconcileSources, reconciliationStatus } from "./reconciliation";
import { DEFAULT_SOURCE_FRESHNESS_THRESHOLD_HOURS } from "./reconciliation-config";
import type {
  CorrelatedSignal,
  ReconciliationFreshness,
  ReconciliationReview,
  ResolutionProof,
  SourceCoverage,
} from "./reconciliation-types";
import {
  assertSafeCodexAutomationTarget,
  scaffoldCodexAutomationTemplate,
  setCodexAutomationStatus,
} from "./remote";

const DEFAULT_RRULE = "RRULE:FREQ=DAILY;BYHOUR=19;BYMINUTE=0";
const DEFAULT_LOOKBACK_HOURS = 168;
const DEFAULT_VERIFICATION_DELAY_HOURS = 168;
const DEFAULT_VERIFICATION_GRACE_HOURS = 24;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MINUTES = 60;
const LOOP_VERSION = 1;
const ACTION_LOCATOR_RUNTIME_ID_PATTERN = /^[0-9a-f-]{36}$/;
const ACTION_LOCATOR_ROOT_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

export type LoopQueueState =
  | "open"
  | "approval_needed"
  | "verification_pending"
  | "verification_due"
  | "verification_overdue"
  | "regressed"
  | "blocked"
  | "resolved"
  | "deferred";

export interface EvolutionLoopConfig {
  version: 1;
  generation: number;
  enabled: boolean;
  scope: "global" | "project";
  automationName: string;
  rrule: string;
  sourceIds: string[];
  lookbackHours: number;
  verificationDelayHours: number;
  verificationGraceHours: number;
  maxAttempts: number;
  leaseMinutes: number;
  autoApply: {
    mode: "off" | "plan-only";
    reason: string;
  };
  actionLocator?: {
    version: 1;
    runtimeId: string;
    rootIdentity: string;
  };
  updatedAt: string;
}

export interface LoopQueueItem {
  id: string;
  kind: "signal" | "proposal" | "coverage";
  title: string;
  state: LoopQueueState;
  revision: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  disposition?: CorrelatedSignal["disposition"];
  proposalStatus?: AiProposalRecord["status"];
  familyId?: string;
  familyAliases?: string[];
  proposalId?: string;
  linkedWork: string[];
  approvalRequired: boolean;
  requestedExternalAction?: "reopen";
  verification?: {
    opensAt?: string;
    dueAt?: string;
    overdueAt?: string;
    state:
      | "unscheduled"
      | "pending"
      | "due"
      | "overdue"
      | "improved"
      | "unchanged"
      | "regressed"
      | "inconclusive";
    attempts: number;
  };
  sourceIds: string[];
  evidenceRefs: string[];
}

interface EvolutionLoopState {
  version: 1;
  generation: number;
  queue: Record<string, LoopQueueItem>;
  fingerprints: Record<string, string>;
  lastRunAt?: string;
  lastScheduledRunAt?: string;
  lastSuccessfulScheduledRunAt?: string;
  lastSuccessfulScheduledConfigGeneration?: number;
  lastRunStatus?: "complete" | "degraded" | "failed";
  lastCoverageComplete?: boolean;
  lastFreshnessState?: ReconciliationFreshness["state"];
  lastSuccessfulCoverageUntil?: string;
  lastReviewId?: string;
  lastReportPath?: string;
  lastFailure?: {
    at: string;
    message: string;
    attempts: number;
  };
}

export interface LoopMutationPlan {
  type:
    | "record-writeback"
    | "link-writeback"
    | "create-proposal"
    | "link-proposal"
    | "draft-proposal"
    | "auto-apply-withheld";
  target: string;
  reason: string;
  applied: boolean;
}

export interface EvolutionLoopReport {
  version: 1;
  runId: string;
  generatedAt: string;
  scope: "global" | "project";
  projectRoot?: string;
  status: "preview" | "complete" | "degraded" | "failed";
  trigger: "manual" | "scheduled";
  generationBefore: number;
  generationAfter: number;
  reviewId?: string;
  coverage: SourceCoverage[];
  coverageComplete: boolean;
  freshness: ReconciliationFreshness;
  queue: LoopQueueItem[];
  delta: {
    new: string[];
    changed: string[];
    resolved: string[];
    notifiable: string[];
    unchangedSuppressed: number;
  };
  mutations: LoopMutationPlan[];
  attempts: Array<{ attempt: number; ok: boolean; error?: string }>;
  artifactPath: string;
  auditPath: string;
  activity?: import("./activity").ActivityFeed;
}

const ACTIVE_LOOP_PROPOSAL_STATUSES = new Set([
  "proposed",
  "drafted",
  "in_review",
  "accepted",
  "applied",
]);
const UNKNOWN_FRESHNESS: ReconciliationFreshness = {
  state: "unknown",
  staleSourceIds: [],
  unknownSourceIds: [],
  alertSourceIds: [],
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("|", "\\|")
    .trim();
}

function signalFamilyId(signal: CorrelatedSignal): string {
  const current =
    typeof signal.familyId === "string" ? signal.familyId.trim() : "";
  if (current) {
    return current;
  }
  const seed =
    signal.subjectKeys?.[0] ??
    signal.id ??
    signal.evidenceKeys?.[0] ??
    "legacy";
  return `SF-${sha256(seed).slice(0, 16)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = positiveNumber(value, name);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeRrule(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!normalized.startsWith("RRULE:FREQ=")) {
    throw new Error("rrule must start with RRULE:FREQ=");
  }
  const entries = normalized.slice("RRULE:".length).split(";");
  const parts = new Map<string, string>();
  for (const entry of entries) {
    const [key, rawValue, ...extra] = entry.split("=");
    if (!(key && rawValue) || extra.length > 0 || parts.has(key)) {
      throw new Error(`rrule contains an invalid or duplicate field: ${entry}`);
    }
    parts.set(key, rawValue);
  }
  const supported = new Set([
    "FREQ",
    "INTERVAL",
    "BYDAY",
    "BYHOUR",
    "BYMINUTE",
  ]);
  for (const key of parts.keys()) {
    if (!supported.has(key)) {
      throw new Error(`rrule field is not supported: ${key}`);
    }
  }
  const frequency = parts.get("FREQ");
  if (frequency !== "DAILY" && frequency !== "WEEKLY") {
    throw new Error("rrule FREQ must be DAILY or WEEKLY");
  }
  const boundedInteger = (key: string, minimum: number, maximum: number) => {
    const raw = parts.get(key);
    if (raw === undefined) {
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`rrule ${key} must be between ${minimum} and ${maximum}`);
    }
  };
  boundedInteger("INTERVAL", 1, 365);
  boundedInteger("BYHOUR", 0, 23);
  boundedInteger("BYMINUTE", 0, 59);
  const byDay = parts.get("BYDAY");
  if (
    byDay !== undefined &&
    !byDay
      .split(",")
      .every((day) => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(day))
  ) {
    throw new Error("rrule BYDAY must contain weekday abbreviations");
  }
  return normalized;
}

function schedulerStaleAfterHours(config: EvolutionLoopConfig): number {
  const parts = new Map(
    config.rrule
      .slice("RRULE:".length)
      .split(";")
      .map((part) => {
        const separator = part.indexOf("=");
        return separator > 0
          ? [part.slice(0, separator), part.slice(separator + 1)]
          : [part, ""];
      })
  );
  const intervalText = parts.get("INTERVAL") ?? "1";
  const interval = Number.parseInt(intervalText, 10);
  const cadenceHours =
    {
      HOURLY: 1,
      DAILY: 24,
      WEEKLY: 168,
      MONTHLY: 24 * 31,
    }[parts.get("FREQ") ?? ""] ?? config.lookbackHours;
  return Math.max(
    48,
    cadenceHours *
      (Number.isSafeInteger(interval) && interval > 0 ? interval : 1) *
      2
  );
}

function parseConfig(value: unknown): EvolutionLoopConfig {
  if (!isPlainObject(value) || value.version !== LOOP_VERSION) {
    throw new Error("Unsupported evolution loop config schema");
  }
  if (
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    typeof value.enabled !== "boolean" ||
    (value.scope !== "global" && value.scope !== "project") ||
    typeof value.automationName !== "string" ||
    typeof value.rrule !== "string" ||
    !Array.isArray(value.sourceIds) ||
    value.sourceIds.some((entry) => typeof entry !== "string") ||
    !isPlainObject(value.autoApply) ||
    (value.autoApply.mode !== "off" && value.autoApply.mode !== "plan-only") ||
    typeof value.autoApply.reason !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Malformed evolution loop config");
  }
  const actionLocator = value.actionLocator;
  if (
    actionLocator !== undefined &&
    (!isPlainObject(actionLocator) ||
      actionLocator.version !== 1 ||
      typeof actionLocator.runtimeId !== "string" ||
      !ACTION_LOCATOR_RUNTIME_ID_PATTERN.test(actionLocator.runtimeId) ||
      typeof actionLocator.rootIdentity !== "string" ||
      !ACTION_LOCATOR_ROOT_IDENTITY_PATTERN.test(actionLocator.rootIdentity))
  ) {
    throw new Error("Malformed evolution loop action locator identity");
  }
  return {
    version: 1,
    generation: value.generation,
    enabled: value.enabled,
    scope: value.scope,
    automationName: value.automationName,
    rrule: normalizeRrule(value.rrule),
    sourceIds: unique(value.sourceIds as string[]),
    lookbackHours: positiveNumber(value.lookbackHours, "lookbackHours"),
    verificationDelayHours: positiveNumber(
      value.verificationDelayHours,
      "verificationDelayHours"
    ),
    verificationGraceHours: positiveNumber(
      value.verificationGraceHours,
      "verificationGraceHours"
    ),
    maxAttempts: positiveInteger(value.maxAttempts, "maxAttempts"),
    leaseMinutes: positiveNumber(value.leaseMinutes, "leaseMinutes"),
    autoApply: {
      mode: value.autoApply.mode,
      reason: value.autoApply.reason,
    },
    ...(actionLocator
      ? {
          actionLocator: actionLocator as EvolutionLoopConfig["actionLocator"],
        }
      : {}),
    updatedAt: value.updatedAt,
  };
}

function withCurrentActionLocatorIdentity(args: {
  config: EvolutionLoopConfig;
  rootDir: string;
}): EvolutionLoopConfig {
  const rootIdentity = activityActionRootIdentity(args.rootDir);
  if (!rootIdentity) {
    return { ...args.config, actionLocator: undefined };
  }
  if (args.config.actionLocator?.rootIdentity === rootIdentity) {
    return args.config;
  }
  return {
    ...args.config,
    actionLocator: {
      version: 1,
      runtimeId: randomUUID(),
      rootIdentity,
    },
  };
}

function emptyState(): EvolutionLoopState {
  return {
    version: 1,
    generation: 0,
    queue: {},
    fingerprints: {},
  };
}

function parseState(value: unknown): EvolutionLoopState {
  if (!isPlainObject(value) || value.version !== LOOP_VERSION) {
    throw new Error("Unsupported evolution loop state schema");
  }
  if (
    typeof value.generation !== "number" ||
    !isPlainObject(value.queue) ||
    !isPlainObject(value.fingerprints)
  ) {
    throw new Error("Malformed evolution loop state");
  }
  return value as unknown as EvolutionLoopState;
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(pathValue: string, body: string): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  const temporaryPath = `${pathValue}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(temporaryPath, body);
  await rename(temporaryPath, pathValue);
}

async function appendLoopAudit(
  args: { homeDir: string; rootDir: string },
  event: Record<string, unknown>
): Promise<void> {
  const auditPath = facultAiEvolutionLoopAuditPath(args.homeDir, args.rootDir);
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(
    auditPath,
    `${JSON.stringify({ version: 1, ...event })}\n`,
    "utf8"
  );
}

async function loadConfig(args: {
  homeDir: string;
  rootDir: string;
}): Promise<EvolutionLoopConfig | null> {
  const pathValue = facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir);
  if (!(await fileExists(pathValue))) {
    return null;
  }
  return parseConfig(JSON.parse(await readFile(pathValue, "utf8")));
}

async function loadState(args: {
  homeDir: string;
  rootDir: string;
}): Promise<EvolutionLoopState> {
  const pathValue = facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir);
  if (!(await fileExists(pathValue))) {
    return emptyState();
  }
  return parseState(JSON.parse(await readFile(pathValue, "utf8")));
}

function automationName(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
}): string {
  const scope =
    args.scope ??
    (projectRootFromAiRoot(args.rootDir, args.homeDir) ? "project" : "global");
  return scope === "project"
    ? `fclt-evolution-${machineStateProjectKey(args.rootDir, args.homeDir)}`
    : "fclt-evolution-global";
}

async function automationStatus(args: {
  homeDir: string;
  name: string;
}): Promise<{
  exists: boolean;
  registered: boolean;
  status?: "ACTIVE" | "PAUSED";
  error?: string;
}> {
  try {
    await assertSafeCodexAutomationTarget({
      homeDir: args.homeDir,
      name: args.name,
    });
  } catch (error) {
    return {
      exists: true,
      registered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const pathValue = join(
    args.homeDir,
    ".codex",
    "automations",
    args.name,
    "automation.toml"
  );
  if (!(await fileExists(pathValue))) {
    const automationDir = dirname(pathValue);
    if (await fileExists(automationDir)) {
      return {
        exists: true,
        registered: false,
        error: `Codex automation directory is incomplete: ${automationDir}`,
      };
    }
    return { exists: false, registered: false };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(await readFile(pathValue, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    return {
      exists: true,
      registered: false,
      error: `Unable to inspect Codex automation ${pathValue}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const status =
    parsed.status === "ACTIVE" || parsed.status === "PAUSED"
      ? parsed.status
      : undefined;
  return {
    exists: true,
    registered: parsed.managed_by === "fclt-evolution-loop",
    status,
  };
}

async function enableEvolutionLoopScoped(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
  rrule?: string;
  sourceIds?: string[];
  dryRun?: boolean;
  now?: () => Date;
}): Promise<{
  config: EvolutionLoopConfig;
  configPath: string;
  automationPath: string;
  dryRun: boolean;
}> {
  const now = (args.now?.() ?? new Date()).toISOString();
  const current = await loadConfig(args);
  const inferredScope = projectRootFromAiRoot(args.rootDir, args.homeDir)
    ? "project"
    : "global";
  if (current && args.scope && current.scope !== args.scope) {
    throw new Error(
      `Evolution loop is already configured for ${current.scope} scope at this root`
    );
  }
  const scope = args.scope ?? current?.scope ?? inferredScope;
  const projectRoot =
    scope === "project"
      ? projectRootFromAiRoot(args.rootDir, args.homeDir)
      : null;
  const name = current?.automationName ?? automationName({ ...args, scope });
  const sourceIds = unique(
    args.sourceIds && args.sourceIds.length > 0
      ? args.sourceIds
      : (current?.sourceIds ?? [])
  );
  const sourceIdsUnchanged =
    current !== null &&
    current.sourceIds.length === sourceIds.length &&
    current.sourceIds.every((sourceId, index) => sourceId === sourceIds[index]);
  let config: EvolutionLoopConfig = {
    version: 1,
    generation: (current?.generation ?? 0) + (args.dryRun ? 0 : 1),
    enabled: true,
    scope,
    automationName: name,
    rrule: normalizeRrule(
      args.rrule?.trim() || current?.rrule || DEFAULT_RRULE
    ),
    sourceIds,
    lookbackHours: current?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS,
    verificationDelayHours:
      current?.verificationDelayHours ?? DEFAULT_VERIFICATION_DELAY_HOURS,
    verificationGraceHours:
      current?.verificationGraceHours ?? DEFAULT_VERIFICATION_GRACE_HOURS,
    maxAttempts: current?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    leaseMinutes: current?.leaseMinutes ?? DEFAULT_LEASE_MINUTES,
    autoApply: {
      mode: "plan-only",
      reason:
        "Automatic canonical writes are withheld until a hash-bound transaction and rollback receipt are available.",
    },
    ...(current?.actionLocator && sourceIdsUnchanged
      ? { actionLocator: current.actionLocator }
      : {}),
    updatedAt: now,
  };
  if (!args.dryRun) {
    config = withCurrentActionLocatorIdentity({
      config,
      rootDir: args.rootDir,
    });
  }
  const existingAutomation = await automationStatus({
    homeDir: args.homeDir,
    name,
  });
  if (existingAutomation.exists && !existingAutomation.registered) {
    throw new Error(
      existingAutomation.error ??
        `Refusing to replace an automation not owned by the fclt evolution loop: ${name}`
    );
  }
  const scaffold = await scaffoldCodexAutomationTemplate({
    homeDir: args.homeDir,
    cwd: projectRoot ?? args.homeDir,
    templateId: "closed-loop-review",
    name,
    scope,
    projectRoot,
    rootDir: args.rootDir,
    rrule: config.rrule,
    status: "PAUSED",
    force: existingAutomation.exists,
    dryRun: args.dryRun,
  });
  if (!args.dryRun) {
    await atomicWrite(
      facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
      `${JSON.stringify(config, null, 2)}\n`
    );
    await setCodexAutomationStatus({
      homeDir: args.homeDir,
      name,
      status: "ACTIVE",
    });
    await appendLoopAudit(args, {
      generatedAt: now,
      action: "enabled",
      generation: config.generation,
      scope: config.scope,
      automationName: name,
      rrule: config.rrule,
      sourceIds: config.sourceIds,
    });
  }
  return {
    config,
    configPath: facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
    automationPath: scaffold.path,
    dryRun: Boolean(args.dryRun),
  };
}

export async function enableEvolutionLoop(
  args: Parameters<typeof enableEvolutionLoopScoped>[0]
): ReturnType<typeof enableEvolutionLoopScoped> {
  const scope =
    args.scope ??
    (projectRootFromAiRoot(args.rootDir, args.homeDir) ? "project" : "global");
  return await withFacultRootScope(
    { rootDir: args.rootDir, scope },
    async () => await enableEvolutionLoopScoped({ ...args, scope })
  );
}

async function disableEvolutionLoopScoped(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
  dryRun?: boolean;
  now?: () => Date;
}): Promise<{
  config: EvolutionLoopConfig | null;
  changed: boolean;
  dryRun: boolean;
  scheduler: { paused: boolean; error?: string } | null;
}> {
  const current = await loadConfig(args);
  if (!current) {
    return {
      config: null,
      changed: false,
      dryRun: Boolean(args.dryRun),
      scheduler: null,
    };
  }
  const next: EvolutionLoopConfig = {
    ...current,
    generation: current.generation + (args.dryRun ? 0 : 1),
    enabled: false,
    updatedAt: (args.now?.() ?? new Date()).toISOString(),
  };
  let scheduler: { paused: boolean; error?: string };
  try {
    await setCodexAutomationStatus({
      homeDir: args.homeDir,
      name: current.automationName,
      status: "PAUSED",
      dryRun: args.dryRun,
    });
    scheduler = { paused: true };
  } catch (error) {
    scheduler = {
      paused: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!args.dryRun) {
    await atomicWrite(
      facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
      `${JSON.stringify(next, null, 2)}\n`
    );
    await appendLoopAudit(args, {
      generatedAt: next.updatedAt,
      action: "disabled",
      generation: next.generation,
      scope: next.scope,
      automationName: next.automationName,
      scheduler,
    });
  }
  return {
    config: next,
    changed: current.enabled,
    dryRun: Boolean(args.dryRun),
    scheduler,
  };
}

export async function disableEvolutionLoop(
  args: Parameters<typeof disableEvolutionLoopScoped>[0]
): ReturnType<typeof disableEvolutionLoopScoped> {
  const scope =
    args.scope ??
    (projectRootFromAiRoot(args.rootDir, args.homeDir) ? "project" : "global");
  return await withFacultRootScope(
    { rootDir: args.rootDir, scope },
    async () => await disableEvolutionLoopScoped(args)
  );
}

function verificationState(
  proposal: AiProposalRecord,
  now: Date
): NonNullable<LoopQueueItem["verification"]> {
  const attempts =
    proposal.verification?.attempts.length ??
    proposal.effectivenessHistory?.length ??
    (proposal.effectiveness ? 1 : 0);
  if (
    proposal.effectiveness &&
    proposal.effectiveness.effectiveness !== "inconclusive"
  ) {
    return {
      opensAt: proposal.verification?.opensAt,
      dueAt: proposal.verification?.dueAt,
      overdueAt: proposal.verification?.overdueAt,
      state: proposal.effectiveness.effectiveness,
      attempts,
    };
  }
  if (!proposal.verification) {
    return { state: "unscheduled", attempts };
  }
  const nowMs = now.getTime();
  const state =
    nowMs >= Date.parse(proposal.verification.overdueAt)
      ? "overdue"
      : nowMs >= Date.parse(proposal.verification.dueAt)
        ? "due"
        : "pending";
  return {
    opensAt: proposal.verification.opensAt,
    dueAt: proposal.verification.dueAt,
    overdueAt: proposal.verification.overdueAt,
    state,
    attempts,
  };
}

function proposalQueueState(
  proposal: AiProposalRecord,
  verification: NonNullable<LoopQueueItem["verification"]>
): LoopQueueState {
  if (
    proposal.status === "rejected" ||
    proposal.status === "superseded" ||
    proposal.status === "failed"
  ) {
    return "resolved";
  }
  if (
    verification.state === "regressed" ||
    verification.state === "unchanged" ||
    proposal.verification?.status === "reopened"
  ) {
    return "regressed";
  }
  if (verification.state === "overdue") {
    return "verification_overdue";
  }
  if (verification.state === "due") {
    return "verification_due";
  }
  if (
    verification.state === "pending" ||
    verification.state === "inconclusive"
  ) {
    return "verification_pending";
  }
  if (verification.state === "improved") {
    return "resolved";
  }
  if (proposal.status === "applied" && verification.state === "unscheduled") {
    return "verification_pending";
  }
  return proposal.reviewRequired && proposal.status !== "accepted"
    ? "approval_needed"
    : "open";
}

function signalQueueState(signal: CorrelatedSignal): LoopQueueState {
  if (!signal.unresolved) {
    return "resolved";
  }
  if (signal.disposition === "defer") {
    return "deferred";
  }
  if (
    signal.disposition === "propose" ||
    signal.disposition === "apply-local"
  ) {
    return "approval_needed";
  }
  return "open";
}

function rawQueue(args: {
  review: ReconciliationReview;
  proposals: AiProposalRecord[];
  writebacks: AiWritebackRecord[];
  now: Date;
}): Omit<
  LoopQueueItem,
  "revision" | "firstSeenAt" | "lastSeenAt" | "lastChangedAt"
>[] {
  const signalItems = args.review.signals.map((signal) => {
    const familyId = signalFamilyId(signal);
    const familyEvidenceRefs = new Set(
      [familyId, ...(signal.familyAliases ?? [])].map(
        (candidate) => `signal-family:${candidate}`
      )
    );
    const bridgeWritebackIds = new Set(
      args.writebacks
        .filter((entry) =>
          entry.evidence.some(
            (evidence) =>
              evidence.type === "reconciliation" &&
              familyEvidenceRefs.has(evidence.ref)
          )
        )
        .map((entry) => entry.id)
    );
    const linkedProposal = args.proposals.find(
      (proposal) =>
        proposal.sourceWritebacks.some((id) => bridgeWritebackIds.has(id)) &&
        ACTIVE_LOOP_PROPOSAL_STATUSES.has(proposal.status) &&
        proposal.effectiveness?.effectiveness !== "improved"
    );
    return {
      id: `family:${familyId}`,
      kind: "signal" as const,
      title: signal.title,
      state: linkedProposal ? ("resolved" as const) : signalQueueState(signal),
      disposition: signal.disposition,
      familyId,
      familyAliases: signal.familyAliases ?? [],
      linkedWork: unique([
        ...signal.issueRefs,
        ...(signal.dispositionTarget ? [signal.dispositionTarget] : []),
        ...(linkedProposal ? [linkedProposal.id] : []),
      ]),
      approvalRequired: linkedProposal
        ? false
        : signal.disposition === "propose" ||
          signal.disposition === "apply-local",
      proposalId: linkedProposal?.id,
      sourceIds: signal.sourceIds,
      evidenceRefs: signal.evidenceKeys,
    };
  });
  const proposalItems = args.proposals.map((proposal) => {
    const verification = verificationState(proposal, args.now);
    const sourceWritebacks = args.writebacks.filter((entry) =>
      proposal.sourceWritebacks.includes(entry.id)
    );
    const linkedWork = unique(
      sourceWritebacks.flatMap((entry) => entry.issueLinks ?? [])
    );
    const state = proposalQueueState(proposal, verification);
    return {
      id: `proposal:${proposal.id}`,
      kind: "proposal" as const,
      title: proposal.summary,
      state,
      proposalStatus: proposal.status,
      proposalId: proposal.id,
      linkedWork,
      approvalRequired: state === "approval_needed",
      requestedExternalAction:
        state === "regressed" && linkedWork.length > 0
          ? ("reopen" as const)
          : undefined,
      verification,
      sourceIds: [],
      evidenceRefs: proposal.sourceWritebacks,
    };
  });
  const coverageItems = args.review.coverage
    .filter((entry) => entry.state === "unavailable" || entry.state === "stale")
    .map((entry) => ({
      id: `coverage:${entry.sourceId}`,
      kind: "coverage" as const,
      title: `${entry.sourceId} coverage is ${entry.state}`,
      state: "blocked" as const,
      linkedWork: [],
      approvalRequired: false,
      sourceIds: [entry.sourceId],
      evidenceRefs: [
        entry.unavailableReason ?? entry.staleReason ?? entry.state,
      ],
    }));
  const freshnessItems = args.review.coverage
    .filter((entry) => entry.freshness.state === "stale")
    .map((entry) => ({
      id: `freshness:${entry.sourceId}`,
      kind: "coverage" as const,
      title: `${entry.sourceId} cursor freshness is stale`,
      state: "blocked" as const,
      linkedWork: [],
      approvalRequired: false,
      sourceIds: [entry.sourceId],
      evidenceRefs: [
        entry.freshness.reason,
        ...(entry.freshness.cursorAt
          ? [`cursor:${entry.freshness.cursorAt}`]
          : []),
        ...(entry.freshness.latestSourceAt
          ? [`latest:${entry.freshness.latestSourceAt}`]
          : []),
      ],
    }));
  return [
    ...signalItems,
    ...proposalItems,
    ...coverageItems,
    ...freshnessItems,
  ];
}

function queueFingerprint(
  item: Omit<
    LoopQueueItem,
    "revision" | "firstSeenAt" | "lastSeenAt" | "lastChangedAt"
  >
): string {
  return sha256(
    JSON.stringify({
      ...item,
      linkedWork: unique(item.linkedWork),
      sourceIds: unique(item.sourceIds),
      evidenceRefs: unique(item.evidenceRefs),
    })
  );
}

function reconcileQueue(args: {
  current: ReturnType<typeof rawQueue>;
  prior: EvolutionLoopState;
  generatedAt: string;
  coverageComplete: boolean;
  resolutionProofs: ResolutionProof[];
  resolvedSignalFamilies: string[];
}): {
  queue: Record<string, LoopQueueItem>;
  fingerprints: Record<string, string>;
  delta: EvolutionLoopReport["delta"];
} {
  const queue: Record<string, LoopQueueItem> = {};
  const fingerprints: Record<string, string> = {};
  const newIds: string[] = [];
  const changedIds: string[] = [];
  const resolvedIds: string[] = [];
  const containedEvidenceKeys = new Set(
    args.resolutionProofs
      .filter((proof) => proof.kind === "default_branch_containment")
      .map((proof) => proof.evidenceKey)
  );
  const resolvedSignalFamilies = new Set(args.resolvedSignalFamilies);
  let unchangedSuppressed = 0;
  for (const raw of args.current) {
    const prior = args.prior.queue[raw.id];
    const fingerprint = queueFingerprint(raw);
    const changed = args.prior.fingerprints[raw.id] !== fingerprint;
    queue[raw.id] = {
      ...raw,
      revision: prior ? prior.revision + (changed ? 1 : 0) : 1,
      firstSeenAt: prior?.firstSeenAt ?? args.generatedAt,
      lastSeenAt: args.generatedAt,
      lastChangedAt: changed
        ? args.generatedAt
        : (prior?.lastChangedAt ?? args.generatedAt),
    };
    fingerprints[raw.id] = fingerprint;
    if (!prior) {
      newIds.push(raw.id);
    } else if (changed) {
      if (prior.state !== "resolved" && raw.state === "resolved") {
        resolvedIds.push(raw.id);
      } else {
        changedIds.push(raw.id);
      }
    } else {
      unchangedSuppressed += 1;
    }
  }
  for (const [id, prior] of Object.entries(args.prior.queue)) {
    if (queue[id]) {
      continue;
    }
    const mergedInto =
      prior.kind === "signal" && prior.familyId
        ? Object.values(queue).find((item) =>
            item.familyAliases?.includes(prior.familyId!)
          )
        : undefined;
    if (mergedInto) {
      const resolved = {
        ...prior,
        state: "resolved" as const,
        revision:
          prior.state === "resolved" ? prior.revision : prior.revision + 1,
        lastSeenAt: args.generatedAt,
        lastChangedAt:
          prior.state === "resolved" ? prior.lastChangedAt : args.generatedAt,
        linkedWork: unique([...prior.linkedWork, `merged:${mergedInto.id}`]),
        approvalRequired: false,
      };
      queue[id] = resolved;
      fingerprints[id] = queueFingerprint(resolved);
      if (prior.state !== "resolved") {
        resolvedIds.push(id);
      } else {
        unchangedSuppressed += 1;
      }
      continue;
    }
    const signalHasResolutionProof =
      prior.kind === "signal" &&
      (prior.evidenceRefs.some((key) => containedEvidenceKeys.has(key)) ||
        Boolean(prior.familyId && resolvedSignalFamilies.has(prior.familyId)));
    if (
      !args.coverageComplete ||
      (prior.kind === "signal" && !signalHasResolutionProof)
    ) {
      queue[id] = prior;
      fingerprints[id] = args.prior.fingerprints[id] ?? queueFingerprint(prior);
      unchangedSuppressed += 1;
      continue;
    }
    const resolved = {
      ...prior,
      state: "resolved" as const,
      revision:
        prior.state === "resolved" ? prior.revision : prior.revision + 1,
      lastSeenAt: args.generatedAt,
      lastChangedAt:
        prior.state === "resolved" ? prior.lastChangedAt : args.generatedAt,
      approvalRequired: false,
      requestedExternalAction: undefined,
    };
    queue[id] = resolved;
    fingerprints[id] = queueFingerprint(resolved);
    if (prior.state !== "resolved") {
      resolvedIds.push(id);
    } else {
      unchangedSuppressed += 1;
    }
  }
  const notifiable = unique([...newIds, ...changedIds, ...resolvedIds]).filter(
    (id) => {
      const item = queue[id];
      return Boolean(
        item && (item.state !== "deferred" || resolvedIds.includes(id))
      );
    }
  );
  return {
    queue,
    fingerprints,
    delta: {
      new: unique(newIds),
      changed: unique(changedIds),
      resolved: unique(resolvedIds),
      notifiable,
      unchangedSuppressed,
    },
  };
}

function bridgeEvidenceRef(signal: CorrelatedSignal): string {
  return `signal-family:${signalFamilyId(signal)}`;
}

async function materializeSignals(args: {
  homeDir: string;
  rootDir: string;
  review: ReconciliationReview;
  dryRun: boolean;
  scope: "global" | "project";
  plans?: LoopMutationPlan[];
  onMutationCommitted?: (mutation: LoopMutationPlan) => void | Promise<void>;
}): Promise<LoopMutationPlan[]> {
  const plans = args.plans ?? [];
  const recordPlan = async (plan: LoopMutationPlan) => {
    plans.push(plan);
    if (plan.applied) {
      await args.onMutationCommitted?.(plan);
    }
  };
  if (!args.review.coverageComplete) {
    return plans;
  }
  const existing = await listWritebacks({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
  });
  for (const signal of args.review.signals) {
    if (
      signal.disposition !== "propose" &&
      signal.disposition !== "apply-local"
    ) {
      continue;
    }
    const target =
      signal.assetRefs.length === 1 ? signal.assetRefs[0] : undefined;
    if (!target) {
      await recordPlan({
        type: "record-writeback",
        target: signal.familyId,
        reason: "Actionable signal has no single graph-backed asset target",
        applied: false,
      });
      continue;
    }
    const evidenceRef = bridgeEvidenceRef(signal);
    const evidenceRefs = new Set([
      evidenceRef,
      ...(signal.familyAliases ?? []).map(
        (familyId) => `signal-family:${familyId}`
      ),
    ]);
    let createdWriteback = false;
    let writeback = existing.find((entry) =>
      entry.evidence.some(
        (evidence) =>
          evidence.type === "reconciliation" && evidenceRefs.has(evidence.ref)
      )
    );
    if (!(writeback || args.dryRun)) {
      writeback = await addWriteback({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        kind: "capability_gap",
        summary: signal.title,
        suggestedDestination: target,
        evidence: [{ type: "reconciliation", ref: evidenceRef }],
        confidence: "medium",
        source: "fclt:evolution-loop",
      });
      existing.push(writeback);
      createdWriteback = true;
    }
    await recordPlan({
      type: "record-writeback",
      target: evidenceRef,
      reason: writeback
        ? "Stable signal-family writeback exists"
        : "Would record a stable signal-family writeback",
      applied: createdWriteback,
    });
    if (writeback && !args.dryRun) {
      if (
        !writeback.evidence.some(
          (entry) =>
            entry.type === "reconciliation" && entry.ref === evidenceRef
        )
      ) {
        writeback = await linkWritebackEvidence(
          writeback.id,
          { type: "reconciliation", ref: evidenceRef },
          { homeDir: args.homeDir, rootDir: args.rootDir }
        );
        await recordPlan({
          type: "link-writeback",
          target: `${writeback.id}:${evidenceRef}`,
          reason: "Canonicalized merged signal-family provenance",
          applied: true,
        });
      }
      for (const issueRef of signal.issueRefs) {
        if (!writeback.issueLinks?.includes(issueRef)) {
          writeback = await linkWritebackIssue(writeback.id, issueRef, {
            homeDir: args.homeDir,
            rootDir: args.rootDir,
          });
          await recordPlan({
            type: "link-writeback",
            target: `${writeback.id}:${issueRef}`,
            reason: "Preserved linked external work as local provenance",
            applied: true,
          });
        }
      }
    }
    if (args.dryRun) {
      const activeProposal = (
        await listProposals({
          homeDir: args.homeDir,
          rootDir: args.rootDir,
        })
      ).find(
        (proposal) =>
          proposal.targets.includes(target) &&
          ACTIVE_LOOP_PROPOSAL_STATUSES.has(proposal.status) &&
          proposal.effectiveness?.effectiveness !== "improved"
      );
      if (!activeProposal) {
        await recordPlan({
          type: "create-proposal",
          target,
          reason: `Would create a proposal for reconciled ${signal.disposition} signal ${signalFamilyId(signal)}`,
          applied: false,
        });
        await recordPlan({
          type: "draft-proposal",
          target,
          reason: "Would draft the proposal without applying canonical changes",
          applied: false,
        });
      }
      continue;
    }
    if (!writeback) {
      continue;
    }
    const activeProposal = (
      await listProposals({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
      })
    ).find(
      (proposal) =>
        proposal.targets.includes(target) &&
        ACTIVE_LOOP_PROPOSAL_STATUSES.has(proposal.status) &&
        proposal.effectiveness?.effectiveness !== "improved"
    );
    if (activeProposal) {
      if (!activeProposal.sourceWritebacks.includes(writeback.id)) {
        await linkProposalWriteback(activeProposal.id, writeback.id, {
          homeDir: args.homeDir,
          rootDir: args.rootDir,
        });
        await recordPlan({
          type: "link-proposal",
          target: `${activeProposal.id}:${writeback.id}`,
          reason:
            "Attached the signal-family bridge to existing target lineage",
          applied: true,
        });
      }
      if (activeProposal.status === "proposed") {
        const drafted = await draftProposal(activeProposal.id, {
          homeDir: args.homeDir,
          rootDir: args.rootDir,
        });
        await recordPlan({
          type: "draft-proposal",
          target: drafted.id,
          reason: "Recovered an existing undrafted proposal from a prior run",
          applied: true,
        });
      }
      continue;
    }
    const proposals = await proposeEvolution({
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      writebackIds: [writeback.id],
    });
    for (const proposal of proposals) {
      await recordPlan({
        type: "create-proposal",
        target: proposal.id,
        reason: `Assessment recommended a proposal for ${target}`,
        applied: true,
      });
      const drafted = await draftProposal(proposal.id, {
        homeDir: args.homeDir,
        rootDir: args.rootDir,
      });
      await recordPlan({
        type: "draft-proposal",
        target: drafted.id,
        reason: "Drafted the review artifact; canonical apply remains gated",
        applied: true,
      });
    }
  }
  const projectRoot =
    args.scope === "project"
      ? projectRootFromAiRoot(args.rootDir, args.homeDir)
      : null;
  await recordPlan({
    type: "auto-apply-withheld",
    target: projectRoot ?? args.rootDir,
    reason: projectRoot
      ? "Project auto-apply is plan-only until hash preconditions, atomic rollback, and validation receipts are implemented"
      : "Global and shared capability always remains proposal-only without explicit approval",
    applied: false,
  });
  return plans;
}

function renderReport(report: EvolutionLoopReport): string {
  const activityItems = report.activity?.items ?? [];
  const activityAttention = activityItems.filter(
    (item) => item.state !== "resolved" && item.state !== "deferred"
  );
  const activityLines = activityAttention.flatMap((item) => [
    `### ${markdownCell(item.title)}`,
    "",
    `- kind: ${markdownCell(item.kind)}`,
    `- category: ${markdownCell(item.categories.join(", "))}`,
    `- state: ${markdownCell(item.state)}`,
    `- decision: ${markdownCell(item.decision.disposition ?? item.decision.proposalStatus ?? "unassigned")}`,
    ...(item.decision.rationale
      ? [`- why: ${markdownCell(item.decision.rationale)}`]
      : []),
    ...item.observations.flatMap((observation) => [
      `- captured: ${markdownCell(observation.summary)}`,
      ...(observation.contextOmitted
        ? ["- context: omitted because the observation is private"]
        : [
            ...(observation.details
              ? [`- context: ${markdownCell(observation.details)}`]
              : []),
            ...(observation.impact
              ? [`- impact: ${markdownCell(observation.impact)}`]
              : []),
          ]),
    ]),
    `- next: ${markdownCell(item.nextAction)}`,
    "",
  ]);
  const queueRows = report.queue.map(
    (item) =>
      `| ${markdownCell(item.id)} | ${markdownCell(item.kind)} | ${markdownCell(item.state)} | ${markdownCell(item.disposition ?? item.proposalStatus ?? "-")} | ${markdownCell(item.linkedWork.join(", ") || "-")} | ${markdownCell(item.verification?.state ?? "-")} | ${item.approvalRequired ? "yes" : "no"} |`
  );
  const coverageRows = report.coverage.map(
    (entry) =>
      `| ${markdownCell(entry.sourceId)} | ${markdownCell(entry.state)} | ${markdownCell(entry.freshness.state)} | ${markdownCell(entry.freshness.reason)} | ${entry.recordsScanned} | ${entry.signalsDiscovered} | ${markdownCell(entry.unavailableReason ?? entry.staleReason ?? "")} |`
  );
  const attemptRows = report.attempts.map(
    (entry) =>
      `| ${entry.attempt} | ${entry.ok ? "ok" : "failed"} | ${markdownCell(entry.error ?? "")} |`
  );
  const mutationRows = report.mutations.map(
    (entry) =>
      `| ${markdownCell(entry.type)} | ${markdownCell(entry.target)} | ${entry.applied ? "yes" : "no"} | ${markdownCell(entry.reason)} |`
  );
  return [
    "---",
    'artifact: "evolution-loop-review"',
    `runId: ${JSON.stringify(report.runId)}`,
    `scope: ${JSON.stringify(report.scope)}`,
    ...(report.projectRoot
      ? [`projectRoot: ${JSON.stringify(report.projectRoot)}`]
      : []),
    `status: ${JSON.stringify(report.status)}`,
    `generatedAt: ${JSON.stringify(report.generatedAt)}`,
    `coverageComplete: ${report.coverageComplete}`,
    `freshness: ${JSON.stringify(report.freshness.state)}`,
    "---",
    "",
    `# Evolution loop ${report.runId}`,
    "",
    "## Activity summary",
    "",
    `- Run status: ${report.status}`,
    `- Coverage: ${report.coverageComplete ? "complete" : "incomplete"} (${report.activity?.coverage.checked ?? 0}/${report.coverage.length} sources checked)`,
    `- Freshness: ${report.freshness.state}${report.freshness.staleSourceIds.length > 0 ? ` (${report.freshness.staleSourceIds.join(", ")})` : ""}`,
    `- Changes: ${report.delta.new.length} new, ${report.delta.changed.length} changed, ${report.delta.resolved.length} resolved`,
    `- Needs attention: ${activityAttention.length}`,
    "",
    ...(activityLines.length > 0
      ? activityLines
      : [
          report.status !== "failed" && report.coverageComplete
            ? "Configured coverage was checked and nothing needs attention."
            : "The run did not prove complete coverage; inspect source problems below.",
          "",
        ]),
    "## Notification delta",
    "",
    `- New: ${report.delta.new.join(", ") || "none"}`,
    `- Changed: ${report.delta.changed.join(", ") || "none"}`,
    `- Resolved: ${report.delta.resolved.join(", ") || "none"}`,
    `- Unchanged suppressed: ${report.delta.unchangedSuppressed}`,
    "",
    "## Source coverage",
    "",
    "| Source | Coverage | Freshness | Freshness reason | Records | Signals | Detail |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    ...coverageRows,
    "",
    "## Full current queue",
    "",
    "| Item | Kind | State | Disposition/status | Linked work | Verification | Approval |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...(queueRows.length > 0 ? queueRows : ["| - | - | - | - | - | - | - |"]),
    "",
    "## Mutation plan",
    "",
    "| Type | Target | Applied | Reason |",
    "| --- | --- | --- | --- |",
    ...(mutationRows.length > 0
      ? mutationRows
      : ["| - | - | no | No mutations |"]),
    "",
    "## Attempts",
    "",
    "| Attempt | Result | Error |",
    "| ---: | --- | --- |",
    ...(attemptRows.length > 0
      ? attemptRows
      : ["| - | - | No reconciliation attempt for this preview |"]),
    "",
  ].join("\n");
}

async function withLoopLock<T>(args: {
  path: string;
  leaseMinutes: number;
  now: Date;
  resolveProcessStartIdentity?: (pid: number) => string | undefined;
  onLockAcquired?: () => void | Promise<void>;
  openLockFile?: (path: string, flags: "wx") => Promise<FileHandle>;
  fn: () => Promise<T>;
}): Promise<T> {
  await mkdir(dirname(args.path), { recursive: true });
  const ownerToken = randomUUID();
  let handle: FileHandle;
  try {
    handle = await (args.openLockFile ?? open)(args.path, "wx");
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    const takeoverPath = `${args.path}.takeover`;
    let takeover: FileHandle;
    try {
      takeover = await open(takeoverPath, "wx");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }
      throw new Error(
        `Another evolution loop run is recovering ${args.path} using ${takeoverPath}. Inspect the claim owner; if that process is gone and the claim is abandoned, remove exactly ${takeoverPath} and retry.`
      );
    }
    try {
      await takeover.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          token: ownerToken,
          startedAt: args.now.toISOString(),
          processStartedAt: (
            args.resolveProcessStartIdentity ?? processStartIdentity
          )(process.pid),
        })}\n`
      );
      const info = await stat(args.path).catch(() => null);
      const ageMs = info ? args.now.getTime() - info.mtime.getTime() : 0;
      const leaseMs = args.leaseMinutes * 60 * 1000;
      const stale = Boolean(info && ageMs > leaseMs);
      if (!stale) {
        throw new Error(`Another evolution loop run holds ${args.path}`);
      }
      let ownerAlive = false;
      let recordedProcessStartedAt: string | undefined;
      let ownerPid: number | undefined;
      try {
        const owner = JSON.parse(await readFile(args.path, "utf8")) as {
          pid?: unknown;
          processStartedAt?: unknown;
        };
        if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid)) {
          ownerPid = owner.pid;
          recordedProcessStartedAt =
            typeof owner.processStartedAt === "string"
              ? owner.processStartedAt
              : undefined;
          try {
            process.kill(owner.pid, 0);
            ownerAlive = true;
          } catch (error) {
            ownerAlive =
              error instanceof Error && "code" in error
                ? (error as NodeJS.ErrnoException).code !== "ESRCH"
                : false;
          }
        }
      } catch {
        ownerAlive = false;
      }
      if (ownerAlive) {
        const observedProcessStartedAt =
          recordedProcessStartedAt && ownerPid
            ? (args.resolveProcessStartIdentity ?? processStartIdentity)(
                ownerPid
              )
            : undefined;
        if (
          !(recordedProcessStartedAt && observedProcessStartedAt) ||
          processStartIdentityMatches(
            recordedProcessStartedAt,
            observedProcessStartedAt
          )
        ) {
          throw new Error(
            `A live evolution loop owner still holds ${args.path}. If process identity is unavailable and the lease is known to be abandoned, inspect the owner record and remove this one lock file explicitly.`
          );
        }
      }
      const stalePath = `${args.path}.stale-${args.now.getTime()}-${ownerToken}`;
      await rename(args.path, stalePath);
      handle = await open(args.path, "wx");
    } finally {
      await takeover.close();
      const owner = await readFile(takeoverPath, "utf8").catch(() => "");
      if (owner.includes(`"token":"${ownerToken}"`)) {
        await rm(takeoverPath, { force: true });
      }
    }
  }
  await handle.writeFile(
    `${JSON.stringify({
      pid: process.pid,
      token: ownerToken,
      startedAt: args.now.toISOString(),
      processStartedAt: (
        args.resolveProcessStartIdentity ?? processStartIdentity
      )(process.pid),
    })}\n`
  );
  await handle.sync();
  const stillOwnsPath = async () => {
    try {
      const current = JSON.parse(await readFile(args.path, "utf8")) as {
        token?: unknown;
      };
      return current.token === ownerToken;
    } catch {
      return false;
    }
  };
  const heartbeatMs = Math.max(
    1000,
    Math.min(30_000, (args.leaseMinutes * 60 * 1000) / 3)
  );
  const heartbeat = setInterval(() => {
    stillOwnsPath()
      .then((ownsPath) => {
        if (ownsPath) {
          const heartbeatAt = new Date();
          return utimes(args.path, heartbeatAt, heartbeatAt);
        }
        return undefined;
      })
      .catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();
  try {
    await args.onLockAcquired?.();
    return await args.fn();
  } finally {
    clearInterval(heartbeat);
    await handle.close();
    if (await stillOwnsPath()) {
      await rm(args.path, { force: true });
    }
  }
}

export async function withEvolutionLoopMutationLock<T>(args: {
  homeDir: string;
  rootDir: string;
  now?: Date;
  fn: () => Promise<T>;
}): Promise<T> {
  return await withLoopLock({
    path: facultAiEvolutionLoopLockPath(args.homeDir, args.rootDir),
    leaseMinutes: DEFAULT_LEASE_MINUTES,
    now: args.now ?? new Date(),
    fn: args.fn,
  });
}

async function evolutionLoopStatusScoped(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
  now?: () => Date;
}): Promise<{
  configured: boolean;
  config: EvolutionLoopConfig | null;
  state: EvolutionLoopState;
  scheduler: Awaited<ReturnType<typeof automationStatus>>;
  schedulerObservation: {
    state: "never_observed" | "healthy" | "stale";
    lastObservedRunAt?: string;
    lastSuccessfulRunAt?: string;
    staleAfterHours?: number;
  };
  health: "disabled" | "ready" | "degraded";
  configPath: string;
  statePath: string;
  auditPath: string;
  reportDir: string;
}> {
  const config = await loadConfig(args);
  const state = await loadState(args);
  const scheduler = config
    ? await automationStatus({
        homeDir: args.homeDir,
        name: config.automationName,
      })
    : { exists: false, registered: false };
  const reconciliation = await reconciliationStatus(args);
  const lastObservedRunAt = state.lastScheduledRunAt;
  const lastSuccessfulRunAt = state.lastSuccessfulScheduledRunAt;
  const staleAfterHours = config ? schedulerStaleAfterHours(config) : undefined;
  const schedulerObservation = {
    state: lastObservedRunAt
      ? (args.now?.() ?? new Date()).getTime() - Date.parse(lastObservedRunAt) >
        (staleAfterHours ?? 48) * 60 * 60 * 1000
        ? ("stale" as const)
        : ("healthy" as const)
      : ("never_observed" as const),
    lastObservedRunAt,
    lastSuccessfulRunAt,
    staleAfterHours,
  };
  const successfulScheduledRunIsRecent = Boolean(
    lastSuccessfulRunAt &&
      lastSuccessfulRunAt === lastObservedRunAt &&
      state.lastSuccessfulScheduledConfigGeneration === config?.generation &&
      (args.now?.() ?? new Date()).getTime() -
        Date.parse(lastSuccessfulRunAt) <=
        (staleAfterHours ?? 48) * 60 * 60 * 1000
  );
  const health = config?.enabled
    ? scheduler.registered &&
      scheduler.status === "ACTIVE" &&
      schedulerObservation.state === "healthy" &&
      successfulScheduledRunIsRecent &&
      reconciliation.configurationState === "ready" &&
      state.lastCoverageComplete === true
      ? "ready"
      : "degraded"
    : "disabled";
  return {
    configured: Boolean(config),
    config,
    state,
    scheduler,
    schedulerObservation,
    health,
    configPath: facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
    statePath: facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir),
    auditPath: facultAiEvolutionLoopAuditPath(args.homeDir, args.rootDir),
    reportDir: facultAiEvolutionLoopReportDir(args.homeDir, args.rootDir),
  };
}

export async function evolutionLoopStatus(
  args: Parameters<typeof evolutionLoopStatusScoped>[0]
): ReturnType<typeof evolutionLoopStatusScoped> {
  const scope =
    args.scope ??
    (projectRootFromAiRoot(args.rootDir, args.homeDir) ? "project" : "global");
  return await withFacultRootScope(
    { rootDir: args.rootDir, scope },
    async () => await evolutionLoopStatusScoped(args)
  );
}

export async function diagnoseEvolutionLoop(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
}): Promise<{
  configurationState: "ready" | "not_configured" | "invalid";
  configurationError?: string;
  stateError?: string;
  schedulerError?: string;
  config?: EvolutionLoopConfig;
  status?: Awaited<ReturnType<typeof evolutionLoopStatus>>;
}> {
  const scope =
    args.scope ??
    (projectRootFromAiRoot(args.rootDir, args.homeDir) ? "project" : "global");
  return await withFacultRootScope(
    { rootDir: args.rootDir, scope },
    async () => {
      let config: EvolutionLoopConfig | null;
      try {
        config = await loadConfig(args);
      } catch (error) {
        return {
          configurationState: "invalid" as const,
          configurationError:
            error instanceof Error ? error.message : String(error),
        };
      }
      if (!config) {
        return { configurationState: "not_configured" as const };
      }
      try {
        await loadState(args);
      } catch (error) {
        return {
          configurationState: "ready" as const,
          config,
          stateError: error instanceof Error ? error.message : String(error),
        };
      }
      let scheduler: Awaited<ReturnType<typeof automationStatus>>;
      try {
        scheduler = await automationStatus({
          homeDir: args.homeDir,
          name: config.automationName,
        });
      } catch (error) {
        return {
          configurationState: "ready" as const,
          config,
          schedulerError:
            error instanceof Error ? error.message : String(error),
        };
      }
      if (scheduler.error) {
        return {
          configurationState: "ready" as const,
          config,
          schedulerError: scheduler.error,
        };
      }
      return {
        configurationState: "ready" as const,
        config,
        status: await evolutionLoopStatus({ ...args, scope }),
      };
    }
  );
}

async function latestEvolutionLoopReportScoped(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
}): Promise<EvolutionLoopReport | null> {
  const state = await loadState(args);
  if (!state.lastReportPath) {
    return null;
  }
  try {
    const report = JSON.parse(
      await readFile(state.lastReportPath, "utf8")
    ) as EvolutionLoopReport;
    const coverage = report.coverage.map((entry) =>
      entry.freshness
        ? entry
        : {
            ...entry,
            freshness: {
              state: "unknown" as const,
              reason: "legacy_report" as const,
              checkedAt: entry.checkedAt ?? report.generatedAt,
              thresholdHours: DEFAULT_SOURCE_FRESHNESS_THRESHOLD_HOURS,
              alert: false,
            },
          }
    );
    const unknownSourceIds = coverage
      .filter((entry) => entry.freshness.state === "unknown")
      .map((entry) => entry.sourceId)
      .sort();
    return {
      ...report,
      coverage,
      freshness: report.freshness ?? {
        state: "unknown",
        staleSourceIds: [],
        unknownSourceIds,
        alertSourceIds: [],
      },
    };
  } catch {
    return null;
  }
}

export async function latestEvolutionLoopReport(
  args: Parameters<typeof latestEvolutionLoopReportScoped>[0]
): ReturnType<typeof latestEvolutionLoopReportScoped> {
  const scope =
    args.scope ??
    (projectRootFromAiRoot(args.rootDir, args.homeDir) ? "project" : "global");
  return await withFacultRootScope(
    { rootDir: args.rootDir, scope },
    async () => await latestEvolutionLoopReportScoped(args)
  );
}

async function appendFailedRunHistory(args: {
  homeDir: string;
  rootDir: string;
  report: EvolutionLoopReport;
  review?: ReconciliationReview | null;
  configRevision: number;
}): Promise<void> {
  try {
    const { appendActivityHistory } = await import("./activity-history");
    await appendActivityHistory(args);
  } catch {
    // A secondary history-store failure must not hide the failed run's root cause.
    return;
  }
}

async function persistFailedLoopRun(args: {
  homeDir: string;
  rootDir: string;
  config: EvolutionLoopConfig;
  prior: EvolutionLoopState;
  generatedAt: string;
  trigger: "manual" | "scheduled";
  attempts: EvolutionLoopReport["attempts"];
  message: string;
  mutations?: LoopMutationPlan[];
  review?: ReconciliationReview;
}): Promise<EvolutionLoopReport> {
  const generationAfter = args.prior.generation + 1;
  const runId = `LR-${sha256(
    `${args.config.scope}\n${args.generatedAt}\nfailed\n${args.prior.generation}`
  ).slice(0, 16)}`;
  const reportDir = facultAiEvolutionLoopReportDir(args.homeDir, args.rootDir);
  const reportPath = join(reportDir, `${runId}.json`);
  const artifactPath = join(
    facultAiEvolutionReviewDir(args.homeDir, args.rootDir),
    `${runId}.md`
  );
  const auditPath = facultAiEvolutionLoopAuditPath(args.homeDir, args.rootDir);
  const report: EvolutionLoopReport = {
    version: 1,
    runId,
    generatedAt: args.generatedAt,
    scope: args.config.scope,
    projectRoot:
      args.config.scope === "project"
        ? (projectRootFromAiRoot(args.rootDir, args.homeDir) ?? undefined)
        : undefined,
    status: "failed",
    trigger: args.trigger,
    generationBefore: args.prior.generation,
    generationAfter,
    reviewId: args.review?.reviewId,
    coverage: args.review?.coverage ?? [],
    coverageComplete: args.review?.coverageComplete ?? false,
    freshness: args.review?.freshness ?? UNKNOWN_FRESHNESS,
    queue: Object.values(args.prior.queue).sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    delta: {
      new: [],
      changed: [],
      resolved: [],
      notifiable: [],
      unchangedSuppressed: Object.keys(args.prior.queue).length,
    },
    mutations: args.mutations ?? [],
    attempts: args.attempts,
    artifactPath,
    auditPath,
  };
  const { buildActivityFeed } = await import("./activity");
  const proposals = await listProposals({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
  });
  report.activity = buildActivityFeed({
    report,
    review: args.review ?? null,
    writebacks: [],
    proposals,
    locatorContext: {
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      runtimeId: args.config.actionLocator?.runtimeId,
    },
  });
  await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await atomicWrite(artifactPath, `${renderReport(report)}\n`);
  const failedState: EvolutionLoopState = {
    ...args.prior,
    generation: generationAfter,
    lastScheduledRunAt:
      args.trigger === "scheduled"
        ? args.generatedAt
        : args.prior.lastScheduledRunAt,
    lastRunStatus: "failed",
    lastCoverageComplete: false,
    lastReportPath: reportPath,
    lastFailure: {
      at: args.generatedAt,
      message: args.message,
      attempts: args.attempts.length,
    },
  };
  await atomicWrite(
    facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir),
    `${JSON.stringify(failedState, null, 2)}\n`
  );
  await appendLoopAudit(args, {
    runId,
    generatedAt: args.generatedAt,
    trigger: args.trigger,
    status: "failed",
    generationBefore: args.prior.generation,
    generationAfter,
    attempts: args.attempts,
    mutations: args.mutations ?? [],
    reportPath,
    recovery:
      "Resolve the reported error, inspect the failed report, and rerun the same bounded window",
  });
  await appendFailedRunHistory({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    report,
    review: args.review,
    configRevision: args.config.generation,
  });
  return report;
}

async function runEvolutionLoopScoped(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
  since?: string;
  until?: string;
  sourceIds?: string[];
  dryRun?: boolean;
  trigger?: "manual" | "scheduled";
  now?: () => Date;
  onMutationCommitted?: (mutation: LoopMutationPlan) => void | Promise<void>;
  onBeforeAuditCommit?: () => void | Promise<void>;
  resolveProcessStartIdentity?: (pid: number) => string | undefined;
  onLockAcquired?: () => void | Promise<void>;
  openLockFile?: (path: string, flags: "wx") => Promise<FileHandle>;
}): Promise<EvolutionLoopReport> {
  const loadedConfig = await loadConfig(args);
  if (!(loadedConfig?.enabled || args.dryRun)) {
    throw new Error(
      "Evolution loop is disabled. Run `fclt ai loop enable` first."
    );
  }
  const now = args.now?.() ?? new Date();
  const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
  const scope = args.scope ?? (projectRoot ? "project" : "global");
  let config: EvolutionLoopConfig = loadedConfig ?? {
    version: 1,
    generation: 0,
    enabled: false,
    scope,
    automationName: automationName({ ...args, scope }),
    rrule: DEFAULT_RRULE,
    sourceIds: [],
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    verificationDelayHours: DEFAULT_VERIFICATION_DELAY_HOURS,
    verificationGraceHours: DEFAULT_VERIFICATION_GRACE_HOURS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMinutes: DEFAULT_LEASE_MINUTES,
    autoApply: {
      mode: "plan-only",
      reason: "Canonical apply is withheld from preview.",
    },
    updatedAt: now.toISOString(),
  };
  const lockPath = facultAiEvolutionLoopLockPath(args.homeDir, args.rootDir);
  const execute = async (): Promise<EvolutionLoopReport> => {
    if (!args.dryRun) {
      const lockedConfig = await loadConfig(args);
      if (!lockedConfig?.enabled) {
        throw new Error(
          "Evolution loop is disabled. Run `fclt ai loop enable` first."
        );
      }
      const identifiedConfig = withCurrentActionLocatorIdentity({
        config: lockedConfig,
        rootDir: args.rootDir,
      });
      if (identifiedConfig !== lockedConfig) {
        await atomicWrite(
          facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
          `${JSON.stringify(identifiedConfig, null, 2)}\n`
        );
      }
      config = identifiedConfig;
    }
    const prior = await loadState(args);
    const generatedAt = now.toISOString();
    const since =
      args.since ??
      prior.lastSuccessfulCoverageUntil ??
      new Date(
        now.getTime() - config.lookbackHours * 60 * 60 * 1000
      ).toISOString();
    const until = args.until ?? generatedAt;
    const attempts: EvolutionLoopReport["attempts"] = [];
    let review: ReconciliationReview | null = null;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      try {
        review = await reconcileSources({
          homeDir: args.homeDir,
          rootDir: args.rootDir,
          since,
          until,
          sourceIds:
            args.sourceIds && args.sourceIds.length > 0
              ? args.sourceIds
              : config.sourceIds,
          incremental: true,
          persist: !args.dryRun,
        });
        attempts.push({ attempt, ok: true });
        break;
      } catch (error) {
        attempts.push({
          attempt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!review) {
      const message = attempts.at(-1)?.error ?? "Reconciliation failed";
      if (args.dryRun) {
        throw new Error(message);
      }
      return await persistFailedLoopRun({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        config,
        prior,
        generatedAt,
        trigger: args.trigger ?? "manual",
        attempts,
        message,
      });
    }
    if (!args.dryRun) {
      await appendLoopAudit(args, {
        generatedAt,
        trigger: args.trigger ?? "manual",
        status: "started",
        generationBefore: prior.generation,
        reviewId: review.reviewId,
      });
    }
    let mutations: LoopMutationPlan[] = [];
    try {
      mutations = await materializeSignals({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        review,
        dryRun: Boolean(args.dryRun),
        scope: config.scope,
        plans: mutations,
        onMutationCommitted: args.onMutationCommitted,
      });
      const proposals = await listProposals({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
      });
      const writebacks = await listWritebacks({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
      });
      const reconciledQueue = reconcileQueue({
        current: rawQueue({ review, proposals, writebacks, now }),
        prior,
        generatedAt,
        coverageComplete: review.coverageComplete,
        resolutionProofs: review.resolutionProofs ?? [],
        resolvedSignalFamilies: review.resolvedSignalFamilies ?? [],
      });
      const generationAfter = prior.generation + (args.dryRun ? 0 : 1);
      const runId = `LR-${sha256(
        `${config.scope}\n${generatedAt}\n${review.reviewId}\n${prior.generation}`
      ).slice(0, 16)}`;
      const reportDir = facultAiEvolutionLoopReportDir(
        args.homeDir,
        args.rootDir
      );
      const artifactPath = join(
        facultAiEvolutionReviewDir(args.homeDir, args.rootDir),
        `${runId}.md`
      );
      const auditPath = facultAiEvolutionLoopAuditPath(
        args.homeDir,
        args.rootDir
      );
      const report: EvolutionLoopReport = {
        version: 1,
        runId,
        generatedAt,
        scope: config.scope,
        projectRoot:
          config.scope === "project"
            ? (projectRootFromAiRoot(args.rootDir, args.homeDir) ?? undefined)
            : undefined,
        status: args.dryRun
          ? "preview"
          : review.coverageComplete
            ? "complete"
            : "degraded",
        trigger: args.trigger ?? "manual",
        generationBefore: prior.generation,
        generationAfter,
        reviewId: review.reviewId,
        coverage: review.coverage,
        coverageComplete: review.coverageComplete,
        freshness: review.freshness,
        queue: Object.values(reconciledQueue.queue).sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
        delta: reconciledQueue.delta,
        mutations,
        attempts,
        artifactPath,
        auditPath,
      };
      const { buildActivityFeed } = await import("./activity");
      report.activity = buildActivityFeed({
        report,
        review,
        writebacks,
        proposals,
        locatorContext: args.dryRun
          ? undefined
          : {
              homeDir: args.homeDir,
              rootDir: args.rootDir,
              runtimeId: config.actionLocator?.runtimeId,
            },
      });
      if (!args.dryRun) {
        const reportPath = join(reportDir, `${runId}.json`);
        await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        await atomicWrite(artifactPath, `${renderReport(report)}\n`);
        const nextState: EvolutionLoopState = {
          version: 1,
          generation: generationAfter,
          queue: reconciledQueue.queue,
          fingerprints: reconciledQueue.fingerprints,
          lastRunAt: generatedAt,
          lastScheduledRunAt:
            report.trigger === "scheduled"
              ? generatedAt
              : prior.lastScheduledRunAt,
          lastSuccessfulScheduledRunAt:
            report.trigger === "scheduled" && review.coverageComplete
              ? generatedAt
              : prior.lastSuccessfulScheduledRunAt,
          lastSuccessfulScheduledConfigGeneration:
            report.trigger === "scheduled" && review.coverageComplete
              ? config.generation
              : prior.lastSuccessfulScheduledConfigGeneration,
          lastRunStatus: review.coverageComplete ? "complete" : "degraded",
          lastCoverageComplete: review.coverageComplete,
          lastFreshnessState: review.freshness.state,
          lastSuccessfulCoverageUntil: review.coverageComplete
            ? review.window.until
            : prior.lastSuccessfulCoverageUntil,
          lastReviewId: review.reviewId,
          lastReportPath: reportPath,
          lastFailure: undefined,
        };
        await atomicWrite(
          facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir),
          `${JSON.stringify(nextState, null, 2)}\n`
        );
        let historyAttempted = false;
        try {
          await args.onBeforeAuditCommit?.();
          await mkdir(dirname(auditPath), { recursive: true });
          await appendFile(
            auditPath,
            `${JSON.stringify({
              version: 1,
              runId,
              generatedAt,
              trigger: report.trigger,
              status: report.status,
              generationBefore: report.generationBefore,
              generationAfter: report.generationAfter,
              reviewId: report.reviewId,
              delta: report.delta,
              mutations: report.mutations,
              recovery: `Inspect ${reportPath} and rerun after resolving blocked coverage or verification`,
            })}\n`,
            "utf8"
          );
          historyAttempted = true;
          const { appendActivityHistory } = await import("./activity-history");
          await appendActivityHistory({
            homeDir: args.homeDir,
            rootDir: args.rootDir,
            report,
            review,
            configRevision: config.generation,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const failedAttempts = [
            ...attempts,
            {
              attempt: attempts.length + 1,
              ok: false,
              error: `post-commit ${historyAttempted ? "history" : "audit"}: ${message}`,
            },
          ];
          const failedReport: EvolutionLoopReport = {
            ...report,
            status: "failed",
            attempts: failedAttempts,
          };
          failedReport.activity = buildActivityFeed({
            report: failedReport,
            review,
            writebacks,
            proposals,
            locatorContext: {
              homeDir: args.homeDir,
              rootDir: args.rootDir,
              runtimeId: config.actionLocator?.runtimeId,
            },
          });
          await atomicWrite(
            reportPath,
            `${JSON.stringify(failedReport, null, 2)}\n`
          );
          await atomicWrite(artifactPath, `${renderReport(failedReport)}\n`);
          await atomicWrite(
            facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir),
            `${JSON.stringify(
              {
                ...nextState,
                lastRunStatus: "failed",
                lastCoverageComplete: false,
                lastFreshnessState: "unknown",
                lastSuccessfulScheduledRunAt:
                  prior.lastSuccessfulScheduledRunAt,
                lastSuccessfulScheduledConfigGeneration:
                  prior.lastSuccessfulScheduledConfigGeneration,
                lastSuccessfulCoverageUntil: prior.lastSuccessfulCoverageUntil,
                lastFailure: {
                  at: generatedAt,
                  message,
                  attempts: failedAttempts.length,
                },
              } satisfies EvolutionLoopState,
              null,
              2
            )}\n`
          );
          if (historyAttempted) {
            try {
              await appendLoopAudit(args, {
                runId,
                generatedAt,
                trigger: report.trigger,
                status: "failed",
                generationBefore: report.generationBefore,
                generationAfter: report.generationAfter,
                attempts: failedAttempts,
                mutations: report.mutations,
                reportPath,
                recovery:
                  "Repair activity history storage, inspect the failed report, and rerun the same bounded window",
              });
            } catch {
              // Preserve the authoritative failed report when the audit sink also becomes unavailable.
            }
          } else {
            await appendFailedRunHistory({
              homeDir: args.homeDir,
              rootDir: args.rootDir,
              report: failedReport,
              review,
              configRevision: config.generation,
            });
          }
          return failedReport;
        }
      }
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.dryRun) {
        throw error;
      }
      attempts.push({
        attempt: attempts.length + 1,
        ok: false,
        error: `post-reconciliation: ${message}`,
      });
      return await persistFailedLoopRun({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        config,
        prior,
        generatedAt,
        trigger: args.trigger ?? "manual",
        attempts,
        message,
        mutations,
        review,
      });
    }
  };
  if (args.dryRun) {
    return await execute();
  }
  return await withLoopLock({
    path: lockPath,
    leaseMinutes: config.leaseMinutes,
    now,
    resolveProcessStartIdentity: args.resolveProcessStartIdentity,
    onLockAcquired: args.onLockAcquired,
    openLockFile: args.openLockFile,
    fn: execute,
  });
}

export async function runEvolutionLoop(
  args: Parameters<typeof runEvolutionLoopScoped>[0]
): ReturnType<typeof runEvolutionLoopScoped> {
  const scope =
    args.scope ??
    (projectRootFromAiRoot(args.rootDir, args.homeDir) ? "project" : "global");
  return await withFacultRootScope(
    { rootDir: args.rootDir, scope },
    async () => await runEvolutionLoopScoped({ ...args, scope })
  );
}
