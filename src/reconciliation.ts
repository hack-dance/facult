import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  utimes,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WritebackDisposition } from "./ai";
import {
  facultAiReconciliationLockPath,
  facultAiReconciliationReviewDir,
  facultAiReconciliationStatePath,
  projectRootFromAiRoot,
} from "./paths";
import {
  processStartIdentity,
  processStartIdentityMatches,
} from "./process-identity";
import {
  gitDefaultBranchContainment,
  reconciliationAdapterFor,
} from "./reconciliation-adapters";
import {
  DEFAULT_SOURCE_FRESHNESS_THRESHOLD_HOURS,
  loadReconciliationConfig,
} from "./reconciliation-config";
import type {
  AdapterScanResult,
  CorrelatedSignal,
  ExtractionDecision,
  LinkedWorkStatusObservation,
  ReconciledEvidence,
  ReconciliationConfig,
  ReconciliationFreshness,
  ReconciliationReview,
  ReconciliationSourceType,
  ReconciliationState,
  ReconciliationWindow,
  ResolutionProof,
  SignalClassification,
  SourceCoverage,
  SourceFreshness,
  SourceRecord,
} from "./reconciliation-types";

const CAPABILITY_PATH_RE =
  /(?:^|[\s,])(?:\.ai\/|AGENTS\.md|instructions\/|skills\/|agents\/|automations\/|snippets\/|mcp\/)/i;
const OUTCOME_RE =
  /\b(?:verified|proof|passed|released|published|deployed|fixed|completed|green)\b/i;
const CAPABILITY_RE =
  /\b(?:capability|writeback|evolution|instruction|skill|agent|runbook|reconciliation|feedback loop|verification)\b/i;
const NOISE_RE =
  /\b(?:chore|format|typo|timestamp|heartbeat unchanged|no-op)\b/i;
const RECONCILIATION_ENGINE_VERSION = 7;
const STOP_WORD_RE =
  /\b(?:the|and|for|with|from|this|that|into|was|were|are|has|have)\b/g;
const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/g;
const WHITESPACE_RE = /\s+/g;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_ID_RE = /^RV-[a-f0-9]{16}$/;
const RECONCILIATION_LOCK_LEASE_MS = 15 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyState(): ReconciliationState {
  return {
    version: 1,
    sources: {},
    evidence: {},
    decisions: {},
    families: {},
    resolutionProofs: {},
    linkedWorkStatuses: {},
    reviews: {},
  };
}

type LegacyLinkedWorkStatusObservation = Omit<
  LinkedWorkStatusObservation,
  "sourceType"
> & {
  sourceType?: ReconciliationSourceType;
};

function compareLinkedWorkStatusObservations(
  left: LinkedWorkStatusObservation,
  right: LinkedWorkStatusObservation
): number {
  const leftInstant = Date.parse(left.observedAt);
  const rightInstant = Date.parse(right.observedAt);
  if (Number.isFinite(leftInstant) && Number.isFinite(rightInstant)) {
    return (
      leftInstant - rightInstant ||
      left.sourceRecordId.localeCompare(right.sourceRecordId)
    );
  }
  return (
    left.observedAt.localeCompare(right.observedAt) ||
    left.sourceRecordId.localeCompare(right.sourceRecordId)
  );
}

function migrateLinkedWorkStatuses(args: {
  resolutionProofs: NonNullable<ReconciliationState["resolutionProofs"]>;
  synthesizeMissing: boolean;
  statuses: Record<string, LegacyLinkedWorkStatusObservation>;
}): NonNullable<ReconciliationState["linkedWorkStatuses"]> {
  const authoritativeSourceIds = new Set(
    Object.values(args.resolutionProofs)
      .filter(
        (entry) =>
          entry.proof.kind === "linked_work_terminal" &&
          entry.proof.sourceType === "evidence-export"
      )
      .map((entry) => entry.proof.sourceId)
  );
  const migrated: NonNullable<ReconciliationState["linkedWorkStatuses"]> = {};
  for (const [issueRef, observation] of Object.entries(args.statuses)) {
    if (
      observation.sourceType !== "evidence-export" &&
      !(
        observation.sourceType === undefined &&
        authoritativeSourceIds.has(observation.sourceId)
      )
    ) {
      continue;
    }
    migrated[issueRef] = {
      ...observation,
      sourceType: "evidence-export",
    };
  }
  if (!args.synthesizeMissing) {
    return migrated;
  }
  const existingIssueRefs = new Set(Object.keys(migrated));
  for (const entry of Object.values(args.resolutionProofs)) {
    const proof = entry.proof;
    if (
      proof.kind !== "linked_work_terminal" ||
      proof.sourceType !== "evidence-export"
    ) {
      continue;
    }
    for (const issueRef of proof.issueRefs) {
      if (existingIssueRefs.has(issueRef)) {
        continue;
      }
      const observation: LinkedWorkStatusObservation = {
        issueRef,
        ordering: proof.observedAt ? "known" : "unknown",
        observedAt: proof.observedAt ?? entry.lastSeenAt,
        terminal: true,
        sourceId: proof.sourceId,
        sourceType: proof.sourceType,
        sourceRecordId: proof.sourceRecordId,
        ...(proof.status ? { status: proof.status } : {}),
      };
      const prior = migrated[issueRef];
      if (
        !prior ||
        compareLinkedWorkStatusObservations(prior, observation) < 0
      ) {
        migrated[issueRef] = observation;
      }
    }
  }
  return migrated;
}

function parseState(value: unknown): ReconciliationState {
  if (!isPlainObject(value) || value.version !== 1) {
    throw new Error("Unsupported reconciliation state schema");
  }
  if (
    !(
      isPlainObject(value.sources) &&
      isPlainObject(value.evidence) &&
      isPlainObject(value.decisions) &&
      (value.families === undefined || isPlainObject(value.families)) &&
      (value.resolutionProofs === undefined ||
        isPlainObject(value.resolutionProofs)) &&
      (value.linkedWorkStatuses === undefined ||
        isPlainObject(value.linkedWorkStatuses)) &&
      isPlainObject(value.reviews)
    )
  ) {
    throw new Error("Malformed reconciliation state schema");
  }
  const resolutionProofs = isPlainObject(value.resolutionProofs)
    ? (value.resolutionProofs as NonNullable<
        ReconciliationState["resolutionProofs"]
      >)
    : {};
  return {
    version: 1,
    sources: value.sources as ReconciliationState["sources"],
    evidence: value.evidence as ReconciliationState["evidence"],
    decisions: value.decisions as ReconciliationState["decisions"],
    families: isPlainObject(value.families)
      ? (value.families as NonNullable<ReconciliationState["families"]>)
      : {},
    resolutionProofs,
    linkedWorkStatuses: migrateLinkedWorkStatuses({
      resolutionProofs,
      synthesizeMissing: value.linkedWorkStatuses === undefined,
      statuses: isPlainObject(value.linkedWorkStatuses)
        ? (value.linkedWorkStatuses as Record<
            string,
            LegacyLinkedWorkStatusObservation
          >)
        : {},
    }),
    reviews: value.reviews as ReconciliationState["reviews"],
  };
}

async function loadState(path: string): Promise<ReconciliationState> {
  if (!(await Bun.file(path).exists())) {
    return emptyState();
  }
  try {
    return parseState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Invalid reconciliation state at ${path}; the file was preserved: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(temporaryPath, value);
  await rename(temporaryPath, path);
}

async function lockOwnerIsLive(path: string): Promise<boolean> {
  let ownerPid: number | undefined;
  let recordedProcessStartedAt: string | undefined;
  try {
    const owner = JSON.parse(await readFile(path, "utf8")) as {
      pid?: unknown;
      processStartedAt?: unknown;
    };
    if (!(typeof owner.pid === "number" && Number.isSafeInteger(owner.pid))) {
      return false;
    }
    ownerPid = owner.pid;
    recordedProcessStartedAt =
      typeof owner.processStartedAt === "string"
        ? owner.processStartedAt
        : undefined;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code !== "ESRCH"
      );
    }
  } catch {
    return false;
  }
  const observedProcessStartedAt =
    recordedProcessStartedAt && ownerPid
      ? processStartIdentity(ownerPid)
      : undefined;
  return (
    !(recordedProcessStartedAt && observedProcessStartedAt) ||
    processStartIdentityMatches(
      recordedProcessStartedAt,
      observedProcessStartedAt
    )
  );
}

