import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type ActivityFeed,
  type ActivityItem,
  isActivityFeed,
  redactPortableActivityText,
} from "./activity";
import {
  type ActivityActionClass,
  type ActivityActionLocatorCandidate,
  activityActionRootIdentity,
  activityActionScopeBinding,
  createActivityActionLocator,
  parseActivityActionLocator,
} from "./activity-action-contract";
import type { AiProposalRecord } from "./ai";
import {
  type EvolutionLoopReport,
  type LoopQueueItem,
  withEvolutionLoopMutationLock,
} from "./evolution-loop";
import {
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopDecisionJournalPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionLoopStatePath,
  facultAiProposalDir,
  facultAiStateDir,
  facultLocalStateRoot,
  facultMachineStateDir,
  legacyFacultAiStateDirs,
  machineStateProjectKey,
  preferredGlobalAiRoot,
} from "./paths";

const MAX_ACTIVITY_REPORT_BYTES = 2_000_000;
const MAX_ACTIVITY_STATE_BYTES = 100_000;
const MAX_PROPOSAL_BYTES = 2_000_000;
const MAX_PROJECT_SCOPE_DIRS = 1000;
const PROPOSAL_ID_PATTERN = /^EV-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUNTIME_ID_PATTERN = /^[0-9a-f-]{36}$/;
const ROOT_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVITY_SCOPE_ID_PATTERN = /^(?:global|project:[a-f0-9]{16})$/;
const DECISION_ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const DECISION_RECEIPT_ID_PATTERN = /^AD-[0-9a-f-]{36}$/;
const MAX_DECISION_APPROVAL_REFERENCE_LENGTH = 500;
const MAX_DECISION_NOTE_LENGTH = 1000;
const MAX_DECISION_REDIRECT_TARGET_LENGTH = 500;
const MAX_DECISION_RESOURCE_ID_LENGTH = 500;
const MAX_DECISION_RUN_ID_LENGTH = 500;
const MAX_DECISION_WORK_UNIT_TEXT_LENGTH = 2000;
const MAX_DECISION_JOURNAL_BYTES = 5_000_000;
const MAX_DECISION_JOURNAL_ENTRIES = 10_000;

export type ActivityActionResolutionErrorCode =
  | "invalid_locator"
  | "incompatible_locator"
  | "locator_not_found"
  | "stale_revision"
  | "duplicate_identity"
  | "locator_not_issued";

export type ActivityActionResolution =
  | {
      version: 1;
      kind: "activity-action-resolution";
      status: "resolved";
      resolvedAt: string;
      target: {
        scopeId: string;
        scope: "global" | "project";
        resource: {
          kind: ActivityActionLocatorCandidate["resourceKind"];
          id: string;
        };
        activity: {
          runId: string;
          revision: number;
        };
        allowedActionClass: ActivityActionClass;
      };
      plan: {
        summary: string;
        steps: string[];
        mutation: {
          available: false;
          performed: false;
          separateCommandRequired: true;
          approvalRequired: boolean;
          staleRevisionCheckRequired: true;
        };
      };
    }
  | {
      version: 1;
      kind: "activity-action-resolution";
      status: "rejected";
      error: {
        code: ActivityActionResolutionErrorCode;
        message: string;
        recoverable: true;
        next: string;
      };
    };

export type ActivityDecision = "accept" | "redirect" | "reject" | "defer";

export type ActivityDecisionErrorCode =
  | ActivityActionResolutionErrorCode
  | "approval_required"
  | "invalid_decision_input"
  | "not_signal_family"
  | "replayed_decision"
  | "malformed_history"
  | "decision_conflict";

export interface ActivityDecisionWorkUnit {
  targets: NonNullable<ActivityItem["context"]>["targets"];
  evidence: ActivityItem["evidence"];
  linkedWork: string[];
  expectedOutcome: string | null;
  verification: ActivityItem["verification"] | null;
  nextAction: string;
}

export interface ActivityDecisionReceipt {
  version: 1;
  kind: "activity-decision";
  receiptId: string;
  scopeId: string;
  scope: "global" | "project";
  resource: { kind: "signal"; id: string };
  decision: ActivityDecision;
  actor: string;
  approval: { reference: string } | { note: string };
  redirectTarget?: string;
  previousLifecycleRevision: number;
  newLifecycleRevision: number;
  activity: {
    runId: string;
    queueRevision: number;
    bindingRevision: string;
  };
  decidedAt: string;
  workUnit: ActivityDecisionWorkUnit;
}

export type ActivityDecisionResult =
  | {
      version: 1;
      kind: "activity-decision-receipt";
      status: "recorded";
      receipt: ActivityDecisionReceipt;
      workUnit: ActivityDecisionWorkUnit;
      mutation: {
        decisionHistoryRecorded: true;
        canonicalCapabilityChanged: false;
        externalSystemsChanged: false;
        taskSpawned: false;
        authorityGranted: false;
      };
    }
  | {
      version: 1;
      kind: "activity-decision-receipt";
      status: "rejected";
      error: {
        code: ActivityDecisionErrorCode;
        message: string;
        recoverable: true;
        next: string;
      };
    };

