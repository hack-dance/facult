import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { closeSync, constants, fstatSync, readSync } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ScanResult } from "../scan";
import {
  auditReportPersistenceSupported,
  openReadOnlyAt,
  writeExclusiveAt,
} from "./safe-openat";
import {
  type AuditSourceSnapshot,
  assertAuditSourceSnapshot,
  canonicalAuditSourceSnapshot,
  captureStableAuditLexicalPathChain,
  validateAuditSourceSnapshot,
} from "./source-provenance";
import type { AuditFinding, AuditItemResult } from "./types";

export type AuditReportMode = "agent" | "static";

export interface AuditEvaluation<TReport> {
  auditedRoots: string[];
  remediationBindings?: AuditMcpRemediationBinding[];
  report: TReport;
  sourceSnapshot: AuditSourceSnapshot;
}

export const AUDIT_READ_ONLY_CAPABILITY = "audit-read-only-v1";
export const AUDIT_REPORT_REVISION = 11;
export const AUDIT_REPORT_MAX_AGE_MS = 15 * 60 * 1000;
export const AUDIT_REPORT_MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

const PATH_SEGMENT_SPLIT_RE = /[\\/]+/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = [
  "schemaVersion",
  "capability",
  "reportRevision",
  "mode",
  "persistedAt",
  "reportTimestamp",
  "reportSha256",
  "sourceIdentitySha256",
  "sourceSnapshot",
  "findingIdentities",
  "remediationBindings",
] as const;

function permissionBits(mode: number): number {
  return mode % 0o1000;
}

export function auditReportRootPermissionsAreSafe(
  metadata: { mode: number; uid: number },
  expectedOwner: number | undefined = process.getuid?.()
): boolean {
  const permissions = permissionBits(metadata.mode);
  const groupPermissions = Math.floor(permissions / 0o10) % 0o10;
  const otherPermissions = permissions % 0o10;
  const includesWrite = (value: number) => value % 0o4 >= 0o2;
  return (
    expectedOwner !== undefined &&
    metadata.uid === expectedOwner &&
    !includesWrite(groupPermissions) &&
    !includesWrite(otherPermissions)
  );
}

interface PathSemantics {
  parse?(path: string): { root: string };
  relative(from: string, to: string): string;
  sep: string;
}

export interface AuditReportReceipt {
  schemaVersion: 6;
  capability: typeof AUDIT_READ_ONLY_CAPABILITY;
  reportRevision: typeof AUDIT_REPORT_REVISION;
  mode: AuditReportMode;
  persistedAt: string;
  reportTimestamp: string;
  reportSha256: string;
  sourceIdentitySha256: string;
  sourceSnapshot: AuditSourceSnapshot;
  findingIdentities: string[];
  remediationBindings: AuditMcpRemediationBinding[];
}

export interface AuditMcpRemediationBinding {
  canonicalRootPath: string;
  destinationPath: string;
  envKey: string;
  findingIdentity: string;
  kind: "mcp-inline-secret";
  serverName: string;
  sourcePath: string;
}

interface PersistedAuditEnvelope {
  schemaVersion: 1;
  receipt: AuditReportReceipt;
  report: unknown;
}

export interface VerifiedAuditReportEnvelope<TReport> {
  receipt: AuditReportReceipt;
  report: TReport;
}

