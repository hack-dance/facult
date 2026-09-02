import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { caseFold } from "unicode-case-folding";
import { readDirectoryEntriesAt } from "./audit/safe-openat";
import { readStableRegularFile } from "./deployment-plan";
import {
  type ClaudeProjectRenderProducer,
  renderClaudeProjectTarget,
} from "./project-render-claude";
import {
  type CodexProjectRenderProducer,
  renderCodexProjectTarget,
} from "./project-render-codex";
import {
  createProjectRenderLock,
  type ProjectRenderLockBindingV1,
  verifyProjectRenderLock,
} from "./project-render-lock";

declare const FCLT_COMPILED_VERSION: string | undefined;

const PROJECT_RENDER_SCHEMA_VERSION = 1 as const;
const PROJECT_RENDER_PLAN_SCHEMA_VERSION = 1 as const;
const DEFAULT_MANIFEST_NAME = "project-render.toml";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_TARGET_BYTES = 64 * 1024 * 1024;
const MAX_TARGETS = 512;
const MAX_SOURCES_PER_TARGET = 64;
const MAX_CHECKED_OUTPUT_ENTRIES = 4096;
const DEFAULT_MAX_CHECK_DIFFERENCES = 200;
const SAFE_IDENTIFIER_RE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_RELATIVE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const MODE_RE = /^0[0-7]{3}$/;
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type ProjectRenderProducer =
  | "concat-text"
  | "copy-text"
  | ClaudeProjectRenderProducer
  | CodexProjectRenderProducer;

interface ProjectRenderManifestTargetV1 {
  destination: string;
  id: string;
  mode: string;
  producer: ProjectRenderProducer;
  producerVersion: 1;
  separator: string;
  sources: string[];
  tool: string;
}

interface ProjectRenderManifestV1 {
  exclusiveRoots: string[];
  schemaVersion: 1;
  targets: ProjectRenderManifestTargetV1[];
}

export interface ProjectRenderPlanV1 {
  schemaVersion: 1;
  planId: string;
  compiler: {
    name: "fclt";
    version: string;
  };
  manifest: {
    path: string;
    hash: string;
  };
  ownership: {
    exclusiveRoots: string[];
  };
  inputs: Array<{
    path: string;
    hash: string;
    bytes: number;
  }>;
  targets: Array<{
    id: string;
    tool: string;
    destination: string;
    mode: string;
    producer: {
      id: ProjectRenderProducer;
      version: 1;
    };
    sources: string[];
    content: {
      encoding: "base64";
      data: string;
      bytes: number;
      hash: string;
    };
  }>;
  hashes: {
    inputs: string;
    desiredTree: string;
  };
  lock?: ProjectRenderLockBindingV1;
}

export interface BuildProjectRenderPlanOptions {
  canonicalRoot: string;
  compilerArtifactPath?: string;
  compilerArtifactPlatform?: string;
  compilerVersion?: string;
  lock?: string;
  manifest?: string;
  projectRoot: string;
  requireLock?: boolean;
  skipLockVerification?: boolean;
}

export type ProjectRenderDifferenceStatus =
  | "changed"
  | "missing"
  | "type-conflict"
  | "unexpected";

export interface ProjectRenderCheckDifference {
  path: string;
  status: ProjectRenderDifferenceStatus;
  actualHash?: string;
  actualKind?: "directory" | "file" | "other" | "symlink";
  actualMode?: string;
  expectedHash?: string;
  expectedMode?: string;
}

export interface ProjectRenderCheckV1 {
  schemaVersion: 1;
  planId: string;
  clean: boolean;
  differences: ProjectRenderCheckDifference[];
  summary: {
    changed: number;
    matching: number;
    missing: number;
    totalDifferences: number;
    typeConflicts: number;
    unexpected: number;
  };
  truncated: boolean;
}

interface ParsedProjectPlanArgs {
  canonicalRoot?: string;
  check: boolean;
  json: boolean;
  lock?: string;
  manifest?: string;
  projectRoot?: string;
  requireLock: boolean;
  rollback: boolean;
}

interface ParsedProjectLockArgs {
  canonicalRoot?: string;
  compilerArtifacts: Record<string, string>;
  compilerCompatibility?: string;
  json: boolean;
  lock?: string;
  manifest?: string;
  packSchemaVersion?: number;
  packVersion?: string;
  projectRoot?: string;
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

function validateSafeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_RE.test(value)) {
    throw new Error(`${label} must be a lowercase portable identifier.`);
  }
  return value;
}

function validateRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a safe relative path.`);
  }
  const normalized = value.replace(/\\/g, "/");
  if (
    !normalized ||
    isAbsolute(value) ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    !SAFE_RELATIVE_PATH_RE.test(normalized) ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return normalized;
}

function validateMode(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODE_RE.test(value)) {
    throw new Error(`${label} must be a four-digit octal mode such as 0644.`);
  }
  return value;
}

function parseManifestTarget(
  value: unknown,
  index: number
): ProjectRenderManifestTargetV1 {
  if (!isPlainObject(value)) {
    throw new Error(`Manifest target ${index + 1} must be a table.`);
  }
  const allowedKeys = [
    "destination",
    "id",
    "mode",
    "producer",
    "producer_version",
    "separator",
    "sources",
    "tool",
  ];
  const producer = value.producer;
  const exactKeys =
    producer === "concat-text"
      ? allowedKeys
      : allowedKeys.filter((key) => key !== "separator");
  if (!hasExactKeys(value, exactKeys)) {
    throw new Error(
      `Manifest target ${index + 1} must contain exactly: ${exactKeys.join(", ")}.`
    );
  }
  if (
    producer !== "copy-text" &&
    producer !== "concat-text" &&
    producer !== "claude-agent-md" &&
    producer !== "claude-mcp-json" &&
    producer !== "claude-root-claude-md" &&
    producer !== "claude-settings-json" &&
    producer !== "claude-skill-md" &&
    producer !== "codex-agent-toml" &&
    producer !== "codex-config-toml" &&
    producer !== "codex-root-agents-md" &&
    producer !== "codex-skill-md"
  ) {
    throw new Error(
      `Manifest target ${index + 1} uses an unsupported producer: ${String(producer)}.`
    );
  }
  if (value.producer_version !== 1) {
    throw new Error(
      `Manifest target ${index + 1} uses an unsupported producer version: ${String(value.producer_version)}.`
    );
  }
  if (!Array.isArray(value.sources)) {
    throw new Error(`Manifest target ${index + 1} sources must be an array.`);
  }
  if (
    value.sources.length === 0 ||
    value.sources.length > MAX_SOURCES_PER_TARGET
  ) {
    throw new Error(
      `Manifest target ${index + 1} must declare between 1 and ${MAX_SOURCES_PER_TARGET} sources.`
    );
  }
  const sources = value.sources.map((source, sourceIndex) =>
    validateRelativePath(
      source,
      `Manifest target ${index + 1} source ${sourceIndex + 1}`
    )
  );
  if (
    (producer === "copy-text" ||
      producer === "claude-agent-md" ||
      producer === "claude-root-claude-md" ||
      producer === "claude-skill-md" ||
      producer === "codex-agent-toml" ||
      producer === "codex-skill-md") &&
    sources.length !== 1
  ) {
    throw new Error(
      `Manifest target ${index + 1} ${producer} producer requires exactly one source.`
    );
  }
  const separator = producer === "concat-text" ? value.separator : "";
  if (typeof separator !== "string") {
    throw new Error(
      `Manifest target ${index + 1} concat-text separator must be a string.`
    );
  }
  return {
    destination: validateRelativePath(
      value.destination,
      `Manifest target ${index + 1} destination`
    ),
    id: validateSafeIdentifier(value.id, `Manifest target ${index + 1} id`),
    mode: validateMode(value.mode, `Manifest target ${index + 1} mode`),
    producer,
    producerVersion: 1,
    separator,
    sources,
    tool: validateSafeIdentifier(
      value.tool,
      `Manifest target ${index + 1} tool`
    ),
  };
}

function parseManifest(bytes: Uint8Array): ProjectRenderManifestV1 {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new Error("Project render manifest must be valid UTF-8 TOML.");
  }
  if (
    !(
      isPlainObject(parsed) &&
      hasExactKeys(parsed, ["exclusive_roots", "schema_version", "targets"])
    )
  ) {
    throw new Error(
      "Project render manifest must contain exactly: exclusive_roots, schema_version, targets."
    );
  }
  if (parsed.schema_version !== PROJECT_RENDER_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported project render manifest version: ${String(parsed.schema_version)}.`
    );
  }
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error(
      "Project render manifest must declare at least one target."
    );
  }
  if (parsed.targets.length > MAX_TARGETS) {
    throw new Error(
      `Project render manifest exceeds the ${MAX_TARGETS}-target limit.`
    );
  }
  if (!Array.isArray(parsed.exclusive_roots)) {
    throw new Error(
      "Project render manifest exclusive_roots must be an array."
    );
  }
  const exclusiveRoots = parsed.exclusive_roots.map((root, index) =>
    validateRelativePath(root, `Manifest exclusive root ${index + 1}`)
  );
  return {
    exclusiveRoots,
    schemaVersion: PROJECT_RENDER_SCHEMA_VERSION,
    targets: parsed.targets.map(parseManifestTarget),
  };
}