interface FileIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
}

function sameFileIdentity(
  left: FileIdentity | null,
  right: FileIdentity | null
): boolean {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mtimeMs === right.mtimeMs
  );
}

async function restoreMovedFileIfUnclaimed(args: {
  currentPath: string;
  movedPath: string;
}): Promise<void> {
  try {
    await link(args.movedPath, args.currentPath);
    await unlink(args.movedPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return;
    }
    throw error;
  }
}

async function moveFileIfIdentityMatches(args: {
  currentPath: string;
  expected: FileIdentity;
  movedPath: string;
}): Promise<boolean> {
  await rename(args.currentPath, args.movedPath);
  const moved = await lstat(args.movedPath).catch(() => null);
  if (sameFileIdentity(args.expected, moved)) {
    return true;
  }
  await restoreMovedFileIfUnclaimed({
    currentPath: args.currentPath,
    movedPath: args.movedPath,
  });
  return false;
}

async function acquireRecoveryClaim(args: {
  lockPath: string;
  onStaleClaimInspected?: () => void | Promise<void>;
  onStaleClaimRevalidated?: () => void | Promise<void>;
  ownerToken: string;
  takeoverPath: string;
}): Promise<FileHandle> {
  try {
    return await open(args.takeoverPath, "wx");
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const info = await lstat(args.takeoverPath).catch(() => null);
  const ageMs = info ? Date.now() - info.mtime.getTime() : 0;
  const safeTakeoverFile = info?.isFile() === true && !info.isSymbolicLink();
  if (
    !safeTakeoverFile ||
    ageMs <= RECONCILIATION_LOCK_LEASE_MS ||
    (await lockOwnerIsLive(args.takeoverPath))
  ) {
    throw new Error(
      `Another reconciliation is recovering ${args.lockPath} using ${args.takeoverPath}`
    );
  }
  await args.onStaleClaimInspected?.();
  const current = await lstat(args.takeoverPath).catch(() => null);
  if (
    !(
      info &&
      current &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === info.dev &&
      current.ino === info.ino &&
      current.mtimeMs === info.mtimeMs
    )
  ) {
    throw new Error(
      `Another reconciliation is recovering ${args.lockPath} using ${args.takeoverPath}`
    );
  }
  await args.onStaleClaimRevalidated?.();
  const stalePath = `${args.takeoverPath}.stale-${Date.now()}-${args.ownerToken}`;
  try {
    if (
      !(
        info &&
        (await moveFileIfIdentityMatches({
          currentPath: args.takeoverPath,
          expected: info,
          movedPath: stalePath,
        }))
      )
    ) {
      throw new Error(
        `Another reconciliation is recovering ${args.lockPath} using ${args.takeoverPath}`
      );
    }
    return await open(args.takeoverPath, "wx");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EEXIST", "ENOENT"].includes(
        String((error as NodeJS.ErrnoException).code)
      )
    ) {
      throw new Error(
        `Another reconciliation is recovering ${args.lockPath} using ${args.takeoverPath}`
      );
    }
    throw error;
  }
}

async function withStateLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  onLockAcquired?: () => void | Promise<void>,
  onStaleClaimInspected?: () => void | Promise<void>,
  onStaleClaimRevalidated?: () => void | Promise<void>
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const ownerToken = randomUUID();
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    const takeoverPath = `${lockPath}.takeover`;
    const takeover = await acquireRecoveryClaim({
      lockPath,
      onStaleClaimInspected,
      onStaleClaimRevalidated,
      ownerToken,
      takeoverPath,
    });
    try {
      await takeover.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          token: ownerToken,
          startedAt: new Date().toISOString(),
          processStartedAt: processStartIdentity(process.pid),
        })}\n`
      );
      await takeover.sync();
      const info = await lstat(lockPath).catch(() => null);
      const ageMs = info ? Date.now() - info.mtime.getTime() : 0;
      if (
        !(
          info?.isFile() &&
          !info.isSymbolicLink() &&
          ageMs > RECONCILIATION_LOCK_LEASE_MS
        )
      ) {
        throw new Error(
          `Another reconciliation is already updating ${lockPath}`
        );
      }
      if (await lockOwnerIsLive(lockPath)) {
        throw new Error(`A live reconciliation owner still holds ${lockPath}`);
      }
      const takeoverOwner = JSON.parse(
        await readFile(takeoverPath, "utf8")
      ) as { token?: unknown };
      if (takeoverOwner.token !== ownerToken) {
        throw new Error(
          `Reconciliation recovery ownership changed for ${takeoverPath}`
        );
      }
      const currentLock = await lstat(lockPath).catch(() => null);
      if (
        !(
          info &&
          currentLock &&
          currentLock.dev === info.dev &&
          currentLock.ino === info.ino &&
          currentLock.mtimeMs === info.mtimeMs
        )
      ) {
        throw new Error(
          `Reconciliation lock ownership changed during recovery for ${lockPath}`
        );
      }
      if (
        !(
          info &&
          (await moveFileIfIdentityMatches({
            currentPath: lockPath,
            expected: info,
            movedPath: `${lockPath}.stale-${Date.now()}-${ownerToken}`,
          }))
        )
      ) {
        throw new Error(
          `Reconciliation lock ownership changed during recovery for ${lockPath}`
        );
      }
      handle = await open(lockPath, "wx");
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
      startedAt: new Date().toISOString(),
      processStartedAt: processStartIdentity(process.pid),
    })}\n`
  );
  await handle.sync();
  const stillOwnsPath = async (): Promise<boolean> => {
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
        token?: unknown;
      };
      return owner.token === ownerToken;
    } catch {
      return false;
    }
  };
  const heartbeat = setInterval(
    () => {
      stillOwnsPath()
        .then((ownsPath) => {
          if (ownsPath) {
            const heartbeatAt = new Date();
            return utimes(lockPath, heartbeatAt, heartbeatAt);
          }
          return undefined;
        })
        .catch(() => undefined);
    },
    Math.min(30_000, RECONCILIATION_LOCK_LEASE_MS / 3)
  );
  heartbeat.unref();
  try {
    if (!(await stillOwnsPath())) {
      throw new Error(`Reconciliation lock ownership changed for ${lockPath}`);
    }
    await onLockAcquired?.();
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await handle.close();
    if (await stillOwnsPath()) {
      await rm(lockPath, { force: true });
    }
  }
}

function configDigest(config: ReconciliationConfig): string {
  return sha256(
    JSON.stringify({
      engineVersion: RECONCILIATION_ENGINE_VERSION,
      config,
      adapters: config.sources.map((source) => ({
        type: source.type,
        version: reconciliationAdapterFor(source.type).version,
      })),
    })
  );
}

function sourceStateDigest(
  source: ReconciliationConfig["sources"][number]
): string {
  return sha256(
    JSON.stringify({
      engineVersion: RECONCILIATION_ENGINE_VERSION,
      adapterVersion: reconciliationAdapterFor(source.type).version,
      source,
    })
  );
}

function createWindow(args: {
  config: ReconciliationConfig;
  rootDir: string;
  homeDir: string;
  since: string;
  until: string;
  mode: "window" | "incremental";
}): ReconciliationWindow {
  const since = new Date(args.since).toISOString();
  const until = DATE_ONLY_RE.test(args.until)
    ? new Date(`${args.until}T23:59:59.999Z`).toISOString()
    : new Date(args.until).toISOString();
  if (Date.parse(since) > Date.parse(until)) {
    throw new Error("Reconciliation --since must be before --until");
  }
  const digest = configDigest(args.config);
  const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
  const scope = projectRoot ? "project" : "global";
  const id = `RV-${sha256(`${scope}\n${args.rootDir}\n${args.mode}\n${since}\n${until}\n${digest}`).slice(0, 16)}`;
  return {
    id,
    mode: args.mode,
    since,
    until,
    scope,
    rootDir: args.rootDir,
    projectRoot: projectRoot ?? undefined,
    configDigest: digest,
  };
}