interface ResolvableScope {
  feed: ActivityFeed;
  report: EvolutionLoopReport;
  rootDir: string;
  scopeBinding: NonNullable<ReturnType<typeof activityActionScopeBinding>>;
}

interface MatchingCandidate {
  candidate: ActivityActionLocatorCandidate;
  item: LoopQueueItem;
  issuedItem?: ActivityItem;
  scope: ResolvableScope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(
  pathValue: string,
  maxBytes: number
): Promise<unknown> {
  const info = await lstat(pathValue);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error("Activity state is not a bounded regular file");
  }
  return JSON.parse(await readFile(pathValue, "utf8")) as unknown;
}

function isQueueItem(value: unknown): value is LoopQueueItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.kind === "signal" ||
      value.kind === "proposal" ||
      value.kind === "coverage") &&
    typeof value.state === "string" &&
    Number.isInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.firstSeenAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    typeof value.lastChangedAt === "string" &&
    Array.isArray(value.linkedWork) &&
    value.linkedWork.every((entry) => typeof entry === "string") &&
    typeof value.approvalRequired === "boolean" &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.every((entry) => typeof entry === "string") &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every((entry) => typeof entry === "string") &&
    (value.proposalId === undefined ||
      (typeof value.proposalId === "string" &&
        PROPOSAL_ID_PATTERN.test(value.proposalId))) &&
    (value.familyId === undefined || typeof value.familyId === "string") &&
    (value.proposalStatus === undefined ||
      typeof value.proposalStatus === "string")
  );
}

function isProposalRecord(
  value: unknown,
  id: string
): value is AiProposalRecord {
  return (
    isRecord(value) &&
    value.id === id &&
    typeof value.ts === "string" &&
    [
      "proposed",
      "drafted",
      "in_review",
      "accepted",
      "rejected",
      "applied",
      "failed",
      "superseded",
    ].includes(String(value.status)) &&
    (value.scope === "global" || value.scope === "project") &&
    typeof value.kind === "string" &&
    Array.isArray(value.targets) &&
    value.targets.every((entry) => typeof entry === "string") &&
    Array.isArray(value.sourceWritebacks) &&
    value.sourceWritebacks.every((entry) => typeof entry === "string") &&
    typeof value.summary === "string" &&
    typeof value.rationale === "string" &&
    (value.confidence === "low" ||
      value.confidence === "medium" ||
      value.confidence === "high") &&
    typeof value.reviewRequired === "boolean" &&
    typeof value.policyClass === "string" &&
    Array.isArray(value.draftRefs) &&
    value.draftRefs.every((entry) => typeof entry === "string")
  );
}

async function currentProposal(args: {
  homeDir: string;
  id: string;
  rootDir: string;
  scope: "global" | "project";
}): Promise<AiProposalRecord | null> {
  if (!PROPOSAL_ID_PATTERN.test(args.id)) {
    return null;
  }
  const dirs = [
    facultAiProposalDir(args.homeDir, args.rootDir),
    join(
      facultAiStateDir(args.homeDir, args.rootDir),
      args.scope,
      "evolution",
      "proposals"
    ),
    ...legacyFacultAiStateDirs(args.homeDir, args.rootDir).map((dir) =>
      join(dir, args.scope, "evolution", "proposals")
    ),
  ];
  for (const dir of new Set(dirs)) {
    try {
      const value = await readBoundedJson(
        join(dir, `${args.id}.json`),
        MAX_PROPOSAL_BYTES
      );
      if (isProposalRecord(value, args.id)) {
        return value;
      }
    } catch (error) {
      if (
        !(
          isRecord(error) &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
      ) {
        return null;
      }
    }
  }
  return null;
}

async function latestReport(args: {
  configPath: string;
  reportDir: string;
  statePath: string;
  scope: "global" | "project";
}): Promise<{
  report: EvolutionLoopReport;
  rootIdentity: string;
  runtimeId: string;
} | null> {
  try {
    const config = await readBoundedJson(
      args.configPath,
      MAX_ACTIVITY_STATE_BYTES
    );
    if (
      !isRecord(config) ||
      config.version !== 1 ||
      config.scope !== args.scope ||
      !isRecord(config.actionLocator) ||
      config.actionLocator.version !== 1 ||
      typeof config.actionLocator.runtimeId !== "string" ||
      !RUNTIME_ID_PATTERN.test(config.actionLocator.runtimeId) ||
      typeof config.actionLocator.rootIdentity !== "string" ||
      !ROOT_IDENTITY_PATTERN.test(config.actionLocator.rootIdentity)
    ) {
      return null;
    }
    const state = await readBoundedJson(
      args.statePath,
      MAX_ACTIVITY_STATE_BYTES
    );
    if (
      !(
        isRecord(state) &&
        state.version === 1 &&
        typeof state.lastReportPath === "string"
      )
    ) {
      return null;
    }
    const reportName = basename(state.lastReportPath);
    if (!reportName.endsWith(".json")) {
      return null;
    }
    const value = await readBoundedJson(
      join(args.reportDir, reportName),
      MAX_ACTIVITY_REPORT_BYTES
    );
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.scope !== args.scope ||
      typeof value.runId !== "string" ||
      !Array.isArray(value.queue) ||
      !value.queue.every(isQueueItem) ||
      !isActivityFeed(value.activity) ||
      value.activity.scope !== args.scope ||
      value.activity.run.id !== value.runId
    ) {
      return null;
    }
    return {
      report: value as unknown as EvolutionLoopReport,
      rootIdentity: config.actionLocator.rootIdentity,
      runtimeId: config.actionLocator.runtimeId,
    };
  } catch {
    return null;
  }
}

