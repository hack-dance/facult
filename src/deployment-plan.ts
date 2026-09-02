import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  readSync,
} from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize as normalizePath,
  relative,
  resolve,
} from "node:path";
import { caseFold } from "unicode-case-folding";
import { getAdapter } from "./adapters";
import { openReadOnlyAt, readDirectoryEntriesAt } from "./audit/safe-openat";

declare const FCLT_COMPILED_VERSION: string | undefined;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const SECRET_VARIABLE_RE = /^secret:([A-Z_][A-Z0-9_]*)$/;
const ONE_PASSWORD_REFERENCE_RE = /op:\/\/[A-Za-z0-9._~%/-]+/g;
const SAFE_RELATIVE_SEGMENT_RE = /^[A-Za-z0-9._/-]+$/;
const MARKDOWN_SUFFIX_RE = /\.md$/;
const PATH_SEPARATOR_RE = /[\\/]/;
const DEPLOYMENT_PLAN_SCHEMA_VERSION = 1 as const;
const DEPLOYMENT_STATE_SCHEMA_VERSION = 1 as const;
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DESTINATION_IDENTITY_PREFIX = "physical-path-v3:";
const DESTINATION_COLLISION_KEY_PREFIX =
  "case-folded-path-v2:unicode-case-folding@1.1.1:";
const MAX_PLANNING_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DEPLOYMENT_STATE_RECORD_BYTES = 256 * 1024;
const MAX_DEPLOYMENT_STATE_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_DEPLOYMENT_STATE_RECORDS = 128;

export type DeploymentAssetKind = "instruction" | "snippet";
export type DeploymentOwnerMode = "fclt-owned" | "unowned";

export interface DeploymentLossReport {
  lossless: boolean;
  entries: Array<{
    code: string;
    message: string;
    sourcePath?: string;
  }>;
}

export interface DeploymentTranslation {
  desiredContent: Uint8Array;
  lossReport: DeploymentLossReport;
}

export interface DeploymentStateV1 {
  schemaVersion: 1;
  planSchemaVersion: 1;
  binding: {
    assetCanonicalRef: string;
    destinationCollisionKey: string;
    destinationIdentity: string;
    destinationPath: string;
    tool: string;
    adapterVersion: string;
  };
  desiredHash: string;
  ownerMode: "fclt-owned";
  rollbackTarget:
    | { kind: "absent"; path: string }
    | { kind: "snapshot"; path: string; expectedHash: string };
}

export interface DeploymentPlanV1 {
  schemaVersion: 1;
  planId: string;
  planner: { name: "fclt"; version: string };
  binding: {
    asset: {
      kind: DeploymentAssetKind;
      selector: string;
      canonicalRef: string;
      path: string;
    };
    destination: {
      tool: string;
      root: string;
      relativePath: string;
      path: string;
      collisionKey: string;
      identity: string;
    };
  };
  hashes: {
    source: string;
    current: string | null;
    desired: string;
    state: string | null;
  };
  ownerMode: DeploymentOwnerMode;
  adapter: { id: string; version: string };
  lossReport: DeploymentLossReport;
  secretReferences: Array<
    | { kind: "environment"; name: string }
    | { kind: "one-password"; reference: string }
  >;
  operations: {
    reads: Array<{
      kind:
        | "canonical-source"
        | "current-target"
        | "ownership-directory"
        | "deployment-state"
        | "rollback-snapshot";
      path: string;
      required: boolean;
      expectedHash: string | null;
    }>;
    writes: Array<{
      kind: "rollback-snapshot" | "target" | "deployment-state";
      path: string;
      contentSource:
        | { kind: "path"; path: string }
        | {
            kind: "inline-state";
            serialization: "stable-json-v1";
            state: DeploymentStateV1;
          };
      expectedCurrentHash: string | null;
      desiredHash: string;
    }>;
    removals: Array<{ path: string; expectedHash: string }>;
    nativeCommands: Array<{ argv: string[]; cwd: string }>;
  };
  verificationProbe: {
    kind: "file-sha256";
    path: string;
    expectedHash: string;
  };
  rollbackTarget: DeploymentStateV1["rollbackTarget"];
}

export interface BuildDeploymentPlanOptions {
  adapterVersion: string;
  asset: string;
  canonicalRoot: string;
  destination: string;
  expectedCurrentHash?: string | null;
  expectedSourceHash?: string;
  plannerVersion?: string;
  scope: "global" | "project";
  stateRoot: string;
  targetRoot: string;
  tool: string;
  translation?: DeploymentTranslation;
}

interface ParsedAssetSelector {
  canonicalRef: string;
  kind: DeploymentAssetKind;
  relativePath: string;
  selector: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key]);
  }
  return sorted;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function validateHash(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256_RE.test(normalized)) {
    throw new Error(`${label} must be a sha256:<64 lowercase hex> hash.`);
  }
  return normalized;
}

function validateRelativePath(pathValue: string, label: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  if (
    !normalized ||
    isAbsolute(pathValue) ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    !SAFE_RELATIVE_SEGMENT_RE.test(normalized) ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return normalized;
}

function parseAssetSelector(args: {
  scope: "global" | "project";
  selector: string;
}): ParsedAssetSelector {
  const separator = args.selector.indexOf(":");
  const kind = args.selector.slice(0, separator);
  const rawName = args.selector.slice(separator + 1);
  if (separator <= 0 || (kind !== "instruction" && kind !== "snippet")) {
    throw new Error(
      "--asset must use instruction:<name> or snippet:<relative-path>."
    );
  }
  const safeName = validateRelativePath(rawName, "Asset name");
  const relativeName = safeName.endsWith(".md") ? safeName : `${safeName}.md`;
  const relativePath = `${kind === "instruction" ? "instructions" : "snippets"}/${relativeName}`;
  const prefix = args.scope === "global" ? "@ai" : "@project";
  return {
    canonicalRef: `${prefix}/${relativePath}`,
    kind,
    relativePath,
    selector: `${kind}:${safeName.replace(MARKDOWN_SUFFIX_RE, "")}`,
  };
}

async function assertRootDirectory(
  pathValue: string,
  label: string
): Promise<string> {
  const absolute = resolve(pathValue);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `${label} must be an existing non-symlink directory: ${absolute}`
    );
  }
  return absolute;
}