export interface LoadVerifiedAuditReportArgs {
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeEnvelopeReadChunk?: (bytesRead: number) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeEnvelopeReturn?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeSourceValidation?: () => Promise<void>;
  expectedMode?: AuditReportMode;
  now?: number;
  reportPath: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function auditFindingIdentity(args: {
  finding: AuditFinding;
  result: AuditItemResult;
}): string {
  return sha256(
    stableJson({
      evidence: args.finding.evidence ?? null,
      item: args.result.item,
      location: args.finding.location ?? null,
      message: args.finding.message,
      path: args.result.path,
      ruleId: args.finding.ruleId,
      severity: args.finding.severity,
      sourceId: args.result.sourceId ?? null,
      type: args.result.type,
    })
  );
}

export function auditSnapshotCanonicalPath(
  snapshot: AuditSourceSnapshot,
  pathValue: string
): string {
  const requestedPath = normalize(resolve(pathValue));
  const present = snapshot.requestedPaths.find(
    (entry) => entry.requestedPath === requestedPath
  );
  if (present) {
    return present.canonicalPath;
  }
  const absent = snapshot.absentPaths.find(
    (entry) => entry.requestedPath === requestedPath
  );
  return absent?.path ?? requestedPath;
}

const REMEDIATION_BINDING_KEYS = [
  "canonicalRootPath",
  "destinationPath",
  "envKey",
  "findingIdentity",
  "kind",
  "serverName",
  "sourcePath",
] as const;

function parseInlineSecretLocation(args: {
  configPath: string;
  location: string;
  serverName: string;
}): {
  configPath: string;
  envKey: string;
  serverName: string;
} | null {
  const prefix = `${args.configPath}:${args.serverName}:env:`;
  if (!args.location.startsWith(prefix)) {
    return null;
  }
  const envKey = args.location.slice(prefix.length).trim();
  return envKey
    ? {
        configPath: args.configPath,
        envKey,
        serverName: args.serverName,
      }
    : null;
}

function isSingleSafeSegment(value: string): boolean {
  return (
    !!value &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function assertRemediationBinding(
  binding: unknown,
  receipt: Pick<AuditReportReceipt, "findingIdentities" | "sourceSnapshot">
): asserts binding is AuditMcpRemediationBinding {
  const value = binding as Partial<AuditMcpRemediationBinding> | null;
  if (
    !value ||
    Object.keys(value).join("\0") !== REMEDIATION_BINDING_KEYS.join("\0") ||
    value.kind !== "mcp-inline-secret" ||
    typeof value.canonicalRootPath !== "string" ||
    typeof value.sourcePath !== "string" ||
    typeof value.destinationPath !== "string" ||
    typeof value.serverName !== "string" ||
    typeof value.envKey !== "string" ||
    typeof value.findingIdentity !== "string" ||
    !SHA256_RE.test(value.findingIdentity) ||
    !receipt.findingIdentities.includes(value.findingIdentity) ||
    !isSingleSafeSegment(value.serverName) ||
    !isSingleSafeSegment(value.envKey)
  ) {
    throw new Error("Audit remediation binding is unsupported");
  }
  const root = value.canonicalRootPath;
  const mcpRoot = join(root, "mcp");
  const sourceNames = new Set(["servers.json", "mcp.json"]);
  const destinationNames = new Set(["servers.local.json", "mcp.local.json"]);
  if (
    !isAbsolute(root) ||
    normalize(root) !== root ||
    dirname(value.sourcePath) !== mcpRoot ||
    dirname(value.destinationPath) !== mcpRoot ||
    !sourceNames.has(basename(value.sourcePath)) ||
    !destinationNames.has(basename(value.destinationPath)) ||
    value.sourcePath === value.destinationPath ||
    !receipt.sourceSnapshot.protectedRoots.some(
      (identity) => identity.kind === "directory" && identity.path === root
    ) ||
    !receipt.sourceSnapshot.evaluatedDirectories.some(
      (identity) => identity.path === mcpRoot
    ) ||
    !receipt.sourceSnapshot.evaluatedFiles.some(
      (identity) => identity.path === value.sourcePath
    ) ||
    !(
      receipt.sourceSnapshot.evaluatedFiles.some(
        (identity) => identity.path === value.destinationPath
      ) ||
      receipt.sourceSnapshot.absentPaths.some(
        (identity) => identity.path === value.destinationPath
      )
    )
  ) {
    throw new Error("Audit remediation binding is not source-bound");
  }
}

function canonicalRemediationBindings(
  bindings: readonly AuditMcpRemediationBinding[]
): AuditMcpRemediationBinding[] {
  return bindings
    .map((binding) => ({ ...binding }))
    .sort((left, right) =>
      [
        left.findingIdentity,
        left.sourcePath,
        left.destinationPath,
        left.serverName,
        left.envKey,
      ]
        .join("\0")
        .localeCompare(
          [
            right.findingIdentity,
            right.sourcePath,
            right.destinationPath,
            right.serverName,
            right.envKey,
          ].join("\0")
        )
    );
}

function assertRemediationBindingsMatchReport(args: {
  bindings: readonly AuditMcpRemediationBinding[];
  mode: AuditReportMode;
  report: unknown;
  sourceSnapshot: AuditSourceSnapshot;
}): void {
  if (args.bindings.length === 0) {
    return;
  }
  if (
    args.mode !== "static" ||
    !(args.report && typeof args.report === "object") ||
    !Array.isArray((args.report as { results?: unknown }).results)
  ) {
    throw new Error("Audit remediation bindings do not match the report");
  }
  const expected = new Map<
    string,
    { envKey: string; serverName: string; sourcePath: string }
  >();
  for (const candidate of (args.report as { results: unknown[] }).results) {
    if (!(candidate && typeof candidate === "object")) {
      continue;
    }
    const result = candidate as AuditItemResult;
    if (result.type !== "mcp" || !Array.isArray(result.findings)) {
      continue;
    }
    for (const findingCandidate of result.findings) {
      if (!(findingCandidate && typeof findingCandidate === "object")) {
        continue;
      }
      const finding = findingCandidate as AuditFinding;
      const location = finding.location
        ? parseInlineSecretLocation({
            configPath: result.path,
            location: finding.location,
            serverName: result.item,
          })
        : null;
      if (
        finding.ruleId === "mcp-env-inline-secret" &&
        location &&
        location.configPath === result.path
      ) {
        expected.set(auditFindingIdentity({ finding, result }), {
          envKey: location.envKey,
          serverName: location.serverName,
          sourcePath: auditSnapshotCanonicalPath(
            args.sourceSnapshot,
            result.path
          ),
        });
      }
    }
  }
  for (const binding of args.bindings) {
    const finding = expected.get(binding.findingIdentity);
    if (
      !finding ||
      finding.envKey !== binding.envKey ||
      finding.serverName !== binding.serverName ||
      finding.sourcePath !== binding.sourcePath
    ) {
      throw new Error("Audit remediation bindings do not match the report");
    }
  }
}

export function buildMcpRemediationBindings(args: {
  canonicalRootPath: string;
  report: { results: AuditItemResult[] };
  sourceSnapshot: AuditSourceSnapshot;
}): AuditMcpRemediationBinding[] {
  const canonicalRootPath = auditSnapshotCanonicalPath(
    args.sourceSnapshot,
    args.canonicalRootPath
  );
  const mcpRoot = join(canonicalRootPath, "mcp");
  const requestedMcpRoot = join(normalize(args.canonicalRootPath), "mcp");
  const canonicalDestination = auditSnapshotCanonicalPath(
    args.sourceSnapshot,
    join(requestedMcpRoot, "servers.local.json")
  );
  const legacyDestination = auditSnapshotCanonicalPath(
    args.sourceSnapshot,
    join(requestedMcpRoot, "mcp.local.json")
  );
  const existingPaths = new Set(
    args.sourceSnapshot.evaluatedFiles.map((identity) => identity.path)
  );
  const absentPaths = new Set(
    args.sourceSnapshot.absentPaths.map((identity) => identity.path)
  );
  const destinationPath = existingPaths.has(canonicalDestination)
    ? canonicalDestination
    : existingPaths.has(legacyDestination)
      ? legacyDestination
      : absentPaths.has(canonicalDestination)
        ? canonicalDestination
        : null;
  if (!destinationPath) {
    return [];
  }

  const bindings = args.report.results.flatMap((result) =>
    result.findings.flatMap((finding) => {
      const location = finding.location
        ? parseInlineSecretLocation({
            configPath: result.path,
            location: finding.location,
            serverName: result.item,
          })
        : null;
      const sourcePath = auditSnapshotCanonicalPath(
        args.sourceSnapshot,
        result.path
      );
      if (
        result.type !== "mcp" ||
        finding.ruleId !== "mcp-env-inline-secret" ||
        !location ||
        result.path !== location.configPath ||
        dirname(sourcePath) !== mcpRoot ||
        !["servers.json", "mcp.json"].includes(basename(result.path)) ||
        !existingPaths.has(sourcePath) ||
        !isSingleSafeSegment(location.serverName) ||
        !isSingleSafeSegment(location.envKey)
      ) {
        return [];
      }
      return [
        {
          canonicalRootPath,
          destinationPath,
          envKey: location.envKey,
          findingIdentity: auditFindingIdentity({ finding, result }),
          kind: "mcp-inline-secret" as const,
          serverName: location.serverName,
          sourcePath,
        },
      ];
    })
  );
  const canonical = canonicalRemediationBindings(bindings);
  const receiptShape = {
    findingIdentities: canonicalFindingIdentities(args.report),
    sourceSnapshot: args.sourceSnapshot,
  };
  for (const binding of canonical) {
    assertRemediationBinding(binding, receiptShape);
  }
  return canonical;
}

function canonicalFindingIdentities(report: unknown): string[] {
  if (!(report && typeof report === "object" && !Array.isArray(report))) {
    throw new Error("Audit report schema is unsupported");
  }
  const results = (report as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error("Audit report schema is unsupported");
  }
  const identities = results
    .flatMap((candidate) => {
      if (
        !(
          candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate)
        )
      ) {
        throw new Error("Audit report schema is unsupported");
      }
      const result = candidate as AuditItemResult;
      if (!Array.isArray(result.findings)) {
        throw new Error("Audit report schema is unsupported");
      }
      return result.findings.map((finding) =>
        auditFindingIdentity({ finding, result })
      );
    })
    .sort();
  if (
    identities.some(
      (identity, index) => index > 0 && identity === identities[index - 1]
    )
  ) {
    throw new Error("Audit report contains duplicate finding identities");
  }
  return identities;
}

export function auditPathsOverlap(
  a: string,
  b: string,
  semantics: PathSemantics = { parse, relative, sep }
): boolean {
  const aRoot = semantics.parse?.(a).root;
  const bRoot = semantics.parse?.(b).root;
  if (aRoot && bRoot && aRoot.toLowerCase() !== bRoot.toLowerCase()) {
    return false;
  }
  const aToB = semantics.relative(a, b);
  const bToA = semantics.relative(b, a);
  const contains = (value: string) =>
    value === "" ||
    (!(isAbsolute(value) || value.startsWith(`..${semantics.sep}`)) &&
      value !== "..");
  return contains(aToB) || contains(bToA);
}

function hasTraversalSegment(value: string): boolean {
  return value.split(PATH_SEGMENT_SPLIT_RE).includes("..");
}

async function canonicalExistingPath(
  path: string,
  label: string
): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new Error(`${label} could not be resolved safely: ${path}`);
  }
}