async function isVerifiedCanonicalRoot(rootDir: string): Promise<boolean> {
  try {
    const info = await lstat(rootDir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function globalScope(homeDir: string): Promise<ResolvableScope | null> {
  const rootDir = preferredGlobalAiRoot(homeDir);
  if (!(await isVerifiedCanonicalRoot(rootDir))) {
    return null;
  }
  const report = await latestReport({
    configPath: facultAiEvolutionLoopConfigPath(homeDir, rootDir),
    reportDir: facultAiEvolutionLoopReportDir(homeDir, rootDir),
    statePath: facultAiEvolutionLoopStatePath(homeDir, rootDir),
    scope: "global",
  });
  if (!report?.report.activity) {
    return null;
  }
  if (report.rootIdentity !== activityActionRootIdentity(rootDir)) {
    return null;
  }
  const scopeBinding = activityActionScopeBinding({
    homeDir,
    rootDir,
    runtimeId: report.runtimeId,
    scope: "global",
  });
  if (!scopeBinding) {
    return null;
  }
  return {
    feed: report.report.activity,
    report: report.report,
    rootDir,
    scopeBinding,
  };
}

async function projectScope(args: {
  entry: Dirent<string>;
  homeDir: string;
  projectsDir: string;
}): Promise<ResolvableScope | null> {
  const loopDir = join(
    args.projectsDir,
    args.entry.name,
    "ai",
    "project",
    "evolution",
    "loop"
  );
  const report = await latestReport({
    configPath: join(loopDir, "config.json"),
    reportDir: join(loopDir, "reports"),
    statePath: join(loopDir, "state.json"),
    scope: "project",
  });
  if (
    !(report?.report.activity && typeof report.report.projectRoot === "string")
  ) {
    return null;
  }
  const rootDir = join(report.report.projectRoot, ".ai");
  if (!(await isVerifiedCanonicalRoot(rootDir))) {
    return null;
  }
  if (report.rootIdentity !== activityActionRootIdentity(rootDir)) {
    return null;
  }
  if (machineStateProjectKey(rootDir, args.homeDir) !== args.entry.name) {
    return null;
  }
  if (
    resolve(facultMachineStateDir(args.homeDir, rootDir)) !==
    resolve(join(args.projectsDir, args.entry.name))
  ) {
    return null;
  }
  const scopeBinding = activityActionScopeBinding({
    homeDir: args.homeDir,
    rootDir,
    runtimeId: report.runtimeId,
    scope: "project",
  });
  if (!scopeBinding) {
    return null;
  }
  return {
    feed: report.report.activity,
    report: report.report,
    rootDir,
    scopeBinding,
  };
}

async function resolvableScopes(homeDir: string): Promise<ResolvableScope[]> {
  const scopes: ResolvableScope[] = [];
  const global = await globalScope(homeDir);
  if (global) {
    scopes.push(global);
  }
  const projectsDir = join(facultLocalStateRoot(homeDir), "projects");
  let entries: Dirent<string>[] = [];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return scopes;
  }
  if (entries.length > MAX_PROJECT_SCOPE_DIRS) {
    return scopes;
  }
  for (const entry of entries) {
    const project = await projectScope({ entry, homeDir, projectsDir });
    if (project) {
      scopes.push(project);
    }
  }
  return scopes;
}

function rejected(args: {
  code: ActivityActionResolutionErrorCode;
  message: string;
  next: string;
}): Extract<ActivityActionResolution, { status: "rejected" }> {
  return {
    version: 1,
    kind: "activity-action-resolution",
    status: "rejected",
    error: { ...args, recoverable: true },
  };
}

function planFor(
  actionClass: ActivityActionClass,
  resource: { kind: string; id: string }
) {
  const actionStep: Record<ActivityActionClass, string> = {
    review:
      "Review the current evidence and proposed direction in the verified scope.",
    decide:
      "Review the current proposal, then explicitly accept or reject it through the separate workflow.",
    apply:
      "Preview the accepted proposal against current canonical state before any separately approved apply.",
    verify:
      "Collect fresh outcome evidence, then record verification through the separate workflow.",
    handoff:
      "Hand off the verified scope and resource target; this locator authorizes no mutation.",
  };
  return {
    summary: `${actionStep[actionClass]} Target: ${resource.kind} ${resource.id}.`,
    steps: [
      actionStep[actionClass],
      "Revalidate this locator immediately before any later lifecycle action.",
      resource.kind === "signal"
        ? "Record an approved signal decision only through loop decide with this locator and the exact expected queue revision; the receipt does not implement the decision."
        : "Do not invoke a mutation from this plan; proposal and coverage lifecycle changes remain separate closed workflows.",
    ],
    mutation: {
      available: false as const,
      performed: false as const,
      separateCommandRequired: true as const,
      approvalRequired: actionClass !== "handoff",
      staleRevisionCheckRequired: true as const,
    },
  };
}

async function matchingCandidate(args: {
  homeDir: string;
  locator: string;
}): Promise<
  | { status: "matched"; match: MatchingCandidate }
  | {
      status: "rejected";
      resolution: Extract<ActivityActionResolution, { status: "rejected" }>;
    }
> {
  const parsed = parseActivityActionLocator(args.locator);
  if (!parsed.ok) {
    return {
      status: "rejected",
      resolution: rejected({
        code: parsed.code,
        message: parsed.message,
        next: "Refresh the aggregate activity set and use a current version 1 locator.",
      }),
    };
  }

  const matches: MatchingCandidate[] = [];
  for (const scope of await resolvableScopes(args.homeDir)) {
    for (const item of scope.report.queue) {
      const proposal = item.proposalId
        ? await currentProposal({
            homeDir: args.homeDir,
            id: item.proposalId,
            rootDir: scope.rootDir,
            scope: scope.scopeBinding.scope,
          })
        : null;
      const candidate = createActivityActionLocator({
        item,
        proposal,
        runId: scope.report.runId,
        scope: scope.scopeBinding,
      });
      if (candidate?.identityDigest !== parsed.identityDigest) {
        continue;
      }
      matches.push({
        candidate,
        item,
        issuedItem: scope.feed.items.find(
          (activityItem) =>
            activityItem.actionLocator === args.locator &&
            activityItem.technical.queueId === item.id
        ),
        scope,
      });
    }
  }

  if (matches.length === 0) {
    return {
      status: "rejected",
      resolution: rejected({
        code: "locator_not_found",
        message:
          "The locator no longer identifies a verified current scope and resource.",
        next: "Refresh activity. Missing state, moved or renamed roots, cross-project replay, and removed resources are intentionally not guessed.",
      }),
    };
  }
  if (matches.length > 1) {
    return {
      status: "rejected",
      resolution: rejected({
        code: "duplicate_identity",
        message:
          "More than one verified current target matched the locator identity, so resolution was refused.",
        next: "Refresh project registration and activity state before retrying.",
      }),
    };
  }
  const match = matches[0];
  if (!match) {
    throw new Error("Expected one activity action locator match");
  }
  if (match.candidate.bindingDigest !== parsed.bindingDigest) {
    return {
      status: "rejected",
      resolution: rejected({
        code: "stale_revision",
        message:
          "The scope, activity run, queue revision, resource lifecycle, or allowed action class changed.",
        next: "Refresh the aggregate activity set and resolve its new locator.",
      }),
    };
  }
  if (!match.issuedItem) {
    return {
      status: "rejected",
      resolution: rejected({
        code: "locator_not_issued",
        message:
          "The locator matches current state but was not issued by the current aggregate activity snapshot.",
        next: "Refresh the aggregate activity set and use the locator it returns.",
      }),
    };
  }
  return { status: "matched", match };
}

export async function resolveActivityActionLocator(args: {
  homeDir: string;
  locator: string;
  now?: () => Date;
}): Promise<ActivityActionResolution> {
  const resolved = await matchingCandidate(args);
  if (resolved.status === "rejected") {
    return resolved.resolution;
  }
  const { match } = resolved;

  return {
    version: 1,
    kind: "activity-action-resolution",
    status: "resolved",
    resolvedAt: (args.now?.() ?? new Date()).toISOString(),
    target: {
      scopeId: match.scope.scopeBinding.scopeId,
      scope: match.scope.scopeBinding.scope,
      resource: {
        kind: match.candidate.resourceKind,
        id: match.candidate.resourceId,
      },
      activity: {
        runId: match.scope.report.runId,
        revision: match.candidate.queueRevision,
      },
      allowedActionClass: match.candidate.actionClass,
    },
    plan: planFor(match.candidate.actionClass, {
      kind: match.candidate.resourceKind,
      id: match.candidate.resourceId,
    }),
  };
}

class DecisionJournalError extends Error {
  readonly code: "malformed_history" | "decision_conflict";

  constructor(
    code: "malformed_history" | "decision_conflict",
    message: string
  ) {
    super(message);
    this.code = code;
    this.name = "DecisionJournalError";
  }
}

function decisionRejected(args: {
  code: ActivityDecisionErrorCode;
  message: string;
  next: string;
}): ActivityDecisionResult {
  return {
    version: 1,
    kind: "activity-decision-receipt",
    status: "rejected",
    error: { ...args, recoverable: true },
  };
}

function resolutionDecisionRejection(
  resolution: Extract<ActivityActionResolution, { status: "rejected" }>
): ActivityDecisionResult {
  return decisionRejected(resolution.error);
}

function isPortableDecisionText(value: string, maxLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    }) &&
    redactPortableActivityText(value) === value
  );
}