async function assertContainedPath(args: {
  label: string;
  path: string;
  root: string;
}): Promise<string> {
  const candidate = resolve(args.path);
  const rel = relative(args.root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${args.label} escapes its root: ${candidate}`);
  }

  let cursor = args.root;
  for (const segment of rel.split(PATH_SEPARATOR_RE)) {
    cursor = join(cursor, segment);
    const stat = await lstat(cursor).catch(() => null);
    if (!stat) {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${args.label} traverses a symlink: ${cursor}`);
    }
  }
  return candidate;
}

function validatePersistedAbsolutePath(
  pathValue: string,
  label: string
): string {
  if (
    !pathValue ||
    pathValue.includes("\0") ||
    !isAbsolute(pathValue) ||
    normalizePath(pathValue) !== pathValue
  ) {
    throw new Error(`${label} must be an absolute normalized safe path.`);
  }
  return pathValue;
}

async function canonicalPhysicalPath(
  pathValue: string,
  label: string
): Promise<string> {
  const absolute = validatePersistedAbsolutePath(pathValue, label);
  const missingSegments: string[] = [];
  let cursor = absolute;
  let stat = await lstat(cursor).catch(() => null);
  while (!stat) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`${label} identity cannot be established safely.`);
    }
    missingSegments.unshift(basename(cursor));
    cursor = parent;
    stat = await lstat(cursor).catch(() => null);
  }
  if (
    stat.isSymbolicLink() ||
    (missingSegments.length > 0 && !stat.isDirectory())
  ) {
    throw new Error(`${label} identity cannot be established safely.`);
  }
  let canonicalAncestor: string;
  try {
    canonicalAncestor = await realpath(cursor);
  } catch {
    throw new Error(`${label} identity cannot be established safely.`);
  }
  const canonicalStat = await lstat(canonicalAncestor).catch(() => null);
  if (
    !canonicalStat ||
    canonicalStat.dev !== stat.dev ||
    canonicalStat.ino !== stat.ino
  ) {
    throw new Error(`${label} identity cannot be established safely.`);
  }
  return join(canonicalAncestor, ...missingSegments);
}

interface PhysicalDestinationIdentity {
  collisionKey: string;
  identity: string;
}

function physicalPathIdentities(
  canonicalPath: string
): PhysicalDestinationIdentity {
  const portablePath = canonicalPath.replace(/\\/g, "/").normalize("NFC");
  const foldedPortablePath = caseFold(portablePath).normalize("NFC");
  const pathSemantics = process.platform === "win32" ? "win32" : "posix";
  const losslessPath = Buffer.from(canonicalPath, "utf8").toString("base64url");
  return {
    collisionKey: `${DESTINATION_COLLISION_KEY_PREFIX}${foldedPortablePath}`,
    identity: `${DESTINATION_IDENTITY_PREFIX}${pathSemantics}:${losslessPath}`,
  };
}

async function resolveDestinationIdentity(args: {
  destinationPath: string;
  label: string;
  targetRoot?: string;
}): Promise<PhysicalDestinationIdentity> {
  const canonicalDestination = await canonicalPhysicalPath(
    args.destinationPath,
    args.label
  );
  if (args.targetRoot) {
    const canonicalRoot = await canonicalPhysicalPath(
      args.targetRoot,
      "Target root"
    );
    const rel = relative(canonicalRoot, canonicalDestination);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`${args.label} escapes its physical root.`);
    }
  }
  return physicalPathIdentities(canonicalDestination);
}

interface StableReadInterlock {
  afterOpen?: () => Promise<void>;
}

interface StableRegularFileReadArgs {
  expectedIdentity?: string;
  interlock?: StableReadInterlock;
  label: string;
  path: string;
  root: string;
}

function isErrnoException(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === code
  );
}