function pathsForSource(source: ScanResult["sources"][number]): string[] {
  const directPaths = [
    ...source.roots,
    ...source.evidence,
    ...source.skills.roots,
    ...source.skills.roots.map(dirname),
    ...source.skills.entries,
    ...source.skills.entries.map((entry) => join(entry, "SKILL.md")),
  ];
  const evaluatedFiles = [
    ...source.mcp.configs.map((config) => config.path),
    ...source.assets.files.map((file) => file.path),
  ];
  return [
    ...directPaths,
    ...evaluatedFiles,
    ...evaluatedFiles.map(dirname),
  ].filter((path) => isAbsolute(path));
}

export function auditedRootsFromScan(scan: ScanResult): string[] {
  return Array.from(
    new Set(scan.sources.flatMap(pathsForSource).map((root) => resolve(root)))
  ).sort();
}

export function parseReportRootFlag(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report-root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--report-root requires an absolute directory path");
      }
      return value;
    }
    if (arg?.startsWith("--report-root=")) {
      const value = arg.slice("--report-root=".length);
      if (!value) {
        throw new Error("--report-root requires an absolute directory path");
      }
      return value;
    }
  }
  return null;
}

function readOnlyDirectoryNoFollowFlags(): number {
  if (!auditReportPersistenceSupported()) {
    throw new Error(
      `Audit report loading is unavailable on ${process.platform}: descriptor-relative reads are unsupported`
    );
  }
  return (
    constants.O_RDONLY +
    (constants.O_NOFOLLOW ?? 0) +
    (constants.O_DIRECTORY ?? 0)
  );
}

