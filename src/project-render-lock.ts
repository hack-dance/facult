import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readStableRegularFile } from "./deployment-plan";

declare const FCLT_COMPILED_RUNTIME: boolean | undefined;

const DEFAULT_LOCK_NAME = "project-render.lock.json";
const LOCK_SCHEMA_VERSION = 1 as const;
const MAX_LOCK_BYTES = 256 * 1024;
const MAX_COMPILER_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACK_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,126}$/;
const ARTIFACT_KEY_RE = /^(?:darwin|linux|windows)-(?:arm64|x64)$/;
const SAFE_RELATIVE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const COMPARATOR_RE = /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/;
const CORE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;
const WHITESPACE_RE = /\s+/;

export interface ProjectRenderLockV1 {
  schemaVersion: 1;
  compiler: {
    name: "fclt";
    version: string;
    artifacts: Record<string, string>;
  };
  manifestSchemaVersion: 1;
  pack: {
    schemaVersion: number;
    version: string;
    digest: string;
    compilerCompatibility: string;
  };
}

export interface ProjectRenderLockBindingV1 {
  path: string;
  hash: string;
  compilerArtifact: {
    platform: string;
    hash: string;
  };
  pack: ProjectRenderLockV1["pack"];
}

interface LockableProjectRenderPlan {
  compiler: { name: "fclt"; version: string };
  hashes: { inputs: string };
  schemaVersion: 1;
}

interface StableArtifactStat {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a sha256:<64 lowercase hex> digest.`);
  }
  return value;
}

function validateVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !VERSION_RE.test(value)) {
    throw new Error(`${label} must be a semantic package version.`);
  }
  return value;
}

function validatePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function validateRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (
    !normalized ||
    isAbsolute(value) ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    !SAFE_RELATIVE_PATH_RE.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Project render lock path must be a safe relative path.");
  }
  return normalized;
}

function parseCoreVersion(value: string): [number, number, number] {
  const match = CORE_VERSION_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid semantic version: ${value}.`);
  }
  const [, major, minor, patch] = match;
  if (!(major && minor && patch)) {
    throw new Error(`Invalid semantic version: ${value}.`);
  }
  return [Number(major), Number(minor), Number(patch)];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseCoreVersion(left);
  const rightParts = parseCoreVersion(right);
  for (const index of [0, 1, 2] as const) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function compilerVersionSatisfiesRange(args: {
  range: string;
  version: string;
}): boolean {
  validateVersion(args.version, "Compiler version");
  const comparators = args.range.trim().split(WHITESPACE_RE).filter(Boolean);
  if (comparators.length === 0) {
    throw new Error("Compiler compatibility range must not be empty.");
  }
  return comparators.every((comparator) => {
    const match = COMPARATOR_RE.exec(comparator);
    if (!match) {
      throw new Error(
        "Compiler compatibility supports whitespace-separated =, >, >=, <, and <= comparators."
      );
    }
    const comparatorVersion = match[2];
    if (!comparatorVersion) {
      throw new Error(
        "Compiler compatibility comparator is missing a version."
      );
    }
    const comparison = compareVersions(args.version, comparatorVersion);
    switch (match[1] ?? "=") {
      case ">":
        return comparison > 0;
      case ">=":
        return comparison >= 0;
      case "<":
        return comparison < 0;
      case "<=":
        return comparison <= 0;
      default:
        return comparison === 0;
    }
  });
}