function stableStatMatches(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function stableFileIdentityMatches(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableReadFlags(): number {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error(
      "Safe descriptor reads are unsupported on this platform: O_NOFOLLOW is unavailable."
    );
  }
  const nonBlocking =
    typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  const extendedConstants = constants as typeof constants & {
    O_CLOEXEC?: number;
  };
  const closeOnExec =
    typeof extendedConstants.O_CLOEXEC === "number"
      ? extendedConstants.O_CLOEXEC
      : 0;
  return constants.O_RDONLY + noFollow + nonBlocking + closeOnExec;
}

function stableDirectoryFlags(): number {
  const directory = constants.O_DIRECTORY;
  const noFollow = constants.O_NOFOLLOW;
  if (
    typeof directory !== "number" ||
    directory === 0 ||
    typeof noFollow !== "number" ||
    noFollow === 0
  ) {
    throw new Error(
      "Safe deployment-state directory scans are unsupported on this platform."
    );
  }
  const extendedConstants = constants as typeof constants & {
    O_CLOEXEC?: number;
  };
  const closeOnExec = extendedConstants.O_CLOEXEC ?? 0;
  return constants.O_RDONLY + directory + noFollow + closeOnExec;
}

function readDirectoryEntriesFromDescriptor(args: {
  directory: string;
  handle: FileHandle;
}): string[] {
  const entries = readDirectoryEntriesAt({
    directoryFd: args.handle.fd,
    maxEntries: MAX_DEPLOYMENT_STATE_RECORDS + 1,
  }).map((entry) => entry.name);
  for (const entry of entries) {
    if (
      !entry ||
      entry.includes("\0") ||
      entry.includes("/") ||
      entry.includes("\\") ||
      entry.includes("\uFFFD")
    ) {
      throw new Error(
        `Unsafe entry in deployment state directory: ${args.directory}`
      );
    }
  }
  if (entries.length > MAX_DEPLOYMENT_STATE_RECORDS) {
    throw new Error(
      `Deployment state directory exceeds the ${MAX_DEPLOYMENT_STATE_RECORDS}-record limit.`
    );
  }
  return entries;
}

function assertStableRegularFileStat(
  stat: BigIntStats,
  label: string,
  maxBytes = MAX_PLANNING_FILE_BYTES
): number {
  if (!stat.isFile() || stat.ino <= 0n || stat.dev < 0n) {
    throw new Error(
      `${label} must expose a stable regular-file identity for planning.`
    );
  }
  if (stat.size < 0n || stat.size > BigInt(maxBytes)) {
    throw new Error(
      `${label} exceeds the ${maxBytes}-byte planning read limit.`
    );
  }
  return Number(stat.size);
}

async function readDescriptorBytes(args: {
  handle: FileHandle;
  label: string;
  size: number;
}): Promise<Uint8Array> {
  const bytes = Buffer.alloc(args.size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await args.handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset
    );
    if (result.bytesRead === 0) {
      throw new Error(`${args.label} changed while it was being read.`);
    }
    offset += result.bytesRead;
  }
  const extra = Buffer.alloc(1);
  const trailing = await args.handle.read(extra, 0, 1, args.size);
  if (trailing.bytesRead !== 0) {
    throw new Error(`${args.label} changed while it was being read.`);
  }
  return bytes;
}

function readRawDescriptorBytes(args: {
  descriptor: number;
  label: string;
  size: number;
}): Uint8Array {
  const bytes = Buffer.alloc(args.size);
  let offset = 0;
  while (offset < bytes.length) {
    const bytesRead = readSync(
      args.descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset
    );
    if (bytesRead === 0) {
      throw new Error(`${args.label} changed while it was being read.`);
    }
    offset += bytesRead;
  }
  const extra = Buffer.alloc(1);
  if (readSync(args.descriptor, extra, 0, 1, args.size) !== 0) {
    throw new Error(`${args.label} changed while it was being read.`);
  }
  return bytes;
}

async function verifyStableReadPath(args: {
  descriptorStat: BigIntStats;
  expectedIdentity?: string;
  label: string;
  path: string;
  root: string;
}): Promise<void> {
  const pathStat = await lstat(args.path, { bigint: true }).catch(() => null);
  if (
    !pathStat?.isFile() ||
    pathStat.isSymbolicLink() ||
    !stableFileIdentityMatches(args.descriptorStat, pathStat)
  ) {
    throw new Error(`${args.label} path changed during planning.`);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(args.path);
  } catch {
    throw new Error(`${args.label} path changed during planning.`);
  }
  const canonicalRoot = await canonicalPhysicalPath(
    args.root,
    `${args.label} root`
  );
  const rel = relative(canonicalRoot, canonicalPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${args.label} escapes its physical root.`);
  }
  const canonicalStat = await lstat(canonicalPath, { bigint: true }).catch(
    () => null
  );
  if (
    !(
      canonicalStat?.isFile() &&
      stableFileIdentityMatches(args.descriptorStat, canonicalStat)
    )
  ) {
    throw new Error(`${args.label} path changed during planning.`);
  }
  if (
    args.expectedIdentity &&
    physicalPathIdentities(canonicalPath).identity !== args.expectedIdentity
  ) {
    throw new Error(`${args.label} physical identity changed during planning.`);
  }
}

async function verifyStableDirectoryPath(args: {
  descriptorStat: BigIntStats;
  directory: string;
  root: string;
}): Promise<void> {
  const pathStat = await lstat(args.directory, { bigint: true }).catch(
    () => null
  );
  if (
    !pathStat?.isDirectory() ||
    pathStat.isSymbolicLink() ||
    !stableFileIdentityMatches(args.descriptorStat, pathStat)
  ) {
    throw new Error("Deployment state directory changed during planning.");
  }
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(args.directory);
  } catch {
    throw new Error("Deployment state directory changed during planning.");
  }
  const canonicalRoot = await canonicalPhysicalPath(
    args.root,
    "Deployment state root"
  );
  const rel = relative(canonicalRoot, canonicalDirectory);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Deployment state directory escapes its physical root.");
  }
  const canonicalStat = await lstat(canonicalDirectory, {
    bigint: true,
  }).catch(() => null);
  if (
    !(
      canonicalStat?.isDirectory() &&
      stableFileIdentityMatches(args.descriptorStat, canonicalStat)
    )
  ) {
    throw new Error("Deployment state directory changed during planning.");
  }
}

async function readAnchoredRegularFile(args: {
  directory: string;
  directoryHandle: FileHandle;
  entry: string;
  root: string;
}): Promise<Uint8Array> {
  const label = "Deployment state";
  let descriptor: number;
  try {
    descriptor = openReadOnlyAt({
      directoryFd: args.directoryHandle.fd,
      fileName: args.entry,
    });
  } catch {
    throw new Error(
      `${label} must be openable through its anchored directory as a regular non-symlink file.`
    );
  }
  const path = join(args.directory, args.entry);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const size = assertStableRegularFileStat(
      before,
      label,
      MAX_DEPLOYMENT_STATE_RECORD_BYTES
    );
    const firstRead = readRawDescriptorBytes({ descriptor, label, size });
    const middle = fstatSync(descriptor, { bigint: true });
    if (!stableStatMatches(before, middle)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    const secondRead = readRawDescriptorBytes({ descriptor, label, size });
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !(
        stableStatMatches(middle, after) &&
        Buffer.from(firstRead).equals(secondRead)
      )
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }
    await verifyStableReadPath({
      descriptorStat: after,
      label,
      path,
      root: args.root,
    });
    return firstRead;
  } finally {
    closeSync(descriptor);
  }
}

async function readRegularFileOrNull(
  args: StableRegularFileReadArgs
): Promise<Uint8Array | null> {
  let handle: FileHandle;
  try {
    handle = await open(args.path, stableReadFlags());
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return null;
    }
    throw new Error(
      `${args.label} must be openable as a regular non-symlink file.`
    );
  }

  try {
    const before = await handle.stat({ bigint: true });
    const size = assertStableRegularFileStat(before, args.label);
    await args.interlock?.afterOpen?.();
    const firstRead = await readDescriptorBytes({
      handle,
      label: args.label,
      size,
    });
    const middle = await handle.stat({ bigint: true });
    if (!stableStatMatches(before, middle)) {
      throw new Error(`${args.label} changed while it was being read.`);
    }
    const secondRead = await readDescriptorBytes({
      handle,
      label: args.label,
      size,
    });
    const after = await handle.stat({ bigint: true });
    if (
      !(
        stableStatMatches(middle, after) &&
        Buffer.from(firstRead).equals(secondRead)
      )
    ) {
      throw new Error(`${args.label} changed while it was being read.`);
    }
    await verifyStableReadPath({
      descriptorStat: after,
      expectedIdentity: args.expectedIdentity,
      label: args.label,
      path: args.path,
      root: args.root,
    });
    return firstRead;
  } finally {
    await handle.close();
  }
}

/** Read one bounded regular file without following links or accepting an unstable snapshot. */
export async function readStableRegularFile(args: {
  label: string;
  path: string;
  root: string;
}): Promise<Uint8Array | null> {
  return await readRegularFileOrNull(args);
}

/** Deterministic seam for descriptor replacement and symlink-race tests. */
export async function readStableRegularFileForTest(args: {
  afterOpen: () => Promise<void>;
  label: string;
  path: string;
  root: string;
}): Promise<Uint8Array | null> {
  return await readRegularFileOrNull({
    interlock: { afterOpen: args.afterOpen },
    label: args.label,
    path: args.path,
    root: args.root,
  });
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} must contain valid UTF-8 text.`);
  }
}