async function descriptorCanonicalPath(fd: number): Promise<string> {
  const descriptorPath =
    process.platform === "darwin"
      ? `/dev/fd/${fd}`
      : process.platform === "linux"
        ? `/proc/self/fd/${fd}`
        : null;
  if (!descriptorPath) {
    throw new Error(
      `Audit report loading is unavailable on ${process.platform}: directory descriptor paths are unsupported`
    );
  }
  return await realpath(descriptorPath);
}

interface BoundReportDirectory {
  canonicalPath: string;
  handle: Awaited<ReturnType<typeof open>>;
  lexicalChain: Awaited<ReturnType<typeof captureStableAuditLexicalPathChain>>;
  metadata: Stats;
  requestedPath: string;
}

async function openBoundReportDirectory(
  requestedPath: string,
  beforeOpen?: () => Promise<void>
): Promise<BoundReportDirectory> {
  const lexicalChain = await captureStableAuditLexicalPathChain(requestedPath);
  const pathMetadata = await lstat(requestedPath).catch(() => null);
  if (
    !pathMetadata?.isDirectory() ||
    pathMetadata.isSymbolicLink() ||
    !auditReportRootPermissionsAreSafe(pathMetadata)
  ) {
    throw new Error(
      `Exact audit report directory is missing, linked, or permission-ambiguous: ${requestedPath}`
    );
  }
  const canonicalPath = await canonicalExistingPath(
    requestedPath,
    "Audit report directory"
  );
  await beforeOpen?.();
  const handle = await open(
    requestedPath,
    readOnlyDirectoryNoFollowFlags()
  ).catch(() => null);
  if (!handle) {
    throw new Error(`Exact audit report directory is unsafe: ${requestedPath}`);
  }
  const metadata = await handle.stat().catch(async () => {
    await handle.close().catch(() => undefined);
    return null;
  });
  if (!metadata) {
    throw new Error(`Exact audit report directory is unsafe: ${requestedPath}`);
  }
  const descriptorPath = await descriptorCanonicalPath(handle.fd).catch(
    () => null
  );
  const lexicalAfter = await captureStableAuditLexicalPathChain(
    requestedPath
  ).catch(() => null);
  if (
    !metadata.isDirectory() ||
    metadata.dev !== pathMetadata.dev ||
    metadata.ino !== pathMetadata.ino ||
    metadata.uid !== pathMetadata.uid ||
    metadata.mode !== pathMetadata.mode ||
    metadata.nlink !== pathMetadata.nlink ||
    !auditReportRootPermissionsAreSafe(metadata) ||
    descriptorPath !== canonicalPath ||
    !lexicalAfter ||
    JSON.stringify(lexicalAfter) !== JSON.stringify(lexicalChain)
  ) {
    await handle.close().catch(() => undefined);
    throw new Error("Exact audit report directory changed while it was opened");
  }
  return { canonicalPath, handle, lexicalChain, metadata, requestedPath };
}

async function assertBoundReportDirectory(
  binding: BoundReportDirectory
): Promise<void> {
  const descriptorMetadata = await binding.handle.stat().catch(() => null);
  const pathMetadata = await lstat(binding.requestedPath).catch(() => null);
  const pathCanonical = await realpath(binding.requestedPath).catch(() => null);
  const descriptorPath = await descriptorCanonicalPath(binding.handle.fd).catch(
    () => null
  );
  const lexicalChain = await captureStableAuditLexicalPathChain(
    binding.requestedPath
  ).catch(() => null);
  if (
    !(descriptorMetadata?.isDirectory() && pathMetadata?.isDirectory()) ||
    pathMetadata.isSymbolicLink() ||
    descriptorMetadata.dev !== binding.metadata.dev ||
    descriptorMetadata.ino !== binding.metadata.ino ||
    descriptorMetadata.uid !== binding.metadata.uid ||
    descriptorMetadata.mode !== binding.metadata.mode ||
    descriptorMetadata.nlink !== binding.metadata.nlink ||
    pathMetadata.dev !== binding.metadata.dev ||
    pathMetadata.ino !== binding.metadata.ino ||
    pathMetadata.uid !== binding.metadata.uid ||
    pathMetadata.mode !== binding.metadata.mode ||
    pathMetadata.nlink !== binding.metadata.nlink ||
    !auditReportRootPermissionsAreSafe(descriptorMetadata) ||
    !auditReportRootPermissionsAreSafe(pathMetadata) ||
    pathCanonical !== binding.canonicalPath ||
    descriptorPath !== binding.canonicalPath ||
    !lexicalChain ||
    JSON.stringify(lexicalChain) !== JSON.stringify(binding.lexicalChain)
  ) {
    throw new Error("Exact audit report directory changed while reading");
  }
}