function validateDecisionInput(args: {
  decision: ActivityDecision;
  expectedRevision: number;
  actor: string;
  approvalReference?: string;
  note?: string;
  redirectTarget?: string;
  approve: boolean;
}): ActivityDecisionResult | null {
  if (!args.approve) {
    return decisionRejected({
      code: "approval_required",
      message: "Recording an activity decision requires explicit approval.",
      next: "Retry with approve=true only after the exact current signal decision is approved.",
    });
  }
  const validDecision = ["accept", "redirect", "reject", "defer"].includes(
    args.decision
  );
  if (
    !(validDecision && Number.isSafeInteger(args.expectedRevision)) ||
    args.expectedRevision < 1 ||
    !DECISION_ACTOR_PATTERN.test(args.actor)
  ) {
    return decisionRejected({
      code: "invalid_decision_input",
      message: "The decision, expected revision, or actor is malformed.",
      next: "Use a supported decision, a positive expected revision, and a bounded actor identifier.",
    });
  }
  const hasReference = args.approvalReference !== undefined;
  const hasNote = args.note !== undefined;
  if (hasReference === hasNote) {
    return decisionRejected({
      code: "invalid_decision_input",
      message:
        "Provide exactly one approval reference or bounded approval note.",
      next: "Retry with one portable approval source and no secret or local path content.",
    });
  }
  if (
    (args.approvalReference !== undefined &&
      !isPortableDecisionText(
        args.approvalReference,
        MAX_DECISION_APPROVAL_REFERENCE_LENGTH
      )) ||
    (args.note !== undefined &&
      !isPortableDecisionText(args.note, MAX_DECISION_NOTE_LENGTH))
  ) {
    return decisionRejected({
      code: "invalid_decision_input",
      message: "The approval source is empty, unsafe, or exceeds its bound.",
      next: "Use an opaque source reference or a short portable note without secrets or machine paths.",
    });
  }
  if (
    args.decision === "redirect" ? !args.redirectTarget : args.redirectTarget
  ) {
    return decisionRejected({
      code: "invalid_decision_input",
      message:
        "Redirect requires one bounded target; other decisions do not accept a redirect target.",
      next: "Provide --redirect-target only with the redirect decision.",
    });
  }
  if (
    args.redirectTarget !== undefined &&
    !isPortableDecisionText(
      args.redirectTarget,
      MAX_DECISION_REDIRECT_TARGET_LENGTH
    )
  ) {
    return decisionRejected({
      code: "invalid_decision_input",
      message: "The redirect target is unsafe or exceeds its bound.",
      next: "Use one portable capability selector or opaque work reference.",
    });
  }
  return null;
}

function isPortableTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isActivityDecisionWorkUnit(
  value: unknown
): value is ActivityDecisionWorkUnit {
  if (!(isRecord(value) && isRecord(value.evidence))) {
    return false;
  }
  const verification = value.verification;
  return (
    Array.isArray(value.targets) &&
    value.targets.every(
      (target) =>
        isRecord(target) &&
        [
          "instruction",
          "snippet",
          "skill",
          "agent",
          "prompt",
          "automation",
          "mcp",
          "tool",
          "document",
          "capability",
        ].includes(String(target.kind)) &&
        (target.scope === "global" ||
          target.scope === "project" ||
          target.scope === "unknown") &&
        typeof target.selector === "string" &&
        isPortableDecisionText(
          target.selector,
          MAX_DECISION_WORK_UNIT_TEXT_LENGTH
        ) &&
        typeof target.label === "string" &&
        isPortableDecisionText(target.label, MAX_DECISION_WORK_UNIT_TEXT_LENGTH)
    ) &&
    Number.isSafeInteger(value.evidence.count) &&
    Number(value.evidence.count) >= 0 &&
    Array.isArray(value.evidence.types) &&
    value.evidence.types.every(
      (entry) =>
        typeof entry === "string" &&
        isPortableDecisionText(entry, MAX_DECISION_WORK_UNIT_TEXT_LENGTH)
    ) &&
    Array.isArray(value.evidence.writebackIds) &&
    value.evidence.writebackIds.every(
      (entry) =>
        typeof entry === "string" &&
        isPortableDecisionText(entry, MAX_DECISION_WORK_UNIT_TEXT_LENGTH)
    ) &&
    Array.isArray(value.linkedWork) &&
    value.linkedWork.every(
      (entry) =>
        typeof entry === "string" &&
        isPortableDecisionText(entry, MAX_DECISION_WORK_UNIT_TEXT_LENGTH)
    ) &&
    (value.expectedOutcome === null ||
      (typeof value.expectedOutcome === "string" &&
        isPortableDecisionText(
          value.expectedOutcome,
          MAX_DECISION_WORK_UNIT_TEXT_LENGTH
        ))) &&
    (verification === null ||
      (isRecord(verification) &&
        [
          "unscheduled",
          "pending",
          "due",
          "overdue",
          "improved",
          "unchanged",
          "regressed",
          "inconclusive",
        ].includes(String(verification.state)) &&
        Number.isSafeInteger(verification.attempts) &&
        Number(verification.attempts) >= 0 &&
        (verification.opensAt === undefined ||
          isPortableTimestamp(verification.opensAt)) &&
        (verification.dueAt === undefined ||
          isPortableTimestamp(verification.dueAt)) &&
        (verification.overdueAt === undefined ||
          isPortableTimestamp(verification.overdueAt)))) &&
    typeof value.nextAction === "string" &&
    isPortableDecisionText(value.nextAction, MAX_DECISION_WORK_UNIT_TEXT_LENGTH)
  );
}

