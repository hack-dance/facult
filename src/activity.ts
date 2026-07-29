import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  ACTIVITY_ACTION_LOCATOR_PATTERN,
  activityActionScopeBinding,
  createActivityActionLocator,
} from "./activity-action-contract";
import type {
  AiProposalRecord,
  AiWritebackRecord,
  WritebackCategory,
  WritebackSensitivity,
} from "./ai";
import {
  type EvolutionLoopReport,
  type LoopQueueItem,
  latestEvolutionLoopReport,
} from "./evolution-loop";
import {
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionLoopStatePath,
  facultLocalStateRoot,
  machineStateProjectScopeId,
  preferredGlobalAiRoot,
  withFacultRootScope,
} from "./paths";
import { reconciliationReviewById } from "./reconciliation";
import { redactReconciliationText } from "./reconciliation-adapters";
import type {
  CorrelatedSignal,
  ReconciliationReview,
  SourceCoverage,
} from "./reconciliation-types";

const MAX_OBSERVATIONS_PER_ITEM = 10;
const MAX_TARGETS_PER_ITEM = 5;
const MAX_LINKS_PER_ITEM = 5;
const MAX_ACTIVITY_REPORT_BYTES = 2_000_000;
const MAX_ACTIVITY_SET_BYTES = 1_500_000;
const MAX_ACTIVITY_SET_ITEMS = 250;
const MAX_ACTIVITY_SET_PROJECTS = 50;
const MAX_ACTIVITY_SET_SOURCES_PER_FEED = 25;
const MAX_DISCOVERED_PROJECT_STATE_DIRS = 1000;
const MAX_PORTABLE_AGGREGATE_STRING_LENGTH = 1000;
const FILE_URL_PATH_RE = /\bfile:\/\/[^\s)\]}>"'`,;]+/gi;
const WINDOWS_ABSOLUTE_PATH_RE =
  /\b[A-Za-z]:[\\/](?:[^\\/\s)\]}>"'`,;]+[\\/])*[^\\/\s)\]}>"'`,;]*/g;