function privateEnvelopeMetadataIsSafe(metadata: Stats): boolean {
  const expectedOwner = process.getuid?.();
  const allocatedBlocks = metadata.blocks * 512;
  return (
    metadata.isFile() &&
    metadata.nlink === 1 &&
    permissionBits(metadata.mode) === 0o600 &&
    expectedOwner !== undefined &&
    metadata.uid === expectedOwner &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size > 0 &&
    metadata.size <= AUDIT_REPORT_MAX_ENVELOPE_BYTES &&
    (metadata.size <= 4096 || allocatedBlocks >= metadata.size)
  );
}

function sameEnvelopeIdentity(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    right.dev === left.dev &&
    right.ino === left.ino &&
    right.uid === left.uid &&
    right.mode === left.mode &&
    right.nlink === left.nlink &&
    right.size === left.size &&
    right.ctimeMs === left.ctimeMs &&
    right.mtimeMs === left.mtimeMs
  );
}

async function assertBoundReportEnvelope(args: {
  directory: BoundReportDirectory;
  fileFd: number;
  fileName: string;
  metadata: Stats;
}): Promise<void> {
  await assertBoundReportDirectory(args.directory);
  const descriptorMetadata = fstatSync(args.fileFd);
  if (
    !(
      privateEnvelopeMetadataIsSafe(descriptorMetadata) &&
      sameEnvelopeIdentity(args.metadata, descriptorMetadata)
    )
  ) {
    throw new Error("Exact audit report envelope changed while reading");
  }
  const currentNameFd = openReadOnlyAt({
    directoryFd: args.directory.handle.fd,
    fileName: args.fileName,
  });
  try {
    const currentNameMetadata = fstatSync(currentNameFd);
    if (
      !(
        privateEnvelopeMetadataIsSafe(currentNameMetadata) &&
        sameEnvelopeIdentity(args.metadata, currentNameMetadata)
      )
    ) {
      throw new Error("Exact audit report envelope name changed while reading");
    }
  } finally {
    closeSync(currentNameFd);
  }
}

function assertReportDirectoryDoesNotOverlap(
  sourceSnapshot: AuditSourceSnapshot,
  outputRoot: string
): void {
  if (
    auditSourcePaths(sourceSnapshot).some((sourcePath) =>
      auditPathsOverlap(sourcePath, outputRoot)
    )
  ) {
    throw new Error("Audit report directory now overlaps an audited source");
  }
}

function auditSourcePaths(sourceSnapshot: AuditSourceSnapshot): string[] {
  return [
    ...sourceSnapshot.protectedRoots.map((source) => source.path),
    ...sourceSnapshot.evaluatedFiles.map((source) => source.path),
    ...sourceSnapshot.evaluatedDirectories.map((source) => source.path),
    ...sourceSnapshot.derivedContexts.map((source) => source.path),
    ...sourceSnapshot.absentPaths.map((proof) => proof.path),
  ];
}

