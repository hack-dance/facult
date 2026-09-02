import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
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
import {
  acquireExclusiveAdvisoryLock,
  unlinkVerifiedFileAt,
} from "./audit/safe-openat";
import {
  MAX_STABLE_REGULAR_FILE_BYTES,
  readStableRegularFile,
} from "./deployment-plan";
import { facultMachineStateDir } from "./paths";
import {
  buildProjectRenderPlan,
  checkProjectRenderPlan,
  type ProjectRenderPlanV1,
} from "./project-render";

const RECEIPT_SCHEMA_VERSION = 1 as const;
const TRANSACTION_SCHEMA_VERSION = 1 as const;
const RESULT_SCHEMA_VERSION = 1 as const;
const MAX_TRANSACTION_BYTES = 256 * 1024 * 1024;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const MODE_RE = /^0[0-7]{3}$/;
const PATH_SEGMENT_SPLIT_RE = /[\\/]+/;

interface OwnedTargetV1 {
  hash: string;
  mode: string;
  path: string;
}

interface ProjectRenderOwnershipV1 {
  desiredTreeHash: string;
  inputsHash: string;
  manifestHash: string;
  planId: string;
  projectId: string;
  targets: OwnedTargetV1[];
}

interface FileSnapshotV1 {
  data: string;
  hash: string;
  mode: string;
}

interface TransactionOperationV1 {
  after: FileSnapshotV1 | null;
  before: FileSnapshotV1 | null;
  path: string;
}

interface ProjectRenderTransactionV1 {
  operations: TransactionOperationV1[];
  ownershipAfter: ProjectRenderOwnershipV1;
  ownershipBefore: ProjectRenderOwnershipV1 | null;
  projectId: string;
  schemaVersion: 1;
  transactionId: string;
}

interface ProjectRenderReceiptV1 {
  ownership: ProjectRenderOwnershipV1;
  rollback: {
    operations: TransactionOperationV1[];
    ownership: ProjectRenderOwnershipV1 | null;
  };
  schemaVersion: 1;
}

export interface ProjectRenderApplyResultV1 {
  changed: boolean;
  planId: string;
  recovered: boolean;
  removed: number;
  schemaVersion: 1;
  written: number;
}

export interface ProjectRenderRollbackResultV1 {
  planId: string | null;
  restored: number;
  schemaVersion: 1;
}

export interface ProjectRenderApplyHooks {
  afterOperation?: (operation: {
    index: number;
    path: string;
  }) => Promise<void>;
  beforeOperation?: (operation: {
    index: number;
    path: string;
  }) => Promise<void>;
  beforeReceiptCommit?: () => Promise<void>;
  beforeTargetCommit?: (operation: {
    index: number;
    path: string;
  }) => Promise<void>;
}

export interface ApplyProjectRenderOptions {
  canonicalRoot: string;
  compilerArtifactPath?: string;
  compilerArtifactPlatform?: string;
  homeDir?: string;
  hooks?: ProjectRenderApplyHooks;
  lock?: string;
  manifest?: string;
  projectRoot: string;
  requireLock?: boolean;
  stateRoot?: string;
}