function stableArtifactStatMatches(
  left: StableArtifactStat,
  right: StableArtifactStat
): boolean {
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

export async function hashCompilerArtifact(pathValue: string): Promise<string> {
  const artifactPath = resolve(pathValue);
  const pathStats = await lstat(artifactPath, { bigint: true }).catch(
    () => null
  );
  if (
    !pathStats?.isFile() ||
    pathStats.isSymbolicLink() ||
    pathStats.nlink !== 1n ||
    pathStats.size < 1n ||
    pathStats.size > BigInt(MAX_COMPILER_ARTIFACT_BYTES)
  ) {
    throw new Error(
      "Compiler artifact must be a bounded non-symlink regular file."
    );
  }
  const extendedConstants = constants as typeof constants & {
    O_CLOEXEC?: number;
  };
  const descriptor = await open(
    artifactPath,
    constants.O_RDONLY +
      (constants.O_NOFOLLOW ?? 0) +
      (extendedConstants.O_CLOEXEC ?? 0)
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    if (!stableArtifactStatMatches(pathStats, before)) {
      throw new Error("Compiler artifact changed before hashing.");
    }
    const hasher = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await descriptor.read(
        chunk,
        0,
        Math.min(chunk.byteLength, Number(before.size) - position),
        position
      );
      if (bytesRead < 1) {
        throw new Error("Compiler artifact ended while hashing.");
      }
      hasher.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await descriptor.stat({ bigint: true });
    const finalPathStats = await lstat(artifactPath, { bigint: true }).catch(
      () => null
    );
    if (
      !(
        finalPathStats &&
        stableArtifactStatMatches(before, after) &&
        stableArtifactStatMatches(after, finalPathStats)
      )
    ) {
      throw new Error("Compiler artifact changed while hashing.");
    }
    return `sha256:${hasher.digest("hex")}`;
  } finally {
    await descriptor.close();
  }
}

export function currentCompilerArtifactKey(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  return `${platform}-${process.arch}`;
}

function parseLock(value: unknown): ProjectRenderLockV1 {
  if (
    !(
      isPlainObject(value) &&
      hasExactKeys(value, [
        "compiler",
        "manifestSchemaVersion",
        "pack",
        "schemaVersion",
      ])
    ) ||
    value.schemaVersion !== LOCK_SCHEMA_VERSION ||
    value.manifestSchemaVersion !== 1
  ) {
    throw new Error("Project render lock has an unsupported schema.");
  }
  if (
    !(
      isPlainObject(value.compiler) &&
      hasExactKeys(value.compiler, ["artifacts", "name", "version"])
    ) ||
    value.compiler.name !== "fclt" ||
    !isPlainObject(value.compiler.artifacts)
  ) {
    throw new Error("Project render lock compiler identity is invalid.");
  }
  const compilerVersion = validateVersion(
    value.compiler.version,
    "Project render lock compiler version"
  );
  const artifacts: Record<string, string> = {};
  for (const [platform, digest] of Object.entries(value.compiler.artifacts)) {
    if (!ARTIFACT_KEY_RE.test(platform)) {
      throw new Error(
        `Project render lock artifact key is invalid: ${platform}.`
      );
    }
    artifacts[platform] = validateHash(
      digest,
      `Project render lock artifact ${platform}`
    );
  }
  if (Object.keys(artifacts).length === 0) {
    throw new Error(
      "Project render lock must declare at least one compiler artifact."
    );
  }
  if (
    !(
      isPlainObject(value.pack) &&
      hasExactKeys(value.pack, [
        "compilerCompatibility",
        "digest",
        "schemaVersion",
        "version",
      ])
    ) ||
    typeof value.pack.version !== "string" ||
    !PACK_VERSION_RE.test(value.pack.version) ||
    typeof value.pack.compilerCompatibility !== "string"
  ) {
    throw new Error("Project render lock pack identity is invalid.");
  }
  const pack = {
    compilerCompatibility: value.pack.compilerCompatibility,
    digest: validateHash(value.pack.digest, "Project render lock pack digest"),
    schemaVersion: validatePositiveInteger(
      value.pack.schemaVersion,
      "Project render lock pack schema version"
    ),
    version: value.pack.version,
  };
  compilerVersionSatisfiesRange({
    range: pack.compilerCompatibility,
    version: compilerVersion,
  });
  return {
    compiler: {
      artifacts,
      name: "fclt",
      version: compilerVersion,
    },
    manifestSchemaVersion: 1,
    pack,
    schemaVersion: 1,
  };
}

async function readLock(args: {
  canonicalRoot: string;
  lockPath: string;
}): Promise<{ lock: ProjectRenderLockV1; bytes: Uint8Array } | null> {
  const bytes = await readStableRegularFile({
    label: "Project render lock",
    path: join(args.canonicalRoot, args.lockPath),
    root: args.canonicalRoot,
  });
  if (!bytes) {
    return null;
  }
  if (bytes.byteLength > MAX_LOCK_BYTES) {
    throw new Error(
      `Project render lock exceeds the ${MAX_LOCK_BYTES}-byte limit.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new Error("Project render lock must contain strict UTF-8 JSON.");
  }
  return { bytes, lock: parseLock(parsed) };
}

function runtimeCompilerArtifactPath(explicitPath?: string): string {
  if (explicitPath) {
    return resolve(explicitPath);
  }
  if (
    typeof FCLT_COMPILED_RUNTIME !== "boolean" ||
    FCLT_COMPILED_RUNTIME !== true
  ) {
    throw new Error(
      "Locked project rendering requires an exact compiled fclt artifact; source checkout and PATH identity are insufficient."
    );
  }
  return process.execPath;
}

export async function verifyProjectRenderLock(args: {
  canonicalRoot: string;
  compilerArtifactPath?: string;
  compilerArtifactPlatform?: string;
  lock?: string;
  plan: LockableProjectRenderPlan;
  required?: boolean;
}): Promise<ProjectRenderLockBindingV1 | null> {
  const lockPath = validateRelativePath(args.lock ?? DEFAULT_LOCK_NAME);
  const loaded = await readLock({
    canonicalRoot: args.canonicalRoot,
    lockPath,
  });
  if (!loaded) {
    if (args.required) {
      throw new Error(`Project render lock does not exist: ${lockPath}.`);
    }
    return null;
  }
  const { lock } = loaded;
  if (
    lock.compiler.version !== args.plan.compiler.version ||
    lock.manifestSchemaVersion !== args.plan.schemaVersion
  ) {
    throw new Error(
      "Project render lock compiler or manifest schema does not match the running compiler."
    );
  }
  if (
    !compilerVersionSatisfiesRange({
      range: lock.pack.compilerCompatibility,
      version: args.plan.compiler.version,
    })
  ) {
    throw new Error(
      "Project render compiler is outside the locked pack compatibility range."
    );
  }
  if (lock.pack.digest !== args.plan.hashes.inputs) {
    throw new Error(
      "Project render canonical inputs do not match the locked pack digest."
    );
  }
  const platform =
    args.compilerArtifactPlatform ?? currentCompilerArtifactKey();
  if (!ARTIFACT_KEY_RE.test(platform)) {
    throw new Error(
      `Project render compiler platform is unsupported: ${platform}.`
    );
  }
  const expectedArtifactHash = lock.compiler.artifacts[platform];
  if (!expectedArtifactHash) {
    throw new Error(
      `Project render lock has no compiler artifact for ${platform}.`
    );
  }
  const actualArtifactHash = await hashCompilerArtifact(
    runtimeCompilerArtifactPath(args.compilerArtifactPath)
  );
  if (actualArtifactHash !== expectedArtifactHash) {
    throw new Error(
      `Project render compiler artifact does not match the ${platform} lock digest.`
    );
  }
  return {
    compilerArtifact: { hash: actualArtifactHash, platform },
    hash: sha256(loaded.bytes),
    pack: lock.pack,
    path: lockPath,
  };
}

export async function createProjectRenderLock(args: {
  canonicalRoot: string;
  compilerArtifacts: Record<string, string>;
  compilerCompatibility: string;
  lock?: string;
  packSchemaVersion: number;
  packVersion: string;
  plan: LockableProjectRenderPlan;
}): Promise<{ lock: ProjectRenderLockV1; path: string }> {
  if (!PACK_VERSION_RE.test(args.packVersion)) {
    throw new Error("Pack version must be a portable non-empty identifier.");
  }
  const packSchemaVersion = validatePositiveInteger(
    args.packSchemaVersion,
    "Pack schema version"
  );
  if (
    !compilerVersionSatisfiesRange({
      range: args.compilerCompatibility,
      version: args.plan.compiler.version,
    })
  ) {
    throw new Error(
      "Running compiler does not satisfy the requested pack compatibility range."
    );
  }
  const artifacts: Record<string, string> = {};
  for (const [platform, artifactPath] of Object.entries(
    args.compilerArtifacts
  )) {
    if (!ARTIFACT_KEY_RE.test(platform)) {
      throw new Error(`Compiler artifact key is invalid: ${platform}.`);
    }
    if (!isAbsolute(artifactPath)) {
      throw new Error(
        `Compiler artifact path for ${platform} must be absolute.`
      );
    }
    artifacts[platform] = await hashCompilerArtifact(artifactPath);
  }
  if (Object.keys(artifacts).length === 0) {
    throw new Error("At least one exact compiler artifact is required.");
  }
  const lock: ProjectRenderLockV1 = {
    compiler: {
      artifacts,
      name: "fclt",
      version: args.plan.compiler.version,
    },
    manifestSchemaVersion: args.plan.schemaVersion,
    pack: {
      compilerCompatibility: args.compilerCompatibility,
      digest: args.plan.hashes.inputs,
      schemaVersion: packSchemaVersion,
      version: args.packVersion,
    },
    schemaVersion: 1,
  };
  const lockPath = validateRelativePath(args.lock ?? DEFAULT_LOCK_NAME);
  const destination = join(resolve(args.canonicalRoot), lockPath);
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  const descriptor = await open(
    temporary,
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await descriptor.writeFile(`${stableJson(lock)}\n`, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await chmod(temporary, 0o644);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { lock, path: lockPath };
}