export async function persistAuditReport(args: {
  auditedRoots: string[];
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeDescriptorCommit?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeReportRootOpen?: () => Promise<void>;
  mode: AuditReportMode;
  remediationBindings?: AuditMcpRemediationBinding[];
  report: unknown;
  reportRoot: string;
  sourceSnapshot: AuditSourceSnapshot;
}): Promise<string> {
  if (!auditReportPersistenceSupported()) {
    throw new Error(
      `Audit report persistence is unavailable on ${process.platform}: safe descriptor-relative creation is unsupported`
    );
  }
  if (!isAbsolute(args.reportRoot) || hasTraversalSegment(args.reportRoot)) {
    throw new Error(
      "Audit report root must be an absolute path without traversal segments"
    );
  }

  const reportValue = args.report as {
    mode?: unknown;
    results?: unknown;
    timestamp?: unknown;
  } | null;
  if (
    !reportValue ||
    reportValue.mode !== args.mode ||
    !Array.isArray(reportValue.results) ||
    typeof reportValue.timestamp !== "string"
  ) {
    throw new Error("Audit report provenance does not match its mode");
  }
  const canonicalFindingIdentityList = canonicalFindingIdentities(args.report);
  const reportTimestamp = reportValue.timestamp;
  const parsedReportTimestamp = Date.parse(reportTimestamp);
  if (
    !Number.isFinite(parsedReportTimestamp) ||
    new Date(parsedReportTimestamp).toISOString() !== reportTimestamp
  ) {
    throw new Error(
      "Audit report has no valid timestamp for receipt provenance"
    );
  }
  const reportContents = `${JSON.stringify(args.report, null, 2)}\n`;
  const reportSha256 = sha256(reportContents);

  const requestedRoot = normalize(args.reportRoot);
  const requestedMetadata = await lstat(requestedRoot).catch(() => null);
  if (!requestedMetadata) {
    throw new Error(
      `Audit report root is not fully resolvable: ${args.reportRoot}`
    );
  }
  const reportRootLexicalChain =
    await captureStableAuditLexicalPathChain(requestedRoot);
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(
      `Audit report root must not be a symlink: ${args.reportRoot}`
    );
  }
  if (!requestedMetadata.isDirectory()) {
    throw new Error(
      `Audit report root must be an existing directory: ${args.reportRoot}`
    );
  }
  if (!auditReportRootPermissionsAreSafe(requestedMetadata)) {
    throw new Error(
      `Audit report root ownership or permissions are ambiguous: ${args.reportRoot}`
    );
  }
  try {
    await access(requestedRoot, constants.W_OK);
  } catch {
    throw new Error(
      `Audit report root is not unambiguously writable: ${args.reportRoot}`
    );
  }

  const reportRoot = await canonicalExistingPath(
    requestedRoot,
    "Audit report root"
  );
  assertAuditSourceSnapshot(args.sourceSnapshot);
  const canonicalAuditedRoots = await Promise.all(
    args.auditedRoots.map((root) =>
      canonicalExistingPath(root, "Audited source path")
    )
  );
  const protectedRootPaths = new Set(
    args.sourceSnapshot.protectedRoots.map((source) => source.path)
  );
  const unboundRoot = canonicalAuditedRoots.find(
    (root) => !protectedRootPaths.has(root)
  );
  if (unboundRoot) {
    throw new Error(
      `Audit source snapshot does not bind protected root: ${unboundRoot}`
    );
  }
  const overlap = auditSourcePaths(args.sourceSnapshot).find((sourcePath) =>
    auditPathsOverlap(sourcePath, reportRoot)
  );
  if (overlap) {
    throw new Error(
      `Audit report root overlaps audited source: ${reportRoot} <-> ${overlap}`
    );
  }

  const canonicalSourceSnapshot = canonicalAuditSourceSnapshot(
    args.sourceSnapshot
  );
  const remediationBindings = canonicalRemediationBindings(
    args.remediationBindings ?? []
  );
  const receiptBindingShape = {
    findingIdentities: canonicalFindingIdentityList,
    sourceSnapshot: canonicalSourceSnapshot,
  };
  for (const binding of remediationBindings) {
    assertRemediationBinding(binding, receiptBindingShape);
  }
  assertRemediationBindingsMatchReport({
    bindings: remediationBindings,
    mode: args.mode,
    report: args.report,
    sourceSnapshot: canonicalSourceSnapshot,
  });
  const receipt: AuditReportReceipt = {
    schemaVersion: 6,
    capability: AUDIT_READ_ONLY_CAPABILITY,
    reportRevision: AUDIT_REPORT_REVISION,
    mode: args.mode,
    persistedAt: reportTimestamp,
    reportTimestamp,
    reportSha256,
    sourceIdentitySha256: sha256(stableJson(canonicalSourceSnapshot)),
    sourceSnapshot: canonicalSourceSnapshot,
    findingIdentities: canonicalFindingIdentityList,
    remediationBindings,
  };
  const envelope: PersistedAuditEnvelope = {
    schemaVersion: 1,
    receipt,
    report: args.report,
  };
  const envelopeContents = `${JSON.stringify(envelope, null, 2)}\n`;
  const reportFileName = `${args.mode}-${sha256(envelopeContents)}.json`;
  const reportPath = join(reportRoot, reportFileName);
  if (Buffer.byteLength(envelopeContents) > AUDIT_REPORT_MAX_ENVELOPE_BYTES) {
    throw new Error(
      `Audit report envelope exceeds ${AUDIT_REPORT_MAX_ENVELOPE_BYTES} bytes`
    );
  }

  const reportDirectory = await openBoundReportDirectory(
    requestedRoot,
    args.beforeReportRootOpen
  );
  const directoryHandle = reportDirectory.handle;
  try {
    const openedMetadata = await directoryHandle.stat();
    if (
      !openedMetadata.isDirectory() ||
      openedMetadata.dev !== requestedMetadata.dev ||
      openedMetadata.ino !== requestedMetadata.ino ||
      openedMetadata.uid !== requestedMetadata.uid ||
      openedMetadata.mode !== requestedMetadata.mode ||
      !auditReportRootPermissionsAreSafe(openedMetadata)
    ) {
      throw new Error(
        "Audit report root changed before it could be safely opened"
      );
    }
    await directoryHandle.sync();
    if (args.beforeDescriptorCommit) {
      await validateAuditSourceSnapshot(args.sourceSnapshot);
      await args.beforeDescriptorCommit();
    }
    await validateAuditSourceSnapshot(args.sourceSnapshot);
    const finalMetadata = await lstat(requestedRoot).catch(() => null);
    const finalCanonical = await realpath(requestedRoot).catch(() => null);
    const finalLexicalChain = await captureStableAuditLexicalPathChain(
      requestedRoot
    ).catch(() => null);
    if (
      !finalMetadata?.isDirectory() ||
      finalMetadata.isSymbolicLink() ||
      finalMetadata.dev !== openedMetadata.dev ||
      finalMetadata.ino !== openedMetadata.ino ||
      finalMetadata.uid !== openedMetadata.uid ||
      finalMetadata.mode !== openedMetadata.mode ||
      !auditReportRootPermissionsAreSafe(finalMetadata) ||
      !finalLexicalChain ||
      JSON.stringify(finalLexicalChain) !==
        JSON.stringify(reportRootLexicalChain) ||
      finalCanonical !== reportRoot
    ) {
      throw new Error(
        "Audit report root changed before descriptor-relative commit"
      );
    }
    writeExclusiveAt({
      contents: envelopeContents,
      directoryFd: directoryHandle.fd,
      fileName: reportFileName,
    });
    // The atomic link is the irrevocable commit point. A pre-commit directory
    // sync above proves support; this post-link sync normally makes the entry
    // durable. It cannot be reported as a failed transaction after commit
    // because pathname rollback would reintroduce the races this boundary avoids.
    await directoryHandle.sync().catch(() => undefined);
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }
  return reportPath;
}