interface MutationStatePaths {
  lock: string;
  receipt: string;
  root: string;
  transaction: string;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return (
    Object.keys(value).sort(compareStrings).join("\0") ===
    [...keys].sort(compareStrings).join("\0")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertMode(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !MODE_RE.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertLogicalPath(
  value: unknown,
  label: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

function parseSnapshot(value: unknown, label: string): FileSnapshotV1 | null {
  if (value === null) {
    return null;
  }
  if (!(isObject(value) && exactKeys(value, ["data", "hash", "mode"]))) {
    throw new Error(`${label} is invalid.`);
  }
  if (typeof value.data !== "string") {
    throw new Error(`${label} data is invalid.`);
  }
  assertHash(value.hash, `${label} hash`);
  assertMode(value.mode, `${label} mode`);
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.toString("base64") !== value.data || sha256(bytes) !== value.hash) {
    throw new Error(`${label} content does not match its hash.`);
  }
  return { data: value.data, hash: value.hash, mode: value.mode };
}

function parseOwnedTarget(value: unknown, label: string): OwnedTargetV1 {
  if (!(isObject(value) && exactKeys(value, ["hash", "mode", "path"]))) {
    throw new Error(`${label} is invalid.`);
  }
  assertLogicalPath(value.path, `${label} path`);
  assertHash(value.hash, `${label} hash`);
  assertMode(value.mode, `${label} mode`);
  return { hash: value.hash, mode: value.mode, path: value.path };
}

function parseOwnership(
  value: unknown,
  label: string
): ProjectRenderOwnershipV1 {
  const keys = [
    "desiredTreeHash",
    "inputsHash",
    "manifestHash",
    "planId",
    "projectId",
    "targets",
  ];
  if (
    !(isObject(value) && exactKeys(value, keys) && Array.isArray(value.targets))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  assertHash(value.desiredTreeHash, `${label} desiredTreeHash`);
  assertHash(value.inputsHash, `${label} inputsHash`);
  assertHash(value.manifestHash, `${label} manifestHash`);
  assertHash(value.planId, `${label} planId`);
  assertHash(value.projectId, `${label} projectId`);
  const targets = value.targets.map((target, index) =>
    parseOwnedTarget(target, `${label} target ${index + 1}`)
  );
  const sorted = [...targets].sort((left, right) =>
    compareStrings(left.path, right.path)
  );
  if (
    stableJson(targets) !== stableJson(sorted) ||
    new Set(targets.map((target) => target.path)).size !== targets.length
  ) {
    throw new Error(`${label} targets must be unique and sorted.`);
  }
  return {
    desiredTreeHash: value.desiredTreeHash,
    inputsHash: value.inputsHash,
    manifestHash: value.manifestHash,
    planId: value.planId,
    projectId: value.projectId,
    targets,
  };
}

function parseOperation(value: unknown, label: string): TransactionOperationV1 {
  if (!(isObject(value) && exactKeys(value, ["after", "before", "path"]))) {
    throw new Error(`${label} is invalid.`);
  }
  assertLogicalPath(value.path, `${label} path`);
  const before = parseSnapshot(value.before, `${label} before`);
  const after = parseSnapshot(value.after, `${label} after`);
  if (stableJson(before) === stableJson(after)) {
    throw new Error(`${label} does not change its target.`);
  }
  return { after, before, path: value.path };
}

function parseOperations(
  value: unknown,
  label: string
): TransactionOperationV1[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const operations = value.map((operation, index) =>
    parseOperation(operation, `${label} ${index + 1}`)
  );
  if (
    new Set(operations.map((operation) => operation.path)).size !==
    operations.length
  ) {
    throw new Error(`${label} paths must be unique.`);
  }
  return operations;
}

function parseReceipt(text: string): ProjectRenderReceiptV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Project render ownership receipt is not valid JSON.");
  }
  if (
    !(
      isObject(value) &&
      exactKeys(value, ["ownership", "rollback", "schemaVersion"])
    ) ||
    value.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    !isObject(value.rollback) ||
    !exactKeys(value.rollback, ["operations", "ownership"])
  ) {
    throw new Error(
      "Project render ownership receipt has an unsupported schema."
    );
  }
  return {
    ownership: parseOwnership(
      value.ownership,
      "Project render receipt ownership"
    ),
    rollback: {
      operations: parseOperations(
        value.rollback.operations,
        "Project render receipt rollback operation"
      ),
      ownership:
        value.rollback.ownership === null
          ? null
          : parseOwnership(
              value.rollback.ownership,
              "Project render receipt rollback ownership"
            ),
    },
    schemaVersion: RECEIPT_SCHEMA_VERSION,
  };
}

function parseTransaction(text: string): ProjectRenderTransactionV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Project render transaction is not valid JSON.");
  }
  const keys = [
    "operations",
    "ownershipAfter",
    "ownershipBefore",
    "projectId",
    "schemaVersion",
    "transactionId",
  ];
  if (
    !(isObject(value) && exactKeys(value, keys)) ||
    value.schemaVersion !== TRANSACTION_SCHEMA_VERSION
  ) {
    throw new Error("Project render transaction has an unsupported schema.");
  }
  assertHash(value.projectId, "Project render transaction projectId");
  assertHash(value.transactionId, "Project render transaction transactionId");
  const transaction = {
    operations: parseOperations(
      value.operations,
      "Project render transaction operation"
    ),
    ownershipAfter: parseOwnership(
      value.ownershipAfter,
      "Project render transaction ownershipAfter"
    ),
    ownershipBefore:
      value.ownershipBefore === null
        ? null
        : parseOwnership(
            value.ownershipBefore,
            "Project render transaction ownershipBefore"
          ),
    projectId: value.projectId,
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    transactionId: value.transactionId,
  };
  const body = { ...transaction, transactionId: undefined };
  if (sha256(stableJson(body)) !== transaction.transactionId) {
    throw new Error("Project render transaction identity is invalid.");
  }
  return transaction;
}