function incrementalSince(requestedSince: string, watermark?: string): string {
  if (!watermark) {
    return requestedSince;
  }
  const requested = Date.parse(requestedSince);
  const previous = Date.parse(watermark);
  if (!Number.isFinite(previous) || previous <= requested) {
    return requestedSince;
  }
  return new Date(previous - 1).toISOString();
}

function boundedIncrementalSince(
  requestedSince: string,
  watermark: string | undefined,
  until: string
): string {
  const since = incrementalSince(requestedSince, watermark);
  return Date.parse(since) > Date.parse(until) ? until : since;
}

function classify(record: SourceRecord): SignalClassification {
  if (record.classification) {
    return record.classification;
  }
  const text = `${record.title}\n${record.body}`;
  const paths = Array.isArray(record.provenance.files)
    ? record.provenance.files.join(" ")
    : String(record.provenance.path ?? "");
  if (CAPABILITY_PATH_RE.test(paths) || CAPABILITY_RE.test(text)) {
    return OUTCOME_RE.test(text)
      ? "capability-implementation"
      : "capability-source";
  }
  if (OUTCOME_RE.test(text)) {
    return "outcome-proof";
  }
  if (record.issueRefs.length > 0) {
    return "implementation-only";
  }
  return NOISE_RE.test(text) ? "noise" : "noise";
}

function semanticKey(record: SourceRecord): string {
  const normalized = `${record.title} ${record.body}`
    .toLowerCase()
    .replace(STOP_WORD_RE, " ")
    .replace(NON_ALPHANUMERIC_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim()
    .slice(0, 500);
  return `semantic:${sha256(normalized)}`;
}

function correlationKeys(record: SourceRecord): string[] {
  const referenceCount =
    record.assetRefs.length +
    record.issueRefs.length +
    (record.sourceType === "writebacks" ? 0 : record.writebackRefs.length);
  const boundedReferenceKeys =
    referenceCount <= 2
      ? [
          ...record.assetRefs.map((entry) => `asset:${entry.toLowerCase()}`),
          ...record.issueRefs.map((entry) => `issue:${entry}`),
          ...(record.sourceType === "writebacks"
            ? [record.dedupeKey]
            : record.writebackRefs.map((entry) => `writeback:${entry}`)),
        ]
      : [];
  const semanticKeys = referenceCount === 0 ? [semanticKey(record)] : [];
  return unique([...boundedReferenceKeys, ...semanticKeys]);
}

function extractionDecision(record: SourceRecord): ExtractionDecision {
  const classification = classify(record);
  const included = classification !== "noise";
  const terminalSourceState = record.provenance.terminal === true;
  return {
    id: `XD-${sha256(`${record.sourceId}:${record.recordId}:${record.dedupeKey}`).slice(0, 16)}`,
    sourceId: record.sourceId,
    sourceRecordId: record.recordId,
    dedupeKey: record.dedupeKey,
    included,
    classification,
    reason: included
      ? `Included as ${classification} evidence`
      : terminalSourceState
        ? "Excluded as a terminal source state that resolves prior evidence"
        : "Excluded as noise: no capability, linked-work, or outcome signal was found",
    correlationKeys: correlationKeys(record),
  };
}

function explicitDisposition(
  record: SourceRecord
): WritebackDisposition | undefined {
  const value = record.provenance.disposition;
  return value === "propose" ||
    value === "apply-local" ||
    value === "task" ||
    value === "resolve-watch" ||
    value === "defer"
    ? value
    : undefined;
}

function dispositionFor(args: {
  records: SourceRecord[];
  classifications: SignalClassification[];
  assetRefs: string[];
  issueRefs: string[];
}): { disposition: WritebackDisposition; target?: string; rationale: string } {
  const requested = args.records.map(explicitDisposition).find(Boolean);
  const explicitTarget = args.records
    .map((record) => record.provenance.dispositionTarget)
    .find(
      (value): value is string => typeof value === "string" && Boolean(value)
    );
  if (requested) {
    return {
      disposition: requested,
      target: explicitTarget ?? args.issueRefs[0] ?? args.assetRefs[0],
      rationale:
        "Preserved the explicit disposition from the latest writeback state",
    };
  }
  const exactImplementationOnDefaultBranch = args.records.some(
    (record) =>
      record.sourceType === "git" && record.provenance.onDefaultBranch === true
  );
  const terminalIssueRefs = new Set(
    args.records
      .filter(
        (record) =>
          record.provenance.terminal === true &&
          !(
            record.sourceType === "git" &&
            record.provenance.onDefaultBranch === true
          )
      )
      .flatMap((record) => record.issueRefs)
  );
  const hasTerminalLinkedWork = terminalIssueRefs.size > 0;
  const allLinkedWorkTerminal =
    args.issueRefs.length > 0 &&
    args.issueRefs.every((issueRef) => terminalIssueRefs.has(issueRef));
  if (exactImplementationOnDefaultBranch || allLinkedWorkTerminal) {
    return {
      disposition: "resolve-watch",
      target: args.issueRefs[0] ?? args.assetRefs[0],
      rationale:
        "Bounded current-source evidence proves the linked work is terminal or the exact implementation is on the default branch",
    };
  }
  if (hasTerminalLinkedWork) {
    return {
      disposition: "task",
      target: args.issueRefs.find(
        (issueRef) => !terminalIssueRefs.has(issueRef)
      ),
      rationale:
        "Some linked work is terminal, but the full prior and current linked-work family is not terminal",
    };
  }
  if (args.classifications.includes("capability-implementation")) {
    return OUTCOME_RE.test(args.records.map((record) => record.body).join(" "))
      ? {
          disposition: "resolve-watch",
          target: args.issueRefs[0] ?? args.assetRefs[0],
          rationale:
            "Capability implementation has outcome evidence and should be watched for effectiveness",
        }
      : {
          disposition: "task",
          target: args.issueRefs[0] ?? args.assetRefs[0],
          rationale:
            "Capability implementation belongs in linked delivery work, not a duplicate proposal",
        };
  }
  if (args.classifications.includes("outcome-proof")) {
    return {
      disposition: "resolve-watch",
      target: args.issueRefs[0] ?? args.assetRefs[0],
      rationale:
        "Outcome evidence closes or monitors existing work rather than creating a proposal",
    };
  }
  if (args.classifications.includes("implementation-only")) {
    return {
      disposition: "task",
      target: args.issueRefs[0],
      rationale:
        "Implementation evidence remains linked work and is not promoted into capability evolution",
    };
  }
  const sourceCount = unique(
    args.records.map((record) => record.sourceId)
  ).length;
  if (args.assetRefs.some((asset) => asset.startsWith("@project/"))) {
    const projectTarget = args.assetRefs.find((asset) =>
      asset.startsWith("@project/")
    );
    return {
      disposition: "apply-local",
      target: projectTarget,
      rationale:
        "Project-local capability evidence has a concrete local target",
    };
  }
  if (sourceCount >= 2) {
    return {
      disposition: "propose",
      target: args.assetRefs[0],
      rationale:
        "Repeated capability signal is corroborated by multiple configured sources",
    };
  }
  return {
    disposition: "defer",
    target: args.assetRefs[0],
    rationale:
      "Capability signal is currently a singleton and needs recurrence or a clearer target",
  };
}

class DisjointSet {
  readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index] ?? index;
    if (parent === index) {
      return index;
    }
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent[rightRoot] = leftRoot;
    }
  }
}