function assertReceipt(value: unknown): asserts value is AuditReportReceipt {
  const receipt = value as Partial<AuditReportReceipt> | null;
  if (
    !receipt ||
    Object.keys(receipt).join("\0") !== RECEIPT_KEYS.join("\0") ||
    receipt.schemaVersion !== 6 ||
    receipt.capability !== AUDIT_READ_ONLY_CAPABILITY ||
    receipt.reportRevision !== AUDIT_REPORT_REVISION ||
    (receipt.mode !== "static" && receipt.mode !== "agent") ||
    typeof receipt.persistedAt !== "string" ||
    typeof receipt.reportTimestamp !== "string" ||
    !SHA256_RE.test(receipt.reportSha256 ?? "") ||
    !SHA256_RE.test(receipt.sourceIdentitySha256 ?? "") ||
    !receipt.sourceSnapshot ||
    !Array.isArray(receipt.findingIdentities) ||
    !Array.isArray(receipt.remediationBindings) ||
    receipt.findingIdentities.some(
      (identity) => typeof identity !== "string" || !SHA256_RE.test(identity)
    )
  ) {
    throw new Error("Audit report receipt schema or revision is unsupported");
  }
  const persistedTime = Date.parse(receipt.persistedAt!);
  const reportTime = Date.parse(receipt.reportTimestamp!);
  if (
    !(Number.isFinite(persistedTime) && Number.isFinite(reportTime)) ||
    new Date(persistedTime).toISOString() !== receipt.persistedAt ||
    new Date(reportTime).toISOString() !== receipt.reportTimestamp ||
    receipt.findingIdentities!.some(
      (identity, index) =>
        index > 0 && identity <= receipt.findingIdentities![index - 1]!
    )
  ) {
    throw new Error("Audit report receipt schema or revision is unsupported");
  }
  assertAuditSourceSnapshot(receipt.sourceSnapshot);
  for (const binding of receipt.remediationBindings) {
    assertRemediationBinding(binding, receipt as AuditReportReceipt);
  }
  const canonicalBindings = canonicalRemediationBindings(
    receipt.remediationBindings
  );
  if (
    JSON.stringify(canonicalBindings) !==
      JSON.stringify(receipt.remediationBindings) ||
    new Set(
      receipt.remediationBindings.map((binding) => binding.findingIdentity)
    ).size !== receipt.remediationBindings.length
  ) {
    throw new Error("Audit report receipt schema or revision is unsupported");
  }
}

function canonicalReceipt(receipt: AuditReportReceipt): AuditReportReceipt {
  return {
    schemaVersion: 6,
    capability: receipt.capability,
    reportRevision: receipt.reportRevision,
    mode: receipt.mode,
    persistedAt: receipt.persistedAt,
    reportTimestamp: receipt.reportTimestamp,
    reportSha256: receipt.reportSha256,
    sourceIdentitySha256: receipt.sourceIdentitySha256,
    sourceSnapshot: canonicalAuditSourceSnapshot(receipt.sourceSnapshot),
    findingIdentities: [...receipt.findingIdentities],
    remediationBindings: canonicalRemediationBindings(
      receipt.remediationBindings
    ),
  };
}

function assertEnvelope(
  value: unknown
): asserts value is PersistedAuditEnvelope {
  const envelope = value as Partial<PersistedAuditEnvelope> | null;
  if (
    !envelope ||
    Object.keys(envelope).join("\0") !== "schemaVersion\0receipt\0report" ||
    envelope.schemaVersion !== 1 ||
    !("report" in envelope)
  ) {
    throw new Error("Audit report receipt schema or revision is unsupported");
  }
  assertReceipt(envelope.receipt);
  assertRemediationBindingsMatchReport({
    bindings: envelope.receipt.remediationBindings,
    mode: envelope.receipt.mode,
    report: envelope.report,
    sourceSnapshot: envelope.receipt.sourceSnapshot,
  });
}