const UNC_ABSOLUTE_PATH_RE = /\\\\[^\\\s)\]}>"'`,;]+\\[^\s)\]}>"'`,;]+/g;
const HOME_RELATIVE_PATH_RE = /(^|[\s([{:="'`])~[\\/][^\s)\]}>"'`,;]+/g;
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s([{:="'`])\/(?!\/)[^\s)\]}>"'`,;]+/g;
const PATH_TOKEN_RE = /[^\s)\]}>"'`,;]+/g;
const PERCENT_ENCODED_BYTE_RE = /%([0-9a-f]{2})/gi;
const FILE_SCHEME_PATH_RE = /^file:\/\//i;
const EMBEDDED_ABSOLUTE_PATH_RE = /[=:](?:\/|[A-Za-z]:\/)/;
const HTTP_URL_RE = /\bhttps?:\/\/[^\s)\]}>"'`,;]+/gi;
const URL_METADATA_SEPARATOR_RE = /[?#]/;
const ENCODED_PATH_SEPARATOR_RE = /%(?:2f|5c)/i;
const LOCAL_URL_PATH_RE =
  /(?:^|\/)(?:(?:Applications|Library|Network|System|Users|Volumes|afs|bin|boot|cdrom|dev|etc|export|home|lib(?:32|64)?|lost\+found|media|mnt|net|nix|opt|private|proc|root|run|sbin|selinux|srv|sys|tmp|usr|var)(?:\/|$)|[A-Za-z]:(?:\/|$)|~(?:\/|$))/i;
const DOUBLE_PATH_SEPARATOR_RE = /\/\//;
const WINDOWS_DRIVE_SELECTOR_RE = /^[A-Za-z]:\//;
const FILE_SELECTOR_RE = /^file:/i;
const HTTP_SELECTOR_RE = /^https?:/i;
const ISSUE_SELECTOR_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const TYPED_TARGET_SELECTOR_RE =
  /^(instruction|snippet|skill|agent|prompt|automation|mcp|tool):(.+)$/i;
const CANONICAL_SCOPE_PREFIX_RE = /^@(ai|project)\//;
const FILE_EXTENSION_RE = /\.[^.]+$/;
const TARGET_LABEL_SEPARATOR_RE = /[-_]+/g;

export type ActivityCategory =
  | WritebackCategory
  | "signal"
  | "evolution"
  | "coverage";

export interface ActivityObservation {
  writebackId: string;
  category: WritebackCategory;
  sensitivity: WritebackSensitivity;
  summary: string;
  contextOmitted: boolean;
  details?: string;
  impact?: string;
  attemptedWorkaround?: string;
  desiredOutcome?: string;
}

export type ActivityTargetKind =
  | "instruction"
  | "snippet"
  | "skill"
  | "agent"
  | "prompt"
  | "automation"
  | "mcp"
  | "tool"
  | "document"
  | "capability";

export interface ActivityTarget {
  kind: ActivityTargetKind;
  scope: "global" | "project" | "unknown";
  selector: string;
  label: string;
}

export interface ActivityLink {
  label: string;
  url: string;
  source: "evidence" | "linked-work";
}

export interface ActivityContext {
  scope: "global" | "project";
  project?: {
    key: string;
    name: string;
  };
  targets: ActivityTarget[];
  links: ActivityLink[];
}

export interface ActivityItem {
  actionLocator?: string;
  id: string;
  kind: LoopQueueItem["kind"];
  categories: ActivityCategory[];
  title: string;
  state: LoopQueueItem["state"];
  change: "new" | "changed" | "resolved" | "unchanged";
  firstSeenAt: string;
  lastChangedAt: string;
  sourceLabels: string[];
  evidence: {
    count: number;
    types: string[];
    writebackIds: string[];
  };
  observations: ActivityObservation[];
  omittedObservations: number;
  context?: ActivityContext;
  decision: {
    disposition?: LoopQueueItem["disposition"];
    proposalStatus?: LoopQueueItem["proposalStatus"];
    rationale?: string;
    target?: string;
  };
  linkedWork: string[];
  approvalRequired: boolean;
  verification?: LoopQueueItem["verification"];
  nextAction: string;
  technical: {
    queueId: string;
    familyId?: string;
    proposalId?: string;
  };
}

export interface ActivityFeed {
  version: 1;
  mode: "latest";
  snapshot: "embedded" | "legacy-derived";
  generatedAt: string;
  scope: "global" | "project";
  project?: {
    key: string;
    name: string;
  };
  run: {
    id: string;
    status: EvolutionLoopReport["status"];
    reviewId?: string;
  };
  coverage: {
    complete: boolean;
    checked: number;
    degraded: number;
    freshness?: EvolutionLoopReport["freshness"];
    sources: Array<{
      id: string;
      label: string;
      state: SourceCoverage["state"];
      freshness?: SourceCoverage["freshness"];
      detail?: string;
    }>;
  };
  counts: {
    total: number;
    needsAttention: number;
    new: number;
    changed: number;
    resolved: number;
    unchangedSuppressed: number;
  };
  items: ActivityItem[];
}

export interface ActivitySet {
  version: 2;
  kind: "activity-set";
  mode: "latest";
  scope: "all";
  generatedAt: string | null;
  coverage: {
    complete: boolean;
    configuredScopes: number;
    reportingScopes: number;
    unavailableScopes: number;
    checkedSources: number;
    degradedSources: number;
  };
  counts: ActivityFeed["counts"];
  scopes: Array<{
    id: string;
    scope: "global" | "project";
    state: "reporting" | "unavailable" | "omitted";
    project?: ActivityFeed["project"];
  }>;
  feeds: Array<{
    scopeId: string;
    feed: ActivityFeed;
  }>;
  truncation: {
    truncated: boolean;
    omittedScopes: number;
    omittedItems: number;
    omittedSources: number;
    discoveryTruncated: boolean;
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function containsEncodedOrBareLocalPath(value: string): boolean {
  let decoded = value;
  for (let remaining = value.length; remaining > 0; remaining -= 1) {
    const next = decoded.replace(
      PERCENT_ENCODED_BYTE_RE,
      (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  const normalized = decoded.replaceAll("\\", "/");
  if (!normalized.includes("/")) {
    return false;
  }
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    FILE_SCHEME_PATH_RE.test(normalized) ||
    EMBEDDED_ABSOLUTE_PATH_RE.test(normalized) ||
    LOCAL_URL_PATH_RE.test(normalized)
  );
}

function redactActivityPaths(value: string): string {
  return value
    .replace(PATH_TOKEN_RE, (token) =>
      !FILE_SCHEME_PATH_RE.test(token) && containsEncodedOrBareLocalPath(token)
        ? "<redacted-path>"
        : token
    )
    .replace(FILE_URL_PATH_RE, "file:///<redacted-path>")
    .replace(WINDOWS_ABSOLUTE_PATH_RE, "<redacted-path>")
    .replace(UNC_ABSOLUTE_PATH_RE, "<redacted-path>")
    .replace(
      HOME_RELATIVE_PATH_RE,
      (_match, prefix: string) => `${prefix}<redacted-path>`
    )
    .replace(
      POSIX_ABSOLUTE_PATH_RE,
      (_match, prefix: string) => `${prefix}<redacted-path>`
    );
}

function stripHttpUrlMetadata(value: string): string {
  // Provider-specific signed URL credentials cannot be safely enumerated.
  const metadataIndex = value.search(URL_METADATA_SEPARATOR_RE);
  return metadataIndex >= 0 ? value.slice(0, metadataIndex) : value;
}

function isPortableUrlPath(pathname: string): boolean {
  try {
    let decodedPathname = pathname;
    for (let remaining = pathname.length; remaining > 0; remaining -= 1) {
      // Encoded separators can hide absolute machine paths at any encoding
      // depth. Decode until stable and fail closed before publishing the URL.
      if (ENCODED_PATH_SEPARATOR_RE.test(decodedPathname)) {
        return false;
      }
      const next = decodeURIComponent(decodedPathname);
      if (next === decodedPathname) {
        break;
      }
      decodedPathname = next;
    }
    const normalizedPathname = decodedPathname.replaceAll("\\", "/");
    return !(
      DOUBLE_PATH_SEPARATOR_RE.test(normalizedPathname) ||
      EMBEDDED_ABSOLUTE_PATH_RE.test(normalizedPathname) ||
      LOCAL_URL_PATH_RE.test(normalizedPathname)
    );
  } catch {
    return false;
  }
}

function redactPortableHttpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !(parsed.username || parsed.password) &&
      isPortableUrlPath(parsed.pathname)
    ) {
      return stripHttpUrlMetadata(value);
    }
  } catch {
    // Malformed or partially redacted URLs fail closed below.
  }
  return "<redacted-url>";
}

export function redactPortableActivityText(value: string): string {
  const redactedSecrets = redactReconciliationText(value);
  let cursor = 0;
  let output = "";
  for (const match of redactedSecrets.matchAll(HTTP_URL_RE)) {
    const index = match.index;
    output += redactActivityPaths(redactedSecrets.slice(cursor, index));
    output += redactPortableHttpUrl(match[0]);
    cursor = index + match[0].length;
  }
  return output + redactActivityPaths(redactedSecrets.slice(cursor));
}

function sourceLabel(sourceId: string): string {
  const normalized = sourceId
    .replaceAll(/[-_.]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized
    ? normalized.replace(/\b\w/g, (value) => value.toUpperCase())
    : "Unknown source";
}

function projectKey(projectRoot: string): string {
  return basename(projectRoot)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function activityProject(
  projectRoot: string | undefined
): ActivityContext["project"] {
  return projectRoot
    ? {
        key: projectKey(projectRoot),
        name: basename(projectRoot),
      }
    : undefined;
}

function safeTargetSelector(value: string): string | null {
  const selector = value.trim();
  if (
    !selector ||
    selector.length > 300 ||
    selector.includes("\\") ||
    selector.includes("%") ||
    selector.includes("?") ||
    selector.includes("#") ||
    selector.startsWith("/") ||
    selector.startsWith("~") ||
    WINDOWS_DRIVE_SELECTOR_RE.test(selector) ||
    FILE_SELECTOR_RE.test(selector) ||
    HTTP_SELECTOR_RE.test(selector) ||
    ISSUE_SELECTOR_RE.test(selector)
  ) {
    return null;
  }
  const typed = TYPED_TARGET_SELECTOR_RE.exec(selector);
  const pathValue =
    typed?.[2] ?? selector.replace(CANONICAL_SCOPE_PREFIX_RE, "");
  const segments = pathValue.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  const redacted = redactPortableActivityText(selector);
  return redacted.includes("<redacted") ? null : redacted;
}

function targetKind(selector: string): ActivityTargetKind {
  const typed = TYPED_TARGET_SELECTOR_RE.exec(selector)?.[1]?.toLowerCase();
  if (typed) {
    return typed as Exclude<ActivityTargetKind, "document" | "capability">;
  }
  const normalized = selector.toLowerCase();
  const segmentKinds: [string, ActivityTargetKind][] = [
    ["/instructions/", "instruction"],
    ["/snippets/", "snippet"],
    ["/skills/", "skill"],
    ["/agents/", "agent"],
    ["/prompts/", "prompt"],
    ["/automations/", "automation"],
    ["/mcp/", "mcp"],
    ["/tools/", "tool"],
  ];
  for (const [segment, kind] of segmentKinds) {
    if (`/${normalized}`.includes(segment)) {
      return kind;
    }
  }
  return normalized.endsWith(".md") ? "document" : "capability";
}

function targetScope(
  selector: string,
  defaultScope: ActivityContext["scope"]
): ActivityTarget["scope"] {
  if (selector.startsWith("@project/")) {
    return "project";
  }
  if (selector.startsWith("@ai/")) {
    return "global";
  }
  return defaultScope;
}

function targetLabel(selector: string): string {
  const typed = TYPED_TARGET_SELECTOR_RE.exec(selector)?.[2];
  const parts = (typed ?? selector).split("/").filter(Boolean);
  const last = parts.at(-1) ?? selector;
  const name =
    last.toLowerCase() === "skill.md" && parts.length > 1
      ? (parts.at(-2) ?? last)
      : last.replace(FILE_EXTENSION_RE, "");
  return name.replaceAll(TARGET_LABEL_SEPARATOR_RE, " ").trim() || selector;
}

function activityTargets(args: {
  signal?: CorrelatedSignal;
  proposal?: AiProposalRecord;
  writebacks: AiWritebackRecord[];
  scope: ActivityContext["scope"];
}): ActivityTarget[] {
  const candidates = [
    ...(args.signal?.assetRefs ?? []),
    ...(args.proposal?.targets ?? []),
    ...args.writebacks.flatMap((record) => [
      record.assetRef ?? "",
      record.suggestedDestination ?? "",
    ]),
    args.signal?.dispositionTarget ?? "",
  ];
  const targets = new Map<string, ActivityTarget>();
  for (const candidate of candidates) {
    const selector = safeTargetSelector(candidate);
    if (!(selector && !targets.has(selector))) {
      continue;
    }
    targets.set(selector, {
      kind: targetKind(selector),
      scope: targetScope(selector, args.scope),
      selector,
      label: targetLabel(selector),
    });
    if (targets.size >= MAX_TARGETS_PER_ITEM) {
      break;
    }
  }
  return [...targets.values()];
}

function safeActivityLink(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "https:" || parsed.protocol === "http:")) {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (!isPortableUrlPath(parsed.pathname)) {
      return null;
    }
    // Query strings are not portable evidence: signed URLs use many
    // provider-specific credential keys, so an allowlist would fail open.
    if (parsed.search) {
      return null;
    }
    parsed.hash = "";
    const redacted = redactPortableActivityText(parsed.toString());
    return redacted.includes("<redacted") ? null : redacted;
  } catch {
    return null;
  }
}

function activityLinks(args: {
  item: LoopQueueItem;
  signal?: CorrelatedSignal;
  review: ReconciliationReview | null;
  writebacks: AiWritebackRecord[];
}): ActivityLink[] {
  const evidenceKeys = new Set(args.signal?.evidenceKeys ?? []);
  const writebackSensitivity = new Map(
    args.writebacks.map((record) => [
      record.id,
      record.capture?.sensitivity ?? "internal",
    ])
  );
  const provenanceLinks =
    args.review?.evidence
      .filter(
        (entry) =>
          evidenceKeys.has(entry.dedupeKey) &&
          entry.writebackRefs.every(
            (id) =>
              writebackSensitivity.has(id) &&
              writebackSensitivity.get(id) !== "private"
          )
      )
      .flatMap((entry) => entry.provenance)
      .flatMap((provenance) => {
        const candidates = [
          provenance.sourceUri,
          provenance.url,
          provenance.htmlUrl,
        ];
        return candidates.filter(
          (candidate): candidate is string => typeof candidate === "string"
        );
      }) ?? [];
  const evidenceLinks = args.writebacks
    .filter((record) => record.capture?.sensitivity !== "private")
    .flatMap((record) => record.evidence.map((entry) => entry.ref));
  const candidates: Array<{
    value: string;
    source: ActivityLink["source"];
  }> = [
    ...provenanceLinks.map((value) => ({ value, source: "evidence" as const })),
    ...evidenceLinks.map((value) => ({ value, source: "evidence" as const })),
    ...args.item.linkedWork.map((value) => ({
      value,
      source: "linked-work" as const,
    })),
  ];
  const links = new Map<string, ActivityLink>();
  for (const candidate of candidates) {
    const url = safeActivityLink(candidate.value);
    if (!(url && !links.has(url))) {
      continue;
    }
    links.set(url, {
      label: new URL(url).hostname,
      url,
      source: candidate.source,
    });
    if (links.size >= MAX_LINKS_PER_ITEM) {
      break;
    }
  }
  return [...links.values()];
}

function inferredCategory(kind: string): WritebackCategory {
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

function signalForItem(
  item: LoopQueueItem,
  review: ReconciliationReview | null
): CorrelatedSignal | undefined {
  if (!(review && item.kind === "signal" && item.familyId)) {
    return undefined;
  }
  return review.signals.find(
    (signal) =>
      signal.familyId === item.familyId ||
      signal.familyAliases?.includes(item.familyId!) ||
      item.familyAliases?.includes(signal.familyId)
  );
}

function writebackIdsForSignal(
  signal: CorrelatedSignal | undefined,
  review: ReconciliationReview | null,
  writebacks: AiWritebackRecord[]
): string[] {
  if (!(signal && review)) {
    return [];
  }
  const evidenceKeys = new Set(signal.evidenceKeys);
  const familyRefs = new Set(
    [signal.familyId, ...(signal.familyAliases ?? [])].map(
      (familyId) => `signal-family:${familyId}`
    )
  );
  return unique([
    ...signal.writebackRefs,
    ...review.evidence
      .filter((entry) => evidenceKeys.has(entry.dedupeKey))
      .flatMap((entry) => entry.writebackRefs),
    ...writebacks
      .filter((record) =>
        record.evidence.some(
          (entry) =>
            entry.type === "reconciliation" && familyRefs.has(entry.ref)
        )
      )
      .map((record) => record.id),
  ]);
}

function itemChange(
  id: string,
  delta: EvolutionLoopReport["delta"]
): ActivityItem["change"] {
  if (delta.new.includes(id)) {
    return "new";
  }
  if (delta.changed.includes(id)) {
    return "changed";
  }
  if (delta.resolved.includes(id)) {
    return "resolved";
  }
  return "unchanged";
}

function observation(record: AiWritebackRecord): ActivityObservation {
  const capture = record.capture;
  const sensitivity = capture?.sensitivity ?? "internal";
  const contextOmitted = sensitivity === "private";
  return {
    writebackId: record.id,
    category: capture?.category ?? inferredCategory(record.kind),
    sensitivity,
    summary: redactPortableActivityText(record.summary),
    contextOmitted,
    details:
      !contextOmitted && capture?.details
        ? redactPortableActivityText(capture.details)
        : undefined,
    impact:
      !contextOmitted && capture?.impact
        ? redactPortableActivityText(capture.impact)
        : undefined,
    attemptedWorkaround:
      !contextOmitted && capture?.attemptedWorkaround
        ? redactPortableActivityText(capture.attemptedWorkaround)
        : undefined,
    desiredOutcome:
      !contextOmitted && capture?.desiredOutcome
        ? redactPortableActivityText(capture.desiredOutcome)
        : undefined,
  };
}

function nextAction(
  item: LoopQueueItem,
  observations: ActivityObservation[]
): string {
  if (item.kind === "coverage") {
    return "Restore or reconfigure this source, then rerun reconciliation.";
  }
  if (item.requestedExternalAction === "reopen") {
    return "Review the regression evidence before explicitly reopening linked work.";
  }
  if (item.state === "approval_needed") {
    return "Review the proposed capability direction; approve, redirect, or defer it explicitly.";
  }
  if (
    item.state === "verification_due" ||
    item.state === "verification_overdue" ||
    item.state === "verification_pending" ||
    item.state === "regressed"
  ) {
    return "Verify the expected outcome against fresh producing-loop evidence.";
  }
  if (item.state === "resolved") {
    return "No action unless the signal recurs.";
  }
  if (item.state === "deferred") {
    const desiredOutcome = observations.find(
      (entry) => entry.desiredOutcome
    )?.desiredOutcome;
    return desiredOutcome
      ? `Wait for the configured trigger; desired outcome: ${desiredOutcome}`
      : "Wait for the configured recurrence or review trigger.";
  }
  if (item.linkedWork.length > 0) {
    return "Track the linked implementation work and preserve outcome proof.";
  }
  return "Choose a disposition and the smallest durable target.";
}

function proposalForItem(
  item: LoopQueueItem,
  proposals: AiProposalRecord[]
): AiProposalRecord | undefined {
  return item.proposalId
    ? proposals.find((proposal) => proposal.id === item.proposalId)
    : undefined;
}

export function buildActivityFeed(args: {
  report: EvolutionLoopReport;
  review: ReconciliationReview | null;
  writebacks: AiWritebackRecord[];
  proposals: AiProposalRecord[];
  snapshot?: ActivityFeed["snapshot"];
  locatorContext?: {
    homeDir: string;
    rootDir: string;
    runtimeId?: string;
  };
}): ActivityFeed {
  const project = activityProject(args.report.projectRoot);
  const locatorScope =
    args.locatorContext?.runtimeId &&
    (args.report.scope === "project" ||
      resolve(args.locatorContext.rootDir) ===
        resolve(preferredGlobalAiRoot(args.locatorContext.homeDir)))
      ? activityActionScopeBinding({
          ...args.locatorContext,
          runtimeId: args.locatorContext.runtimeId,
          scope: args.report.scope,
        })
      : null;
  const writebackById = new Map(
    args.writebacks.map((record) => [record.id, record])
  );
  const items = args.report.queue.map((item): ActivityItem => {
    const signal = signalForItem(item, args.review);
    const proposal = proposalForItem(item, args.proposals);
    const writebackIds =
      item.kind === "signal"
        ? writebackIdsForSignal(signal, args.review, args.writebacks)
        : item.kind === "proposal"
          ? (proposal?.sourceWritebacks ?? item.evidenceRefs)
          : [];
    const writebacks = writebackIds
      .map((id) => writebackById.get(id))
      .filter((record): record is AiWritebackRecord => Boolean(record))
      .sort((left, right) => left.id.localeCompare(right.id));
    const allObservations = writebacks.map(observation);
    const observations = allObservations.slice(0, MAX_OBSERVATIONS_PER_ITEM);
    const evidenceTypes = unique(
      writebacks.flatMap((record) =>
        record.evidence.map((evidence) => evidence.type)
      )
    );
    const evidenceCount = unique(
      writebacks.flatMap((record) =>
        record.evidence.map((evidence) => `${evidence.type}:${evidence.ref}`)
      )
    ).length;
    const categories: ActivityCategory[] =
      item.kind === "coverage"
        ? ["coverage"]
        : item.kind === "proposal"
          ? ["evolution"]
          : observations.length
            ? (unique(
                observations.map((entry) => entry.category)
              ) as ActivityCategory[])
            : ["signal"];
    const context: ActivityContext = {
      scope: args.report.scope,
      project,
      targets: activityTargets({
        signal,
        proposal,
        writebacks,
        scope: args.report.scope,
      }),
      links: activityLinks({
        item,
        signal,
        review: args.review,
        writebacks,
      }),
    };
    const actionLocator = locatorScope
      ? createActivityActionLocator({
          item,
          proposal,
          runId: args.report.runId,
          scope: locatorScope,
        })
      : null;
    return {
      ...(actionLocator ? { actionLocator: actionLocator.locator } : {}),
      id: item.id,
      kind: item.kind,
      categories,
      title: redactPortableActivityText(item.title),
      state: item.state,
      change: itemChange(item.id, args.report.delta),
      firstSeenAt: item.firstSeenAt,
      lastChangedAt: item.lastChangedAt,
      sourceLabels: item.sourceIds.map((sourceId) =>
        redactPortableActivityText(sourceLabel(sourceId))
      ),
      evidence: {
        count: evidenceCount || item.evidenceRefs.length,
        types: evidenceTypes.map(redactPortableActivityText),
        writebackIds,
      },
      observations,
      omittedObservations: allObservations.length - observations.length,
      context,
      decision: {
        disposition: item.disposition,
        proposalStatus: item.proposalStatus,
        rationale: signal?.rationale
          ? redactPortableActivityText(signal.rationale)
          : proposal?.rationale
            ? redactPortableActivityText(proposal.rationale)
            : undefined,
        target: signal?.dispositionTarget
          ? redactPortableActivityText(signal.dispositionTarget)
          : proposal?.targets.length
            ? proposal.targets.map(redactPortableActivityText).join(", ")
            : undefined,
      },
      linkedWork: item.linkedWork.map(redactPortableActivityText),
      approvalRequired: item.approvalRequired,
      verification: item.verification,
      nextAction: redactPortableActivityText(nextAction(item, observations)),
      technical: {
        queueId: item.id,
        familyId: item.familyId,
        proposalId: item.proposalId,
      },
    };
  });
  const degradedSources = args.report.coverage.filter(
    (entry) => entry.state === "unavailable" || entry.state === "stale"
  );
  return {
    version: 1,
    mode: "latest",
    snapshot: args.snapshot ?? "embedded",
    generatedAt: args.report.generatedAt,
    scope: args.report.scope,
    project,
    run: {
      id: args.report.runId,
      status: args.report.status,
      reviewId: args.report.reviewId,
    },
    coverage: {
      complete: args.report.coverageComplete,
      checked: args.report.coverage.length - degradedSources.length,
      degraded: degradedSources.length,
      freshness: args.report.freshness,
      sources: args.report.coverage.map((entry) => ({
        id: redactPortableActivityText(entry.sourceId),
        label: redactPortableActivityText(sourceLabel(entry.sourceId)),
        state: entry.state,
        freshness: entry.freshness,
        detail: entry.unavailableReason
          ? redactPortableActivityText(entry.unavailableReason)
          : entry.staleReason
            ? redactPortableActivityText(entry.staleReason)
            : undefined,
      })),
    },
    counts: {
      total: items.length,
      needsAttention: items.filter(
        (item) => item.state !== "resolved" && item.state !== "deferred"
      ).length,
      new: args.report.delta.new.length,
      changed: args.report.delta.changed.length,
      resolved: args.report.delta.resolved.length,
      unchangedSuppressed: args.report.delta.unchangedSuppressed,
    },
    items,
  };
}

function itemLines(item: ActivityItem): string[] {
  const decision = item.decision.disposition ?? item.decision.proposalStatus;
  const targetLines = item.context?.targets.map(
    (target) =>
      `  Target: ${target.kind} · ${target.label} (${target.selector})`
  );
  const linkLines = item.context?.links.map(
    (link) => `  Source: ${link.label} · ${link.url}`
  );
  return [
    `- ${item.title}`,
    `  ${item.categories.join(" + ")} · ${item.state}${decision ? ` · ${decision}` : ""}`,
    ...item.observations.flatMap((entry) => [
      `  Captured: ${entry.summary}`,
      ...(entry.contextOmitted
        ? ["  Context: omitted because this observation is marked private"]
        : [
            ...(entry.details ? [`  Context: ${entry.details}`] : []),
            ...(entry.impact ? [`  Impact: ${entry.impact}`] : []),
            ...(entry.attemptedWorkaround
              ? [`  Tried: ${entry.attemptedWorkaround}`]
              : []),
          ]),
    ]),
    ...(item.omittedObservations
      ? [`  ${item.omittedObservations} additional observations omitted`]
      : []),
    ...(item.decision.rationale ? [`  Why: ${item.decision.rationale}`] : []),
    ...(targetLines ?? []),
    ...(linkLines ?? []),
    `  Evidence: ${item.evidence.count} item${item.evidence.count === 1 ? "" : "s"}${item.sourceLabels.length ? ` from ${item.sourceLabels.join(", ")}` : ""}`,
    ...(item.linkedWork.length
      ? [`  Linked work: ${item.linkedWork.join(", ")}`]
      : []),
    `  Next: ${item.nextAction}`,
  ];
}

export function renderActivityFeed(feed: ActivityFeed): string {
  const label = feed.project?.name ?? "Global capability";
  const attention = feed.items.filter(
    (item) => item.state !== "resolved" && item.state !== "deferred"
  );
  const recentlyResolved = feed.items.filter(
    (item) => item.change === "resolved"
  );
  const degraded = feed.coverage.sources.filter(
    (source) => source.state === "unavailable" || source.state === "stale"
  );
  const trustworthyEmpty =
    feed.run.status !== "failed" && feed.coverage.complete;
  return [
    `Activity — ${label}`,
    `Last review: ${feed.generatedAt} · ${feed.run.status}`,
    `Coverage: ${feed.coverage.checked}/${feed.coverage.sources.length} sources checked${feed.coverage.complete ? "" : " · incomplete"}`,
    ...(feed.coverage.freshness
      ? [`Freshness: ${feed.coverage.freshness.state}`]
      : []),
    `Changes: ${feed.counts.new} new · ${feed.counts.changed} changed · ${feed.counts.resolved} resolved · ${feed.counts.unchangedSuppressed} unchanged suppressed`,
    "",
    ...(degraded.length
      ? [
          "Source problems",
          ...degraded.map(
            (source) =>
              `- ${source.label}: ${source.state}${source.detail ? ` — ${source.detail}` : ""}`
          ),
          "",
        ]
      : []),
    "Needs attention",
    ...(attention.length
      ? attention.flatMap(itemLines)
      : [
          trustworthyEmpty
            ? "- Nothing needs attention; configured coverage was checked."
            : "- No actionable items are shown because the latest run did not prove complete coverage.",
        ]),
    ...(recentlyResolved.length
      ? ["", "Recently resolved", ...recentlyResolved.flatMap(itemLines)]
      : []),
  ].join("\n");
}

export async function latestActivityFeed(args: {
  homeDir: string;
  rootDir: string;
  scope: "global" | "project";
}): Promise<ActivityFeed | null> {
  const report = await latestEvolutionLoopReport(args);
  if (!report) {
    return null;
  }
  if (report.activity) {
    return report.activity;
  }
  const review = report.reviewId
    ? await reconciliationReviewById({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        reviewId: report.reviewId,
      })
    : null;
  return buildActivityFeed({
    report,
    review,
    writebacks: [],
    proposals: [],
    snapshot: "legacy-derived",
  });
}

function emptyActivityCounts(): ActivityFeed["counts"] {
  return {
    total: 0,
    needsAttention: 0,
    new: 0,
    changed: 0,
    resolved: 0,
    unchangedSuppressed: 0,
  };
}

function addActivityCounts(
  left: ActivityFeed["counts"],
  right: ActivityFeed["counts"]
): ActivityFeed["counts"] {
  return {
    total: left.total + right.total,
    needsAttention: left.needsAttention + right.needsAttention,
    new: left.new + right.new,
    changed: left.changed + right.changed,
    resolved: left.resolved + right.resolved,
    unchangedSuppressed: left.unchangedSuppressed + right.unchangedSuppressed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isReconciliationFreshness(
  value: unknown
): value is EvolutionLoopReport["freshness"] {
  return (
    isRecord(value) &&
    (value.state === "current" ||
      value.state === "stale" ||
      value.state === "unknown") &&
    isStringArray(value.staleSourceIds) &&
    isStringArray(value.unknownSourceIds) &&
    isStringArray(value.alertSourceIds)
  );
}

function isSourceFreshness(
  value: unknown
): value is SourceCoverage["freshness"] {
  return (
    isRecord(value) &&
    (value.state === "current" ||
      value.state === "stale" ||
      value.state === "unknown" ||
      value.state === "not_applicable") &&
    typeof value.reason === "string" &&
    typeof value.checkedAt === "string" &&
    typeof value.thresholdHours === "number" &&
    typeof value.alert === "boolean"
  );
}

function isActivityItem(value: unknown): value is ActivityItem {
  if (!isRecord(value)) {
    return false;
  }
  if (
    (value.actionLocator !== undefined &&
      (typeof value.actionLocator !== "string" ||
        !ACTIVITY_ACTION_LOCATOR_PATTERN.test(value.actionLocator))) ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    !Array.isArray(value.categories) ||
    !value.categories.every((entry) => typeof entry === "string") ||
    typeof value.title !== "string" ||
    typeof value.state !== "string" ||
    typeof value.change !== "string" ||
    typeof value.firstSeenAt !== "string" ||
    typeof value.lastChangedAt !== "string" ||
    !isStringArray(value.sourceLabels) ||
    !isRecord(value.evidence) ||
    !isNonNegativeInteger(value.evidence.count) ||
    !isStringArray(value.evidence.types) ||
    !isStringArray(value.evidence.writebackIds) ||
    !Array.isArray(value.observations) ||
    !value.observations.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.writebackId === "string" &&
        typeof entry.category === "string" &&
        typeof entry.sensitivity === "string" &&
        typeof entry.summary === "string" &&
        typeof entry.contextOmitted === "boolean"
    ) ||
    !isNonNegativeInteger(value.omittedObservations) ||
    !isRecord(value.decision) ||
    !isStringArray(value.linkedWork) ||
    typeof value.approvalRequired !== "boolean" ||
    typeof value.nextAction !== "string" ||
    !isRecord(value.technical) ||
    typeof value.technical.queueId !== "string"
  ) {
    return false;
  }
  if (
    value.context !== undefined &&
    (!isRecord(value.context) ||
      (value.context.scope !== "global" && value.context.scope !== "project") ||
      !Array.isArray(value.context.targets) ||
      !value.context.targets.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.kind === "string" &&
          typeof entry.scope === "string" &&
          typeof entry.selector === "string" &&
          typeof entry.label === "string"
      ) ||
      !Array.isArray(value.context.links) ||
      !value.context.links.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.label === "string" &&
          typeof entry.url === "string" &&
          typeof entry.source === "string"
      ))
  ) {
    return false;
  }
  return true;
}

export function isActivityFeed(value: unknown): value is ActivityFeed {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.mode === "latest" &&
    (value.snapshot === "embedded" || value.snapshot === "legacy-derived") &&
    typeof value.generatedAt === "string" &&
    (value.scope === "global" || value.scope === "project") &&
    isRecord(value.run) &&
    typeof value.run.id === "string" &&
    typeof value.run.status === "string" &&
    isRecord(value.coverage) &&
    typeof value.coverage.complete === "boolean" &&
    isNonNegativeInteger(value.coverage.checked) &&
    isNonNegativeInteger(value.coverage.degraded) &&
    (value.coverage.freshness === undefined ||
      isReconciliationFreshness(value.coverage.freshness)) &&
    Array.isArray(value.coverage.sources) &&
    value.coverage.sources.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        typeof entry.state === "string" &&
        (entry.freshness === undefined || isSourceFreshness(entry.freshness))
    ) &&
    isRecord(value.counts) &&
    isNonNegativeInteger(value.counts.total) &&
    isNonNegativeInteger(value.counts.needsAttention) &&
    isNonNegativeInteger(value.counts.new) &&
    isNonNegativeInteger(value.counts.changed) &&
    isNonNegativeInteger(value.counts.resolved) &&
    isNonNegativeInteger(value.counts.unchangedSuppressed) &&
    Array.isArray(value.items) &&
    value.items.every(isActivityItem)
  );
}

function redactPortableAggregateValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPortableActivityText(value).slice(
      0,
      MAX_PORTABLE_AGGREGATE_STRING_LENGTH
    );
  }
  if (Array.isArray(value)) {
    return value.map(redactPortableAggregateValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactPortableAggregateValue(entry),
      ])
    );
  }
  return value;
}