function portableDestinationKey(destination: string): string {
  return caseFold(destination.normalize("NFC")).normalize("NFC");
}

function assertUniqueTargets(targets: ProjectRenderManifestTargetV1[]): void {
  const ids = new Set<string>();
  const destinations = new Map<string, string>();
  for (const target of targets) {
    if (ids.has(target.id)) {
      throw new Error(`Duplicate project render target id: ${target.id}.`);
    }
    ids.add(target.id);
    const key = portableDestinationKey(target.destination);
    const existing = destinations.get(key);
    if (existing) {
      throw new Error(
        `Portable project render destination collision: ${existing} and ${target.destination}.`
      );
    }
    destinations.set(key, target.destination);
  }
}

function assertClaudeInstructionContract(
  targets: ProjectRenderManifestTargetV1[]
): void {
  const hasClaudeRoot = targets.some(
    (target) => target.producer === "claude-root-claude-md"
  );
  if (
    hasClaudeRoot &&
    !targets.some((target) => target.destination === "AGENTS.md")
  ) {
    throw new Error(
      "claude-root-claude-md requires a declared AGENTS.md target in the same manifest."
    );
  }
}

function assertValidExclusiveRoots(args: {
  exclusiveRoots: string[];
  targets: ProjectRenderManifestTargetV1[];
}): void {
  const roots = [...args.exclusiveRoots].sort(compareStrings);
  const portableRoots = new Map<string, string>();
  for (const root of roots) {
    const key = portableDestinationKey(root);
    const existing = portableRoots.get(key);
    if (existing) {
      throw new Error(
        `Duplicate portable project render exclusive root: ${existing} and ${root}.`
      );
    }
    for (const [existingKey, existingRoot] of portableRoots.entries()) {
      if (
        key.startsWith(`${existingKey}/`) ||
        existingKey.startsWith(`${key}/`)
      ) {
        throw new Error(
          `Overlapping project render exclusive roots: ${existingRoot} and ${root}.`
        );
      }
    }
    portableRoots.set(key, root);
  }

  for (const target of args.targets) {
    const targetKey = portableDestinationKey(target.destination);
    const containingRoots = roots.filter((root) => {
      const rootKey = portableDestinationKey(root);
      return targetKey === rootKey || targetKey.startsWith(`${rootKey}/`);
    });
    if (containingRoots.length > 1) {
      throw new Error(
        `Project render target belongs to overlapping exclusive roots: ${target.destination}.`
      );
    }
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function decodeSourceText(bytes: Uint8Array, logicalPath: string): string {
  try {
    return normalizeLineEndings(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new Error(
      `Project render source must be valid UTF-8 text: ${logicalPath}.`
    );
  }
}

async function assertDirectory(
  pathValue: string,
  label: string
): Promise<string> {
  const absolute = resolve(pathValue);
  const stats = await lstat(absolute).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory.`);
  }
  return absolute;
}

async function projectRelativeCanonicalRoot(args: {
  canonicalRoot: string;
  projectRoot: string;
}): Promise<string> {
  const [canonicalPhysical, projectPhysical] = await Promise.all([
    realpath(args.canonicalRoot),
    realpath(args.projectRoot),
  ]);
  const logicalRelative = relative(args.projectRoot, args.canonicalRoot);
  const physicalRelative = relative(projectPhysical, canonicalPhysical);
  if (
    !logicalRelative ||
    logicalRelative.startsWith("..") ||
    isAbsolute(logicalRelative) ||
    !physicalRelative ||
    physicalRelative.startsWith("..") ||
    isAbsolute(physicalRelative)
  ) {
    throw new Error("Canonical root must be inside the project root.");
  }
  return logicalRelative.replace(/\\/g, "/");
}

async function authoritativeCompilerVersion(
  explicitVersion?: string
): Promise<string> {
  let version: unknown =
    typeof FCLT_COMPILED_VERSION === "string"
      ? FCLT_COMPILED_VERSION
      : undefined;
  if (version === undefined) {
    const packagePath = resolve(import.meta.dir, "..", "package.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(packagePath, "utf8"));
    } catch {
      throw new Error("Authoritative fclt compiler version is unavailable.");
    }
    version = isPlainObject(parsed) ? parsed.version : undefined;
  }
  if (typeof version !== "string" || !PACKAGE_VERSION_RE.test(version)) {
    throw new Error("Authoritative fclt compiler version is invalid.");
  }
  if (explicitVersion !== undefined && explicitVersion !== version) {
    throw new Error(
      "Explicit compiler version does not match the authoritative fclt version."
    );
  }
  return version;
}

export async function buildProjectRenderPlan(
  options: BuildProjectRenderPlanOptions
): Promise<Readonly<ProjectRenderPlanV1>> {
  const projectRoot = await assertDirectory(
    options.projectRoot,
    "Project root"
  );
  const canonicalRoot = await assertDirectory(
    options.canonicalRoot,
    "Canonical root"
  );
  const canonicalRelative = await projectRelativeCanonicalRoot({
    canonicalRoot,
    projectRoot,
  });
  const manifestRelative = options.manifest
    ? validateRelativePath(options.manifest, "Manifest path")
    : DEFAULT_MANIFEST_NAME;
  const manifestPath = join(canonicalRoot, manifestRelative);
  const manifestBytes = await readStableRegularFile({
    label: "Project render manifest",
    path: manifestPath,
    root: canonicalRoot,
  });
  if (!manifestBytes) {
    throw new Error(
      `Project render manifest does not exist: ${canonicalRelative}/${manifestRelative}.`
    );
  }
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(
      `Project render manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`
    );
  }
  const manifest = parseManifest(manifestBytes);
  assertUniqueTargets(manifest.targets);
  assertClaudeInstructionContract(manifest.targets);
  assertValidExclusiveRoots({
    exclusiveRoots: manifest.exclusiveRoots,
    targets: manifest.targets,
  });

  const logicalSourcePath = (source: string) =>
    `${canonicalRelative}/${source}`;
  const sourceBytesByPath = new Map<string, Uint8Array>();
  let totalSourceBytes = 0;
  for (const source of [
    ...new Set(manifest.targets.flatMap((target) => target.sources)),
  ].sort(compareStrings)) {
    const sourcePath = join(canonicalRoot, source);
    const sourceBytes = await readStableRegularFile({
      label: `Project render source ${source}`,
      path: sourcePath,
      root: canonicalRoot,
    });
    if (!sourceBytes) {
      throw new Error(
        `Project render source does not exist: ${canonicalRelative}/${source}.`
      );
    }
    if (sourceBytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(
        `Project render source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${canonicalRelative}/${source}.`
      );
    }
    totalSourceBytes += sourceBytes.byteLength;
    if (totalSourceBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error(
        `Project render sources exceed the ${MAX_TOTAL_SOURCE_BYTES}-byte aggregate limit.`
      );
    }
    sourceBytesByPath.set(
      source,
      Buffer.from(
        decodeSourceText(sourceBytes, logicalSourcePath(source)),
        "utf8"
      )
    );
  }

  const inputs = [...sourceBytesByPath.entries()]
    .map(([source, bytes]) => ({
      bytes: bytes.byteLength,
      hash: sha256(bytes),
      path: logicalSourcePath(source),
    }))
    .sort((left, right) => compareStrings(left.path, right.path));

  let totalTargetBytes = 0;
  const targets = manifest.targets
    .map((target) => {
      const sourceTexts = target.sources.map((source) => {
        const bytes = sourceBytesByPath.get(source);
        if (!bytes) {
          throw new Error(`Project render source was not loaded: ${source}.`);
        }
        return decodeSourceText(bytes, logicalSourcePath(source));
      });
      const contentText =
        target.producer === "copy-text"
          ? sourceTexts[0]
          : target.producer === "concat-text"
            ? sourceTexts.join(target.separator)
            : target.producer.startsWith("claude-")
              ? renderClaudeProjectTarget({
                  destination: target.destination,
                  producer: target.producer as ClaudeProjectRenderProducer,
                  sourceTexts,
                  tool: target.tool,
                })
              : renderCodexProjectTarget({
                  destination: target.destination,
                  producer: target.producer as CodexProjectRenderProducer,
                  sourceTexts,
                  tool: target.tool,
                });
      if (contentText === undefined) {
        throw new Error(`Project render target has no content: ${target.id}.`);
      }
      const content = Buffer.from(contentText, "utf8");
      totalTargetBytes += content.byteLength;
      if (totalTargetBytes > MAX_TOTAL_TARGET_BYTES) {
        throw new Error(
          `Project render outputs exceed the ${MAX_TOTAL_TARGET_BYTES}-byte aggregate limit.`
        );
      }
      return {
        content: {
          bytes: content.byteLength,
          data: content.toString("base64"),
          encoding: "base64" as const,
          hash: sha256(content),
        },
        destination: target.destination,
        id: target.id,
        mode: target.mode,
        producer: {
          id: target.producer,
          version: target.producerVersion,
        },
        sources: target.sources.map(logicalSourcePath),
        tool: target.tool,
      };
    })
    .sort(
      (left, right) =>
        compareStrings(left.destination, right.destination) ||
        compareStrings(left.id, right.id)
    );

  const manifestLogicalPath = `${canonicalRelative}/${manifestRelative}`;
  const compilerVersion = await authoritativeCompilerVersion(
    options.compilerVersion
  );
  const inputsHash = sha256(stableJson(inputs));
  const desiredTreeHash = sha256(
    stableJson(
      targets.map((target) => ({
        destination: target.destination,
        hash: target.content.hash,
        mode: target.mode,
      }))
    )
  );
  const unlockedPlanBody = {
    compiler: {
      name: "fclt" as const,
      version: compilerVersion,
    },
    hashes: {
      desiredTree: desiredTreeHash,
      inputs: inputsHash,
    },
    inputs,
    manifest: {
      hash: sha256(
        stableJson({
          exclusiveRoots: [...manifest.exclusiveRoots].sort(compareStrings),
          schemaVersion: manifest.schemaVersion,
          targets: [...manifest.targets].sort(
            (left, right) =>
              compareStrings(left.destination, right.destination) ||
              compareStrings(left.id, right.id)
          ),
        })
      ),
      path: manifestLogicalPath,
    },
    ownership: {
      exclusiveRoots: [...manifest.exclusiveRoots].sort(compareStrings),
    },
    schemaVersion: PROJECT_RENDER_PLAN_SCHEMA_VERSION,
    targets,
  };
  const lock = options.skipLockVerification
    ? null
    : await verifyProjectRenderLock({
        canonicalRoot,
        compilerArtifactPath: options.compilerArtifactPath,
        compilerArtifactPlatform: options.compilerArtifactPlatform,
        lock: options.lock,
        plan: unlockedPlanBody,
        required: options.requireLock,
      });
  const planBody = {
    ...unlockedPlanBody,
    ...(lock
      ? {
          lock: {
            ...lock,
            path: `${canonicalRelative}/${lock.path}`,
          },
        }
      : {}),
  };
  return deepFreeze({
    ...planBody,
    planId: sha256(stableJson(planBody)),
  });
}

function parseProjectPlanArgs(argv: string[]): ParsedProjectPlanArgs {
  const parsed: ParsedProjectPlanArgs = {
    check: false,
    json: false,
    requireLock: false,
    rollback: false,
  };
  const values = new Map<
    string,
    "canonicalRoot" | "lock" | "manifest" | "projectRoot"
  >([
    ["--root", "canonicalRoot"],
    ["--project-root", "projectRoot"],
    ["--manifest", "manifest"],
    ["--lock", "lock"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg === "--rollback") {
      parsed.rollback = true;
      continue;
    }
    if (arg === "--require-lock") {
      parsed.requireLock = true;
      continue;
    }
    const key = arg ? values.get(arg) : undefined;
    if (!key) {
      throw new Error(`Unknown project plan option: ${String(arg)}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function parseProjectLockArgs(argv: string[]): ParsedProjectLockArgs {
  const parsed: ParsedProjectLockArgs = {
    compilerArtifacts: {},
    json: false,
  };
  const values = new Map<
    string,
    | "canonicalRoot"
    | "compilerCompatibility"
    | "lock"
    | "manifest"
    | "packVersion"
    | "projectRoot"
  >([
    ["--root", "canonicalRoot"],
    ["--project-root", "projectRoot"],
    ["--manifest", "manifest"],
    ["--lock", "lock"],
    ["--pack-version", "packVersion"],
    ["--compiler-compatibility", "compilerCompatibility"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${String(arg)} requires a value.`);
    }
    if (arg === "--pack-schema-version") {
      parsed.packSchemaVersion = parsePositiveInteger(value, arg);
      index += 1;
      continue;
    }
    if (arg === "--compiler-artifact") {
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) {
        throw new Error(
          "--compiler-artifact requires <platform>-<arch>=<absolute-path>."
        );
      }
      const platform = value.slice(0, separator);
      if (platform in parsed.compilerArtifacts) {
        throw new Error(`Duplicate compiler artifact platform: ${platform}.`);
      }
      parsed.compilerArtifacts[platform] = value.slice(separator + 1);
      index += 1;
      continue;
    }
    const key = arg ? values.get(arg) : undefined;
    if (!key) {
      throw new Error(`Unknown project lock option: ${String(arg)}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function fileKind(
  stats: Awaited<ReturnType<typeof lstat>>
): "directory" | "file" | "other" | "symlink" {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}

function fileMode(mode: number): string {
  return `0${(mode % 0o1000).toString(8).padStart(3, "0")}`;
}

async function readCheckedOutput(args: {
  logicalPath: string;
  path: string;
  projectRoot: string;
}): Promise<{ hash: string; mode: string } | null> {
  const before = await lstat(args.path, { bigint: true }).catch(() => null);
  if (!before) {
    return null;
  }
  const bytes = await readStableRegularFile({
    label: `Project render output ${args.logicalPath}`,
    path: args.path,
    root: args.projectRoot,
  });
  if (!bytes) {
    return null;
  }
  const after = await lstat(args.path, { bigint: true }).catch(() => null);
  if (
    !after ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(
      `Project render output changed during check: ${args.logicalPath}.`
    );
  }
  return {
    hash: sha256(bytes),
    mode: fileMode(Number(after.mode)),
  };
}

function checkedDirectoryFlags(): number {
  if (
    typeof constants.O_DIRECTORY !== "number" ||
    constants.O_DIRECTORY === 0 ||
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0
  ) {
    throw new Error(
      "Safe project render output scans are unsupported on this platform."
    );
  }
  const extended = constants as typeof constants & { O_CLOEXEC?: number };
  return (
    constants.O_RDONLY +
    constants.O_DIRECTORY +
    constants.O_NOFOLLOW +
    (extended.O_CLOEXEC ?? 0)
  );
}

async function verifyCheckedDirectory(args: {
  descriptor: FileHandle;
  directoryPath: string;
  projectPhysicalRoot: string;
}): Promise<void> {
  const descriptorStats = await args.descriptor.stat({ bigint: true });
  const pathStats = await lstat(args.directoryPath, { bigint: true }).catch(
    () => null
  );
  if (
    !(descriptorStats.isDirectory() && pathStats?.isDirectory()) ||
    pathStats.isSymbolicLink() ||
    descriptorStats.dev !== pathStats.dev ||
    descriptorStats.ino !== pathStats.ino
  ) {
    throw new Error("Project render output directory changed during check.");
  }
  const physicalDirectory = await realpath(args.directoryPath).catch(
    () => null
  );
  if (!physicalDirectory) {
    throw new Error("Project render output directory changed during check.");
  }
  const rel = relative(args.projectPhysicalRoot, physicalDirectory);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      "Project render output directory escapes the project root."
    );
  }
}

async function listUnexpectedOutputs(args: {
  expectedPaths: Set<string>;
  exclusiveRoots: string[];
  projectRoot: string;
}): Promise<ProjectRenderCheckDifference[]> {
  const differences: ProjectRenderCheckDifference[] = [];
  let entryCount = 0;
  const projectPhysicalRoot = await realpath(args.projectRoot);

  async function visit(logicalDirectory: string): Promise<void> {
    const directoryPath = join(args.projectRoot, logicalDirectory);
    const directoryStats = await lstat(directoryPath).catch(() => null);
    if (!directoryStats) {
      return;
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      if (!args.expectedPaths.has(logicalDirectory)) {
        differences.push({
          actualKind: fileKind(directoryStats),
          path: logicalDirectory,
          status: "unexpected",
        });
      }
      return;
    }
    let descriptor: FileHandle;
    try {
      descriptor = await open(directoryPath, checkedDirectoryFlags());
    } catch {
      throw new Error(
        `Project render output directory must remain a non-symlink directory: ${logicalDirectory}.`
      );
    }
    try {
      await verifyCheckedDirectory({
        descriptor,
        directoryPath,
        projectPhysicalRoot,
      });
      const entries = readDirectoryEntriesAt({
        directoryFd: descriptor.fd,
        maxEntries: MAX_CHECKED_OUTPUT_ENTRIES + 1,
      })
        .map((entry) => entry.name)
        .filter((name) => name !== "." && name !== "..")
        .sort(compareStrings);
      for (const name of entries) {
        if (
          !name ||
          name.includes("\0") ||
          name.includes("/") ||
          name.includes("\\") ||
          name.includes("\uFFFD")
        ) {
          throw new Error(
            `Unsafe project render output entry under ${logicalDirectory}.`
          );
        }
        entryCount += 1;
        if (entryCount > MAX_CHECKED_OUTPUT_ENTRIES) {
          throw new Error(
            `Project render output scan exceeds the ${MAX_CHECKED_OUTPUT_ENTRIES}-entry limit.`
          );
        }
        const logicalPath = `${logicalDirectory}/${name}`;
        const outputPath = join(args.projectRoot, logicalPath);
        const stats = await lstat(outputPath).catch(() => null);
        if (!stats) {
          throw new Error(
            `Project render output changed during check: ${logicalPath}.`
          );
        }
        if (stats.isDirectory() && !stats.isSymbolicLink()) {
          await visit(logicalPath);
          continue;
        }
        if (args.expectedPaths.has(logicalPath)) {
          continue;
        }
        const kind = fileKind(stats);
        const actual =
          kind === "file"
            ? await readCheckedOutput({
                logicalPath,
                path: outputPath,
                projectRoot: args.projectRoot,
              })
            : null;
        differences.push({
          ...(actual
            ? { actualHash: actual.hash, actualMode: actual.mode }
            : {}),
          actualKind: kind,
          path: logicalPath,
          status: "unexpected",
        });
      }
      await verifyCheckedDirectory({
        descriptor,
        directoryPath,
        projectPhysicalRoot,
      });
    } finally {
      await descriptor.close();
    }
  }

  for (const root of args.exclusiveRoots) {
    await visit(root);
  }
  return differences;
}

export async function checkProjectRenderPlan(args: {
  plan: Readonly<ProjectRenderPlanV1>;
  projectRoot: string;
  maxDifferences?: number;
}): Promise<Readonly<ProjectRenderCheckV1>> {
  const projectRoot = await assertDirectory(args.projectRoot, "Project root");
  const differences: ProjectRenderCheckDifference[] = [];
  let matching = 0;

  for (const target of args.plan.targets) {
    const targetPath = join(projectRoot, target.destination);
    const stats = await lstat(targetPath).catch(() => null);
    if (!stats) {
      differences.push({
        expectedHash: target.content.hash,
        expectedMode: target.mode,
        path: target.destination,
        status: "missing",
      });
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      differences.push({
        actualKind: fileKind(stats),
        expectedHash: target.content.hash,
        expectedMode: target.mode,
        path: target.destination,
        status: "type-conflict",
      });
      continue;
    }
    const actual = await readCheckedOutput({
      logicalPath: target.destination,
      path: targetPath,
      projectRoot,
    });
    if (!actual) {
      throw new Error(
        `Project render output disappeared during check: ${target.destination}.`
      );
    }
    const modeMatches =
      process.platform === "win32" || actual.mode === target.mode;
    if (actual.hash !== target.content.hash || !modeMatches) {
      differences.push({
        actualHash: actual.hash,
        actualKind: "file",
        actualMode: actual.mode,
        expectedHash: target.content.hash,
        expectedMode: target.mode,
        path: target.destination,
        status: "changed",
      });
      continue;
    }
    matching += 1;
  }

  differences.push(
    ...(await listUnexpectedOutputs({
      exclusiveRoots: args.plan.ownership.exclusiveRoots,
      expectedPaths: new Set(
        args.plan.targets.map((target) => target.destination)
      ),
      projectRoot,
    }))
  );
  differences.sort(
    (left, right) =>
      compareStrings(left.path, right.path) ||
      compareStrings(left.status, right.status)
  );
  const summary = {
    changed: differences.filter((difference) => difference.status === "changed")
      .length,
    matching,
    missing: differences.filter((difference) => difference.status === "missing")
      .length,
    totalDifferences: differences.length,
    typeConflicts: differences.filter(
      (difference) => difference.status === "type-conflict"
    ).length,
    unexpected: differences.filter(
      (difference) => difference.status === "unexpected"
    ).length,
  };
  const maxDifferences = args.maxDifferences ?? DEFAULT_MAX_CHECK_DIFFERENCES;
  if (!Number.isSafeInteger(maxDifferences) || maxDifferences < 1) {
    throw new Error(
      "Project render max differences must be a positive integer."
    );
  }
  return deepFreeze({
    clean: differences.length === 0,
    differences: differences.slice(0, maxDifferences),
    planId: args.plan.planId,
    schemaVersion: 1,
    summary,
    truncated: differences.length > maxDifferences,
  });
}

function requireOption(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} is required.`);
  }
  return value;
}

export async function projectRenderCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt project - compile, check, and apply a hermetic desired project tree

Usage:
  fclt project render-plan --root <repo>/.ai --project-root <repo> [--manifest project-render.toml] [--json]
  fclt project lock --root <repo>/.ai --project-root <repo> --pack-version <version> --pack-schema-version <number> --compiler-compatibility <range> --compiler-artifact <platform>-<arch>=<absolute-path> [--json]
  fclt project render --root <repo>/.ai --project-root <repo> --check [--manifest project-render.toml] [--json]
  fclt project render --root <repo>/.ai --project-root <repo> [--manifest project-render.toml] [--json]
  fclt project render --root <repo>/.ai --project-root <repo> --rollback [--json]

The planner reads only the manifest and its declared canonical inputs. Check
mode additionally reads declared target paths and exclusive roots. Apply uses a
machine-local ownership receipt and recoverable transaction. Rollback restores
the previous receipt-bound target state. When project-render.lock.json exists,
plan and render verify its exact compiler artifact and canonical input-pack
identity. Use --require-lock to fail when it is absent.
`);
    return;
  }
  try {
    if (
      argv[0] !== "lock" &&
      argv[0] !== "render-plan" &&
      argv[0] !== "render"
    ) {
      throw new Error(
        "project rendering requires the subcommand: lock, render-plan, or render"
      );
    }
    if (argv[0] === "lock") {
      const lockArgs = parseProjectLockArgs(argv.slice(1));
      const canonicalRoot = requireOption(lockArgs.canonicalRoot, "--root");
      const projectRoot = requireOption(lockArgs.projectRoot, "--project-root");
      const packVersion = requireOption(lockArgs.packVersion, "--pack-version");
      const compilerCompatibility = requireOption(
        lockArgs.compilerCompatibility,
        "--compiler-compatibility"
      );
      if (lockArgs.packSchemaVersion === undefined) {
        throw new Error("--pack-schema-version is required.");
      }
      if (Object.keys(lockArgs.compilerArtifacts).length === 0) {
        throw new Error("At least one --compiler-artifact is required.");
      }
      const plan = await buildProjectRenderPlan({
        canonicalRoot,
        manifest: lockArgs.manifest,
        projectRoot,
        skipLockVerification: true,
      });
      const result = await createProjectRenderLock({
        canonicalRoot,
        compilerArtifacts: lockArgs.compilerArtifacts,
        compilerCompatibility,
        lock: lockArgs.lock,
        packSchemaVersion: lockArgs.packSchemaVersion,
        packVersion,
        plan,
      });
      if (lockArgs.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Wrote project render lock ${result.path}.`);
      }
      return;
    }
    const parsed = parseProjectPlanArgs(argv.slice(1));
    if (argv[0] === "render-plan" && (parsed.check || parsed.rollback)) {
      throw new Error(
        "project render-plan does not accept --check or --rollback."
      );
    }
    if (parsed.check && parsed.rollback) {
      throw new Error(
        "project render accepts only one of --check or --rollback."
      );
    }
    if (
      parsed.rollback &&
      (parsed.manifest || parsed.lock || parsed.requireLock)
    ) {
      throw new Error(
        "project render --rollback does not accept manifest or lock options."
      );
    }
    const canonicalRoot = requireOption(parsed.canonicalRoot, "--root");
    const projectRoot = requireOption(parsed.projectRoot, "--project-root");
    if (argv[0] === "render" && parsed.rollback) {
      const { rollbackProjectRender } = await import("./project-render-apply");
      const result = await rollbackProjectRender({
        canonicalRoot,
        projectRoot,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `Project render rollback restored ${result.restored} targets.`
        );
      }
      return;
    }
    const plan = await buildProjectRenderPlan({
      canonicalRoot,
      lock: parsed.lock,
      manifest: parsed.manifest,
      projectRoot,
      requireLock: parsed.requireLock,
    });
    if (argv[0] === "render" && parsed.check) {
      const result = await checkProjectRenderPlan({
        plan,
        projectRoot,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.clean) {
        console.log(
          `Project render check is clean (${plan.targets.length} targets).`
        );
      } else {
        console.log(
          `Project render check found ${result.summary.totalDifferences} differences.`
        );
        for (const difference of result.differences) {
          console.log(`${difference.status}: ${difference.path}`);
        }
        if (result.truncated) {
          console.log("Additional differences were omitted.");
        }
      }
      process.exitCode = result.clean ? 0 : 1;
      return;
    }
    if (argv[0] === "render") {
      const { applyProjectRender } = await import("./project-render-apply");
      const result = await applyProjectRender({
        canonicalRoot,
        manifest: parsed.manifest,
        projectRoot,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.changed) {
        console.log(
          `Project render applied ${result.written} writes and ${result.removed} removals.`
        );
      } else {
        console.log("Project render is already current.");
      }
      return;
    }
    if (parsed.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(
      `Project render plan ${plan.planId} (${plan.targets.length} targets, ${plan.inputs.length} inputs)`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