function modeString(mode: number): string {
  return `0${(mode % 0o1000).toString(8).padStart(3, "0")}`;
}

function groupOrOtherWritable(mode: number): boolean {
  const permissions = mode % 0o1000;
  const group = Math.floor(permissions / 8) % 8;
  const other = permissions % 8;
  return Math.floor(group / 2) % 2 === 1 || Math.floor(other / 2) % 2 === 1;
}

function snapshotsMatch(
  left: FileSnapshotV1 | null,
  right: FileSnapshotV1 | null
): boolean {
  return stableJson(left) === stableJson(right);
}

async function readSnapshot(args: {
  path: string;
  projectRoot: string;
}): Promise<FileSnapshotV1 | null> {
  const metadata = await lstat(args.path).catch(() => null);
  if (!metadata) {
    return null;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Project render target is not a regular file: ${relative(args.projectRoot, args.path).replace(/\\/g, "/")}.`
    );
  }
  const bytes = await readStableRegularFile({
    label: "Project render mutation target",
    path: args.path,
    root: args.projectRoot,
  });
  if (!bytes) {
    throw new Error("Project render target disappeared during mutation.");
  }
  return {
    data: Buffer.from(bytes).toString("base64"),
    hash: sha256(bytes),
    mode: modeString(metadata.mode),
  };
}

async function assertSafeParent(args: {
  create: boolean;
  path: string;
  projectRoot: string;
}): Promise<{ dev: number; ino: number; path: string }> {
  const projectPhysical = await realpath(args.projectRoot);
  const logicalParent = dirname(args.path);
  const rel = relative(args.projectRoot, logicalParent);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Project render target parent escapes the project root.");
  }
  let current = args.projectRoot;
  for (const segment of rel.split(PATH_SEGMENT_SPLIT_RE).filter(Boolean)) {
    current = join(current, segment);
    let metadata = await lstat(current).catch(() => null);
    if (!metadata && args.create) {
      await mkdir(current, { mode: 0o755 });
      metadata = await lstat(current);
    }
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        "Project render target parent must remain a non-symlink directory."
      );
    }
    const physical = await realpath(current);
    const physicalRelative = relative(projectPhysical, physical);
    if (physicalRelative.startsWith("..") || isAbsolute(physicalRelative)) {
      throw new Error("Project render target parent escapes the project root.");
    }
  }
  const parentMetadata = await lstat(logicalParent);
  return {
    dev: parentMetadata.dev,
    ino: parentMetadata.ino,
    path: logicalParent,
  };
}

async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function atomicWrite(args: {
  beforeCommit?: () => Promise<void>;
  bytes: Uint8Array;
  expected: FileSnapshotV1 | null;
  mode: string;
  path: string;
  projectRoot: string;
}): Promise<void> {
  const parent = await assertSafeParent({
    create: true,
    path: args.path,
    projectRoot: args.projectRoot,
  });
  const temporary = join(
    parent.path,
    `.${basename(args.path)}.${randomUUID()}.tmp`
  );
  const descriptor = await open(temporary, "wx", 0o600);
  try {
    await descriptor.writeFile(args.bytes);
    await descriptor.chmod(Number.parseInt(args.mode, 8));
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await args.beforeCommit?.();
    const currentParent = await assertSafeParent({
      create: false,
      path: args.path,
      projectRoot: args.projectRoot,
    });
    if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) {
      throw new Error("Project render target parent changed before commit.");
    }
    const current = await readSnapshot({
      path: args.path,
      projectRoot: args.projectRoot,
    });
    if (!snapshotsMatch(current, args.expected)) {
      throw new Error(
        `Project render target changed before commit: ${relative(args.projectRoot, args.path).replace(/\\/g, "/")}.`
      );
    }
    await rename(temporary, args.path);
    if (process.platform !== "win32") {
      await chmod(args.path, Number.parseInt(args.mode, 8));
    }
    await syncDirectory(parent.path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicRemove(args: {
  beforeCommit?: () => Promise<void>;
  expected: FileSnapshotV1;
  path: string;
  projectRoot: string;
}): Promise<void> {
  const parent = await assertSafeParent({
    create: false,
    path: args.path,
    projectRoot: args.projectRoot,
  });
  const current = await readSnapshot({
    path: args.path,
    projectRoot: args.projectRoot,
  });
  if (!snapshotsMatch(current, args.expected)) {
    throw new Error(
      `Project render target changed before removal: ${relative(args.projectRoot, args.path).replace(/\\/g, "/")}.`
    );
  }
  const [directoryPath, safeRoot] = await Promise.all([
    realpath(parent.path),
    realpath(args.projectRoot),
  ]);
  await unlinkVerifiedFileAt({
    beforeCommit: args.beforeCommit,
    directoryPath,
    expectedSha256: args.expected.hash.slice("sha256:".length),
    fileName: basename(args.path),
    maxBytes: MAX_STABLE_REGULAR_FILE_BYTES,
    safeRoot,
  });
}

async function atomicStateWrite(path: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_TRANSACTION_BYTES) {
    throw new Error(
      `Project render state exceeds the ${MAX_TRANSACTION_BYTES}-byte limit.`
    );
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`
  );
  const descriptor = await open(temporary, "wx", 0o600);
  try {
    await descriptor.writeFile(body, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readOptionalState(path: string): Promise<string | null> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata) {
    return null;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_TRANSACTION_BYTES
  ) {
    throw new Error(`Project render state file is unsafe: ${basename(path)}.`);
  }
  return readFile(path, "utf8");
}

async function statePaths(
  options: ApplyProjectRenderOptions
): Promise<MutationStatePaths> {
  const root = resolve(
    options.stateRoot ??
      join(
        facultMachineStateDir(
          options.homeDir ?? homedir(),
          options.canonicalRoot
        ),
        "project-render"
      )
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  const permissions = metadata.mode % 0o1000;
  const expectedOwner = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    groupOrOtherWritable(permissions) ||
    (expectedOwner !== undefined && metadata.uid !== expectedOwner)
  ) {
    throw new Error("Project render state directory is unsafe.");
  }
  return {
    lock: join(root, "mutation.lock"),
    receipt: join(root, "receipt.json"),
    root,
    transaction: join(root, "transaction.json"),
  };
}

async function projectId(projectRoot: string): Promise<string> {
  return sha256(await realpath(projectRoot));
}

function ownershipFromPlan(args: {
  plan: Readonly<ProjectRenderPlanV1>;
  projectId: string;
}): ProjectRenderOwnershipV1 {
  return {
    desiredTreeHash: args.plan.hashes.desiredTree,
    inputsHash: args.plan.hashes.inputs,
    manifestHash: args.plan.manifest.hash,
    planId: args.plan.planId,
    projectId: args.projectId,
    targets: args.plan.targets.map((target) => ({
      hash: target.content.hash,
      mode: target.mode,
      path: target.destination,
    })),
  };
}

function desiredSnapshot(
  target: Readonly<ProjectRenderPlanV1["targets"][number]>
): FileSnapshotV1 {
  return {
    data: target.content.data,
    hash: target.content.hash,
    mode: target.mode,
  };
}

async function assertPlanUnchanged(
  options: ApplyProjectRenderOptions,
  expectedPlanId: string
): Promise<void> {
  const current = await buildProjectRenderPlan({
    canonicalRoot: options.canonicalRoot,
    compilerArtifactPath: options.compilerArtifactPath,
    compilerArtifactPlatform: options.compilerArtifactPlatform,
    lock: options.lock,
    manifest: options.manifest,
    projectRoot: options.projectRoot,
    requireLock: options.requireLock,
  });
  if (current.planId !== expectedPlanId) {
    throw new Error("Project render manifest or inputs changed during apply.");
  }
}

async function executeOperation(args: {
  hooks?: ProjectRenderApplyHooks;
  index: number;
  operation: TransactionOperationV1;
  options: ApplyProjectRenderOptions;
  revalidatePlan: boolean;
}): Promise<void> {
  const targetPath = join(args.options.projectRoot, args.operation.path);
  const revalidate = async (): Promise<void> => {
    if (args.revalidatePlan) {
      const transactionText = await readOptionalState(
        (await statePaths(args.options)).transaction
      );
      if (!transactionText) {
        throw new Error("Project render transaction disappeared during apply.");
      }
      const transaction = parseTransaction(transactionText);
      await assertPlanUnchanged(
        args.options,
        transaction.ownershipAfter.planId
      );
    }
    await args.hooks?.beforeTargetCommit?.({
      index: args.index,
      path: args.operation.path,
    });
  };
  await args.hooks?.beforeOperation?.({
    index: args.index,
    path: args.operation.path,
  });
  if (args.operation.after) {
    await atomicWrite({
      beforeCommit: revalidate,
      bytes: Buffer.from(args.operation.after.data, "base64"),
      expected: args.operation.before,
      mode: args.operation.after.mode,
      path: targetPath,
      projectRoot: args.options.projectRoot,
    });
  } else if (args.operation.before) {
    await atomicRemove({
      beforeCommit: revalidate,
      expected: args.operation.before,
      path: targetPath,
      projectRoot: args.options.projectRoot,
    });
  }
  await args.hooks?.afterOperation?.({
    index: args.index,
    path: args.operation.path,
  });
}

async function recoverTransaction(args: {
  options: ApplyProjectRenderOptions;
  paths: MutationStatePaths;
  projectId: string;
}): Promise<boolean> {
  const text = await readOptionalState(args.paths.transaction);
  if (!text) {
    return false;
  }
  const transaction = parseTransaction(text);
  if (transaction.projectId !== args.projectId) {
    throw new Error(
      "Project render transaction belongs to a different project."
    );
  }
  const receiptText = await readOptionalState(args.paths.receipt);
  const receipt = receiptText ? parseReceipt(receiptText) : null;
  const receiptMatchesAfter =
    receipt?.ownership.planId === transaction.ownershipAfter.planId ||
    (!receipt && transaction.ownershipAfter.targets.length === 0);
  if (receiptMatchesAfter) {
    const everyCommitted = await Promise.all(
      transaction.operations.map(async (operation) =>
        snapshotsMatch(
          await readSnapshot({
            path: join(args.options.projectRoot, operation.path),
            projectRoot: args.options.projectRoot,
          }),
          operation.after
        )
      )
    );
    if (everyCommitted.every(Boolean)) {
      await unlink(args.paths.transaction);
      await syncDirectory(args.paths.root);
      return true;
    }
  }
  for (const [reverseIndex, operation] of [...transaction.operations]
    .reverse()
    .entries()) {
    const current = await readSnapshot({
      path: join(args.options.projectRoot, operation.path),
      projectRoot: args.options.projectRoot,
    });
    if (snapshotsMatch(current, operation.before)) {
      continue;
    }
    if (!snapshotsMatch(current, operation.after)) {
      throw new Error(
        `Interrupted project render target was modified externally: ${operation.path}.`
      );
    }
    await executeOperation({
      index: transaction.operations.length - reverseIndex - 1,
      operation: {
        after: operation.before,
        before: operation.after,
        path: operation.path,
      },
      options: args.options,
      revalidatePlan: false,
    });
  }
  await unlink(args.paths.transaction);
  await syncDirectory(args.paths.root);
  return true;
}

async function buildOperations(args: {
  options: ApplyProjectRenderOptions;
  plan: Readonly<ProjectRenderPlanV1>;
  receipt: ProjectRenderReceiptV1 | null;
}): Promise<TransactionOperationV1[]> {
  const priorTargets = new Map(
    args.receipt?.ownership.targets.map((target) => [target.path, target]) ?? []
  );
  const desiredPaths = new Set(
    args.plan.targets.map((target) => target.destination)
  );
  const operations: TransactionOperationV1[] = [];
  const check = await checkProjectRenderPlan({
    maxDifferences: 4096,
    plan: args.plan,
    projectRoot: args.options.projectRoot,
  });
  for (const difference of check.differences) {
    if (
      difference.status === "unexpected" &&
      !priorTargets.has(difference.path)
    ) {
      throw new Error(
        `Project render refuses unowned output: ${difference.path}.`
      );
    }
  }
  for (const target of args.plan.targets) {
    const path = join(args.options.projectRoot, target.destination);
    const before = await readSnapshot({
      path,
      projectRoot: args.options.projectRoot,
    });
    const after = desiredSnapshot(target);
    if (snapshotsMatch(before, after)) {
      const prior = priorTargets.get(target.destination);
      if (!prior && before) {
        throw new Error(
          `Project render refuses to adopt unowned target: ${target.destination}.`
        );
      }
      if (
        before &&
        prior &&
        (before.hash !== prior.hash ||
          (process.platform !== "win32" && before.mode !== prior.mode))
      ) {
        throw new Error(
          `Project render target changed outside its ownership receipt: ${target.destination}.`
        );
      }
      continue;
    }
    if (before) {
      const prior = priorTargets.get(target.destination);
      if (
        !prior ||
        before.hash !== prior.hash ||
        (process.platform !== "win32" && before.mode !== prior.mode)
      ) {
        throw new Error(
          `Project render refuses to overwrite modified or unowned target: ${target.destination}.`
        );
      }
    }
    operations.push({ after, before, path: target.destination });
  }
  for (const prior of priorTargets.values()) {
    if (desiredPaths.has(prior.path)) {
      continue;
    }
    const before = await readSnapshot({
      path: join(args.options.projectRoot, prior.path),
      projectRoot: args.options.projectRoot,
    });
    if (!before) {
      continue;
    }
    if (
      before.hash !== prior.hash ||
      (process.platform !== "win32" && before.mode !== prior.mode)
    ) {
      throw new Error(
        `Project render refuses to remove modified stale target: ${prior.path}.`
      );
    }
    operations.push({ after: null, before, path: prior.path });
  }
  return operations.sort((left, right) =>
    compareStrings(left.path, right.path)
  );
}

async function withMutationLock<T>(
  paths: MutationStatePaths,
  operation: () => Promise<T>
): Promise<T> {
  const descriptor = await open(
    paths.lock,
    constants.O_CREAT + constants.O_RDWR + (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  const metadata = await descriptor.stat();
  const expectedOwner = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.mode % 0o100 !== 0 ||
    (expectedOwner !== undefined && metadata.uid !== expectedOwner)
  ) {
    await descriptor.close();
    throw new Error("Project render mutation lock is unsafe.");
  }
  const release = acquireExclusiveAdvisoryLock(descriptor.fd);
  try {
    return await operation();
  } finally {
    release();
    await descriptor.close();
  }
}

export async function applyProjectRender(
  options: ApplyProjectRenderOptions
): Promise<Readonly<ProjectRenderApplyResultV1>> {
  const paths = await statePaths(options);
  return withMutationLock(paths, async () => {
    const identity = await projectId(options.projectRoot);
    const recovered = await recoverTransaction({
      options,
      paths,
      projectId: identity,
    });
    const plan = await buildProjectRenderPlan({
      canonicalRoot: options.canonicalRoot,
      compilerArtifactPath: options.compilerArtifactPath,
      compilerArtifactPlatform: options.compilerArtifactPlatform,
      lock: options.lock,
      manifest: options.manifest,
      projectRoot: options.projectRoot,
      requireLock: options.requireLock,
    });
    const receiptText = await readOptionalState(paths.receipt);
    const receipt = receiptText ? parseReceipt(receiptText) : null;
    if (receipt && receipt.ownership.projectId !== identity) {
      throw new Error(
        "Project render ownership receipt belongs to a different project."
      );
    }
    const operations = await buildOperations({ options, plan, receipt });
    const ownershipAfter = ownershipFromPlan({ plan, projectId: identity });
    if (
      operations.length === 0 &&
      stableJson(receipt?.ownership ?? null) === stableJson(ownershipAfter)
    ) {
      return Object.freeze({
        changed: false,
        planId: plan.planId,
        recovered,
        removed: 0,
        schemaVersion: RESULT_SCHEMA_VERSION,
        written: 0,
      });
    }
    if (operations.length === 0) {
      const reversibleOwnership =
        receipt &&
        stableJson(receipt.ownership.targets) ===
          stableJson(ownershipAfter.targets)
          ? receipt.ownership
          : null;
      await options.hooks?.beforeReceiptCommit?.();
      await assertPlanUnchanged(options, plan.planId);
      await atomicStateWrite(paths.receipt, {
        ownership: ownershipAfter,
        rollback: { operations: [], ownership: reversibleOwnership },
        schemaVersion: RECEIPT_SCHEMA_VERSION,
      } satisfies ProjectRenderReceiptV1);
      return Object.freeze({
        changed: true,
        planId: plan.planId,
        recovered,
        removed: 0,
        schemaVersion: RESULT_SCHEMA_VERSION,
        written: 0,
      });
    }
    const transactionBody = {
      operations,
      ownershipAfter,
      ownershipBefore: receipt?.ownership ?? null,
      projectId: identity,
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
    };
    const transaction: ProjectRenderTransactionV1 = {
      ...transactionBody,
      transactionId: sha256(
        stableJson({ ...transactionBody, transactionId: undefined })
      ),
    };
    await atomicStateWrite(paths.transaction, transaction);
    for (const [index, operation] of operations.entries()) {
      await executeOperation({
        hooks: options.hooks,
        index,
        operation,
        options,
        revalidatePlan: true,
      });
    }
    await options.hooks?.beforeReceiptCommit?.();
    await assertPlanUnchanged(options, plan.planId);
    const finalReceipt: ProjectRenderReceiptV1 = {
      ownership: ownershipAfter,
      rollback: { operations, ownership: receipt?.ownership ?? null },
      schemaVersion: RECEIPT_SCHEMA_VERSION,
    };
    await atomicStateWrite(paths.receipt, finalReceipt);
    await unlink(paths.transaction);
    await syncDirectory(paths.root);
    return Object.freeze({
      changed: true,
      planId: plan.planId,
      recovered,
      removed: operations.filter((operation) => operation.after === null)
        .length,
      schemaVersion: RESULT_SCHEMA_VERSION,
      written: operations.filter((operation) => operation.after !== null)
        .length,
    });
  });
}

function emptyOwnership(projectIdentity: string): ProjectRenderOwnershipV1 {
  const emptyHash = sha256("");
  return {
    desiredTreeHash: emptyHash,
    inputsHash: emptyHash,
    manifestHash: emptyHash,
    planId: sha256("project-render:no-ownership"),
    projectId: projectIdentity,
    targets: [],
  };
}

export async function rollbackProjectRender(
  options: ApplyProjectRenderOptions
): Promise<Readonly<ProjectRenderRollbackResultV1>> {
  const paths = await statePaths(options);
  return withMutationLock(paths, async () => {
    const identity = await projectId(options.projectRoot);
    await recoverTransaction({ options, paths, projectId: identity });
    const receiptText = await readOptionalState(paths.receipt);
    if (!receiptText) {
      throw new Error(
        "Project render does not have an ownership receipt to roll back."
      );
    }
    const receipt = parseReceipt(receiptText);
    if (receipt.ownership.projectId !== identity) {
      throw new Error(
        "Project render ownership receipt belongs to a different project."
      );
    }
    const currentTargets = new Map(
      receipt.ownership.targets.map((target) => [target.path, target])
    );
    for (const target of currentTargets.values()) {
      const current = await readSnapshot({
        path: join(options.projectRoot, target.path),
        projectRoot: options.projectRoot,
      });
      if (
        !current ||
        current.hash !== target.hash ||
        (process.platform !== "win32" && current.mode !== target.mode)
      ) {
        throw new Error(
          `Project render refuses rollback because an owned target changed: ${target.path}.`
        );
      }
    }
    const operations = [...receipt.rollback.operations]
      .reverse()
      .map((operation) => ({
        after: operation.before,
        before: operation.after,
        path: operation.path,
      }));
    if (operations.length === 0 && !receipt.rollback.ownership) {
      throw new Error(
        "Project render receipt does not contain a rollback transition."
      );
    }
    const ownershipAfter =
      receipt.rollback.ownership ?? emptyOwnership(identity);
    if (operations.length === 0) {
      await options.hooks?.beforeReceiptCommit?.();
      await atomicStateWrite(paths.receipt, {
        ownership: ownershipAfter,
        rollback: { operations: [], ownership: receipt.ownership },
        schemaVersion: RECEIPT_SCHEMA_VERSION,
      } satisfies ProjectRenderReceiptV1);
      return Object.freeze({
        planId: ownershipAfter.planId,
        restored: 0,
        schemaVersion: RESULT_SCHEMA_VERSION,
      });
    }
    const transactionBody = {
      operations,
      ownershipAfter,
      ownershipBefore: receipt.ownership,
      projectId: identity,
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
    };
    const transaction: ProjectRenderTransactionV1 = {
      ...transactionBody,
      transactionId: sha256(
        stableJson({ ...transactionBody, transactionId: undefined })
      ),
    };
    await atomicStateWrite(paths.transaction, transaction);
    for (const [index, operation] of operations.entries()) {
      await executeOperation({
        hooks: options.hooks,
        index,
        operation,
        options,
        revalidatePlan: false,
      });
    }
    await options.hooks?.beforeReceiptCommit?.();
    if (receipt.rollback.ownership) {
      const nextReceipt: ProjectRenderReceiptV1 = {
        ownership: receipt.rollback.ownership,
        rollback: {
          operations,
          ownership: receipt.ownership,
        },
        schemaVersion: RECEIPT_SCHEMA_VERSION,
      };
      await atomicStateWrite(paths.receipt, nextReceipt);
    } else {
      await unlink(paths.receipt);
      await syncDirectory(paths.root);
    }
    await unlink(paths.transaction);
    await syncDirectory(paths.root);
    return Object.freeze({
      planId: receipt.rollback.ownership?.planId ?? null,
      restored: operations.length,
      schemaVersion: RESULT_SCHEMA_VERSION,
    });
  });
}