function collectSecretReferences(
  text: string
): DeploymentPlanV1["secretReferences"] {
  const references: DeploymentPlanV1["secretReferences"] = [];
  const environmentNames = new Set<string>();
  const onePasswordReferences = new Set<string>();

  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("${", cursor);
    if (start < 0) {
      break;
    }
    const end = text.indexOf("}", start + 2);
    if (end < 0) {
      throwInterpolationError(text, start);
    }
    const expression = text.slice(start + 2, end);
    const secret = SECRET_VARIABLE_RE.exec(expression);
    if (!secret?.[1]) {
      throwInterpolationError(text, start);
    }
    environmentNames.add(secret[1]);
    cursor = end + 1;
  }
  for (const match of text.matchAll(ONE_PASSWORD_REFERENCE_RE)) {
    if (match[0]) {
      onePasswordReferences.add(match[0]);
    }
  }
  for (const name of [...environmentNames].sort()) {
    references.push({ kind: "environment", name });
  }
  for (const reference of [...onePasswordReferences].sort()) {
    references.push({ kind: "one-password", reference });
  }
  return references;
}

function throwInterpolationError(text: string, offset: number): never {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = offset - lastNewline;
  throw new Error(
    `Invalid interpolation at line ${line}, column ${column} (expression redacted).`
  );
}

