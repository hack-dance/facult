import type { WritebackDisposition } from "./ai";

export type ReconciliationSourceType =
  | "writebacks"
  | "git"
  | "evidence-export"
  | "automation"
  | "markdown";

export type SourceCoverageState =
  | "checked"
  | "unavailable"
  | "changed"
  | "stale";

export type SourceFreshnessState =
  | "current"
  | "stale"
  | "unknown"
  | "not_applicable";

export type SourceFreshnessReason =
  | "cursor_advanced"
  | "within_threshold"
  | "threshold_exceeded"
  | "newer_repository_activity"
  | "source_unavailable"
  | "legacy_report"
  | "no_cursor";

export interface SourceFreshness {
  state: SourceFreshnessState;
  reason: SourceFreshnessReason;
  checkedAt: string;
  thresholdHours: number;
  alert: boolean;
  cursorAt?: string;
  latestSourceAt?: string;
}

export interface ReconciliationFreshness {
  state: "current" | "stale" | "unknown";
  staleSourceIds: string[];
  unknownSourceIds: string[];
  alertSourceIds: string[];
}

export type SignalClassification =
  | "implementation-only"
  | "capability-source"
  | "capability-implementation"
  | "outcome-proof"
  | "noise";

interface BaseSourceConfig {
  id: string;
  type: ReconciliationSourceType;
  enabled?: boolean;
  freshnessThresholdHours?: number;
}

export interface WritebackSourceConfig extends BaseSourceConfig {
  type: "writebacks";
  scope?: "context" | "global";
}

export interface GitSourceConfig extends BaseSourceConfig {
  type: "git";
  repository?: "project";
  paths?: string[];
  allBranches?: boolean;
  defaultBranch?: string;
}

export interface EvidenceExportSourceConfig extends BaseSourceConfig {
  type: "evidence-export";
  path: string;
}

export interface FileSourceConfig extends BaseSourceConfig {
  type: "automation" | "markdown";
  root?: "project" | "home";
  paths: string[];
}

export type ReconciliationSourceConfig =
  | WritebackSourceConfig
  | GitSourceConfig
  | EvidenceExportSourceConfig
  | FileSourceConfig;

export interface ReconciliationConfig {
  version: 1;
  sources: ReconciliationSourceConfig[];
}

export interface ReconciliationWindow {
  id: string;
  mode: "window" | "incremental";
  since: string;
  until: string;
  scope: "global" | "project";
  rootDir: string;
  projectRoot?: string;
  configDigest: string;
}

export interface SourceRecord {
  sourceId: string;
  sourceType: ReconciliationSourceType;
  recordId: string;
  dedupeKey: string;
  observedAt: string;
  title: string;
  body: string;
  classification?: SignalClassification;
  assetRefs: string[];
  issueRefs: string[];
  writebackRefs: string[];
  provenance: Record<string, string | string[] | boolean | number | null>;
}

export interface AdapterScanResult {
  state: SourceCoverageState;
  records: SourceRecord[];
  watermark?: string;
  cursor?: string;
  latestSourceAt?: string;
  unavailableReason?: string;
  staleReason?: string;
}

export interface ReconciliationAdapterContext {
  config: ReconciliationSourceConfig;
  homeDir: string;
  rootDir: string;
  projectRoot: string | null;
  window: ReconciliationWindow;
  previousWatermark?: string;
  previousCursor?: string;
}

export interface ReconciliationAdapter {
  readonly type: ReconciliationSourceType;
  readonly version: 1;
  scan(context: ReconciliationAdapterContext): Promise<AdapterScanResult>;
}

export interface SourceCoverage {
  sourceId: string;
  sourceType: ReconciliationSourceType;
  state: SourceCoverageState;
  checkedAt: string;
  watermarkBefore?: string;
  watermarkAfter?: string;
  cursorBefore?: string;
  cursorAfter?: string;
  recordsScanned: number;
  signalsDiscovered: number;
  freshness: SourceFreshness;
  unavailableReason?: string;
  staleReason?: string;
}

export interface ResolutionProof {
  sourceId: string;
  sourceType: ReconciliationSourceType;
  sourceRecordId: string;
  kind: "linked_work_terminal" | "default_branch_containment";
  issueRefs: string[];
  evidenceKey: string;
  status?: string;
  provenance: SourceRecord["provenance"];
}

export interface ExtractionDecision {
  id: string;
  sourceId: string;
  sourceRecordId: string;
  dedupeKey: string;
  included: boolean;
  classification: SignalClassification;
  reason: string;
  correlationKeys: string[];
  disposition?: WritebackDisposition;
}

export interface ReconciledEvidence {
  dedupeKey: string;
  sourceIds: string[];
  sourceRecordIds: string[];
  observedAt: string;
  title: string;
  body: string;
  classification: Exclude<SignalClassification, "noise">;
  assetRefs: string[];
  issueRefs: string[];
  writebackRefs: string[];
  correlationKeys: string[];
  disposition: WritebackDisposition;
  isNew: boolean;
  provenance: SourceRecord["provenance"][];
}

export interface CorrelatedSignal {
  id: string;
  familyId: string;
  familyAliases?: string[];
  subjectKeys: string[];
  title: string;
  evidenceKeys: string[];
  sourceIds: string[];
  classifications: Exclude<SignalClassification, "noise">[];
  assetRefs: string[];
  issueRefs: string[];
  writebackRefs: string[];
  disposition: WritebackDisposition;
  dispositionTarget?: string;
  rationale: string;
  unresolved: boolean;
}

export interface ReconciliationReview {
  version: 1;
  reviewId: string;
  generatedAt: string;
  window: ReconciliationWindow;
  coverageComplete: boolean;
  degraded: boolean;
  freshness: ReconciliationFreshness;
  emptyReason?: string;
  coverage: SourceCoverage[];
  decisions: ExtractionDecision[];
  evidence: ReconciledEvidence[];
  signals: CorrelatedSignal[];
  resolutionProofs: ResolutionProof[];
  resolvedSignalFamilies: string[];
  resolvedEvidenceKeys: string[];
  unresolvedSignals: string[];
  linkedWork: string[];
  dispositionCounts: Record<WritebackDisposition, number>;
  artifactPath: string;
}

export interface ReconciliationState {
  version: 1;
  sources: Record<
    string,
    {
      watermark?: string;
      cursor?: string;
      configDigest: string;
      adapterVersion: number;
      lastCheckedAt: string;
      coverageUntil?: string;
      coverageState: SourceCoverageState;
      freshnessState?: SourceFreshnessState;
    }
  >;
  evidence: Record<
    string,
    {
      firstSeenAt: string;
      lastSeenAt: string;
      sourceIds: string[];
      reviewIds: string[];
    }
  >;
  decisions: Record<
    string,
    {
      included: boolean;
      classification: SignalClassification;
      reason: string;
      disposition?: WritebackDisposition;
      lastReviewedAt: string;
      reviewId: string;
    }
  >;
  families?: Record<
    string,
    {
      firstSeenAt: string;
      lastSeenAt: string;
      aliases?: string[];
      subjectKeys: string[];
      evidenceKeys: string[];
      reviewIds: string[];
      signalIds: string[];
    }
  >;
  reviews: Record<
    string,
    {
      since: string;
      until: string;
      generatedAt: string;
      artifactPath: string;
      coverageComplete?: boolean;
      freshnessState?: ReconciliationFreshness["state"];
      evidenceKeys: string[];
      signalIds: string[];
      signalFamilyIds?: string[];
    }
  >;
}