function boundedAggregateFeed(feed: ActivityFeed): {
  feed: ActivityFeed;
  omittedSources: number;
} {
  const redacted = redactPortableAggregateValue(feed) as ActivityFeed;
  const sources = redacted.coverage.sources.slice(
    0,
    MAX_ACTIVITY_SET_SOURCES_PER_FEED
  );
  const omittedSources = redacted.coverage.sources.length - sources.length;
  const degraded = sources.filter(
    (source) => source.state === "stale" || source.state === "unavailable"
  ).length;
  const checked = sources.length - degraded;
  return {
    feed: {
      ...redacted,
      coverage: {
        ...redacted.coverage,
        checked,
        complete: redacted.coverage.complete && omittedSources === 0,
        degraded,
        sources,
      },
    },
    omittedSources,
  };
}

function refreshActivitySetCoverageTotals(set: ActivitySet) {
  set.coverage.checkedSources = set.feeds.reduce(
    (total, entry) => total + entry.feed.coverage.checked,
    0
  );
  set.coverage.degradedSources = set.feeds.reduce(
    (total, entry) => total + entry.feed.coverage.degraded,
    0
  );
}

function activityFeedFromReport(
  value: unknown,
  expectedScope: "global" | "project"
): ReturnType<typeof boundedAggregateFeed> | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.scope !== expectedScope ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.queue) ||
    !Array.isArray(value.coverage)
  ) {
    return null;
  }
  const report = value as unknown as EvolutionLoopReport;
  if (report.activity !== undefined) {
    if (
      isActivityFeed(report.activity) &&
      report.activity.scope === expectedScope
    ) {
      return boundedAggregateFeed(report.activity);
    }
    if (expectedScope === "global") {
      return null;
    }
  }
  try {
    return boundedAggregateFeed(
      buildActivityFeed({
        report,
        review: null,
        writebacks: [],
        proposals: [],
        snapshot: "legacy-derived",
      })
    );
  } catch {
    return null;
  }
}