function correlate(args: {
  records: SourceRecord[];
  decisions: ExtractionDecision[];
  state: ReconciliationState;
}): { evidence: ReconciledEvidence[]; signals: CorrelatedSignal[] } {
  const included = args.records
    .map((record, index) => ({ record, decision: args.decisions[index] }))
    .filter(
      (
        entry
      ): entry is { record: SourceRecord; decision: ExtractionDecision } =>
        Boolean(entry.decision?.included)
    );
  const byDedupe = new Map<string, typeof included>();
  for (const entry of included) {
    const current = byDedupe.get(entry.record.dedupeKey) ?? [];
    current.push(entry);
    byDedupe.set(entry.record.dedupeKey, current);
  }
  const evidence: ReconciledEvidence[] = [...byDedupe.entries()].map(
    ([dedupeKey, entries]) => {
      const records = entries.map((entry) => entry.record);
      const newest = [...records].sort((a, b) =>
        b.observedAt.localeCompare(a.observedAt)
      )[0]!;
      const classification = entries
        .map((entry) => entry.decision.classification)
        .find((value) => value !== "noise") as Exclude<
        SignalClassification,
        "noise"
      >;
      return {
        dedupeKey,
        sourceIds: unique(records.map((record) => record.sourceId)),
        sourceRecordIds: unique(records.map((record) => record.recordId)),
        observedAt: newest.observedAt,
        title: newest.title,
        body: newest.body,
        classification,
        assetRefs: unique(records.flatMap((record) => record.assetRefs)),
        issueRefs: unique(records.flatMap((record) => record.issueRefs)),
        writebackRefs: unique(
          records.flatMap((record) => record.writebackRefs)
        ),
        correlationKeys: unique(
          entries.flatMap((entry) => entry.decision.correlationKeys)
        ),
        disposition: "defer",
        isNew: !args.state.evidence[dedupeKey],
        provenance: records.map((record) => record.provenance),
      };
    }
  );

  const writebackSourcesByRef = new Map<string, ReconciledEvidence[]>();
  for (const item of evidence) {
    if (!item.dedupeKey.startsWith("writeback:")) {
      continue;
    }
    for (const ref of item.writebackRefs) {
      const sources = writebackSourcesByRef.get(ref) ?? [];
      sources.push(item);
      writebackSourcesByRef.set(ref, sources);
    }
  }
  for (const [ref, sources] of writebackSourcesByRef) {
    if (sources.length === 1) {
      const source = sources[0]!;
      source.correlationKeys = unique([
        ...source.correlationKeys,
        `writeback:${ref}`,
      ]);
    }
  }
  for (const item of evidence) {
    const matchingFamilyIds = Object.entries(args.state.families ?? {})
      .filter(([, family]) =>
        family.subjectKeys.some((key) => item.correlationKeys.includes(key))
      )
      .map(([familyId]) => familyId);
    item.correlationKeys = unique([
      ...item.correlationKeys,
      ...matchingFamilyIds.map((familyId) => `family:${familyId}`),
    ]);
  }

  const set = new DisjointSet(evidence.length);
  const keyOwner = new Map<string, number>();
  for (const [index, item] of evidence.entries()) {
    for (const key of item.correlationKeys) {
      const owner = keyOwner.get(key);
      if (owner === undefined) {
        keyOwner.set(key, index);
      } else {
        set.union(owner, index);
      }
    }
  }
  const groups = new Map<number, ReconciledEvidence[]>();
  for (const [index, item] of evidence.entries()) {
    const root = set.find(index);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  }
  const signals = [...groups.values()].map((items): CorrelatedSignal => {
    const records = included
      .filter((entry) =>
        items.some((item) => item.dedupeKey === entry.record.dedupeKey)
      )
      .map((entry) => entry.record);
    const assetRefs = unique(items.flatMap((item) => item.assetRefs));
    const writebackRefs = unique(items.flatMap((item) => item.writebackRefs));
    const classifications = unique(items.map((item) => item.classification));
    const id = `SG-${sha256(
      items
        .map((item) => item.dedupeKey)
        .sort()
        .join("\n")
    ).slice(0, 16)}`;
    const subjectKeys = unique(items.flatMap((item) => item.correlationKeys));
    const matchingFamilies = Object.entries(args.state.families ?? {})
      .filter(([, family]) =>
        family.subjectKeys.some((key) => subjectKeys.includes(key))
      )
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.firstSeenAt.localeCompare(right.firstSeenAt) ||
          leftId.localeCompare(rightId)
      );
    const priorFamily = matchingFamilies[0]?.[0];
    const issueRefs = unique([
      ...items.flatMap((item) => item.issueRefs),
      ...matchingFamilies.flatMap(([, family]) =>
        family.subjectKeys
          .filter((key) => key.startsWith("issue:"))
          .map((key) => key.slice("issue:".length))
      ),
    ]);
    const disposition = dispositionFor({
      records,
      classifications,
      assetRefs,
      issueRefs,
    });
    const familySeed =
      subjectKeys[0] ?? items.map((item) => item.dedupeKey).sort()[0] ?? id;
    const familyId = priorFamily ?? `SF-${sha256(familySeed).slice(0, 16)}`;
    const familyAliases = unique([
      ...matchingFamilies
        .map(([matchedId]) => matchedId)
        .filter((matchedId) => matchedId !== familyId),
      ...matchingFamilies.flatMap(([, family]) => family.aliases ?? []),
    ]).filter((matchedId) => matchedId !== familyId);
    for (const item of items) {
      item.disposition = disposition.disposition;
    }
    return {
      id,
      familyId,
      familyAliases,
      subjectKeys,
      title: items[0]?.title ?? id,
      evidenceKeys: items.map((item) => item.dedupeKey).sort(),
      sourceIds: unique(items.flatMap((item) => item.sourceIds)),
      classifications,
      assetRefs,
      issueRefs,
      writebackRefs,
      disposition: disposition.disposition,
      dispositionTarget: disposition.target,
      rationale: disposition.rationale,
      unresolved:
        disposition.disposition === "propose" ||
        disposition.disposition === "apply-local" ||
        disposition.disposition === "task" ||
        disposition.disposition === "defer",
    };
  });
  return { evidence, signals };
}

function dispositionCounts(
  signals: CorrelatedSignal[]
): Record<WritebackDisposition, number> {
  const counts: Record<WritebackDisposition, number> = {
    propose: 0,
    "apply-local": 0,
    task: 0,
    "resolve-watch": 0,
    defer: 0,
  };
  for (const signal of signals) {
    counts[signal.disposition] += 1;
  }
  return counts;
}