function canonicalEnvelopeContents(envelope: PersistedAuditEnvelope): string {
  const canonical: PersistedAuditEnvelope = {
    schemaVersion: 1,
    receipt: canonicalReceipt(envelope.receipt),
    report: envelope.report,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export async function loadVerifiedAuditReportEnvelope<
  TReport extends {
    mode: AuditReportMode;
    timestamp: string;
    results: AuditItemResult[];
  },
>(
  args: LoadVerifiedAuditReportArgs
): Promise<VerifiedAuditReportEnvelope<TReport>> {
  if (!isAbsolute(args.reportPath) || hasTraversalSegment(args.reportPath)) {
    throw new Error(
      "--report requires an exact absolute path without traversal segments"
    );
  }
  const exactPath = normalize(args.reportPath);
  const reportDirectory = await openBoundReportDirectory(dirname(exactPath));
  const fileName = basename(exactPath);
  let reportFd = -1;
  try {
    reportFd = openReadOnlyAt({
      directoryFd: reportDirectory.handle.fd,
      fileName,
    });
    const metadata = fstatSync(reportFd);
    if (!privateEnvelopeMetadataIsSafe(metadata)) {
      throw new Error(
        "Exact audit report envelope must be a private, singly linked regular file"
      );
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      await assertBoundReportEnvelope({
        directory: reportDirectory,
        fileFd: reportFd,
        fileName,
        metadata,
      });
      await args.beforeEnvelopeReadChunk?.(offset);
      await assertBoundReportEnvelope({
        directory: reportDirectory,
        fileFd: reportFd,
        fileName,
        metadata,
      });
      const bytesRead = readSync(
        reportFd,
        bytes,
        offset,
        Math.min(64 * 1024, bytes.length - offset),
        offset
      );
      if (bytesRead <= 0) {
        throw new Error("Exact audit report envelope ended while reading");
      }
      offset += bytesRead;
      await assertBoundReportEnvelope({
        directory: reportDirectory,
        fileFd: reportFd,
        fileName,
        metadata,
      });
    }
    const trailing = Buffer.alloc(1);
    const trailingBytes = readSync(reportFd, trailing, 0, 1, offset);
    if (trailingBytes !== 0) {
      throw new Error("Exact audit report envelope grew while reading");
    }
    await assertBoundReportEnvelope({
      directory: reportDirectory,
      fileFd: reportFd,
      fileName,
      metadata,
    });
    const contents = bytes.toString("utf8");
    let envelopeValue: unknown;
    try {
      envelopeValue = JSON.parse(contents) as unknown;
      assertEnvelope(envelopeValue);
    } catch {
      throw new Error("Audit report receipt schema or revision is unsupported");
    }
    if (canonicalEnvelopeContents(envelopeValue) !== contents) {
      throw new Error("Audit report receipt schema or revision is unsupported");
    }
    const receipt = envelopeValue.receipt;
    const report = envelopeValue.report as TReport;
    const canonicalReportContents = `${JSON.stringify(report, null, 2)}\n`;
    if (sha256(canonicalReportContents) !== receipt.reportSha256) {
      throw new Error("Audit report content hash does not match its receipt");
    }
    if (fileName !== `${receipt.mode}-${sha256(contents)}.json`) {
      throw new Error("Audit report path does not match its content identity");
    }
    if (args.expectedMode && receipt.mode !== args.expectedMode) {
      throw new Error(
        `Expected a ${args.expectedMode} audit report, received ${receipt.mode}`
      );
    }
    if (
      report.mode !== receipt.mode ||
      report.timestamp !== receipt.reportTimestamp ||
      !Array.isArray(report.results)
    ) {
      throw new Error("Audit report provenance does not match its receipt");
    }
    const now = args.now ?? Date.now();
    const reportTime = Date.parse(report.timestamp);
    const persistedTime = Date.parse(receipt.persistedAt);
    if (
      !(Number.isFinite(reportTime) && Number.isFinite(persistedTime)) ||
      reportTime > now + 60_000 ||
      persistedTime > now + 60_000 ||
      now - reportTime > AUDIT_REPORT_MAX_AGE_MS ||
      now - persistedTime > AUDIT_REPORT_MAX_AGE_MS
    ) {
      throw new Error(
        "Audit report receipt is stale or has an invalid timestamp"
      );
    }
    if (
      sha256(stableJson(receipt.sourceSnapshot)) !==
      receipt.sourceIdentitySha256
    ) {
      throw new Error("Audit report source-root identity hash is invalid");
    }
    await assertBoundReportEnvelope({
      directory: reportDirectory,
      fileFd: reportFd,
      fileName,
      metadata,
    });
    assertReportDirectoryDoesNotOverlap(
      receipt.sourceSnapshot,
      reportDirectory.canonicalPath
    );
    await args.beforeSourceValidation?.();
    await assertBoundReportEnvelope({
      directory: reportDirectory,
      fileFd: reportFd,
      fileName,
      metadata,
    });
    assertReportDirectoryDoesNotOverlap(
      receipt.sourceSnapshot,
      reportDirectory.canonicalPath
    );
    await validateAuditSourceSnapshot(receipt.sourceSnapshot);
    await assertBoundReportEnvelope({
      directory: reportDirectory,
      fileFd: reportFd,
      fileName,
      metadata,
    });
    assertReportDirectoryDoesNotOverlap(
      receipt.sourceSnapshot,
      reportDirectory.canonicalPath
    );
    if (
      stableJson(canonicalFindingIdentities(report)) !==
      stableJson(receipt.findingIdentities)
    ) {
      throw new Error(
        "Audit report finding identities do not match its receipt"
      );
    }
    await args.beforeEnvelopeReturn?.();
    await assertBoundReportEnvelope({
      directory: reportDirectory,
      fileFd: reportFd,
      fileName,
      metadata,
    });
    assertReportDirectoryDoesNotOverlap(
      receipt.sourceSnapshot,
      reportDirectory.canonicalPath
    );
    return { receipt, report };
  } finally {
    if (reportFd >= 0) {
      closeSync(reportFd);
    }
    await reportDirectory.handle.close().catch(() => undefined);
  }
}

export async function loadVerifiedAuditReport<
  TReport extends {
    mode: AuditReportMode;
    timestamp: string;
    results: AuditItemResult[];
  },
>(args: LoadVerifiedAuditReportArgs): Promise<TReport> {
  return (await loadVerifiedAuditReportEnvelope<TReport>(args)).report;
}