async function readBoundedJson(pathValue: string, maxBytes: number) {
  const info = await lstat(pathValue);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error("Activity state is not a bounded regular file");
  }
  return JSON.parse(await readFile(pathValue, "utf8")) as unknown;
}

async function latestActivityFromLoopFiles(args: {
  statePath: string;
  reportDir: string;
  scope: "global" | "project";
}): Promise<ReturnType<typeof boundedAggregateFeed> | null> {
  try {
    const state = await readBoundedJson(args.statePath, 100_000);
    if (!isRecord(state) || typeof state.lastReportPath !== "string") {
      return null;
    }
    const reportName = basename(state.lastReportPath);
    if (!reportName.endsWith(".json")) {
      return null;
    }
    return activityFeedFromReport(
      await readBoundedJson(
        join(args.reportDir, reportName),
        MAX_ACTIVITY_REPORT_BYTES
      ),
      args.scope
    );
  } catch {
    // A malformed or missing latest report makes only this scope unavailable;
    // other scopes must remain visible in the aggregate read model.
    return null;
  }
}

async function latestProjectActivityFromLoopDir(
  loopDir: string
): Promise<ReturnType<typeof boundedAggregateFeed> | null> {
  return await latestActivityFromLoopFiles({
    statePath: join(loopDir, "state.json"),
    reportDir: join(loopDir, "reports"),
    scope: "project",
  });
}