function latestTimestampValue(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function sourceFreshness(args: {
  checkedAt: string;
  until: string;
  coverageState: SourceCoverage["state"];
  thresholdHours?: number;
  priorWatermark?: string;
  result: AdapterScanResult;
}): SourceFreshness {
  const thresholdHours =
    args.thresholdHours ?? DEFAULT_SOURCE_FRESHNESS_THRESHOLD_HOURS;
  if (args.coverageState === "unavailable") {
    return {
      state: "unknown",
      reason: "source_unavailable",
      checkedAt: args.checkedAt,
      thresholdHours,
      alert: false,
    };
  }
  const cursorAt = latestTimestampValue(
    args.priorWatermark,
    args.result.watermark
  );
  const latestSourceAt = args.result.latestSourceAt;
  if (
    latestSourceAt &&
    Date.parse(latestSourceAt) <= Date.parse(args.until) &&
    (!cursorAt || Date.parse(latestSourceAt) > Date.parse(cursorAt))
  ) {
    return {
      state: "stale",
      reason: "newer_repository_activity",
      checkedAt: args.checkedAt,
      thresholdHours,
      alert: true,
      cursorAt,
      latestSourceAt,
    };
  }
  if (!cursorAt) {
    return {
      state: "not_applicable",
      reason: "no_cursor",
      checkedAt: args.checkedAt,
      thresholdHours,
      alert: false,
      latestSourceAt,
    };
  }
  const cursorAgeHours =
    (Date.parse(args.until) - Date.parse(cursorAt)) / (60 * 60 * 1000);
  if (cursorAgeHours > thresholdHours) {
    return {
      state: "stale",
      reason: "threshold_exceeded",
      checkedAt: args.checkedAt,
      thresholdHours,
      alert: true,
      cursorAt,
      latestSourceAt,
    };
  }
  const resultWatermark = args.result.watermark;
  const cursorAdvanced =
    Boolean(resultWatermark) &&
    (!args.priorWatermark ||
      Date.parse(resultWatermark as string) > Date.parse(args.priorWatermark));
  return {
    state: "current",
    reason: cursorAdvanced ? "cursor_advanced" : "within_threshold",
    checkedAt: args.checkedAt,
    thresholdHours,
    alert: false,
    cursorAt,
    latestSourceAt,
  };
}

function reconciliationFreshness(
  coverage: SourceCoverage[]
): ReconciliationFreshness {
  const staleSourceIds = coverage
    .filter((entry) => entry.freshness.state === "stale")
    .map((entry) => entry.sourceId)
    .sort();
  const unknownSourceIds = coverage
    .filter((entry) => entry.freshness.state === "unknown")
    .map((entry) => entry.sourceId)
    .sort();
  return {
    state:
      staleSourceIds.length > 0
        ? "stale"
        : unknownSourceIds.length > 0
          ? "unknown"
          : "current",
    staleSourceIds,
    unknownSourceIds,
    alertSourceIds: coverage
      .filter((entry) => entry.freshness.alert)
      .map((entry) => entry.sourceId)
      .sort(),
  };
}

function normalizeReviewFreshness(
  review: ReconciliationReview
): ReconciliationReview {
  const coverage = review.coverage.map((entry) =>
    entry.freshness
      ? entry
      : {
          ...entry,
          freshness: {
            state: "unknown" as const,
            reason: "legacy_report" as const,
            checkedAt: entry.checkedAt ?? review.generatedAt,
            thresholdHours: DEFAULT_SOURCE_FRESHNESS_THRESHOLD_HOURS,
            alert: false,
          },
        }
  );
  return {
    ...review,
    coverage,
    freshness: review.freshness ?? reconciliationFreshness(coverage),
    resolutionProofs: review.resolutionProofs ?? [],
    linkedWorkStatuses: review.linkedWorkStatuses ?? [],
    resolvedSignalFamilies: review.resolvedSignalFamilies ?? [],
  };
}

function linkedWorkStatusObservations(
  records: SourceRecord[]
): LinkedWorkStatusObservation[] {
  return records.flatMap((record) => {
    if (
      record.sourceType !== "evidence-export" ||
      typeof record.provenance.terminal !== "boolean"
    ) {
      return [];
    }
    return record.issueRefs.map((issueRef) => ({
      issueRef,
      observedAt: record.observedAt,
      terminal: record.provenance.terminal as boolean,
      sourceId: record.sourceId,
      sourceType: record.sourceType,
      sourceRecordId: record.recordId,
      ...(typeof record.provenance.status === "string"
        ? { status: record.provenance.status }
        : {}),
    }));
  });
}

function persistedLinkedWorkStatusesForConfig(args: {
  config: ReconciliationConfig;
  state: ReconciliationState;
}): NonNullable<ReconciliationState["linkedWorkStatuses"]> {
  const authoritativeSourceIds = new Set(
    args.config.sources.flatMap((source) => {
      const prior = args.state.sources[source.id];
      return source.type === "evidence-export" &&
        prior?.configDigest === sourceStateDigest(source) &&
        prior.adapterVersion === reconciliationAdapterFor(source.type).version
        ? [source.id]
        : [];
    })
  );
  return Object.fromEntries(
    Object.entries(args.state.linkedWorkStatuses ?? {}).filter(
      ([, observation]) => authoritativeSourceIds.has(observation.sourceId)
    )
  );
}

function latestLinkedWorkStatuses(args: {
  config: ReconciliationConfig;
  state: ReconciliationState;
  observations: LinkedWorkStatusObservation[];
}): Map<string, LinkedWorkStatusObservation> {
  const latest = new Map(
    Object.entries(
      persistedLinkedWorkStatusesForConfig({
        config: args.config,
        state: args.state,
      })
    )
  );
  const observationsByIssue = new Map<string, LinkedWorkStatusObservation[]>();
  for (const observation of args.observations) {
    const observations = observationsByIssue.get(observation.issueRef) ?? [];
    observations.push(observation);
    observationsByIssue.set(observation.issueRef, observations);
  }
  for (const [issueRef, observations] of observationsByIssue) {
    const merged = mergeLinkedWorkStatusObservations({
      observations,
      prior: latest.get(issueRef),
    });
    if (merged) {
      latest.set(issueRef, merged);
    }
  }
  return latest;
}

function mergeLinkedWorkStatusObservations(args: {
  observations: LinkedWorkStatusObservation[];
  prior?: LinkedWorkStatusObservation;
}): LinkedWorkStatusObservation | undefined {
  let latest = args.prior;
  const observations = [...args.observations].sort(
    compareLinkedWorkStatusObservations
  );
  for (const observation of observations) {
    if (latest?.ordering === "unknown") {
      if (
        observation.sourceId === latest.sourceId &&
        observation.sourceRecordId === latest.sourceRecordId
      ) {
        latest = observation;
      }
      continue;
    }
    if (
      !latest ||
      compareLinkedWorkStatusObservations(latest, observation) <= 0
    ) {
      latest = observation;
    }
  }
  return latest;
}

function resolutionProofs(records: SourceRecord[]): ResolutionProof[] {
  return records
    .filter((record) => record.provenance.terminal === true)
    .map((record) => ({
      sourceId: record.sourceId,
      sourceType: record.sourceType,
      sourceRecordId: record.recordId,
      observedAt: record.observedAt,
      kind:
        record.sourceType === "git" &&
        record.provenance.onDefaultBranch === true
          ? ("default_branch_containment" as const)
          : ("linked_work_terminal" as const),
      issueRefs: record.issueRefs,
      evidenceKey: record.dedupeKey,
      status:
        typeof record.provenance.status === "string"
          ? record.provenance.status
          : undefined,
      provenance: record.provenance,
    }));
}

function resolvedSignalFamilies(args: {
  config: ReconciliationConfig;
  state: ReconciliationState;
  proofs: ResolutionProof[];
  signals: CorrelatedSignal[];
  linkedWorkStatuses: LinkedWorkStatusObservation[];
}): string[] {
  const latestStatuses = latestLinkedWorkStatuses({
    config: args.config,
    state: args.state,
    observations: args.linkedWorkStatuses,
  });
  const linkedWorkStatusKeys = new Set(
    [...latestStatuses.keys()].map((issueRef) => `issue:${issueRef}`)
  );
  const terminalIssueKeys = new Set(
    [...latestStatuses.entries()]
      .filter(([, observation]) => observation.terminal)
      .map(([issueRef]) => `issue:${issueRef}`)
  );
  const defaultBranchEvidenceKeys = new Set(
    args.proofs
      .filter((proof) => proof.kind === "default_branch_containment")
      .map((proof) => proof.evidenceKey)
  );
  const terminalEvidenceKeys = new Set(
    args.proofs
      .filter((proof) => proof.kind === "linked_work_terminal")
      .map((proof) => proof.evidenceKey)
  );
  return Object.entries(args.state.families ?? {})
    .flatMap(([familyId, family]) => {
      const currentSignals = args.signals.filter(
        (signal) =>
          signal.familyId === familyId ||
          signal.familyAliases?.includes(familyId)
      );
      const linkedIssues = unique([
        ...family.subjectKeys.filter((key) => key.startsWith("issue:")),
        ...currentSignals.flatMap((signal) =>
          signal.issueRefs.map((issueRef) => `issue:${issueRef}`)
        ),
      ]);
      const allLinkedWorkTerminal =
        linkedIssues.length > 0 &&
        linkedIssues.every((key) => terminalIssueKeys.has(key));
      const exactEvidenceOnDefaultBranch = [
        ...family.evidenceKeys,
        ...currentSignals.flatMap((signal) => signal.evidenceKeys),
      ].some((key) => defaultBranchEvidenceKeys.has(key));
      const exactEvidenceTerminal =
        [
          ...family.evidenceKeys,
          ...currentSignals.flatMap((signal) => signal.evidenceKeys),
        ].some((key) => terminalEvidenceKeys.has(key)) &&
        !linkedIssues.some((key) => linkedWorkStatusKeys.has(key));
      return allLinkedWorkTerminal ||
        exactEvidenceOnDefaultBranch ||
        exactEvidenceTerminal
        ? [familyId]
        : [];
    })
    .sort();
}

function isNewDefaultBranchContainment(args: {
  record: SourceRecord;
  state: ReconciliationState;
}): boolean {
  if (
    args.record.sourceType !== "git" ||
    args.record.provenance.onDefaultBranch !== true
  ) {
    return false;
  }
  return !args.state.evidence[
    args.record.dedupeKey
  ]?.defaultBranchContainment?.[args.record.sourceId]?.includes(
    args.record.recordId
  );
}

function renderReview(review: ReconciliationReview): string {
  const coverage = review.coverage.map(
    (entry) =>
      `| ${entry.sourceId} | ${entry.sourceType} | ${entry.state} | ${entry.freshness.state} | ${entry.freshness.reason} | ${entry.recordsScanned} | ${entry.signalsDiscovered} | ${entry.unavailableReason ?? entry.staleReason ?? ""} |`
  );
  const signals = review.signals.flatMap((signal) => [
    `### ${signal.id} — ${signal.title}`,
    "",
    `- Disposition: **${signal.disposition}**${signal.dispositionTarget ? ` → ${signal.dispositionTarget}` : ""}`,
    `- Family: ${signal.familyId}`,
    `- Sources: ${signal.sourceIds.join(", ")}`,
    `- Classification: ${signal.classifications.join(", ")}`,
    `- Linked work: ${signal.issueRefs.join(", ") || "none"}`,
    `- Evidence: ${signal.evidenceKeys.join(", ")}`,
    `- Rationale: ${signal.rationale}`,
    "",
  ]);
  const exclusions = review.decisions
    .filter((decision) => !decision.included)
    .map(
      (decision) =>
        `- ${decision.sourceId}:${decision.sourceRecordId} — ${decision.reason}`
    );
  return [
    "---",
    'artifact: "reconciliation-review"',
    `reviewId: "${review.reviewId}"`,
    `scope: "${review.window.scope}"`,
    `rootDir: ${JSON.stringify(review.window.rootDir)}`,
    ...(review.window.projectRoot
      ? [`projectRoot: ${JSON.stringify(review.window.projectRoot)}`]
      : []),
    `since: "${review.window.since}"`,
    `until: "${review.window.until}"`,
    `coverageComplete: ${review.coverageComplete}`,
    `freshness: "${review.freshness.state}"`,
    `degraded: ${review.degraded}`,
    "---",
    "",
    `# Reconciliation review ${review.reviewId}`,
    "",
    review.emptyReason ??
      `${review.signals.length} correlated signal(s) were discovered.`,
    "",
    "## Source coverage",
    "",
    "| Source | Type | Coverage | Freshness | Freshness reason | Records | Signals | Detail |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ...coverage,
    "",
    "## Signals and dispositions",
    "",
    ...(signals.length > 0 ? signals : ["No correlated signals.", ""]),
    "## Resolution evidence",
    "",
    ...(review.resolvedEvidenceKeys.length > 0
      ? review.resolvedEvidenceKeys.map((key) => `- ${key}`)
      : ["No terminal source evidence was observed."]),
    "",
    "## Excluded records",
    "",
    ...(exclusions.length > 0 ? exclusions : ["No records were excluded."]),
    "",
  ].join("\n");
}

function updateState(args: {
  state: ReconciliationState;
  review: ReconciliationReview;
  adapterResults: Map<string, AdapterScanResult>;
  config: ReconciliationConfig;
  statusConfig: ReconciliationConfig;
}): ReconciliationState {
  const next = structuredClone(args.state);
  for (const coverage of args.review.coverage) {
    const result = args.adapterResults.get(coverage.sourceId);
    const prior = next.sources[coverage.sourceId];
    const source = args.config.sources.find(
      (entry) => entry.id === coverage.sourceId
    );
    if (!source) {
      continue;
    }
    const advances =
      coverage.state === "checked" || coverage.state === "changed";
    const resultWatermark = result?.watermark;
    const keepsPriorWatermark = Boolean(
      advances &&
        prior?.watermark &&
        resultWatermark &&
        Date.parse(prior.watermark) > Date.parse(resultWatermark)
    );
    const keepsPriorCoverage = Boolean(
      prior?.coverageUntil &&
        Date.parse(prior.coverageUntil) > Date.parse(args.review.window.until)
    );
    next.sources[coverage.sourceId] = {
      watermark:
        advances && !keepsPriorWatermark
          ? (resultWatermark ?? prior?.watermark)
          : prior?.watermark,
      cursor:
        advances && !keepsPriorWatermark
          ? (result?.cursor ?? prior?.cursor)
          : prior?.cursor,
      configDigest: sourceStateDigest(source),
      adapterVersion: reconciliationAdapterFor(source.type).version,
      lastCheckedAt: keepsPriorCoverage
        ? (prior?.lastCheckedAt ?? coverage.checkedAt)
        : coverage.checkedAt,
      coverageUntil: keepsPriorCoverage
        ? prior?.coverageUntil
        : args.review.window.until,
      coverageState: keepsPriorCoverage
        ? (prior?.coverageState ?? coverage.state)
        : coverage.state,
      freshnessState: coverage.freshness.state,
    };
  }
  for (const item of args.review.evidence) {
    const prior = next.evidence[item.dedupeKey];
    const sourceRecordIds = structuredClone(prior?.sourceRecordIds ?? {});
    for (const sourceId of item.sourceIds) {
      sourceRecordIds[sourceId] = unique([
        ...(sourceRecordIds[sourceId] ?? []),
        ...args.review.decisions
          .filter(
            (decision) =>
              decision.dedupeKey === item.dedupeKey &&
              decision.sourceId === sourceId
          )
          .map((decision) => decision.sourceRecordId),
      ]);
    }
    const defaultBranchContainment = structuredClone(
      prior?.defaultBranchContainment ?? {}
    );
    for (const proof of args.review.resolutionProofs) {
      if (
        proof.evidenceKey !== item.dedupeKey ||
        proof.kind !== "default_branch_containment"
      ) {
        continue;
      }
      defaultBranchContainment[proof.sourceId] = unique([
        ...(defaultBranchContainment[proof.sourceId] ?? []),
        proof.sourceRecordId,
      ]);
    }
    next.evidence[item.dedupeKey] = {
      firstSeenAt: prior?.firstSeenAt ?? args.review.generatedAt,
      lastSeenAt: args.review.generatedAt,
      sourceIds: unique([...(prior?.sourceIds ?? []), ...item.sourceIds]),
      sourceRecordIds,
      reviewIds: unique([...(prior?.reviewIds ?? []), args.review.reviewId]),
      ...(Object.keys(defaultBranchContainment).length > 0
        ? { defaultBranchContainment }
        : {}),
    };
  }
  const resolutionProofState = next.resolutionProofs ?? {};
  next.resolutionProofs = resolutionProofState;
  const linkedWorkStatusState = persistedLinkedWorkStatusesForConfig({
    config: args.statusConfig,
    state: args.state,
  });
  next.linkedWorkStatuses = linkedWorkStatusState;
  const linkedWorkObservationsByIssue = new Map<
    string,
    LinkedWorkStatusObservation[]
  >();
  for (const observation of args.review.linkedWorkStatuses ?? []) {
    const observations =
      linkedWorkObservationsByIssue.get(observation.issueRef) ?? [];
    observations.push(observation);
    linkedWorkObservationsByIssue.set(observation.issueRef, observations);
  }
  for (const [issueRef, observations] of linkedWorkObservationsByIssue) {
    const merged = mergeLinkedWorkStatusObservations({
      observations,
      prior: linkedWorkStatusState[issueRef],
    });
    if (merged) {
      linkedWorkStatusState[issueRef] = merged;
    }
  }
  for (const proof of args.review.resolutionProofs) {
    const key = sha256(
      `${proof.kind}\n${proof.sourceId}\n${proof.sourceRecordId}\n${proof.evidenceKey}`
    );
    const prior = resolutionProofState[key];
    resolutionProofState[key] = {
      firstSeenAt: prior?.firstSeenAt ?? args.review.generatedAt,
      lastSeenAt: args.review.generatedAt,
      reviewIds: unique([...(prior?.reviewIds ?? []), args.review.reviewId]),
      proof,
    };
    if (proof.kind !== "default_branch_containment") {
      continue;
    }
    const evidence = next.evidence[proof.evidenceKey];
    if (!evidence) {
      continue;
    }
    evidence.defaultBranchContainment ??= {};
    evidence.defaultBranchContainment[proof.sourceId] = unique([
      ...(evidence.defaultBranchContainment[proof.sourceId] ?? []),
      proof.sourceRecordId,
    ]);
  }
  for (const decision of args.review.decisions) {
    next.decisions[decision.id] = {
      included: decision.included,
      classification: decision.classification,
      reason: decision.reason,
      disposition: decision.disposition,
      lastReviewedAt: args.review.generatedAt,
      reviewId: args.review.reviewId,
    };
  }
  const families = next.families ?? {};
  next.families = families;
  for (const signal of args.review.signals) {
    const mergedFamilies = [
      families[signal.familyId],
      ...(signal.familyAliases ?? []).map((familyId) => families[familyId]),
    ].filter((family): family is NonNullable<typeof family> => Boolean(family));
    const prior = families[signal.familyId];
    families[signal.familyId] = {
      firstSeenAt:
        mergedFamilies
          .map((family) => family.firstSeenAt)
          .sort((left, right) => left.localeCompare(right))[0] ??
        args.review.generatedAt,
      lastSeenAt: args.review.generatedAt,
      aliases: unique([
        ...mergedFamilies.flatMap((family) => family.aliases ?? []),
        ...(signal.familyAliases ?? []),
      ]).filter((familyId) => familyId !== signal.familyId),
      subjectKeys: unique([
        ...mergedFamilies.flatMap((family) => family.subjectKeys),
        ...signal.subjectKeys,
      ]),
      evidenceKeys: unique([
        ...mergedFamilies.flatMap((family) => family.evidenceKeys),
        ...signal.evidenceKeys,
      ]),
      reviewIds: unique([
        ...mergedFamilies.flatMap((family) => family.reviewIds),
        args.review.reviewId,
      ]),
      signalIds: unique([
        ...mergedFamilies.flatMap((family) => family.signalIds),
        signal.id,
      ]),
    };
    for (const alias of signal.familyAliases ?? []) {
      delete families[alias];
    }
  }
  next.reviews[args.review.reviewId] = {
    since: args.review.window.since,
    until: args.review.window.until,
    generatedAt: args.review.generatedAt,
    artifactPath: args.review.artifactPath,
    coverageComplete: args.review.coverageComplete,
    freshnessState: args.review.freshness.state,
    evidenceKeys: args.review.evidence.map((item) => item.dedupeKey),
    signalIds: args.review.signals.map((signal) => signal.id),
    signalFamilyIds: unique(
      args.review.signals.map((signal) => signal.familyId)
    ),
  };
  return next;
}

function latestReviewId(state: ReconciliationState): string | undefined {
  return Object.entries(state.reviews).sort(
    ([, left], [, right]) =>
      right.until.localeCompare(left.until) ||
      right.since.localeCompare(left.since) ||
      right.generatedAt.localeCompare(left.generatedAt)
  )[0]?.[0];
}

export async function reconcileSources(args: {
  homeDir: string;
  rootDir: string;
  since: string;
  until?: string;
  configPath?: string;
  sourceIds?: string[];
  incremental?: boolean;
  persist?: boolean;
  /** @internal Adversarial test hook; production callers must not set this. */
  onLockAcquired?: () => void | Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  onStaleClaimInspected?: () => void | Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  onStaleClaimRevalidated?: () => void | Promise<void>;
}): Promise<ReconciliationReview> {
  const { config } = await loadReconciliationConfig(args);
  const enabledSources = config.sources.filter(
    (source) => source.enabled !== false
  );
  const enabledConfig: ReconciliationConfig = {
    version: 1,
    sources: enabledSources,
  };
  const unknownSourceIds = (args.sourceIds ?? []).filter(
    (sourceId) => !enabledSources.some((source) => source.id === sourceId)
  );
  if (unknownSourceIds.length > 0) {
    throw new Error(
      `Unknown or disabled reconciliation source ids: ${unknownSourceIds.join(", ")}`
    );
  }
  const selectedConfig: ReconciliationConfig = {
    version: 1,
    sources: enabledSources.filter(
      (source) => !args.sourceIds?.length || args.sourceIds.includes(source.id)
    ),
  };
  const filteredCoverage =
    selectedConfig.sources.length < enabledSources.length;
  if (selectedConfig.sources.length === 0) {
    throw new Error("No enabled reconciliation sources matched the request");
  }
  const requestedWindow = createWindow({
    config: selectedConfig,
    rootDir: args.rootDir,
    homeDir: args.homeDir,
    since: args.since,
    until: args.until ?? new Date().toISOString(),
    mode: args.incremental ? "incremental" : "window",
  });
  const statePath = facultAiReconciliationStatePath(args.homeDir, args.rootDir);
  const execute = async (): Promise<ReconciliationReview> => {
    const state = await loadState(statePath);
    const effectiveStarts = selectedConfig.sources.map((source) => {
      const priorState = state.sources[source.id];
      const adapter = reconciliationAdapterFor(source.type);
      const prior =
        priorState?.configDigest === sourceStateDigest(source) &&
        priorState.adapterVersion === adapter.version
          ? priorState
          : undefined;
      return boundedIncrementalSince(
        requestedWindow.since,
        prior?.watermark ?? prior?.coverageUntil,
        requestedWindow.until
      );
    });
    const window = args.incremental
      ? createWindow({
          config: selectedConfig,
          rootDir: args.rootDir,
          homeDir: args.homeDir,
          since: effectiveStarts.sort().at(0) ?? requestedWindow.since,
          until: requestedWindow.until,
          mode: "incremental",
        })
      : requestedWindow;
    const windowPath = join(dirname(statePath), "windows", `${window.id}.json`);
    const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
    const checkedAt = new Date().toISOString();
    const coverage: SourceCoverage[] = [];
    const records: SourceRecord[] = [];
    const recheckedResolutionProofs: ResolutionProof[] = [];
    const adapterResults = new Map<string, AdapterScanResult>();
    for (const source of selectedConfig.sources) {
      const priorState = state.sources[source.id];
      const adapter = reconciliationAdapterFor(source.type);
      const sourceDigest = sourceStateDigest(source);
      const prior =
        priorState?.configDigest === sourceDigest &&
        priorState.adapterVersion === adapter.version
          ? priorState
          : undefined;
      const sourceWindow = {
        ...window,
        since: args.incremental
          ? boundedIncrementalSince(
              requestedWindow.since,
              prior?.watermark ?? prior?.coverageUntil,
              requestedWindow.until
            )
          : window.since,
      };
      const result = await adapter.scan({
        config: source,
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        projectRoot,
        window: sourceWindow,
        previousWatermark: prior?.watermark,
        previousCursor: prior?.cursor,
      });
      if (result.watermark && !result.cursor) {
        const lastRecordId = result.records
          .filter((record) => record.observedAt === result.watermark)
          .map((record) => record.recordId)
          .sort()
          .at(-1);
        result.cursor = lastRecordId
          ? `${result.watermark}|${lastRecordId}`
          : result.watermark;
      }
      adapterResults.set(source.id, result);
      if (
        source.type === "git" &&
        projectRoot &&
        result.state !== "unavailable"
      ) {
        const pendingCommits = Object.entries(state.evidence).flatMap(
          ([evidenceKey, evidence]) =>
            (evidence.sourceRecordIds?.[source.id] ?? []).map((recordId) => ({
              evidenceKey,
              recordId,
            }))
        );
        const sourceRecheckedProofs: ResolutionProof[] = [];
        try {
          for (const pending of pendingCommits) {
            const containment = await gitDefaultBranchContainment({
              commit: pending.recordId,
              config: source,
              projectRoot,
            });
            if (!containment.onDefaultBranch) {
              continue;
            }
            sourceRecheckedProofs.push({
              sourceId: source.id,
              sourceType: "git",
              sourceRecordId: pending.recordId,
              kind: "default_branch_containment",
              issueRefs: [],
              evidenceKey: pending.evidenceKey,
              provenance: {
                repository: projectRoot,
                commit: pending.recordId,
                defaultBranch: containment.defaultBranch,
                onDefaultBranch: true,
                terminal: true,
                rechecked: true,
              },
            });
          }
          recheckedResolutionProofs.push(...sourceRecheckedProofs);
        } catch (error) {
          result.state = "unavailable";
          result.records = [];
          result.unavailableReason = `Default-branch containment recheck failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      const reviewRecords = args.incremental
        ? result.records.filter(
            (record) =>
              !(
                prior?.watermark &&
                Date.parse(record.observedAt) <= Date.parse(prior.watermark) &&
                state.evidence[record.dedupeKey]?.sourceIds.includes(
                  source.id
                ) &&
                !isNewDefaultBranchContainment({ record, state })
              )
          )
        : result.records;
      records.push(...reviewRecords);
      const coverageState =
        result.state === "changed" && reviewRecords.length === 0
          ? "checked"
          : result.state;
      coverage.push({
        sourceId: source.id,
        sourceType: source.type,
        state: coverageState,
        checkedAt,
        watermarkBefore: prior?.watermark,
        watermarkAfter: latestTimestampValue(
          prior?.watermark,
          result.watermark
        ),
        cursorBefore: prior?.cursor,
        cursorAfter: result.cursor ?? prior?.cursor,
        recordsScanned: reviewRecords.length,
        signalsDiscovered: 0,
        freshness: sourceFreshness({
          checkedAt,
          until: requestedWindow.until,
          coverageState,
          thresholdHours: source.freshnessThresholdHours,
          priorWatermark: prior?.watermark,
          result,
        }),
        unavailableReason: result.unavailableReason,
        staleReason: result.staleReason,
      });
    }
    const decisions = records.map(extractionDecision);
    const correlated = correlate({ records, decisions, state });
    for (const decision of decisions) {
      const evidence = correlated.evidence.find(
        (item) => item.dedupeKey === decision.dedupeKey
      );
      decision.disposition = evidence?.disposition;
      const coverageEntry = coverage.find(
        (entry) => entry.sourceId === decision.sourceId
      );
      if (decision.included && coverageEntry) {
        coverageEntry.signalsDiscovered += 1;
      }
    }
    const coverageComplete =
      !filteredCoverage &&
      coverage.every(
        (entry) => entry.state === "checked" || entry.state === "changed"
      );
    const degraded =
      filteredCoverage ||
      coverage.some(
        (entry) => entry.state === "unavailable" || entry.state === "stale"
      );
    const freshness = reconciliationFreshness(coverage);
    const reviewDir = facultAiReconciliationReviewDir(
      args.homeDir,
      args.rootDir
    );
    const artifactPath = join(reviewDir, `${window.id}.md`);
    const emptyReason =
      correlated.signals.length > 0
        ? undefined
        : filteredCoverage
          ? "No signals are reported, but the run checked only a filtered source subset; this is not a proven empty review."
          : coverageComplete
            ? "Zero signals discovered after every configured source was checked for this review window."
            : "No signals are reported, but configured coverage is degraded; this is not a proven empty review.";
    const proofs = [...resolutionProofs(records), ...recheckedResolutionProofs];
    const linkedWorkStatuses = linkedWorkStatusObservations(records);
    const review: ReconciliationReview = {
      version: 1,
      reviewId: window.id,
      generatedAt: checkedAt,
      window,
      coverageComplete,
      degraded,
      freshness,
      emptyReason,
      coverage,
      decisions,
      evidence: correlated.evidence,
      signals: correlated.signals,
      resolutionProofs: proofs,
      linkedWorkStatuses,
      resolvedSignalFamilies: resolvedSignalFamilies({
        config: enabledConfig,
        state,
        proofs,
        signals: correlated.signals,
        linkedWorkStatuses,
      }),
      resolvedEvidenceKeys: unique(
        records
          .filter((record) => record.provenance.terminal === true)
          .map((record) => record.dedupeKey)
      ),
      unresolvedSignals: correlated.signals
        .filter((signal) => signal.unresolved)
        .map((signal) => signal.id),
      linkedWork: unique(
        correlated.signals.flatMap((signal) => signal.issueRefs)
      ),
      dispositionCounts: dispositionCounts(correlated.signals),
      artifactPath,
    };
    if (args.persist !== false) {
      await mkdir(reviewDir, { recursive: true });
      const markdown = `${renderReview(review)}\n`;
      await atomicWrite(artifactPath, markdown);
      await atomicWrite(windowPath, `${JSON.stringify(review, null, 2)}\n`);
      const nextState = updateState({
        state,
        review,
        adapterResults,
        config: selectedConfig,
        statusConfig: enabledConfig,
      });
      if (latestReviewId(nextState) === review.reviewId) {
        await atomicWrite(join(reviewDir, "latest.md"), markdown);
      }
      await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    }
    return review;
  };
  return args.persist === false
    ? await execute()
    : await withStateLock(
        facultAiReconciliationLockPath(args.homeDir, args.rootDir),
        execute,
        args.onLockAcquired,
        args.onStaleClaimInspected,
        args.onStaleClaimRevalidated
      );
}

export async function reconciliationStatus(args: {
  homeDir: string;
  rootDir: string;
}): Promise<{
  configured: boolean;
  configurationState: "ready" | "not_configured" | "invalid";
  configurationError?: string;
  stateError?: string;
  configPath: string;
  statePath: string;
  sourceCount: number;
  lastReviewId?: string;
  coverageState?: "complete" | "degraded";
  freshnessState?: ReconciliationFreshness["state"];
}> {
  const statePath = facultAiReconciliationStatePath(args.homeDir, args.rootDir);
  const configPath = join(args.rootDir, "reconciliation.json");
  if (!(await Bun.file(configPath).exists())) {
    return {
      configured: false,
      configurationState: "not_configured",
      configPath,
      statePath,
      sourceCount: 0,
    };
  }
  let loaded: Awaited<ReturnType<typeof loadReconciliationConfig>>;
  try {
    loaded = await loadReconciliationConfig(args);
  } catch (error) {
    return {
      configured: false,
      configurationState: "invalid",
      configurationError:
        error instanceof Error ? error.message : String(error),
      configPath,
      statePath,
      sourceCount: 0,
    };
  }
  const { config, path } = loaded;
  try {
    const state = await loadState(statePath);
    const lastReview = Object.entries(state.reviews).sort(
      ([, left], [, right]) =>
        right.until.localeCompare(left.until) ||
        right.since.localeCompare(left.since) ||
        right.generatedAt.localeCompare(left.generatedAt)
    )[0];
    const enabledSources = config.sources.filter(
      (source) => source.enabled !== false
    );
    const degraded =
      enabledSources.length === 0 ||
      enabledSources.some((source) => {
        const persisted = state.sources[source.id];
        const adapter = reconciliationAdapterFor(source.type);
        return (
          !persisted ||
          persisted.configDigest !== sourceStateDigest(source) ||
          persisted.adapterVersion !== adapter.version ||
          persisted.coverageState === "unavailable" ||
          persisted.coverageState === "stale"
        );
      });
    return {
      configured: true,
      configurationState: "ready",
      configPath: path,
      statePath,
      sourceCount: enabledSources.length,
      lastReviewId: lastReview?.[0],
      coverageState:
        degraded || lastReview?.[1].coverageComplete !== true
          ? "degraded"
          : lastReview
            ? "complete"
            : undefined,
      freshnessState: lastReview?.[1].freshnessState,
    };
  } catch (error) {
    return {
      configured: true,
      configurationState: "ready",
      stateError: error instanceof Error ? error.message : String(error),
      configPath: path,
      statePath,
      sourceCount: config.sources.filter((source) => source.enabled !== false)
        .length,
      coverageState: "degraded",
    };
  }
}

export async function latestReconciliationReview(args: {
  homeDir: string;
  rootDir: string;
}): Promise<ReconciliationReview | null> {
  const statePath = facultAiReconciliationStatePath(args.homeDir, args.rootDir);
  const state = await loadState(statePath);
  const latestId = latestReviewId(state);
  if (!latestId) {
    return null;
  }
  return await reconciliationReviewById({ ...args, reviewId: latestId });
}

export async function reconciliationReviewById(args: {
  homeDir: string;
  rootDir: string;
  reviewId: string;
}): Promise<ReconciliationReview | null> {
  if (!REVIEW_ID_RE.test(args.reviewId)) {
    return null;
  }
  const statePath = facultAiReconciliationStatePath(args.homeDir, args.rootDir);
  const windowPath = join(
    dirname(statePath),
    "windows",
    `${args.reviewId}.json`
  );
  try {
    return normalizeReviewFreshness(
      JSON.parse(await readFile(windowPath, "utf8")) as ReconciliationReview
    );
  } catch {
    return null;
  }
}