function isActivityDecisionReceipt(
  value: unknown
): value is ActivityDecisionReceipt {
  if (
    !(isRecord(value) && isRecord(value.resource) && isRecord(value.activity))
  ) {
    return false;
  }
  const approval = value.approval;
  const workUnit = value.workUnit;
  return (
    value.version === 1 &&
    value.kind === "activity-decision" &&
    typeof value.receiptId === "string" &&
    DECISION_RECEIPT_ID_PATTERN.test(value.receiptId) &&
    typeof value.scopeId === "string" &&
    ACTIVITY_SCOPE_ID_PATTERN.test(value.scopeId) &&
    (value.scope === "global" || value.scope === "project") &&
    (value.scope === "global"
      ? value.scopeId === "global"
      : value.scopeId.startsWith("project:")) &&
    value.resource.kind === "signal" &&
    typeof value.resource.id === "string" &&
    isPortableDecisionText(
      value.resource.id,
      MAX_DECISION_RESOURCE_ID_LENGTH
    ) &&
    ["accept", "redirect", "reject", "defer"].includes(
      String(value.decision)
    ) &&
    typeof value.actor === "string" &&
    DECISION_ACTOR_PATTERN.test(value.actor) &&
    isRecord(approval) &&
    ((typeof approval.reference === "string" &&
      isPortableDecisionText(
        approval.reference,
        MAX_DECISION_APPROVAL_REFERENCE_LENGTH
      ) &&
      approval.note === undefined) ||
      (typeof approval.note === "string" &&
        isPortableDecisionText(approval.note, MAX_DECISION_NOTE_LENGTH) &&
        approval.reference === undefined)) &&
    (value.decision === "redirect"
      ? typeof value.redirectTarget === "string" &&
        isPortableDecisionText(
          value.redirectTarget,
          MAX_DECISION_REDIRECT_TARGET_LENGTH
        )
      : value.redirectTarget === undefined) &&
    Number.isSafeInteger(value.previousLifecycleRevision) &&
    Number(value.previousLifecycleRevision) >= 0 &&
    Number.isSafeInteger(value.newLifecycleRevision) &&
    Number(value.newLifecycleRevision) ===
      Number(value.previousLifecycleRevision) + 1 &&
    typeof value.activity.runId === "string" &&
    isPortableDecisionText(value.activity.runId, MAX_DECISION_RUN_ID_LENGTH) &&
    Number.isSafeInteger(value.activity.queueRevision) &&
    Number(value.activity.queueRevision) > 0 &&
    typeof value.activity.bindingRevision === "string" &&
    ROOT_IDENTITY_PATTERN.test(value.activity.bindingRevision) &&
    isPortableTimestamp(value.decidedAt) &&
    isActivityDecisionWorkUnit(workUnit)
  );
}

async function readDecisionJournal(pathValue: string): Promise<{
  body: string;
  entries: ActivityDecisionReceipt[];
}> {
  let body: string;
  try {
    const info = await lstat(pathValue);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_DECISION_JOURNAL_BYTES
    ) {
      throw new DecisionJournalError(
        "malformed_history",
        "The decision journal is not a bounded regular file."
      );
    }
    body = await readFile(pathValue, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { body: "", entries: [] };
    }
    throw error;
  }
  const lines = body.split("\n").filter((line) => line.length > 0);
  if (lines.length > MAX_DECISION_JOURNAL_ENTRIES) {
    throw new DecisionJournalError(
      "malformed_history",
      "The decision journal exceeds its entry bound."
    );
  }
  const entries: ActivityDecisionReceipt[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new DecisionJournalError(
        "malformed_history",
        "The decision journal contains malformed JSON."
      );
    }
    if (!isActivityDecisionReceipt(parsed)) {
      throw new DecisionJournalError(
        "malformed_history",
        "The decision journal contains an incompatible receipt."
      );
    }
    entries.push(parsed);
  }
  return { body, entries };
}