async function latestGlobalActivity(args: {
  homeDir: string;
  rootDir: string;
}): Promise<{
  activity: ReturnType<typeof boundedAggregateFeed> | null;
  configured: boolean;
}> {
  return await withFacultRootScope(
    { rootDir: args.rootDir, scope: "global" },
    async () => {
      try {
        const config = await readBoundedJson(
          facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
          100_000
        );
        if (!(isRecord(config) && config.scope === "global")) {
          return { activity: null, configured: false };
        }
      } catch {
        return { activity: null, configured: false };
      }
      return {
        activity: await latestActivityFromLoopFiles({
          statePath: facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir),
          reportDir: facultAiEvolutionLoopReportDir(args.homeDir, args.rootDir),
          scope: "global",
        }),
        configured: true,
      };
    }
  );
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) {
          results[index] = await mapper(value, index);
        }
      }
    })
  );
  return results;
}

async function configuredProjectActivity(args: { homeDir: string }): Promise<{
  projects: Array<{
    activity: ReturnType<typeof boundedAggregateFeed> | null;
    id: string;
    omitted: boolean;
  }>;
  discoveryTruncated: boolean;
}> {
  const projectsDir = join(facultLocalStateRoot(args.homeDir), "projects");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { projects: [], discoveryTruncated: false };
  }
  const directories = entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const discoveryTruncated =
    directories.length > MAX_DISCOVERED_PROJECT_STATE_DIRS;
  const candidates = directories.slice(0, MAX_DISCOVERED_PROJECT_STATE_DIRS);
  const configured = (
    await mapConcurrent(candidates, 8, async (entry) => {
      const loopDir = join(
        projectsDir,
        entry.name,
        "ai",
        "project",
        "evolution",
        "loop"
      );
      try {
        const config = await readBoundedJson(
          join(loopDir, "config.json"),
          100_000
        );
        return isRecord(config) && config.scope === "project"
          ? { entry, loopDir }
          : null;
      } catch {
        return null;
      }
    })
  ).filter(
    (value): value is { entry: Dirent<string>; loopDir: string } =>
      value !== null
  );
  const projects = await mapConcurrent(
    configured,
    8,
    async (project, index) => {
      const omitted = index >= MAX_ACTIVITY_SET_PROJECTS;
      return {
        activity: omitted
          ? null
          : await latestProjectActivityFromLoopDir(project.loopDir),
        id: machineStateProjectScopeId(project.entry.name),
        omitted,
      };
    }
  );
  return { projects, discoveryTruncated };
}