function parseDeploymentState(args: {
  bytes: Uint8Array;
  path: string;
}): DeploymentStateV1 {
  validatePersistedAbsolutePath(args.path, "Deployment state record path");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(args.bytes, "Deployment state")) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("valid UTF-8")) {
      throw error;
    }
    throw new Error(`Deployment state is corrupt JSON: ${args.path}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Deployment state is corrupt: ${args.path}`);
  }
  if (parsed.schemaVersion !== DEPLOYMENT_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported deployment state version: ${String(parsed.schemaVersion)}`
    );
  }
  if (
    !hasExactKeys(parsed, [
      "schemaVersion",
      "planSchemaVersion",
      "binding",
      "desiredHash",
      "ownerMode",
      "rollbackTarget",
    ]) ||
    parsed.planSchemaVersion !== DEPLOYMENT_PLAN_SCHEMA_VERSION ||
    parsed.ownerMode !== "fclt-owned" ||
    typeof parsed.desiredHash !== "string" ||
    !SHA256_RE.test(parsed.desiredHash) ||
    !isPlainObject(parsed.binding) ||
    !hasExactKeys(parsed.binding, [
      "assetCanonicalRef",
      "destinationCollisionKey",
      "destinationIdentity",
      "destinationPath",
      "tool",
      "adapterVersion",
    ]) ||
    typeof parsed.binding.assetCanonicalRef !== "string" ||
    !parsed.binding.assetCanonicalRef ||
    typeof parsed.binding.destinationCollisionKey !== "string" ||
    !parsed.binding.destinationCollisionKey.startsWith(
      DESTINATION_COLLISION_KEY_PREFIX
    ) ||
    parsed.binding.destinationCollisionKey.length ===
      DESTINATION_COLLISION_KEY_PREFIX.length ||
    typeof parsed.binding.destinationIdentity !== "string" ||
    !parsed.binding.destinationIdentity.startsWith(
      DESTINATION_IDENTITY_PREFIX
    ) ||
    parsed.binding.destinationIdentity.length ===
      DESTINATION_IDENTITY_PREFIX.length ||
    typeof parsed.binding.destinationPath !== "string" ||
    typeof parsed.binding.tool !== "string" ||
    !parsed.binding.tool ||
    typeof parsed.binding.adapterVersion !== "string" ||
    !parsed.binding.adapterVersion ||
    !isPlainObject(parsed.rollbackTarget)
  ) {
    throw new Error(`Deployment state is corrupt: ${args.path}`);
  }
  const destinationPath = validatePersistedAbsolutePath(
    parsed.binding.destinationPath,
    "Persisted destination path"
  );
  const rollback = parsed.rollbackTarget;
  let rollbackTarget: DeploymentStateV1["rollbackTarget"] | null = null;
  if (typeof rollback.path === "string") {
    const rollbackPath = validatePersistedAbsolutePath(
      rollback.path,
      "Persisted rollback path"
    );
    if (
      rollback.kind === "absent" &&
      hasExactKeys(rollback, ["kind", "path"]) &&
      rollbackPath === destinationPath
    ) {
      rollbackTarget = { kind: "absent", path: rollbackPath };
    } else if (
      rollback.kind === "snapshot" &&
      hasExactKeys(rollback, ["kind", "path", "expectedHash"]) &&
      typeof rollback.expectedHash === "string" &&
      SHA256_RE.test(rollback.expectedHash)
    ) {
      rollbackTarget = {
        expectedHash: rollback.expectedHash,
        kind: "snapshot",
        path: rollbackPath,
      };
    }
  }
  if (!rollbackTarget) {
    throw new Error(
      `Deployment state has an invalid or escaped rollback target: ${args.path}`
    );
  }
  return {
    binding: {
      adapterVersion: parsed.binding.adapterVersion,
      assetCanonicalRef: parsed.binding.assetCanonicalRef,
      destinationCollisionKey: parsed.binding.destinationCollisionKey,
      destinationIdentity: parsed.binding.destinationIdentity,
      destinationPath,
      tool: parsed.binding.tool,
    },
    desiredHash: parsed.desiredHash,
    ownerMode: "fclt-owned",
    planSchemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    rollbackTarget,
    schemaVersion: DEPLOYMENT_STATE_SCHEMA_VERSION,
  };
}

function destinationOwnershipId(
  binding: Pick<DeploymentStateV1["binding"], "destinationIdentity" | "tool">
): string {
  return createHash("sha256")
    .update(
      stableJson({
        destinationIdentity: binding.destinationIdentity,
        tool: binding.tool,
      })
    )
    .digest("hex")
    .slice(0, 24);
}

export function serializeDeploymentState(state: DeploymentStateV1): string {
  return `${stableJson(state)}\n`;
}

interface ScannedDeploymentState {
  hash: string;
  path: string;
  physicalIdentity: PhysicalDestinationIdentity;
  state: DeploymentStateV1;
}

async function scanDeploymentStates(args: {
  afterEnumerationForTest?: () => Promise<void>;
  directory: string;
  expectedPath: string;
  requestedBinding: DeploymentStateV1["binding"];
  stateRoot: string;
}): Promise<{
  directoryHash: string | null;
  existing: ScannedDeploymentState | null;
  records: ScannedDeploymentState[];
}> {
  const directoryFlags = stableDirectoryFlags();
  let initialPathStat: BigIntStats | null;
  try {
    initialPathStat = await lstat(args.directory, { bigint: true });
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      throw new Error(
        `Deployment state directory cannot be inspected safely: ${args.directory}`
      );
    }
    initialPathStat = null;
  }
  if (!initialPathStat) {
    return { directoryHash: null, existing: null, records: [] };
  }
  if (!initialPathStat.isDirectory() || initialPathStat.isSymbolicLink()) {
    throw new Error(
      `Deployment state directory must be a non-symlink directory: ${args.directory}`
    );
  }

  const records: ScannedDeploymentState[] = [];
  const rawRecords: Array<{ bytes: Uint8Array; path: string }> = [];
  let directoryHandle: FileHandle;
  try {
    directoryHandle = await open(args.directory, directoryFlags);
  } catch {
    throw new Error(
      `Deployment state directory must be openable as a non-symlink directory: ${args.directory}`
    );
  }
  try {
    const descriptorStat = await directoryHandle.stat({ bigint: true });
    if (
      !(
        descriptorStat.isDirectory() &&
        stableStatMatches(initialPathStat, descriptorStat)
      )
    ) {
      throw new Error("Deployment state directory changed during planning.");
    }
    await verifyStableDirectoryPath({
      descriptorStat,
      directory: args.directory,
      root: args.stateRoot,
    });
    const entries = readDirectoryEntriesFromDescriptor({
      directory: args.directory,
      handle: directoryHandle,
    });
    await args.afterEnumerationForTest?.();
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        throw new Error(
          `Unexpected entry in deployment state directory: ${join(args.directory, entry)}`
        );
      }
      const path = join(args.directory, entry);
      const bytes = await readAnchoredRegularFile({
        directory: args.directory,
        directoryHandle,
        entry,
        root: args.directory,
      });
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_DEPLOYMENT_STATE_TOTAL_BYTES) {
        throw new Error(
          `Deployment state records exceed the ${MAX_DEPLOYMENT_STATE_TOTAL_BYTES}-byte aggregate limit.`
        );
      }
      rawRecords.push({ bytes, path });
    }

    const afterEntries = readDirectoryEntriesFromDescriptor({
      directory: args.directory,
      handle: directoryHandle,
    });
    const afterStat = await directoryHandle.stat({ bigint: true });
    if (
      !stableStatMatches(descriptorStat, afterStat) ||
      stableJson(entries) !== stableJson(afterEntries)
    ) {
      throw new Error("Deployment state directory changed during planning.");
    }
    await verifyStableDirectoryPath({
      descriptorStat: afterStat,
      directory: args.directory,
      root: args.stateRoot,
    });
  } finally {
    await directoryHandle.close();
  }

  for (const { bytes, path } of rawRecords) {
    const state = parseDeploymentState({ bytes, path });
    const physicalIdentity = await resolveDestinationIdentity({
      destinationPath: state.binding.destinationPath,
      label: "Recorded deployment destination",
    });
    if (
      physicalIdentity.identity !== state.binding.destinationIdentity ||
      physicalIdentity.collisionKey !== state.binding.destinationCollisionKey
    ) {
      throw new Error(
        `Deployment state has a corrupt destination identity: ${path}`
      );
    }
    if (state.rollbackTarget.kind === "snapshot") {
      await assertContainedPath({
        label: "Recorded rollback snapshot",
        path: state.rollbackTarget.path,
        root: args.stateRoot,
      });
    }
    records.push({
      hash: sha256(bytes),
      path,
      physicalIdentity,
      state,
    });
  }

  const collisionSet = records.filter(
    (record) =>
      record.state.binding.tool === args.requestedBinding.tool &&
      record.physicalIdentity.collisionKey ===
        args.requestedBinding.destinationCollisionKey
  );
  const claims = collisionSet.filter(
    (record) =>
      record.physicalIdentity.identity ===
      args.requestedBinding.destinationIdentity
  );
  if (collisionSet.length !== claims.length) {
    throw new Error(
      "Case-folded destination collision is ambiguous across distinct physical paths."
    );
  }
  if (claims.length > 1) {
    throw new Error(
      "Conflicting deployment ownership claims exist for the destination."
    );
  }
  const existing = claims[0] ?? null;
  const recordAtAuthoritativePath = records.find(
    (record) => record.path === args.expectedPath
  );
  if (recordAtAuthoritativePath && !existing) {
    throw new Error(
      "Authoritative destination state path is occupied by an orphaned ownership claim."
    );
  }
  if (existing && existing.path !== args.expectedPath) {
    throw new Error(
      "Orphaned deployment ownership claim exists outside the authoritative destination state path."
    );
  }
  if (
    existing &&
    (existing.state.binding.assetCanonicalRef !==
      args.requestedBinding.assetCanonicalRef ||
      existing.state.binding.adapterVersion !==
        args.requestedBinding.adapterVersion)
  ) {
    throw new Error(
      "Destination ownership transfer requires a future explicit migration/transfer command; implicit transfer is not supported."
    );
  }

  const manifest = records.map((record) => ({
    hash: record.hash,
    path: record.path,
  }));
  return {
    directoryHash: sha256(stableJson(manifest)),
    existing,
    records,
  };
}

/** Deterministic seam for deployment-state directory replacement tests. */
export async function scanDeploymentStateDirectoryForTest(args: {
  afterEnumeration: () => Promise<void>;
  directory: string;
  expectedPath: string;
  requestedBinding: DeploymentStateV1["binding"];
  stateRoot: string;
}): Promise<void> {
  await scanDeploymentStates({
    afterEnumerationForTest: args.afterEnumeration,
    directory: args.directory,
    expectedPath: args.expectedPath,
    requestedBinding: args.requestedBinding,
    stateRoot: args.stateRoot,
  });
}

async function authoritativePlannerVersion(
  explicitVersion?: string
): Promise<string> {
  let authoritative: unknown =
    typeof FCLT_COMPILED_VERSION === "string"
      ? FCLT_COMPILED_VERSION
      : undefined;
  if (authoritative === undefined) {
    const packagePath = resolve(import.meta.dir, "..", "package.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
    } catch {
      throw new Error("Authoritative fclt planner version is unavailable.");
    }
    authoritative = isPlainObject(parsed) ? parsed.version : undefined;
  }
  if (
    typeof authoritative !== "string" ||
    !PACKAGE_VERSION_RE.test(authoritative)
  ) {
    throw new Error("Authoritative fclt planner version is invalid.");
  }
  if (
    explicitVersion !== undefined &&
    (!PACKAGE_VERSION_RE.test(explicitVersion) ||
      explicitVersion !== authoritative)
  ) {
    throw new Error(
      "Explicit planner version does not match the authoritative fclt version."
    );
  }
  return authoritative;
}

export async function buildDeploymentPlan(
  options: BuildDeploymentPlanOptions
): Promise<Readonly<DeploymentPlanV1>> {
  if (options.tool !== "codex") {
    throw new Error(`Unsupported deployment tool: ${options.tool}`);
  }
  const adapter = getAdapter(options.tool);
  if (!(adapter && adapter.versions.includes(options.adapterVersion))) {
    throw new Error(
      `Unsupported ${options.tool} adapter version: ${options.adapterVersion}`
    );
  }

  const canonicalRoot = await assertRootDirectory(
    options.canonicalRoot,
    "Canonical root"
  );
  const targetRoot = await assertRootDirectory(
    options.targetRoot,
    "Target root"
  );
  const stateRoot = await assertRootDirectory(options.stateRoot, "State root");
  const asset = parseAssetSelector({
    scope: options.scope,
    selector: options.asset,
  });
  const sourcePath = await assertContainedPath({
    label: "Canonical source path",
    path: join(canonicalRoot, asset.relativePath),
    root: canonicalRoot,
  });
  const sourceBytes = await readRegularFileOrNull({
    label: "Canonical source",
    path: sourcePath,
    root: canonicalRoot,
  });
  if (!sourceBytes) {
    throw new Error(`Canonical source does not exist: ${sourcePath}`);
  }
  const sourceHash = sha256(sourceBytes);
  if (
    options.expectedSourceHash &&
    validateHash(options.expectedSourceHash, "Expected source hash") !==
      sourceHash
  ) {
    throw new Error(
      "Stale source hash: canonical source changed before planning."
    );
  }

  const destinationRelativePath = validateRelativePath(
    options.destination,
    "Destination"
  );
  const destinationPath = await assertContainedPath({
    label: "Destination path",
    path: join(targetRoot, destinationRelativePath),
    root: targetRoot,
  });
  const {
    collisionKey: destinationCollisionKey,
    identity: destinationIdentity,
  } = await resolveDestinationIdentity({
    destinationPath,
    label: "Destination path",
    targetRoot,
  });
  const currentBytes = await readRegularFileOrNull({
    expectedIdentity: destinationIdentity,
    label: "Current target",
    path: destinationPath,
    root: targetRoot,
  });
  const currentHash = currentBytes ? sha256(currentBytes) : null;
  if (options.expectedCurrentHash !== undefined) {
    const expected =
      options.expectedCurrentHash === null
        ? null
        : validateHash(options.expectedCurrentHash, "Expected current hash");
    if (expected !== currentHash) {
      throw new Error(
        "Stale current hash: destination changed before planning."
      );
    }
  }

  const translation = options.translation ?? {
    desiredContent: sourceBytes,
    lossReport: { lossless: true, entries: [] },
  };
  if (
    !translation.lossReport.lossless ||
    translation.lossReport.entries.length > 0
  ) {
    throw new Error("Lossy translation is not allowed for deployment plans.");
  }
  const desiredHash = sha256(translation.desiredContent);
  if (desiredHash !== sourceHash) {
    throw new Error(
      "Non-identity translation is unsupported by the first deployment planner slice."
    );
  }
  const desiredText = decodeUtf8(translation.desiredContent, "Desired content");
  const secretReferences = collectSecretReferences(desiredText);

  const stateBinding: DeploymentStateV1["binding"] = {
    adapterVersion: options.adapterVersion,
    assetCanonicalRef: asset.canonicalRef,
    destinationCollisionKey,
    destinationIdentity,
    destinationPath,
    tool: options.tool,
  };
  const ownershipId = destinationOwnershipId(stateBinding);
  const deploymentsDirectory = await assertContainedPath({
    label: "Deployment state directory",
    path: join(stateRoot, "deployments"),
    root: stateRoot,
  });
  const statePath = await assertContainedPath({
    label: "Deployment state path",
    path: join(deploymentsDirectory, `${ownershipId}.json`),
    root: stateRoot,
  });
  const stateScan = await scanDeploymentStates({
    directory: deploymentsDirectory,
    expectedPath: statePath,
    requestedBinding: stateBinding,
    stateRoot,
  });
  const existingStateRecord = stateScan.existing;
  const existingState = existingStateRecord?.state ?? null;
  const stateHash = existingStateRecord?.hash ?? null;
  const ownerMode: DeploymentOwnerMode = existingState
    ? "fclt-owned"
    : "unowned";
  if (existingState && existingState.desiredHash !== currentHash) {
    throw new Error(
      "Target tamper detected: owned destination no longer matches deployment state."
    );
  }
  if (
    !existingState &&
    currentHash !== null &&
    options.expectedCurrentHash === undefined
  ) {
    throw new Error(
      "Unowned destination exists; provide its exact --expected-current-hash to plan replacement."
    );
  }

  let rollbackTarget: DeploymentStateV1["rollbackTarget"];
  let snapshotHash: string | null = null;
  let snapshotRequired = false;
  if (existingState) {
    rollbackTarget = existingState.rollbackTarget;
    if (rollbackTarget.kind === "snapshot") {
      const snapshotPath = await assertContainedPath({
        label: "Existing rollback snapshot path",
        path: rollbackTarget.path,
        root: stateRoot,
      });
      const snapshotBytes = await readRegularFileOrNull({
        label: "Rollback snapshot",
        path: snapshotPath,
        root: stateRoot,
      });
      if (!snapshotBytes) {
        throw new Error(
          "Rollback snapshot is missing for the owned destination."
        );
      }
      snapshotHash = sha256(snapshotBytes);
      if (snapshotHash !== rollbackTarget.expectedHash) {
        throw new Error(
          "Rollback snapshot tamper detected: content hash does not match deployment state."
        );
      }
      snapshotRequired = true;
    }
  } else if (currentHash) {
    const snapshotPath = await assertContainedPath({
      label: "Rollback snapshot path",
      path: join(
        stateRoot,
        "rollback",
        ownershipId,
        currentHash.slice("sha256:".length)
      ),
      root: stateRoot,
    });
    const snapshotBytes = await readRegularFileOrNull({
      label: "Rollback snapshot",
      path: snapshotPath,
      root: stateRoot,
    });
    snapshotHash = snapshotBytes ? sha256(snapshotBytes) : null;
    if (snapshotHash && snapshotHash !== currentHash) {
      throw new Error(
        "Rollback snapshot tamper detected: content hash does not match its destination binding."
      );
    }
    rollbackTarget = {
      kind: "snapshot",
      path: snapshotPath,
      expectedHash: currentHash,
    };
  } else {
    rollbackTarget = { kind: "absent", path: destinationPath };
  }

  const desiredState: DeploymentStateV1 = {
    schemaVersion: DEPLOYMENT_STATE_SCHEMA_VERSION,
    planSchemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    binding: existingState?.binding ?? stateBinding,
    desiredHash,
    ownerMode: "fclt-owned",
    rollbackTarget,
  };
  const desiredStateHash = sha256(serializeDeploymentState(desiredState));

  const reads: DeploymentPlanV1["operations"]["reads"] = [
    {
      kind: "canonical-source",
      path: sourcePath,
      required: true,
      expectedHash: sourceHash,
    },
    {
      kind: "current-target",
      path: destinationPath,
      required: false,
      expectedHash: currentHash,
    },
    {
      kind: "ownership-directory",
      path: deploymentsDirectory,
      required: false,
      expectedHash: stateScan.directoryHash,
    },
    ...stateScan.records.map((record) => ({
      kind: "deployment-state" as const,
      path: record.path,
      required: true,
      expectedHash: record.hash,
    })),
    ...(existingStateRecord
      ? []
      : [
          {
            kind: "deployment-state" as const,
            path: statePath,
            required: false,
            expectedHash: null,
          },
        ]),
  ];
  if (rollbackTarget.kind === "snapshot") {
    reads.push({
      kind: "rollback-snapshot",
      path: rollbackTarget.path,
      required: snapshotRequired,
      expectedHash: snapshotHash,
    });
  }
  const writes: DeploymentPlanV1["operations"]["writes"] = [];
  if (
    !existingState &&
    rollbackTarget.kind === "snapshot" &&
    currentHash &&
    snapshotHash === null
  ) {
    writes.push({
      kind: "rollback-snapshot",
      path: rollbackTarget.path,
      contentSource: { kind: "path", path: destinationPath },
      expectedCurrentHash: null,
      desiredHash: currentHash,
    });
  }
  if (currentHash !== desiredHash) {
    writes.push({
      kind: "target",
      path: destinationPath,
      contentSource: { kind: "path", path: sourcePath },
      expectedCurrentHash: currentHash,
      desiredHash,
    });
  }
  if (stateHash !== desiredStateHash) {
    writes.push({
      kind: "deployment-state",
      path: statePath,
      contentSource: {
        kind: "inline-state",
        serialization: "stable-json-v1",
        state: desiredState,
      },
      expectedCurrentHash: stateHash,
      desiredHash: desiredStateHash,
    });
  }

  const plannerVersion = await authoritativePlannerVersion(
    options.plannerVersion
  );

  const planBody = {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    planner: {
      name: "fclt" as const,
      version: plannerVersion,
    },
    binding: {
      asset: {
        kind: asset.kind,
        selector: asset.selector,
        canonicalRef: asset.canonicalRef,
        path: sourcePath,
      },
      destination: {
        tool: options.tool,
        root: targetRoot,
        relativePath: destinationRelativePath,
        path: destinationPath,
        collisionKey: destinationCollisionKey,
        identity: destinationIdentity,
      },
    },
    hashes: {
      source: sourceHash,
      current: currentHash,
      desired: desiredHash,
      state: stateHash,
    },
    ownerMode,
    adapter: { id: adapter.id, version: options.adapterVersion },
    lossReport: translation.lossReport,
    secretReferences,
    operations: {
      reads,
      writes,
      removals: [],
      nativeCommands: [],
    },
    verificationProbe: {
      kind: "file-sha256" as const,
      path: destinationPath,
      expectedHash: desiredHash,
    },
    rollbackTarget,
  };
  const plan: DeploymentPlanV1 = {
    ...planBody,
    planId: sha256(stableJson(planBody)),
  };
  return deepFreeze(plan);
}

interface ParsedDeployArgs {
  adapterVersion?: string;
  asset?: string;
  destination?: string;
  expectedCurrentHash?: string | null;
  expectedSourceHash?: string;
  root?: string;
  scope: "global" | "project";
  stateRoot?: string;
  targetRoot?: string;
  tool?: string;
}

function parseDeployArgs(argv: string[]): ParsedDeployArgs {
  const parsed: ParsedDeployArgs = { scope: "global" };
  const valueFlags = new Map<string, keyof ParsedDeployArgs>([
    ["--adapter-version", "adapterVersion"],
    ["--asset", "asset"],
    ["--destination", "destination"],
    ["--expected-current-hash", "expectedCurrentHash"],
    ["--expected-source-hash", "expectedSourceHash"],
    ["--root", "root"],
    ["--scope", "scope"],
    ["--state-root", "stateRoot"],
    ["--target-root", "targetRoot"],
    ["--tool", "tool"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--json") {
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) {
      throw new Error(`Unknown deploy plan option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;
    if (key === "scope") {
      if (value !== "global" && value !== "project") {
        throw new Error("--scope must be global or project.");
      }
      parsed.scope = value;
    } else if (key === "expectedCurrentHash") {
      parsed.expectedCurrentHash = value === "absent" ? null : value;
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function requireDeployOption(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} is required.`);
  }
  return value;
}

export async function deployCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt deploy plan — build one immutable read-only deployment plan

Usage:
  fclt deploy plan --asset instruction:<name>|snippet:<path> --destination <relative-path> \\
    --tool codex --adapter-version v1 --root <canonical-root> \\
    --target-root <isolated-tool-root> --state-root <isolated-state-root> \\
    [--scope global|project] [--expected-source-hash sha256:<hex>] \\
    [--expected-current-hash absent|sha256:<hex>] [--json]

This command only reads files and prints a plan. It cannot apply a plan.
`);
    return;
  }
  try {
    if (argv[0] !== "plan") {
      throw new Error("deploy requires the read-only subcommand: plan");
    }
    const parsed = parseDeployArgs(argv.slice(1));
    const plan = await buildDeploymentPlan({
      adapterVersion: requireDeployOption(
        parsed.adapterVersion,
        "--adapter-version"
      ),
      asset: requireDeployOption(parsed.asset, "--asset"),
      canonicalRoot: requireDeployOption(parsed.root, "--root"),
      destination: requireDeployOption(parsed.destination, "--destination"),
      expectedCurrentHash: parsed.expectedCurrentHash,
      expectedSourceHash: parsed.expectedSourceHash,
      scope: parsed.scope,
      stateRoot: requireDeployOption(parsed.stateRoot, "--state-root"),
      targetRoot: requireDeployOption(parsed.targetRoot, "--target-root"),
      tool: requireDeployOption(parsed.tool, "--tool"),
    });
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