async function replaceDecisionJournal(args: {
  path: string;
  expectedBody: string;
  receipt: ActivityDecisionReceipt;
}): Promise<void> {
  const nextBody = `${args.expectedBody}${
    args.expectedBody && !args.expectedBody.endsWith("\n") ? "\n" : ""
  }${JSON.stringify(args.receipt)}\n`;
  if (Buffer.byteLength(nextBody) > MAX_DECISION_JOURNAL_BYTES) {
    throw new DecisionJournalError(
      "malformed_history",
      "The decision journal reached its size bound."
    );
  }
  await mkdir(dirname(args.path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${args.path}.tmp-${process.pid}-${randomUUID()}`;
  let committed = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(nextBody, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await readDecisionJournal(args.path);
    if (current.body !== args.expectedBody) {
      throw new DecisionJournalError(
        "decision_conflict",
        "The decision journal changed before commit."
      );
    }
    await rename(temporaryPath, args.path);
    committed = true;
  } finally {
    if (!committed) {
      await rm(temporaryPath, { force: true });
    }
  }
}

function decisionWorkUnit(item: ActivityItem): ActivityDecisionWorkUnit {
  const desiredOutcome = item.observations.find(
    (entry) => typeof entry.desiredOutcome === "string"
  )?.desiredOutcome;
  return {
    targets: (item.context?.targets ?? []).map((target) => ({
      kind: target.kind,
      scope: target.scope,
      selector: redactPortableActivityText(target.selector),
      label: redactPortableActivityText(target.label),
    })),
    evidence: {
      count: item.evidence.count,
      types: item.evidence.types.map(redactPortableActivityText),
      writebackIds: item.evidence.writebackIds.map(redactPortableActivityText),
    },
    linkedWork: item.linkedWork.map(redactPortableActivityText),
    expectedOutcome:
      typeof desiredOutcome === "string"
        ? redactPortableActivityText(desiredOutcome)
        : null,
    verification: item.verification ?? null,
    nextAction: redactPortableActivityText(item.nextAction),
  };
}

export async function decideActivityAction(args: {
  homeDir: string;
  locator: string;
  decision: ActivityDecision;
  expectedRevision: number;
  actor: string;
  approvalReference?: string;
  note?: string;
  redirectTarget?: string;
  approve: boolean;
  now?: () => Date;
}): Promise<ActivityDecisionResult> {
  const inputError = validateDecisionInput(args);
  if (inputError) {
    return inputError;
  }
  const initial = await matchingCandidate(args);
  if (initial.status === "rejected") {
    return resolutionDecisionRejection(initial.resolution);
  }
  if (
    initial.match.item.kind !== "signal" ||
    initial.match.candidate.resourceKind !== "signal"
  ) {
    return decisionRejected({
      code: "not_signal_family",
      message: "Activity decisions are limited to signal-family items.",
      next: "Use the existing proposal lifecycle for proposals and refresh coverage separately.",
    });
  }
  const decidedAt = (args.now?.() ?? new Date()).toISOString();
  try {
    return await withEvolutionLoopMutationLock({
      homeDir: args.homeDir,
      rootDir: initial.match.scope.rootDir,
      now: new Date(decidedAt),
      fn: async () => {
        const current = await matchingCandidate(args);
        if (current.status === "rejected") {
          return resolutionDecisionRejection(current.resolution);
        }
        const { match } = current;
        if (
          match.item.kind !== "signal" ||
          match.candidate.resourceKind !== "signal"
        ) {
          return decisionRejected({
            code: "not_signal_family",
            message: "Activity decisions are limited to signal-family items.",
            next: "Refresh activity and use a current signal-family locator.",
          });
        }
        if (match.candidate.queueRevision !== args.expectedRevision) {
          return decisionRejected({
            code: "stale_revision",
            message: "The expected activity revision is no longer current.",
            next: "Refresh activity and retry with its locator and exact queue revision.",
          });
        }
        if (!match.issuedItem) {
          return decisionRejected({
            code: "locator_not_issued",
            message:
              "The current activity snapshot did not issue this locator.",
            next: "Refresh activity and use the locator it returns.",
          });
        }
        if (
          !(
            isPortableDecisionText(
              match.candidate.resourceId,
              MAX_DECISION_RESOURCE_ID_LENGTH
            ) &&
            isPortableDecisionText(
              match.scope.report.runId,
              MAX_DECISION_RUN_ID_LENGTH
            )
          )
        ) {
          return decisionRejected({
            code: "invalid_decision_input",
            message:
              "The current signal binding contains a non-portable resource or run identifier.",
            next: "Refresh or repair the current machine-local activity state before recording a decision.",
          });
        }
        const journalPath = facultAiEvolutionLoopDecisionJournalPath(
          args.homeDir,
          match.scope.rootDir
        );
        const journal = await readDecisionJournal(journalPath);
        if (
          journal.entries.some(
            (entry) =>
              entry.scopeId !== match.scope.scopeBinding.scopeId ||
              entry.scope !== match.scope.scopeBinding.scope
          )
        ) {
          throw new DecisionJournalError(
            "malformed_history",
            "The decision journal contains a receipt for another scope."
          );
        }
        const resourceEntries = journal.entries.filter(
          (entry) =>
            entry.scopeId === match.scope.scopeBinding.scopeId &&
            entry.resource.id === match.candidate.resourceId
        );
        let previousLifecycleRevision = 0;
        let priorQueueRevision = 0;
        for (const entry of resourceEntries) {
          if (
            entry.previousLifecycleRevision !== previousLifecycleRevision ||
            entry.newLifecycleRevision !== previousLifecycleRevision + 1 ||
            entry.activity.queueRevision <= priorQueueRevision
          ) {
            throw new DecisionJournalError(
              "malformed_history",
              "The signal decision lifecycle history is not monotonic."
            );
          }
          previousLifecycleRevision = entry.newLifecycleRevision;
          priorQueueRevision = entry.activity.queueRevision;
        }
        if (
          resourceEntries.some(
            (entry) =>
              entry.activity.bindingRevision ===
                match.candidate.bindingDigest ||
              (entry.activity.runId === match.scope.report.runId &&
                entry.activity.queueRevision === match.candidate.queueRevision)
          )
        ) {
          return decisionRejected({
            code: "replayed_decision",
            message:
              "This exact signal activity revision already has a recorded decision.",
            next: "Read the existing receipt or wait for a genuinely changed signal revision before deciding again.",
          });
        }
        if (match.candidate.queueRevision <= priorQueueRevision) {
          return decisionRejected({
            code: "replayed_decision",
            message:
              "The signal revision does not advance the recorded decision lifecycle.",
            next: "Refresh activity and decide only a newer signal revision.",
          });
        }
        const workUnit = decisionWorkUnit(match.issuedItem);
        if (!isActivityDecisionWorkUnit(workUnit)) {
          return decisionRejected({
            code: "invalid_decision_input",
            message:
              "The current activity item does not contain bounded portable work-unit context.",
            next: "Refresh or repair the current activity state before recording a decision.",
          });
        }
        const receipt: ActivityDecisionReceipt = {
          version: 1,
          kind: "activity-decision",
          receiptId: `AD-${randomUUID()}`,
          scopeId: match.scope.scopeBinding.scopeId,
          scope: match.scope.scopeBinding.scope,
          resource: { kind: "signal", id: match.candidate.resourceId },
          decision: args.decision,
          actor: args.actor,
          approval:
            args.approvalReference !== undefined
              ? { reference: args.approvalReference }
              : { note: args.note! },
          ...(args.redirectTarget
            ? { redirectTarget: args.redirectTarget }
            : {}),
          previousLifecycleRevision,
          newLifecycleRevision: previousLifecycleRevision + 1,
          activity: {
            runId: match.scope.report.runId,
            queueRevision: match.candidate.queueRevision,
            bindingRevision: match.candidate.bindingDigest,
          },
          decidedAt,
          workUnit,
        };
        await replaceDecisionJournal({
          path: journalPath,
          expectedBody: journal.body,
          receipt,
        });
        return {
          version: 1,
          kind: "activity-decision-receipt",
          status: "recorded",
          receipt,
          workUnit,
          mutation: {
            decisionHistoryRecorded: true,
            canonicalCapabilityChanged: false,
            externalSystemsChanged: false,
            taskSpawned: false,
            authorityGranted: false,
          },
        };
      },
    });
  } catch (error) {
    if (error instanceof DecisionJournalError) {
      return decisionRejected({
        code: error.code,
        message: error.message,
        next:
          error.code === "malformed_history"
            ? "Inspect and repair the bounded machine-local decision journal before retrying."
            : "Refresh activity after the competing operation completes.",
      });
    }
    return decisionRejected({
      code: "decision_conflict",
      message:
        "The signal decision could not acquire or commit under the evolution-loop lock.",
      next: "Retry after the current loop operation completes, then refresh the locator and revision.",
    });
  }
}

export function renderActivityDecisionResult(
  result: ActivityDecisionResult
): string {
  if (result.status === "rejected") {
    return [
      `Activity decision rejected: ${result.error.message}`,
      `Next: ${result.error.next}`,
    ].join("\n");
  }
  return [
    `Recorded ${result.receipt.decision} decision for signal ${result.receipt.resource.id}`,
    `Scope: ${result.receipt.scopeId}`,
    `Lifecycle revision: ${result.receipt.previousLifecycleRevision} -> ${result.receipt.newLifecycleRevision}`,
    `Next: ${result.workUnit.nextAction}`,
    "No canonical capability, external system, or task was changed.",
  ].join("\n");
}

export function renderActivityActionResolution(
  resolution: ActivityActionResolution
): string {
  if (resolution.status === "rejected") {
    return [
      `Action locator rejected: ${resolution.error.message}`,
      `Next: ${resolution.error.next}`,
    ].join("\n");
  }
  return [
    `Resolved ${resolution.target.resource.kind} ${resolution.target.resource.id}`,
    `Scope: ${resolution.target.scopeId}`,
    `Allowed action: ${resolution.target.allowedActionClass}`,
    `Plan: ${resolution.plan.summary}`,
    "No mutation was performed.",
  ].join("\n");
}