export async function latestActivitySet(args: {
  homeDir: string;
  globalRootDir: string;
}): Promise<ActivitySet> {
  const [globalActivity, discovery] = await Promise.all([
    latestGlobalActivity({
      homeDir: args.homeDir,
      rootDir: args.globalRootDir,
    }),
    configuredProjectActivity({ homeDir: args.homeDir }),
  ]);
  const globalFeed = globalActivity.activity?.feed ?? null;
  const feeds: ActivitySet["feeds"] = [
    ...(globalFeed ? [{ scopeId: "global", feed: globalFeed }] : []),
    ...discovery.projects.flatMap((project) =>
      project.activity
        ? [{ scopeId: project.id, feed: project.activity.feed }]
        : []
    ),
  ];
  const scopes: ActivitySet["scopes"] = [
    ...(globalActivity.configured
      ? [
          {
            id: "global",
            scope: "global" as const,
            state: globalFeed
              ? ("reporting" as const)
              : ("unavailable" as const),
          },
        ]
      : []),
    ...discovery.projects.map((project) => ({
      id: project.id,
      scope: "project" as const,
      state: project.omitted
        ? ("omitted" as const)
        : project.activity
          ? ("reporting" as const)
          : ("unavailable" as const),
      ...(project.activity?.feed.project
        ? { project: project.activity.feed.project }
        : {}),
    })),
  ];
  const unavailableScopes = scopes.filter(
    (scope) => scope.state === "unavailable"
  ).length;
  const omittedScopes = scopes.filter(
    (scope) => scope.state === "omitted"
  ).length;
  const generatedAt = feeds.reduce<string | null>(
    (latest, entry) =>
      !latest || Date.parse(entry.feed.generatedAt) > Date.parse(latest)
        ? entry.feed.generatedAt
        : latest,
    null
  );
  const allFeeds = feeds.map((entry) => entry.feed);
  const omittedSources =
    (globalActivity.activity?.omittedSources ?? 0) +
    discovery.projects.reduce(
      (total, project) => total + (project.activity?.omittedSources ?? 0),
      0
    );
  const fullItemCount = allFeeds.reduce(
    (total, feed) => total + feed.items.length,
    0
  );
  let remainingItems = MAX_ACTIVITY_SET_ITEMS;
  for (const entry of feeds) {
    const originalItemCount = entry.feed.items.length;
    const items = entry.feed.items.slice(0, remainingItems);
    remainingItems -= items.length;
    entry.feed = {
      ...entry.feed,
      coverage:
        items.length < originalItemCount
          ? { ...entry.feed.coverage, complete: false }
          : entry.feed.coverage,
      items,
    };
  }
  let omittedItems =
    fullItemCount -
    feeds.reduce((total, entry) => total + entry.feed.items.length, 0);

  const result: ActivitySet = {
    version: 2,
    kind: "activity-set",
    mode: "latest",
    scope: "all",
    generatedAt,
    coverage: {
      complete:
        scopes.length > 0 &&
        unavailableScopes === 0 &&
        omittedScopes === 0 &&
        !discovery.discoveryTruncated &&
        omittedItems === 0 &&
        omittedSources === 0 &&
        feeds.length === scopes.length &&
        feeds.every((entry) => entry.feed.coverage.complete),
      configuredScopes: scopes.length,
      reportingScopes: feeds.length,
      unavailableScopes,
      checkedSources: feeds.reduce(
        (total, entry) => total + entry.feed.coverage.checked,
        0
      ),
      degradedSources: feeds.reduce(
        (total, entry) => total + entry.feed.coverage.degraded,
        0
      ),
    },
    counts: allFeeds.reduce(
      (counts, feed) => addActivityCounts(counts, feed.counts),
      emptyActivityCounts()
    ),
    scopes,
    feeds,
    truncation: {
      truncated:
        omittedScopes > 0 ||
        omittedItems > 0 ||
        omittedSources > 0 ||
        discovery.discoveryTruncated,
      omittedScopes,
      omittedItems,
      omittedSources,
      discoveryTruncated: discovery.discoveryTruncated,
    },
  };
  const omittedScopeIds = new Set(
    result.scopes
      .filter((scope) => scope.state === "omitted")
      .map((scope) => scope.id)
  );
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_ACTIVITY_SET_BYTES) {
    const itemEntry = [...result.feeds]
      .reverse()
      .find((candidate) => candidate.feed.items.length > 0);
    if (itemEntry) {
      itemEntry.feed.items.pop();
      itemEntry.feed.coverage.complete = false;
      omittedItems += 1;
      result.truncation.omittedItems = omittedItems;
      result.truncation.truncated = true;
      result.coverage.complete = false;
      continue;
    }

    const sourceEntry = [...result.feeds]
      .reverse()
      .find((candidate) => candidate.feed.coverage.sources.length > 0);
    if (sourceEntry) {
      sourceEntry.feed.coverage.sources.pop();
      const degraded = sourceEntry.feed.coverage.sources.filter(
        (source) => source.state === "stale" || source.state === "unavailable"
      ).length;
      sourceEntry.feed.coverage.checked =
        sourceEntry.feed.coverage.sources.length - degraded;
      sourceEntry.feed.coverage.degraded = degraded;
      sourceEntry.feed.coverage.complete = false;
      result.truncation.omittedSources += 1;
      result.truncation.truncated = true;
      result.coverage.complete = false;
      refreshActivitySetCoverageTotals(result);
      continue;
    }

    const feedEntry = result.feeds.pop();
    if (feedEntry) {
      const scopeIndex = result.scopes.findIndex(
        (scope) => scope.id === feedEntry.scopeId
      );
      if (scopeIndex >= 0) {
        const scope = result.scopes[scopeIndex];
        if (scope) {
          result.scopes[scopeIndex] = {
            id: scope.id,
            scope: scope.scope,
            state: "omitted",
          };
          omittedScopeIds.add(scope.id);
        }
      }
      result.coverage.reportingScopes = result.feeds.length;
      refreshActivitySetCoverageTotals(result);
      result.truncation.omittedScopes = omittedScopeIds.size;
      result.truncation.truncated = true;
      result.coverage.complete = false;
      continue;
    }

    const scope = result.scopes.pop();
    if (scope) {
      omittedScopeIds.add(scope.id);
      result.truncation.omittedScopes = omittedScopeIds.size;
      result.truncation.truncated = true;
      result.coverage.complete = false;
      continue;
    }

    break;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_ACTIVITY_SET_BYTES) {
    result.generatedAt = null;
    result.coverage.complete = false;
    result.coverage.reportingScopes = 0;
    result.scopes = [];
    result.feeds = [];
    refreshActivitySetCoverageTotals(result);
    result.truncation.omittedScopes = result.coverage.configuredScopes;
    result.truncation.truncated = true;
  }
  return result;
}

export function renderActivitySet(set: ActivitySet): string {
  const unavailable = set.scopes.filter(
    (scope) => scope.state === "unavailable"
  );
  return [
    "Activity — All scopes",
    `Latest review: ${set.generatedAt ?? "not reported"}`,
    `Scopes: ${set.coverage.reportingScopes}/${set.coverage.configuredScopes} reporting${set.coverage.complete ? "" : " · incomplete"}`,
    `Changes: ${set.counts.new} new · ${set.counts.changed} changed · ${set.counts.resolved} resolved · ${set.counts.unchangedSuppressed} unchanged suppressed`,
    ...(unavailable.length
      ? [
          "",
          "Scope problems",
          ...unavailable.map((scope) =>
            scope.scope === "global"
              ? "- Global activity is unavailable"
              : "- A configured project activity feed is unavailable"
          ),
        ]
      : []),
    ...(set.truncation.truncated
      ? [
          "",
          `Bounded response: ${set.truncation.omittedScopes} scopes, ${set.truncation.omittedItems} items, and ${set.truncation.omittedSources} sources omitted`,
        ]
      : []),
    ...set.feeds.flatMap((entry) => ["", renderActivityFeed(entry.feed)]),
  ].join("\n");
}
