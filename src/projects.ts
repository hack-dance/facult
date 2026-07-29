import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  replaceVerifiedFileAt,
  unlinkVerifiedFileAt,
} from "./audit/safe-openat";
import { resolveCliContextRoot } from "./cli-context";
import { buildIndexSnapshot } from "./index-builder";
import {
  executionMachineStateProjectKey,
  facultAiGraphPath,
  facultAiIndexPath,
  facultLocalStateRoot,
  legacyMachineStateProjectKey,
  pathsMayCollide,
  pathsPhysicallyEquivalent,
  preferredGlobalAiRoot,
} from "./paths";
import {
  type RepositoryExecutionIdentity,
  type RepositoryIdentity,
  repositoryExecutionIdentity,
  repositoryIdentityAliasForPrimary,
  repositoryIdentityFromGitFacts,
} from "./repository-identity";

const DEFAULT_MAX_VISITS = 10_000;
const DEFAULT_MAX_RESULTS = 250;
const DISCOVERY_IGNORES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const PROJECT_SOURCES = new Set(["git", "guidance", "writebacks"]);
const PROJECT_CADENCES = new Set(["on-demand", "weekly", "daily"]);
const PROJECT_CONFIG_KEYS = [
  "cadence",
  "guidance",
  "managed_rendering",
  "repository_id",
  "scheduling",
  "sources",
];
const PROJECT_DECISIONS = new Set([
  "selected",
  "inactive",
  "ignored",
  "disabled",
  "removed",
]);
const PROJECT_HISTORY_ACTIONS = new Set([
  "enrolled",
  "disabled",
  "ignored",
  "inactive",
  "removed",
  "rolled-back",
]);
const PROTECTIVE_IGNORE_LINES = [
  "# fclt machine-local and generated state",
  "/.facult/",
  "/config.local.toml",
];
const SECRET_SHAPE_RE =
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"'#]{8,}/i;
const STANDALONE_CREDENTIAL_RE =
  /\b(?:gh[pour]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_live_[0-9A-Za-z]{16,}|xox[baprs]-[0-9A-Za-z-]{10,})\b/;
const GITHUB_STATELESS_TOKEN_RE =
  /(?:^|[^A-Za-z0-9_])ghs_[A-Za-z0-9._-]{36,}(?=$|[^A-Za-z0-9._-])/m;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LOCAL_UNIX_ABSOLUTE_PATH_RE =
  /(?:^|[\s"'`([{=>:])\/(?!\/)(?=[^\s"'`)\]}>])/m;
const LOCAL_WINDOWS_DRIVE_PATH_RE =
  /(?:^|[\s"'`([{=])(?:[A-Za-z]:(?:[\\/][^\s"'`)\]}]*|[^\s"'`)\]}\\/][^\s"'`)\]}]*))/m;
const LOCAL_WINDOWS_UNC_PATH_RE =
  /(?:^|[\s"'`([{=])(?:\\\\[^\\\s"'`)\]}]+\\[^\\\s"'`)\]}]+|\/\/[^/\s"'`)\]}]+\/[^/\s"'`)\]}]+)/m;
const LEADING_NEGATION_RE = /^!/;
const MARKDOWN_REFERENCE_ROOT_URL_RE =
  /^\s*\[[^\]]+\]:\s*\/{1,2}\S+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm;
const MARKDOWN_ROOT_URL_RE =
  /\]\(\s*\/{1,2}[^\s)]+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const ROOT_URL_ATTRIBUTE_RE =
  /\b(?:href|src)\s*=\s*(?:"\/{1,2}[^"]*"|'\/{1,2}[^']*'|\/{1,2}[^\s>]+)/gi;
const WEB_URL_TOKEN_RE = /\bhttps?:\/\/[^\s"'`<>]+/gi;
const REPOSITORY_ID_RE = /^repo_[a-f0-9]{24}$/;
const EXECUTION_ID_RE = /^worktree_[a-f0-9]{24}$/;
const GUIDANCE_INDEX_ENTRY_RE = /^H [0-7]{6} [0-9a-f]{40,64} 0\t/;
const LINE_SPLIT_RE = /\r?\n/;
const WHITESPACE_RE = /\s+/;
const SINCE_RE = /^(\d+)([dhw])$/;
const PATH_PART_SPLIT_RE = /[\\/]/;
const RECEIPT_ID_RE = /^enroll-[a-zA-Z0-9-]+$/;
const NON_DIGIT_RE = /[^0-9]/g;
const PLAN_SHA_RE = /^[a-f0-9]{64}$/;
const PROJECT_MUTATION_LOCK_ATTEMPTS = 500;
const PROJECT_MUTATION_LOCK_RETRY_MS = 10;
const PROJECT_CANONICAL_FILE_MAX_BYTES = 1024 * 1024;
const PROJECT_GENERATED_FILE_MAX_BYTES = 64 * 1024 * 1024;
const PROJECT_STATE_TREE_MAX_BYTES = 256 * 1024 * 1024;
const PROJECT_STATE_TREE_MAX_ENTRIES = 32_768;
const REBUILDABLE_PROJECT_STATE_PATHS = new Set([
  "ai/graph.json",
  "ai/index.json",
]);
const CANONICAL_FILE_MODE = 0o644;
const MACHINE_LOCAL_FILE_MODE = 0o600;

function permissionMode(mode: number): number {
  return mode % 0o1000;
}

function assertProjectRegistryMutationSupported(
  platform: NodeJS.Platform
): void {
  if (platform === "win32") {
    throw new Error(
      "Project registry mutation is unsupported on win32 because equivalent conditional replacement is unavailable"
    );
  }
}

export type ProjectDecision =
  | "selected"
  | "inactive"
  | "ignored"
  | "disabled"
  | "removed";
export type ProjectCadence = "on-demand" | "weekly" | "daily";
export type ProjectSource = "git" | "guidance" | "writebacks";

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DiscoveredProject {
  root: string;
  name: string;
  identity: RepositoryIdentity;
  executionIdentity: RepositoryExecutionIdentity;
  branch: string | null;
  head: string | null;
  lastCommitAt: string | null;
  dirty: boolean | null;
  canonicalAiRoot: string;
  canonicalAiExists: boolean;
  protectiveIgnore: boolean;
  duplicateLocations: number;
}

export interface ProjectDiscovery {
  version: 1;
  roots: string[];
  since: string | null;
  bounds: {
    maxVisits: number;
    maxResults: number;
    visited: number;
    truncated: boolean;
  };
  projects: DiscoveredProject[];
  groups: Array<{
    repositoryId: string;
    locations: string[];
  }>;
}

export interface GuidancePreview {
  path: string;
  sha256: string;
  content: string;
  gitState: "clean-tracked";
  adoption: "reference";
}

interface FilePrecondition {
  path: string;
  existed: boolean;
  sha256: string | null;
  mode: number | null;
}

export interface ProjectEnrollmentPlan {
  version: 1;
  operation: "project-init";
  projectRoot: string;
  aiRoot: string;
  identity: RepositoryIdentity;
  executionIdentity: RepositoryExecutionIdentity;
  worktree: {
    dirty: boolean | null;
    branch: string | null;
    head: string | null;
  };
  options: {
    sources: ProjectSource[];
    cadence: ProjectCadence;
    scheduling: boolean;
    guidance: string[];
  };
  guidancePreview: GuidancePreview[];
  canonicalWrites: Array<{
    path: string;
    content: string;
    reason: string;
    precondition: FilePrecondition;
  }>;
  generatedWrites: Array<{
    path: string;
    reason: string;
  }>;
  machineLocalWrites: Array<{
    path: string;
    reason: string;
  }>;
  legacyStateRoots: string[];
  stateMigrations: ProjectStateMigrationPlanEntry[];
  protections: {
    ignoreWrittenFirst: true;
    managedRendering: false;
    automaticGuidanceCopy: false;
    privacyFindings: string[];
  };
  warnings: string[];
  rollback: {
    command: string;
    preservesReviewHistory: true;
  };
  planSha256: string;
}

interface ProjectStateMigrationPlanEntry {
  source: string;
  destination: string;
  reason: string;
  strategy: "rename" | "merge-disjoint";
  sourceTreeSha256: string;
  destinationTreeSha256: string | null;
  rebuildableOverlaps: string[];
}

interface ProjectRegistryLocation {
  path: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface ProjectRegistryHistory {
  at: string;
  action:
    | "enrolled"
    | "disabled"
    | "ignored"
    | "inactive"
    | "removed"
    | "rolled-back";
  root: string;
  receiptId?: string;
}

interface ProjectRegistryEntry {
  repositoryId: string;
  aliases?: string[];
  identityKind: RepositoryIdentity["kind"];
  identityFingerprint: string;
  decision: ProjectDecision;
  sources: ProjectSource[];
  cadence: ProjectCadence;
  scheduling: boolean;
  guidance: string[];
  locations: ProjectRegistryLocation[];
  lastSuccessfulRun: string | null;
  pendingApprovals: string[];
  history: ProjectRegistryHistory[];
  activeReceipts?: Record<string, string>;
}

interface ProjectRegistry {
  version: 1;
  updatedAt: string;
  projects: Record<string, ProjectRegistryEntry>;
}

interface EnrollmentReceipt {
  version: 1;
  id: string;
  createdAt: string;
  repositoryId: string;
  executionId: string;
  projectRoot: string;
  planSha256: string;
  registryEntryBefore?: ProjectRegistryEntry | null;
  files: Array<{
    path: string;
    before: string | null;
    beforeMode: number | null;
    afterSha256: string;
    afterMode: number;
  }>;
}

interface TransactionArtifact {
  path: string;
  before: string | null;
  beforeIdentity: {
    dev: number;
    ino: number;
  } | null;
  beforeMode: number | null;
  afterContent: string | null;
  afterSha256: string | null;
  afterMode: number | null;
  afterSize: number | null;
  safeRoot?: string;
  safeRootIdentity?: {
    dev: number;
    ino: number;
    uid: number;
  };
  written: boolean;
}

interface ProjectMutationLockOwner {
  version: 2;
  endpoint: string;
  ownerId: string;
  pid: number;
  acquiredAt: string;
  transport: "ipc-socket";
}

export interface ProjectCommandContext {
  cwd?: string;
  homeDir?: string;
  now?: () => Date;
  /** @internal Platform branch override for cross-platform regression tests. */
  platform?: NodeJS.Platform;
}

interface ProjectStatusRow {
  repositoryId: string;
  decision: ProjectDecision;
  coverage: "covered" | "partial" | "inactive";
  health: "healthy" | "degraded" | "unavailable";
  canonicalRoot: string | null;
  canonical: {
    exists: boolean;
    config: boolean;
    protectiveIgnore: boolean;
    guidance: string[];
  };
  generated: {
    index: boolean;
    graph: boolean;
    health: "ready" | "missing";
  };
  sources: ProjectSource[];
  scheduler: {
    cadence: ProjectCadence;
    enabled: boolean;
    health: "on-demand" | "not-enabled" | "configured";
    lastSuccessfulRun: string | null;
  };
  pendingApprovals: string[];
  locations: Array<{
    path: string;
    exists: boolean;
    dirty: boolean | null;
  }>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runGit(args: {
  cwd: string;
  argv: string[];
  stdin?: string;
}): Promise<GitCommandResult> {
  const gitBinary = Bun.which("git") ?? "/usr/bin/git";
  const proc = Bun.spawn({
    cmd: [gitBinary, ...args.argv],
    cwd: args.cwd,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdin: args.stdin === undefined ? "ignore" : "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
  if (args.stdin !== undefined) {
    const input = proc.stdin;
    if (!input) {
      throw new Error("Git stdin pipe is unavailable");
    }
    input.write(args.stdin);
    input.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

async function validProjectEnrollmentConfig(
  pathValue: string,
  expected: Pick<
    ProjectRegistryEntry,
    "cadence" | "guidance" | "repositoryId" | "scheduling" | "sources"
  >
): Promise<boolean> {
  try {
    const before = await lstat(pathValue);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size > PROJECT_CANONICAL_FILE_MAX_BYTES
    ) {
      return false;
    }
    const content = await readFile(pathValue, "utf8");
    const after = await lstat(pathValue);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return false;
    }
    const parsed = Bun.TOML.parse(content);
    if (!isRecord(parsed) || parsed.version !== 1) {
      return false;
    }
    const project = parsed.project;
    return (
      isRecord(project) &&
      Object.keys(project).sort().join("\0") ===
        PROJECT_CONFIG_KEYS.join("\0") &&
      project.repository_id === expected.repositoryId &&
      Array.isArray(project.sources) &&
      project.sources.length === expected.sources.length &&
      project.sources.every(
        (source, index) =>
          typeof source === "string" &&
          PROJECT_SOURCES.has(source) &&
          source === expected.sources[index]
      ) &&
      Array.isArray(project.guidance) &&
      project.guidance.length === expected.guidance.length &&
      project.guidance.every((pathValue, index) => {
        if (typeof pathValue !== "string") {
          return false;
        }
        try {
          ensureRepoRelativeMarkdown(pathValue);
          return pathValue === expected.guidance[index];
        } catch {
          return false;
        }
      }) &&
      project.cadence === expected.cadence &&
      project.scheduling === expected.scheduling &&
      project.managed_rendering === false
    );
  } catch {
    return false;
  }
}

async function validBoundedGeneratedJson(
  pathValue: string,
  validate: (value: unknown) => boolean
): Promise<boolean> {
  try {
    const before = await lstat(pathValue);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size > PROJECT_GENERATED_FILE_MAX_BYTES
    ) {
      return false;
    }
    const content = await readFile(pathValue, "utf8");
    const after = await lstat(pathValue);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return false;
    }
    return validate(JSON.parse(content));
  } catch {
    return false;
  }
}

function isGeneratedIndex(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1) {
    return false;
  }
  const assetRecordIsValid = (record: Record<string, unknown>) =>
    Object.values(record).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        typeof entry.path === "string"
    );
  return (
    typeof value.updatedAt === "string" &&
    isRecord(value.skills) &&
    assetRecordIsValid(value.skills) &&
    isRecord(value.mcp) &&
    isRecord(value.mcp.servers) &&
    assetRecordIsValid(value.mcp.servers) &&
    isRecord(value.agents) &&
    assetRecordIsValid(value.agents) &&
    (value.automations === undefined ||
      (isRecord(value.automations) && assetRecordIsValid(value.automations))) &&
    isRecord(value.snippets) &&
    assetRecordIsValid(value.snippets) &&
    isRecord(value.instructions) &&
    assetRecordIsValid(value.instructions)
  );
}

function isGeneratedGraph(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.generatedAt !== "string" ||
    !isRecord(value.nodes) ||
    !Array.isArray(value.edges)
  ) {
    return false;
  }
  const nodesAreValid = Object.values(value.nodes).every(
    (node) =>
      isRecord(node) &&
      typeof node.id === "string" &&
      typeof node.kind === "string" &&
      typeof node.name === "string" &&
      typeof node.sourceKind === "string" &&
      typeof node.scope === "string"
  );
  return (
    nodesAreValid &&
    value.edges.every(
      (edge) =>
        isRecord(edge) &&
        typeof edge.from === "string" &&
        typeof edge.to === "string" &&
        typeof edge.kind === "string" &&
        typeof edge.locator === "string"
    )
  );
}

async function fileText(pathValue: string): Promise<string | null> {
  try {
    return await readFile(pathValue, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function lstatIfExists(pathValue: string) {
  try {
    return await lstat(pathValue);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

interface CanonicalFileSnapshot {
  content: string;
  metadata: Stats;
}

function canonicalMetadataMatches(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

async function canonicalFileSnapshot(
  pathValue: string
): Promise<CanonicalFileSnapshot | null> {
  const parentPath = dirname(pathValue);
  const parentBefore = await lstatIfExists(parentPath);
  if (!parentBefore) {
    const file = await lstatIfExists(pathValue);
    const parentAfter = await lstatIfExists(parentPath);
    if (file || parentAfter) {
      throw new Error(
        `Canonical project file parent changed while planning: ${parentPath}`
      );
    }
    return null;
  }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
    throw new Error(`Refusing unsafe canonical project root: ${parentPath}`);
  }

  const pathMetadata = await lstatIfExists(pathValue);
  if (!pathMetadata) {
    const parentAfter = await lstatIfExists(parentPath);
    const rebound = await lstatIfExists(pathValue);
    if (
      !parentAfter ||
      parentAfter.isSymbolicLink() ||
      !parentAfter.isDirectory() ||
      !canonicalMetadataMatches(parentBefore, parentAfter) ||
      rebound
    ) {
      throw new Error(
        `Canonical project file changed while planning: ${pathValue}`
      );
    }
    return null;
  }
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    pathMetadata.nlink !== 1 ||
    !Number.isSafeInteger(pathMetadata.size) ||
    pathMetadata.size < 0 ||
    pathMetadata.size > PROJECT_CANONICAL_FILE_MAX_BYTES
  ) {
    throw new Error(`Refusing unsafe canonical file: ${pathValue}`);
  }
  const handle = await open(
    pathValue,
    constants.O_RDONLY +
      (constants.O_NOFOLLOW ?? 0) +
      (constants.O_NONBLOCK ?? 0)
  ).catch(() => {
    throw new Error(
      `Canonical project file changed before descriptor read: ${pathValue}`
    );
  });
  try {
    const opened = await handle.stat();
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !canonicalMetadataMatches(pathMetadata, opened)
    ) {
      throw new Error(
        `Canonical project file changed before descriptor read: ${pathValue}`
      );
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (bytesRead === 0) {
        throw new Error(
          `Canonical project file changed while reading: ${pathValue}`
        );
      }
      offset += bytesRead;
    }
    const trailing = Buffer.alloc(1);
    if ((await handle.read(trailing, 0, 1, opened.size)).bytesRead !== 0) {
      throw new Error(
        `Canonical project file changed while reading: ${pathValue}`
      );
    }
    const [afterRead, rebound, parentAfter] = await Promise.all([
      handle.stat(),
      lstatIfExists(pathValue),
      lstatIfExists(parentPath),
    ]);
    if (
      !rebound ||
      rebound.isSymbolicLink() ||
      !rebound.isFile() ||
      !parentAfter ||
      parentAfter.isSymbolicLink() ||
      !parentAfter.isDirectory() ||
      !canonicalMetadataMatches(opened, afterRead) ||
      !canonicalMetadataMatches(afterRead, rebound) ||
      !canonicalMetadataMatches(parentBefore, parentAfter)
    ) {
      throw new Error(
        `Canonical project file changed while reading: ${pathValue}`
      );
    }
    return {
      content: bytes.toString("utf8"),
      metadata: opened,
    };
  } finally {
    await handle.close();
  }
}

async function regularFileText(pathValue: string): Promise<string | null> {
  const metadata = await lstatIfExists(pathValue);
  if (!metadata) {
    return null;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe machine-local file: ${pathValue}`);
  }
  return await readFile(pathValue, "utf8");
}

async function filePrecondition(pathValue: string): Promise<FilePrecondition> {
  const snapshot = await canonicalFileSnapshot(pathValue);
  if (!snapshot) {
    return {
      path: pathValue,
      existed: false,
      sha256: null,
      mode: null,
    };
  }
  return {
    path: pathValue,
    existed: true,
    sha256: sha256(snapshot.content),
    mode: permissionMode(snapshot.metadata.mode),
  };
}

function filePreconditionFromSnapshot(
  pathValue: string,
  snapshot: CanonicalFileSnapshot | null
): FilePrecondition {
  return snapshot
    ? {
        path: pathValue,
        existed: true,
        sha256: sha256(snapshot.content),
        mode: permissionMode(snapshot.metadata.mode),
      }
    : {
        path: pathValue,
        existed: false,
        sha256: null,
        mode: null,
      };
}

async function gitRoot(pathValue: string): Promise<string> {
  const resolvedPath = resolve(pathValue);
  const result = await runGit({
    cwd: resolvedPath,
    argv: ["rev-parse", "--show-toplevel"],
  });
  if (result.exitCode !== 0 || !result.stdout) {
    try {
      await lstat(join(resolvedPath, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Not a Git repository: ${resolvedPath}`);
      }
      throw new Error(
        `Git repository inspection failed for ${resolvedPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    throw new Error(
      `Git repository inspection failed for ${resolvedPath}: ${
        result.stderr || "git rev-parse returned no repository root"
      }`
    );
  }
  return await realpath(result.stdout).catch(() => resolve(result.stdout));
}

export async function resolveRepositoryIdentity(
  projectRoot: string,
  homeDir?: string
): Promise<RepositoryIdentity> {
  const root = await gitRoot(projectRoot);
  const identity = await resolveUnstabilizedRepositoryIdentity(root);
  return await stabilizeRepositoryIdentity({
    identity,
    projectRoot: root,
    homeDir: resolve(homeDir ?? process.env.HOME ?? homedir()),
  });
}

async function resolveUnstabilizedRepositoryIdentity(
  projectRoot: string
): Promise<RepositoryIdentity> {
  const root = await gitRoot(projectRoot);
  const [origin, remotes, roots, commonDir] = await Promise.all([
    runGit({ cwd: root, argv: ["remote", "get-url", "origin"] }),
    runGit({
      cwd: root,
      argv: ["config", "--get-regexp", "^remote\\..*\\.url$"],
    }),
    runGit({ cwd: root, argv: ["rev-list", "--max-parents=0", "HEAD"] }),
    runGit({ cwd: root, argv: ["rev-parse", "--git-common-dir"] }),
  ]);
  return repositoryIdentityFromGitFacts({
    projectRoot: root,
    originUrl: origin.exitCode === 0 ? origin.stdout : null,
    remoteUrls:
      remotes.exitCode === 0
        ? remotes.stdout
            .split(LINE_SPLIT_RE)
            .map((line) => line.trim().split(WHITESPACE_RE, 2)[1] ?? "")
            .filter(Boolean)
        : [],
    rootCommit: roots.exitCode === 0 ? roots.stdout : null,
    commonDir: commonDir.exitCode === 0 ? commonDir.stdout : null,
  });
}

export async function resolveRepositoryExecutionIdentity(
  projectRoot: string
): Promise<RepositoryExecutionIdentity> {
  const root = await gitRoot(projectRoot);
  return repositoryExecutionIdentity(root);
}

async function inspectRepository(
  rootValue: string,
  homeDir?: string,
  options?: {
    stabilizeIdentity?: boolean;
    stabilizationContext?: RepositoryStabilizationContext;
  }
): Promise<DiscoveredProject> {
  const root = await gitRoot(rootValue);
  const [rawIdentity, branch, head, lastCommit, statusResult] =
    await Promise.all([
      resolveUnstabilizedRepositoryIdentity(root),
      runGit({ cwd: root, argv: ["branch", "--show-current"] }),
      runGit({ cwd: root, argv: ["rev-parse", "--verify", "HEAD"] }),
      runGit({ cwd: root, argv: ["log", "-1", "--format=%cI"] }),
      runGit({
        cwd: root,
        argv: ["status", "--porcelain=v1", "--untracked-files=all"],
      }),
    ]);
  const identity =
    options?.stabilizeIdentity === false
      ? rawIdentity
      : await stabilizeRepositoryIdentity({
          identity: rawIdentity,
          projectRoot: root,
          homeDir: resolve(homeDir ?? process.env.HOME ?? homedir()),
          context: options?.stabilizationContext,
        });
  const aiRoot = join(root, ".ai");
  return {
    root,
    name: basename(root),
    identity,
    executionIdentity: repositoryExecutionIdentity(root),
    branch: branch.exitCode === 0 && branch.stdout ? branch.stdout : null,
    head: head.exitCode === 0 && head.stdout ? head.stdout : null,
    lastCommitAt:
      lastCommit.exitCode === 0 && lastCommit.stdout ? lastCommit.stdout : null,
    dirty: statusResult.exitCode === 0 ? Boolean(statusResult.stdout) : null,
    canonicalAiRoot: aiRoot,
    canonicalAiExists: await pathExists(aiRoot),
    protectiveIgnore: await hasEffectiveProtectiveIgnore(root),
    duplicateLocations: 1,
  };
}

function parseSince(value: string | undefined, now: Date): Date | null {
  if (!value) {
    return null;
  }
  const match = value.match(SINCE_RE);
  if (!match) {
    throw new Error(
      "--since must use a bounded duration such as 30d, 12h, or 8w"
    );
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2];
  const multiplier =
    unit === "h"
      ? 60 * 60 * 1000
      : unit === "w"
        ? 7 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - amount * multiplier);
}

async function discoverGitRoots(args: {
  roots: string[];
  maxVisits: number;
  maxResults: number;
}): Promise<{ roots: string[]; visited: number; truncated: boolean }> {
  const queue = [...args.roots.map((root) => resolve(root))];
  const found = new Set<string>();
  const visitedPaths = new Set<string>();
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visitedPaths.has(current)) {
      continue;
    }
    visitedPaths.add(current);
    visited += 1;
    if (visited > args.maxVisits || found.size >= args.maxResults) {
      truncated = true;
      break;
    }
    const entries = await readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.name === ".git")) {
      found.add(await realpath(current).catch(() => current));
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        DISCOVERY_IGNORES.has(entry.name)
      ) {
        continue;
      }
      queue.push(join(current, entry.name));
    }
  }

  return {
    roots: [...found].sort(),
    visited: Math.min(visited, args.maxVisits),
    truncated,
  };
}

export async function discoverProjects(args: {
  roots: string[];
  homeDir?: string;
  since?: string;
  maxVisits?: number;
  maxResults?: number;
  now?: Date;
}): Promise<ProjectDiscovery> {
  if (args.roots.length === 0) {
    throw new Error(
      "projects discover requires at least one explicit --root; home-wide discovery is never implicit"
    );
  }
  const roots = [...new Set(args.roots.map((root) => resolve(root)))];
  const maxVisits = args.maxVisits ?? DEFAULT_MAX_VISITS;
  const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;
  if (maxVisits < 1 || maxResults < 1) {
    throw new Error("discovery bounds must be positive integers");
  }
  const cutoff = parseSince(args.since, args.now ?? new Date());
  const discovered = await discoverGitRoots({ roots, maxVisits, maxResults });
  const homeDir = resolve(args.homeDir ?? process.env.HOME ?? homedir());
  const stabilizationContext: RepositoryStabilizationContext = {
    registry: await loadRegistry(homeDir),
    portableAliasProofs: new Map(),
  };
  const inspected = await Promise.all(
    discovered.roots.map(async (root) => {
      try {
        return await inspectRepository(root, homeDir, {
          stabilizationContext,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Not a Git repository:")
        ) {
          return null;
        }
        throw error;
      }
    })
  );
  const projects = inspected
    .filter((project): project is DiscoveredProject => project !== null)
    .filter((project) => {
      if (!cutoff) {
        return true;
      }
      return (
        project.lastCommitAt !== null &&
        new Date(project.lastCommitAt).getTime() >= cutoff.getTime()
      );
    })
    .sort((left, right) => left.root.localeCompare(right.root));
  const grouped = new Map<string, string[]>();
  for (const project of projects) {
    const locations = grouped.get(project.identity.id) ?? [];
    locations.push(project.root);
    grouped.set(project.identity.id, locations);
  }
  for (const project of projects) {
    project.duplicateLocations = grouped.get(project.identity.id)?.length ?? 1;
  }
  return {
    version: 1,
    roots,
    since: args.since ?? null,
    bounds: {
      maxVisits,
      maxResults,
      visited: discovered.visited,
      truncated: discovered.truncated,
    },
    projects,
    groups: [...grouped.entries()]
      .map(([repositoryId, locations]) => ({
        repositoryId,
        locations: locations.sort(),
      }))
      .sort((left, right) =>
        left.repositoryId.localeCompare(right.repositoryId)
      ),
  };
}

function appendProtectiveIgnore(existing: string | null): string {
  const lines = existing?.replace(/\r\n/g, "\n").split("\n") ?? [];
  const protectedLines = new Set(PROTECTIVE_IGNORE_LINES);
  const out = lines.filter((line) => !protectedLines.has(line));
  while (out.at(-1) === "") {
    out.pop();
  }
  if (out.length > 0) {
    out.push("");
  }
  out.push(...PROTECTIVE_IGNORE_LINES);
  return `${out.join("\n")}\n`;
}

async function hasEffectiveProtectiveIgnore(
  projectRoot: string
): Promise<boolean> {
  const expectedSource = join(projectRoot, ".ai", ".gitignore");
  for (const pathValue of [
    ".ai/.facult/fclt-protective-probe",
    ".ai/.facult/nested/fclt-protective-probe",
    ".ai/.facult/nested/fclt-protective-probe.toml",
    ".ai/config.local.toml",
  ]) {
    const result = await runGit({
      cwd: projectRoot,
      argv: ["check-ignore", "-v", "-z", "--no-index", "--stdin"],
      stdin: `${pathValue}\0`,
    });
    if (result.exitCode !== 0) {
      return false;
    }
    const [source, line, pattern, matchedPath, ...extra] =
      result.stdout.split("\0");
    if (
      !(source && line) ||
      pattern === undefined ||
      pattern.startsWith("!") ||
      matchedPath !== pathValue ||
      extra.some(Boolean) ||
      resolve(projectRoot, source) !== expectedSource
    ) {
      return false;
    }
  }
  return true;
}

async function assertSafeCanonicalTargets(
  projectRoot: string,
  aiRoot: string
): Promise<void> {
  const aiStat = await lstat(aiRoot).catch(() => null);
  if (aiStat?.isSymbolicLink() || (aiStat && !aiStat.isDirectory())) {
    throw new Error(`Refusing unsafe project AI root: ${aiRoot}`);
  }
  const resolvedParent = await realpath(dirname(aiRoot));
  if (resolvedParent !== projectRoot) {
    throw new Error(`Project AI root escapes the repository: ${aiRoot}`);
  }
  for (const name of [".gitignore", "config.toml"]) {
    const target = join(aiRoot, name);
    const targetStat = await lstat(target).catch(() => null);
    if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
      throw new Error(`Refusing unsafe canonical project file: ${target}`);
    }
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderProjectConfig(args: {
  repositoryId: string;
  sources: ProjectSource[];
  guidance: string[];
  cadence: ProjectCadence;
  scheduling: boolean;
}): string {
  const stringArray = (values: string[]) =>
    `[${values.map((value) => tomlString(value)).join(", ")}]`;
  const projectTable = [
    "[project]",
    `repository_id = ${tomlString(args.repositoryId)}`,
    `sources = ${stringArray(args.sources)}`,
    `guidance = ${stringArray(args.guidance)}`,
    `cadence = ${tomlString(args.cadence)}`,
    `scheduling = ${args.scheduling ? "true" : "false"}`,
    "managed_rendering = false",
    "",
  ].join("\n");
  return ["version = 1", "", projectTable].join("\n");
}

type TomlMultilineString = "basic" | "literal" | null;

function tomlTableHeader(line: string): {
  array: boolean;
  name: string;
} | null {
  const content = line.trimStart();
  if (!content.startsWith("[")) {
    return null;
  }
  const array = content.startsWith("[[");
  const nameStart = array ? 2 : 1;
  let quote: "basic" | "literal" | null = null;
  for (let index = nameStart; index < content.length; index += 1) {
    const character = content[index];
    if (quote === "basic") {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "literal") {
      if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"') {
      quote = "basic";
      continue;
    }
    if (character === "'") {
      quote = "literal";
      continue;
    }
    const closes = array
      ? character === "]" && content[index + 1] === "]"
      : character === "]";
    if (!closes) {
      continue;
    }
    const trailing = content.slice(index + (array ? 2 : 1)).trimStart();
    if (trailing.length > 0 && !trailing.startsWith("#")) {
      return null;
    }
    return {
      array,
      name: content.slice(nameStart, index).trim(),
    };
  }
  return null;
}

function hasUnescapedDelimiter(
  line: string,
  index: number,
  delimiter: '"""' | "'''"
): boolean {
  if (!line.startsWith(delimiter, index)) {
    return false;
  }
  if (delimiter === "'''") {
    return true;
  }
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && line[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function nextTomlMultilineStringState(
  line: string,
  initial: TomlMultilineString
): TomlMultilineString {
  let state = initial;
  let index = 0;
  while (index < line.length) {
    if (state) {
      const delimiter = state === "basic" ? '"""' : "'''";
      if (hasUnescapedDelimiter(line, index, delimiter)) {
        state = null;
        index += delimiter.length;
      } else {
        index += 1;
      }
      continue;
    }
    const character = line[index];
    if (character === "#") {
      break;
    }
    if (character === '"') {
      if (line.startsWith('"""', index)) {
        state = "basic";
        index += 3;
        continue;
      }
      index += 1;
      while (index < line.length) {
        if (line[index] === "\\") {
          index += 2;
        } else if (line[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (character === "'") {
      if (line.startsWith("'''", index)) {
        state = "literal";
        index += 3;
        continue;
      }
      const closing = line.indexOf("'", index + 1);
      index = closing < 0 ? line.length : closing + 1;
      continue;
    }
    index += 1;
  }
  return state;
}

function projectTableRange(lines: string[]): {
  end: number;
  start: number;
} | null {
  const headers: Array<{
    array: boolean;
    index: number;
    name: string;
  }> = [];
  let multilineState: TomlMultilineString = null;
  for (const [index, line] of lines.entries()) {
    if (!multilineState) {
      const header = tomlTableHeader(line);
      if (header) {
        headers.push({ ...header, index });
      }
    }
    multilineState = nextTomlMultilineStringState(line, multilineState);
  }
  const projectHeaderIndex = headers.findIndex((header) =>
    isOwnedProjectTomlTable(header)
  );
  if (projectHeaderIndex < 0) {
    return null;
  }
  const header = headers[projectHeaderIndex];
  if (!header) {
    return null;
  }
  return {
    start: header.index,
    end: headers[projectHeaderIndex + 1]?.index ?? lines.length,
  };
}

function isOwnedProjectTomlTable(header: {
  array: boolean;
  name: string;
}): boolean {
  if (header.array) {
    return false;
  }
  try {
    const parsed = Bun.TOML.parse(
      `[${header.name}]\n__fclt_owned_project_table__ = true\n`
    ) as Record<string, unknown>;
    return (
      Object.keys(parsed).length === 1 &&
      isRecord(parsed.project) &&
      Object.keys(parsed.project).length === 1 &&
      parsed.project.__fclt_owned_project_table__ === true
    );
  } catch {
    return false;
  }
}

function mergeProjectConfig(
  existing: string | null,
  enrollmentConfig: string
): string {
  if (existing === null || existing === enrollmentConfig) {
    return enrollmentConfig;
  }
  if (privacyFindings(existing).length > 0) {
    throw new Error(
      "Refusing to modify existing canonical project config with privacy findings"
    );
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(existing);
  } catch {
    throw new Error("Refusing to modify invalid canonical project config");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== 1
  ) {
    throw new Error(
      "Refusing to modify canonical project config without version = 1"
    );
  }
  const parsedRecord = parsed as Record<string, unknown>;
  if (!("project" in parsedRecord)) {
    const projectTable = enrollmentConfig.slice(
      enrollmentConfig.indexOf("[project]")
    );
    return `${existing.trimEnd()}\n\n${projectTable}`;
  }
  const project = parsedRecord.project;
  const enrollment = Bun.TOML.parse(enrollmentConfig) as Record<
    string,
    unknown
  >;
  const nextProject = enrollment.project;
  if (
    !(isRecord(project) && isRecord(nextProject)) ||
    Object.keys(project).sort().join("\0") !== PROJECT_CONFIG_KEYS.join("\0") ||
    project.repository_id !== nextProject.repository_id ||
    !Array.isArray(project.sources) ||
    project.sources.some(
      (source) => typeof source !== "string" || !PROJECT_SOURCES.has(source)
    ) ||
    !Array.isArray(project.guidance) ||
    project.guidance.some(
      (pathValue) =>
        typeof pathValue !== "string" ||
        ensureRepoRelativeMarkdown(pathValue) !== pathValue
    ) ||
    typeof project.cadence !== "string" ||
    !PROJECT_CADENCES.has(project.cadence) ||
    typeof project.scheduling !== "boolean" ||
    project.managed_rendering !== false
  ) {
    throw new Error(
      "Refusing to update an invalid canonical project enrollment config"
    );
  }
  const projectTable = enrollmentConfig.slice(
    enrollmentConfig.indexOf("[project]")
  );
  const lines = existing.split(LINE_SPLIT_RE);
  const tableRange = projectTableRange(lines);
  if (!tableRange) {
    throw new Error(
      "Refusing to update canonical project config without an owned [project] section"
    );
  }
  const before = lines.slice(0, tableRange.start).join("\n").trimEnd();
  const after = lines.slice(tableRange.end).join("\n").trim();
  return [before, projectTable.trimEnd(), after]
    .filter((section) => section.length > 0)
    .join("\n\n")
    .concat("\n");
}

function privacyFindings(
  content: string,
  options?: { gitIgnorePatterns?: boolean }
): string[] {
  const findings: string[] = [];
  if (
    SECRET_SHAPE_RE.test(content) ||
    STANDALONE_CREDENTIAL_RE.test(content) ||
    GITHUB_STATELESS_TOKEN_RE.test(content) ||
    PRIVATE_KEY_RE.test(content)
  ) {
    findings.push("secret-shaped content");
  }
  const filteredContent = options?.gitIgnorePatterns
    ? content
        .split(LINE_SPLIT_RE)
        .filter((line) => {
          const pattern = line.trim().replace(LEADING_NEGATION_RE, "");
          return pattern.length === 0 || pattern.startsWith("#");
        })
        .join("\n")
    : content;
  const pathContent = filteredContent
    .replace(WEB_URL_TOKEN_RE, "")
    .replace(MARKDOWN_REFERENCE_ROOT_URL_RE, "")
    .replace(MARKDOWN_ROOT_URL_RE, "]()")
    .replace(ROOT_URL_ATTRIBUTE_RE, "");
  if (
    LOCAL_UNIX_ABSOLUTE_PATH_RE.test(pathContent) ||
    LOCAL_WINDOWS_DRIVE_PATH_RE.test(pathContent) ||
    LOCAL_WINDOWS_UNC_PATH_RE.test(pathContent)
  ) {
    findings.push("machine-local absolute path");
  }
  return findings;
}

function ensureRepoRelativeMarkdown(value: string): string {
  if (
    !value ||
    isAbsolute(value) ||
    value.split(PATH_PART_SPLIT_RE).includes("..") ||
    !value.toLowerCase().endsWith(".md")
  ) {
    throw new Error(
      `Guidance must be a repository-relative Markdown path: ${value}`
    );
  }
  const normalized = value.split(PATH_PART_SPLIT_RE).join("/");
  if (normalized.startsWith(".ai/.facult/") || normalized.startsWith(".git/")) {
    throw new Error(
      `Generated or Git-internal guidance cannot be adopted: ${value}`
    );
  }
  return normalized;
}

async function previewGuidance(args: {
  beforeRead?: () => Promise<void>;
  projectRoot: string;
  paths: string[];
}): Promise<GuidancePreview[]> {
  const previews: GuidancePreview[] = [];
  for (const rawPath of args.paths) {
    const pathValue = ensureRepoRelativeMarkdown(rawPath);
    const absolutePath = resolve(args.projectRoot, pathValue);
    const rel = relative(args.projectRoot, absolutePath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Guidance is outside the repository: ${rawPath}`);
    }
    const guidanceStat = await lstatIfExists(absolutePath);
    if (!guidanceStat?.isFile() || guidanceStat.isSymbolicLink()) {
      throw new Error(
        `Refusing guidance adoption from ${pathValue}: the source must be a regular file`
      );
    }
    const indexEntry = await runGit({
      cwd: args.projectRoot,
      argv: ["ls-files", "--stage", "-v", "--", pathValue],
    });
    const indexBlob = await runGit({
      cwd: args.projectRoot,
      argv: ["rev-parse", "--verify", `:${pathValue}`],
    });
    const headBlob = await runGit({
      cwd: args.projectRoot,
      argv: ["rev-parse", "--verify", `HEAD:${pathValue}`],
    });
    await args.beforeRead?.();
    const handle = await open(
      absolutePath,
      constants.O_RDONLY +
        (constants.O_NOFOLLOW ?? 0) +
        (constants.O_NONBLOCK ?? 0)
    ).catch(() => {
      throw new Error(
        `Refusing guidance adoption from ${pathValue}: the source changed before read`
      );
    });
    let content: string;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.isSymbolicLink() ||
        opened.nlink !== 1 ||
        opened.dev !== guidanceStat.dev ||
        opened.ino !== guidanceStat.ino
      ) {
        throw new Error(
          `Refusing guidance adoption from ${pathValue}: the source changed before read`
        );
      }
      content = await handle.readFile("utf8");
      const afterRead = await handle.stat();
      const rebound = await lstatIfExists(absolutePath);
      if (
        !rebound ||
        rebound.isSymbolicLink() ||
        !rebound.isFile() ||
        rebound.nlink !== 1 ||
        afterRead.dev !== opened.dev ||
        afterRead.ino !== opened.ino ||
        afterRead.mode !== opened.mode ||
        afterRead.size !== opened.size ||
        afterRead.ctimeMs !== opened.ctimeMs ||
        afterRead.mtimeMs !== opened.mtimeMs ||
        rebound.dev !== afterRead.dev ||
        rebound.ino !== afterRead.ino ||
        rebound.mode !== afterRead.mode ||
        rebound.size !== afterRead.size ||
        rebound.ctimeMs !== afterRead.ctimeMs ||
        rebound.mtimeMs !== afterRead.mtimeMs
      ) {
        throw new Error(
          `Refusing guidance adoption from ${pathValue}: the source changed while reading`
        );
      }
    } finally {
      await handle.close();
    }
    const worktreeBlob = await runGit({
      cwd: args.projectRoot,
      argv: ["hash-object", "--stdin"],
      stdin: content,
    });
    const indexLines = indexEntry.stdout.split(LINE_SPLIT_RE).filter(Boolean);
    const indexIsOrdinary =
      indexEntry.exitCode === 0 &&
      indexLines.length === 1 &&
      GUIDANCE_INDEX_ENTRY_RE.test(indexLines[0] ?? "");
    const blobsMatch =
      indexBlob.exitCode === 0 &&
      headBlob.exitCode === 0 &&
      worktreeBlob.exitCode === 0 &&
      indexBlob.stdout === headBlob.stdout &&
      worktreeBlob.stdout === indexBlob.stdout;
    if (!(indexIsOrdinary && blobsMatch)) {
      throw new Error(
        `Refusing guidance adoption from ${pathValue}: the source must be ordinarily tracked and byte-for-byte clean in HEAD, the index, and the worktree`
      );
    }
    const findings = privacyFindings(content);
    if (findings.length > 0) {
      throw new Error(
        `Refusing guidance adoption from ${pathValue}: ${findings.join(", ")}`
      );
    }
    previews.push({
      path: pathValue,
      sha256: sha256(content),
      content,
      gitState: "clean-tracked",
      adoption: "reference",
    });
  }
  return previews;
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function projectRegistryPath(homeDir: string): string {
  return join(facultLocalStateRoot(homeDir), "projects", "registry.json");
}

function projectReceiptsDir(homeDir: string): string {
  return join(facultLocalStateRoot(homeDir), "projects", "receipts");
}

function executionMachineStateDir(homeDir: string, aiRoot: string): string {
  return join(
    facultLocalStateRoot(homeDir),
    "projects",
    executionMachineStateProjectKey(aiRoot, homeDir)
  );
}

function projectMutationLockPath(homeDir: string): string {
  return join(facultLocalStateRoot(homeDir), "projects", "mutation.lock");
}

interface ProjectStateMigration {
  commit: () => Promise<void>;
  restore: () => Promise<void>;
}

interface ProjectStateTreeEntry {
  path: string;
  type: "directory" | "file";
  mode: number;
  size?: number;
  sha256?: string;
}

interface ProjectStateTree {
  entries: ProjectStateTreeEntry[];
  sha256: string;
}

async function hashProjectStateFile(
  pathValue: string,
  expectedSize: number
): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(pathValue)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  if (bytes !== expectedSize) {
    throw new Error(`Project state file changed while hashing: ${pathValue}`);
  }
  return hash.digest("hex");
}

async function inspectProjectStateTree(
  root: string
): Promise<ProjectStateTree> {
  const entries: ProjectStateTreeEntry[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativePath: string) => {
    const before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`Refusing unsafe project state directory: ${directory}`);
    }
    entries.push({
      path: relativePath || ".",
      type: "directory",
      mode: permissionMode(before.mode),
    });
    const children = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name)
    );
    for (const child of children) {
      if (entries.length >= PROJECT_STATE_TREE_MAX_ENTRIES) {
        throw new Error(
          `Project state tree exceeds ${PROJECT_STATE_TREE_MAX_ENTRIES} entries: ${root}`
        );
      }
      const childPath = join(directory, child.name);
      const childRelative = relativePath
        ? `${relativePath}/${child.name}`
        : child.name;
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing symlinked project state: ${childPath}`);
      }
      if (metadata.isDirectory()) {
        await visit(childPath, childRelative);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`Refusing unsafe project state file: ${childPath}`);
      }
      totalBytes += metadata.size;
      if (totalBytes > PROJECT_STATE_TREE_MAX_BYTES) {
        throw new Error(
          `Project state tree exceeds ${PROJECT_STATE_TREE_MAX_BYTES} bytes: ${root}`
        );
      }
      const digest = await hashProjectStateFile(childPath, metadata.size);
      const after = await lstat(childPath);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.nlink !== 1 ||
        after.dev !== metadata.dev ||
        after.ino !== metadata.ino ||
        after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs
      ) {
        throw new Error(
          `Project state file changed while inspecting: ${childPath}`
        );
      }
      entries.push({
        path: childRelative,
        type: "file",
        mode: permissionMode(metadata.mode),
        size: metadata.size,
        sha256: digest,
      });
    }
    const after = await lstat(directory);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(
        `Project state directory changed while inspecting: ${directory}`
      );
    }
  };
  await visit(root, "");
  return {
    entries,
    sha256: sha256(stableJson(entries)),
  };
}

function assertDisjointProjectStateTrees(args: {
  allowRebuildableOverlaps?: boolean;
  destination: ProjectStateTree;
  destinationPath: string;
  source: ProjectStateTree;
  sourcePath: string;
}): string[] {
  const destinationEntries = new Map(
    args.destination.entries.map((entry) => [entry.path, entry])
  );
  const rebuildableOverlaps: string[] = [];
  for (const sourceEntry of args.source.entries) {
    if (sourceEntry.path === ".") {
      continue;
    }
    const destinationEntry = destinationEntries.get(sourceEntry.path);
    if (!destinationEntry) {
      continue;
    }
    if (
      sourceEntry.type === "directory" &&
      destinationEntry.type === "directory"
    ) {
      continue;
    }
    if (
      sourceEntry.type === "file" &&
      destinationEntry.type === "file" &&
      args.allowRebuildableOverlaps === true &&
      REBUILDABLE_PROJECT_STATE_PATHS.has(sourceEntry.path)
    ) {
      rebuildableOverlaps.push(sourceEntry.path);
      continue;
    }
    throw new Error(
      `Refusing conflicting legacy and selected project state at ${sourceEntry.path}: ${args.sourcePath} and ${args.destinationPath}`
    );
  }
  return rebuildableOverlaps.sort();
}

async function removeUnreviewedEmptyStateDirectories(
  root: string,
  reviewedEntries: ProjectStateTreeEntry[]
): Promise<void> {
  const reviewed = new Set(reviewedEntries.map((entry) => entry.path));
  const current = await inspectProjectStateTree(root);
  const extraFiles = current.entries.filter(
    (entry) => entry.type === "file" && !reviewed.has(entry.path)
  );
  if (extraFiles.length > 0) {
    throw new Error(
      `Project state gained unreviewed files during migration: ${extraFiles
        .map((entry) => join(root, entry.path))
        .join(", ")}`
    );
  }
  const extraDirectories = current.entries
    .filter(
      (entry) =>
        entry.type === "directory" &&
        entry.path !== "." &&
        !reviewed.has(entry.path)
    )
    .sort(
      (left, right) =>
        right.path.split("/").length - left.path.split("/").length ||
        right.path.localeCompare(left.path)
    );
  for (const directory of extraDirectories) {
    await rmdir(join(root, directory.path));
  }
}

async function planLegacyProjectStateMigrations(args: {
  aiRoot: string;
  homeDir: string;
  legacyAiRoots: string[];
}): Promise<ProjectStateMigrationPlanEntry[]> {
  const projectsRoot = join(facultLocalStateRoot(args.homeDir), "projects");
  const selectedKey = executionMachineStateProjectKey(
    args.aiRoot,
    args.homeDir
  );
  const legacyKeys = uniqueSorted(
    args.legacyAiRoots.map((root) =>
      legacyMachineStateProjectKey(root, args.homeDir)
    )
  ).filter((key) => key !== selectedKey);
  if (!selectedKey || legacyKeys.length === 0) {
    return [];
  }
  const globalRoot = preferredGlobalAiRoot(args.homeDir);
  const candidates: Array<
    Pick<
      ProjectStateMigrationPlanEntry,
      "source" | "destination" | "reason"
    > & { allowRebuildableOverlaps?: boolean }
  > = legacyKeys.flatMap((legacyKey) => [
    {
      source: join(projectsRoot, legacyKey),
      destination: join(projectsRoot, selectedKey),
      reason:
        "Preserve legacy path-keyed project runtime, journal, managed, and autosync state.",
      allowRebuildableOverlaps: true,
    },
    ...(["writebacks", "evolution", "reconciliation"] as const).map(
      (artifactDir) => ({
        source: join(globalRoot, artifactDir, "projects", legacyKey),
        destination: join(globalRoot, artifactDir, "projects", selectedKey),
        reason: `Preserve legacy path-keyed ${artifactDir} review mirrors.`,
      })
    ),
  ]);
  const planned: ProjectStateMigrationPlanEntry[] = [];
  const claimedDestinations = new Map<string, string>();
  for (const candidate of candidates) {
    const source = await lstatIfExists(candidate.source);
    if (!source) {
      continue;
    }
    if (source.isSymbolicLink() || !source.isDirectory()) {
      throw new Error(
        `Refusing unsafe legacy project state: ${candidate.source}`
      );
    }
    const claimedSource = claimedDestinations.get(candidate.destination);
    if (claimedSource) {
      throw new Error(
        `Refusing multiple legacy project state sources for ${candidate.destination}: ${claimedSource} and ${candidate.source}`
      );
    }
    claimedDestinations.set(candidate.destination, candidate.source);
    const sourceTree = await inspectProjectStateTree(candidate.source);
    const destination = await lstatIfExists(candidate.destination);
    if (!destination) {
      planned.push({
        ...candidate,
        strategy: "rename",
        sourceTreeSha256: sourceTree.sha256,
        destinationTreeSha256: null,
        rebuildableOverlaps:
          candidate.allowRebuildableOverlaps === true
            ? sourceTree.entries
                .filter(
                  (entry) =>
                    entry.type === "file" &&
                    REBUILDABLE_PROJECT_STATE_PATHS.has(entry.path)
                )
                .map((entry) => entry.path)
                .sort()
            : [],
      });
      continue;
    }
    if (destination.isSymbolicLink() || !destination.isDirectory()) {
      throw new Error(
        `Refusing unsafe selected project state: ${candidate.destination}`
      );
    }
    const destinationTree = await inspectProjectStateTree(
      candidate.destination
    );
    const rebuildableOverlaps = assertDisjointProjectStateTrees({
      allowRebuildableOverlaps: candidate.allowRebuildableOverlaps,
      source: sourceTree,
      sourcePath: candidate.source,
      destination: destinationTree,
      destinationPath: candidate.destination,
    });
    planned.push({
      ...candidate,
      strategy: "merge-disjoint",
      sourceTreeSha256: sourceTree.sha256,
      destinationTreeSha256: destinationTree.sha256,
      rebuildableOverlaps,
    });
  }
  return planned;
}

async function migrateLegacyProjectState(args: {
  afterQuarantine?: (args: {
    destination: string;
    index: number;
    quarantine: string;
    source: string;
  }) => Promise<void>;
  beforeQuarantine?: (args: {
    destination: string;
    index: number;
    quarantine: string;
    source: string;
  }) => Promise<void>;
  expected: ProjectStateMigrationPlanEntry[];
  beforeRename?: (args: {
    destination: string;
    index: number;
    source: string;
  }) => Promise<void>;
  beforeRestore?: (args: {
    destination: string;
    index: number;
    source: string;
  }) => Promise<void>;
}): Promise<ProjectStateMigration | null> {
  const planned: Array<
    ProjectStateMigrationPlanEntry & {
      destinationDev: number | null;
      destinationEntries: ProjectStateTreeEntry[] | null;
      destinationIno: number | null;
      sourceEntries: ProjectStateTreeEntry[];
      sourceDev: number;
      sourceIno: number;
    }
  > = [];
  for (const candidate of args.expected) {
    const source = await lstatIfExists(candidate.source);
    if (!source || source.isSymbolicLink() || !source.isDirectory()) {
      throw new Error(
        `Reviewed legacy project state migration is stale: ${candidate.source}`
      );
    }
    const sourceTree = await inspectProjectStateTree(candidate.source);
    if (sourceTree.sha256 !== candidate.sourceTreeSha256) {
      throw new Error(
        `Reviewed legacy project state migration is stale: ${candidate.source}`
      );
    }
    const destination = await lstatIfExists(candidate.destination);
    if (candidate.strategy === "rename" && destination) {
      throw new Error(
        `Reviewed legacy project state migration is stale: ${candidate.destination}`
      );
    }
    if (
      candidate.strategy === "merge-disjoint" &&
      (!destination ||
        destination.isSymbolicLink() ||
        !destination.isDirectory())
    ) {
      throw new Error(
        `Reviewed legacy project state migration is stale: ${candidate.destination}`
      );
    }
    const destinationTree =
      candidate.strategy === "merge-disjoint" && destination
        ? await inspectProjectStateTree(candidate.destination)
        : null;
    if (destinationTree) {
      if (destinationTree.sha256 !== candidate.destinationTreeSha256) {
        throw new Error(
          `Reviewed legacy project state migration is stale: ${candidate.destination}`
        );
      }
      const rebuildableOverlaps = assertDisjointProjectStateTrees({
        allowRebuildableOverlaps: candidate.rebuildableOverlaps.length > 0,
        source: sourceTree,
        sourcePath: candidate.source,
        destination: destinationTree,
        destinationPath: candidate.destination,
      });
      if (
        stableJson(rebuildableOverlaps) !==
        stableJson(candidate.rebuildableOverlaps)
      ) {
        throw new Error(
          `Reviewed legacy project state migration is stale: ${candidate.source}`
        );
      }
    }
    planned.push({
      ...candidate,
      sourceDev: source.dev,
      sourceIno: source.ino,
      sourceEntries: sourceTree.entries,
      destinationDev: destination?.dev ?? null,
      destinationIno: destination?.ino ?? null,
      destinationEntries: destinationTree?.entries ?? null,
    });
  }
  if (args.expected.length === 0) {
    return null;
  }
  type MovedPath = {
    dev: number;
    ino: number;
    relativePath: string;
  };
  type RebuildableFileBackup = {
    contents: Uint8Array;
    mode: number;
    relativePath: string;
    sha256: string;
  };
  type QuarantinedSource = {
    dev: number;
    files: RebuildableFileBackup[];
    ino: number;
    path: string;
  };
  type CompletedMigration = (typeof planned)[number] & {
    movedPaths: MovedPath[];
    quarantine: QuarantinedSource | null;
  };
  const completed: CompletedMigration[] = [];
  let commitStarted = false;

  const mergeDisjoint = async (
    source: string,
    destination: string,
    relativePath: string,
    movedPaths: MovedPath[],
    rebuildableOverlaps: Set<string>
  ): Promise<void> => {
    const entries = (await readdir(source, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const childRelative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      const sourceMetadata = await lstat(sourcePath);
      const destinationMetadata = await lstatIfExists(destinationPath);
      if (!destinationMetadata) {
        await rename(sourcePath, destinationPath);
        movedPaths.push({
          relativePath: childRelative,
          dev: sourceMetadata.dev,
          ino: sourceMetadata.ino,
        });
        continue;
      }
      if (
        sourceMetadata.isDirectory() &&
        !sourceMetadata.isSymbolicLink() &&
        destinationMetadata.isDirectory() &&
        !destinationMetadata.isSymbolicLink()
      ) {
        await mergeDisjoint(
          sourcePath,
          destinationPath,
          childRelative,
          movedPaths,
          rebuildableOverlaps
        );
        continue;
      }
      if (
        rebuildableOverlaps.has(childRelative) &&
        sourceMetadata.isFile() &&
        !sourceMetadata.isSymbolicLink() &&
        sourceMetadata.nlink === 1 &&
        destinationMetadata.isFile() &&
        !destinationMetadata.isSymbolicLink() &&
        destinationMetadata.nlink === 1
      ) {
        continue;
      }
      throw new Error(
        `Project state changed during disjoint merge: ${sourcePath}`
      );
    }
  };

  const assertReviewedMergeRemainder = (
    entry: CompletedMigration,
    remaining: ProjectStateTree
  ): void => {
    const remainingFiles = remaining.entries.filter(
      (item) => item.type === "file"
    );
    const expectedFiles = entry.sourceEntries.filter(
      (item) =>
        item.type === "file" && entry.rebuildableOverlaps.includes(item.path)
    );
    if (
      stableJson(remainingFiles) !== stableJson(expectedFiles) ||
      stableJson(remainingFiles.map((item) => item.path).sort()) !==
        stableJson(entry.rebuildableOverlaps)
    ) {
      throw new Error(
        `Legacy project state merge left unreviewed content: ${entry.source}`
      );
    }
  };

  const captureRebuildableFiles = async (
    entry: CompletedMigration
  ): Promise<RebuildableFileBackup[]> => {
    const backups: RebuildableFileBackup[] = [];
    for (const relativePath of entry.rebuildableOverlaps) {
      const reviewed = entry.sourceEntries.find(
        (item) => item.type === "file" && item.path === relativePath
      );
      if (
        !reviewed ||
        reviewed.sha256 === undefined ||
        reviewed.size === undefined
      ) {
        throw new Error(
          `Reviewed rebuildable project state is missing: ${join(entry.source, relativePath)}`
        );
      }
      const pathValue = join(entry.source, relativePath);
      const before = await lstat(pathValue);
      const contents = await readFile(pathValue);
      const after = await lstat(pathValue);
      const digest = createHash("sha256").update(contents).digest("hex");
      if (
        before.isSymbolicLink() ||
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.size !== reviewed.size ||
        permissionMode(before.mode) !== reviewed.mode ||
        digest !== reviewed.sha256
      ) {
        throw new Error(
          `Rebuildable project state changed before quarantine: ${pathValue}`
        );
      }
      backups.push({
        contents,
        mode: reviewed.mode,
        relativePath,
        sha256: reviewed.sha256,
      });
    }
    return backups;
  };

  const removeEmptyStateTree = async (root: string): Promise<void> => {
    const tree = await inspectProjectStateTree(root);
    if (tree.entries.some((item) => item.type === "file")) {
      throw new Error(
        `Quarantined legacy project state still contains files: ${root}`
      );
    }
    for (const directory of tree.entries
      .filter((item) => item.type === "directory" && item.path !== ".")
      .sort(
        (left, right) =>
          right.path.split("/").length - left.path.split("/").length ||
          right.path.localeCompare(left.path)
      )) {
      await rmdir(join(root, directory.path));
    }
    await rmdir(root);
  };

  const treeContainsReviewedEntries = (
    tree: ProjectStateTree,
    reviewed: ProjectStateTreeEntry[],
    replaceable: ReadonlySet<string> = new Set()
  ): boolean => {
    const current = new Map(tree.entries.map((entry) => [entry.path, entry]));
    return reviewed.every(
      (entry) =>
        replaceable.has(entry.path) ||
        stableJson(current.get(entry.path)) === stableJson(entry)
    );
  };

  const restoreQuarantinedSource = async (
    entry: CompletedMigration
  ): Promise<void> => {
    const quarantine = entry.quarantine;
    if (!quarantine) {
      return;
    }
    const source = await lstatIfExists(entry.source);
    if (source && (source.isSymbolicLink() || !source.isDirectory())) {
      throw new Error(
        `Legacy project state path was recreated unsafely during compensation: ${entry.source}`
      );
    }
    const quarantined = await lstatIfExists(quarantine.path);
    if (quarantined) {
      if (
        quarantined.isSymbolicLink() ||
        !quarantined.isDirectory() ||
        quarantined.dev !== quarantine.dev ||
        quarantined.ino !== quarantine.ino
      ) {
        throw new Error(
          `Quarantined legacy project state changed before compensation: ${quarantine.path}`
        );
      }
      if (source) {
        await mergeDisjoint(quarantine.path, entry.source, "", [], new Set());
        await removeEmptyStateTree(quarantine.path);
      } else {
        await rename(quarantine.path, entry.source);
      }
    } else if (!source) {
      await mkdir(entry.source, { recursive: true, mode: 0o700 });
    }
  };

  const compensate = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const [reverseIndex, entry] of completed.toReversed().entries()) {
      try {
        await args.beforeRestore?.({
          ...entry,
          index: completed.length - reverseIndex - 1,
        });
        const destination = await lstatIfExists(entry.destination);
        if (
          !destination ||
          destination.isSymbolicLink() ||
          !destination.isDirectory() ||
          (entry.strategy === "rename" &&
            (destination.dev !== entry.sourceDev ||
              destination.ino !== entry.sourceIno)) ||
          (entry.strategy === "merge-disjoint" &&
            (destination.dev !== entry.destinationDev ||
              destination.ino !== entry.destinationIno))
        ) {
          throw new Error(
            `Migrated project state destination changed before compensation: ${entry.destination}`
          );
        }
        if (entry.strategy === "rename") {
          const source = await lstatIfExists(entry.source);
          if (source) {
            if (source.isSymbolicLink() || !source.isDirectory()) {
              throw new Error(
                `Legacy project state path was recreated unsafely during compensation: ${entry.source}`
              );
            }
            const sourceTree = await inspectProjectStateTree(entry.source);
            const destinationTree = await inspectProjectStateTree(
              entry.destination
            );
            assertDisjointProjectStateTrees({
              allowRebuildableOverlaps: false,
              source: destinationTree,
              sourcePath: entry.destination,
              destination: sourceTree,
              destinationPath: entry.source,
            });
            await mergeDisjoint(
              entry.destination,
              entry.source,
              "",
              [],
              new Set()
            );
            await removeEmptyStateTree(entry.destination);
            if (
              !treeContainsReviewedEntries(
                await inspectProjectStateTree(entry.source),
                entry.sourceEntries
              )
            ) {
              throw new Error(
                `Migrated project state destination changed before compensation: ${entry.destination}`
              );
            }
          } else {
            await removeUnreviewedEmptyStateDirectories(
              entry.destination,
              entry.sourceEntries
            );
            if (
              (await inspectProjectStateTree(entry.destination)).sha256 !==
              entry.sourceTreeSha256
            ) {
              throw new Error(
                `Migrated project state destination changed before compensation: ${entry.destination}`
              );
            }
            await rename(entry.destination, entry.source);
          }
          continue;
        }
        await restoreQuarantinedSource(entry);
        const source = await lstatIfExists(entry.source);
        if (!source) {
          if (!commitStarted) {
            throw new Error(
              `Legacy project state path disappeared before compensation: ${entry.source}`
            );
          }
          await mkdir(entry.source, { recursive: true, mode: 0o700 });
          const rootMode = entry.sourceEntries.find(
            (directory) => directory.path === "."
          )?.mode;
          if (rootMode !== undefined) {
            await chmod(entry.source, rootMode);
          }
        } else if (source.isSymbolicLink() || !source.isDirectory()) {
          throw new Error(
            `Legacy project state path changed before compensation: ${entry.source}`
          );
        }
        for (const movedPath of entry.movedPaths.toReversed()) {
          const destinationPath = join(
            entry.destination,
            movedPath.relativePath
          );
          const sourcePath = join(entry.source, movedPath.relativePath);
          if (await lstatIfExists(sourcePath)) {
            throw new Error(
              `Legacy project state path was recreated during compensation: ${sourcePath}`
            );
          }
          const moved = await lstatIfExists(destinationPath);
          if (
            !moved ||
            moved.isSymbolicLink() ||
            moved.dev !== movedPath.dev ||
            moved.ino !== movedPath.ino
          ) {
            throw new Error(
              `Merged project state changed before compensation: ${destinationPath}`
            );
          }
          await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 });
          await rename(destinationPath, sourcePath);
        }
        if (commitStarted) {
          for (const directory of entry.sourceEntries.filter(
            (item) => item.type === "directory"
          )) {
            if (directory.path !== ".") {
              await mkdir(join(entry.source, directory.path), {
                recursive: true,
                mode: directory.mode,
              });
              await chmod(join(entry.source, directory.path), directory.mode);
            }
          }
        }
        for (const backup of entry.quarantine?.files ?? []) {
          const pathValue = join(entry.source, backup.relativePath);
          const existing = await lstatIfExists(pathValue);
          if (existing) {
            if (
              existing.isSymbolicLink() ||
              !existing.isFile() ||
              existing.nlink !== 1 ||
              permissionMode(existing.mode) !== backup.mode ||
              createHash("sha256")
                .update(await readFile(pathValue))
                .digest("hex") !== backup.sha256
            ) {
              throw new Error(
                `Legacy rebuildable state was replaced during compensation: ${pathValue}`
              );
            }
            continue;
          }
          await mkdir(dirname(pathValue), {
            recursive: true,
            mode: 0o700,
          });
          await writeFile(pathValue, backup.contents, {
            mode: backup.mode,
          });
          await chmod(pathValue, backup.mode);
        }
        if (!entry.destinationEntries) {
          throw new Error(
            `Reviewed selected project state is missing: ${entry.destination}`
          );
        }
        await removeUnreviewedEmptyStateDirectories(
          entry.destination,
          entry.destinationEntries
        );
        const restoredSource = await inspectProjectStateTree(entry.source);
        if (
          !(
            restoredSource.sha256 === entry.sourceTreeSha256 ||
            treeContainsReviewedEntries(restoredSource, entry.sourceEntries)
          ) ||
          (await inspectProjectStateTree(entry.destination)).sha256 !==
            entry.destinationTreeSha256
        ) {
          throw new Error(
            `Merged project state changed before compensation: ${entry.source}`
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Legacy project state migration compensation was incomplete"
      );
    }
  };
  try {
    for (const [index, entry] of planned.entries()) {
      await args.beforeRename?.({ ...entry, index });
      const source = await lstatIfExists(entry.source);
      const sourceTree = source
        ? await inspectProjectStateTree(entry.source)
        : null;
      const destination = await lstatIfExists(entry.destination);
      if (
        !source ||
        source.isSymbolicLink() ||
        !source.isDirectory() ||
        source.dev !== entry.sourceDev ||
        source.ino !== entry.sourceIno ||
        sourceTree?.sha256 !== entry.sourceTreeSha256
      ) {
        throw new Error(
          `Project state changed during legacy migration: ${entry.source}`
        );
      }
      if (entry.strategy === "rename") {
        if (destination) {
          throw new Error(
            `Project state changed during legacy migration: ${entry.destination}`
          );
        }
        await rename(entry.source, entry.destination);
        completed.push({ ...entry, movedPaths: [], quarantine: null });
        continue;
      }
      if (
        !destination ||
        destination.isSymbolicLink() ||
        !destination.isDirectory() ||
        destination.dev !== entry.destinationDev ||
        destination.ino !== entry.destinationIno ||
        (await inspectProjectStateTree(entry.destination)).sha256 !==
          entry.destinationTreeSha256
      ) {
        throw new Error(
          `Project state changed during legacy migration: ${entry.destination}`
        );
      }
      const migration: CompletedMigration = {
        ...entry,
        movedPaths: [],
        quarantine: null,
      };
      completed.push(migration);
      await mergeDisjoint(
        entry.source,
        entry.destination,
        "",
        migration.movedPaths,
        new Set(entry.rebuildableOverlaps)
      );
    }
  } catch (error) {
    try {
      await compensate();
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        "Legacy project state migration failed and compensation was incomplete"
      );
    }
    throw error;
  }
  const commit = async () => {
    const assertRenameCommitBoundary = async (
      entry: CompletedMigration
    ): Promise<void> => {
      const destination = await lstatIfExists(entry.destination);
      if (
        (await lstatIfExists(entry.source)) ||
        !destination ||
        destination.isSymbolicLink() ||
        !destination.isDirectory() ||
        destination.dev !== entry.sourceDev ||
        destination.ino !== entry.sourceIno ||
        !treeContainsReviewedEntries(
          await inspectProjectStateTree(entry.destination),
          entry.sourceEntries,
          new Set(entry.rebuildableOverlaps)
        )
      ) {
        throw new Error(
          `Legacy project state changed before commit: ${entry.source}`
        );
      }
    };
    const pending = await Promise.all(
      completed.map(async (entry) => {
        if (entry.strategy === "rename") {
          await assertRenameCommitBoundary(entry);
          return {
            entry,
            kind: "rename" as const,
          };
        }
        const remaining = await inspectProjectStateTree(entry.source);
        assertReviewedMergeRemainder(entry, remaining);
        return {
          entry,
          files: await captureRebuildableFiles(entry),
          kind: "merge-disjoint" as const,
          remaining,
        };
      })
    );
    commitStarted = true;
    for (const [index, candidate] of pending.entries()) {
      if (candidate.kind === "rename") {
        await assertRenameCommitBoundary(candidate.entry);
        continue;
      }
      const { entry, files, remaining } = candidate;
      const quarantinePath = `${entry.source}.fclt-quarantine-${randomUUID()}`;
      await args.beforeQuarantine?.({
        destination: entry.destination,
        index,
        quarantine: quarantinePath,
        source: entry.source,
      });
      const source = await lstatIfExists(entry.source);
      if (
        !source ||
        source.isSymbolicLink() ||
        !source.isDirectory() ||
        source.dev !== entry.sourceDev ||
        source.ino !== entry.sourceIno ||
        (await inspectProjectStateTree(entry.source)).sha256 !==
          remaining.sha256 ||
        (await lstatIfExists(quarantinePath))
      ) {
        throw new Error(
          `Legacy project state changed before quarantine: ${entry.source}`
        );
      }
      await rename(entry.source, quarantinePath);
      entry.quarantine = {
        dev: entry.sourceDev,
        files,
        ino: entry.sourceIno,
        path: quarantinePath,
      };
      const quarantined = await lstatIfExists(quarantinePath);
      if (
        !quarantined ||
        quarantined.isSymbolicLink() ||
        !quarantined.isDirectory() ||
        quarantined.dev !== entry.sourceDev ||
        quarantined.ino !== entry.sourceIno ||
        (await inspectProjectStateTree(quarantinePath)).sha256 !==
          remaining.sha256 ||
        (await lstatIfExists(entry.source))
      ) {
        throw new Error(
          `Legacy project state changed at quarantine boundary: ${entry.source}`
        );
      }
      await args.afterQuarantine?.({
        destination: entry.destination,
        index,
        quarantine: quarantinePath,
        source: entry.source,
      });
      if (
        (await lstatIfExists(entry.source)) ||
        (await inspectProjectStateTree(quarantinePath)).sha256 !==
          remaining.sha256
      ) {
        throw new Error(
          `Legacy project state changed after quarantine: ${entry.source}`
        );
      }
      const assertQuarantineBinding = async (): Promise<void> => {
        const current = await lstatIfExists(quarantinePath);
        if (
          !current ||
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          current.dev !== entry.sourceDev ||
          current.ino !== entry.sourceIno
        ) {
          throw new Error(
            `Quarantined legacy project state binding changed: ${quarantinePath}`
          );
        }
      };
      for (const file of files) {
        if (await lstatIfExists(entry.source)) {
          throw new Error(
            `Legacy project state path reappeared during quarantine cleanup: ${entry.source}`
          );
        }
        await assertQuarantineBinding();
        await unlinkVerifiedFileAt({
          directoryPath: dirname(join(quarantinePath, file.relativePath)),
          expectedSha256: file.sha256,
          fileName: basename(file.relativePath),
          maxBytes: PROJECT_STATE_TREE_MAX_BYTES,
          safeRoot: quarantinePath,
        });
      }
      const directories = remaining.entries
        .filter((item) => item.type === "directory" && item.path !== ".")
        .sort(
          (left, right) =>
            right.path.split("/").length - left.path.split("/").length ||
            right.path.localeCompare(left.path)
        );
      for (const directory of directories) {
        if (await lstatIfExists(entry.source)) {
          throw new Error(
            `Legacy project state path reappeared during quarantine cleanup: ${entry.source}`
          );
        }
        await assertQuarantineBinding();
        await rmdir(join(quarantinePath, directory.path));
      }
      if (await lstatIfExists(entry.source)) {
        throw new Error(
          `Legacy project state path reappeared during quarantine cleanup: ${entry.source}`
        );
      }
      await assertQuarantineBinding();
      await rmdir(quarantinePath);
      if (await lstatIfExists(entry.source)) {
        throw new Error(
          `Legacy project state path reappeared after quarantine cleanup: ${entry.source}`
        );
      }
    }
    for (const candidate of pending) {
      if (candidate.kind === "rename") {
        await assertRenameCommitBoundary(candidate.entry);
      }
    }
  };
  return { commit, restore: compensate };
}

function emptyRegistry(): ProjectRegistry {
  return {
    version: 1,
    updatedAt: "",
    projects: {},
  };
}

function parseRegistryText(text: string, pathValue: string): ProjectRegistry {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.updatedAt === "string" &&
      isRecord(parsed.projects) &&
      Object.entries(parsed.projects).every(
        ([key, entry]) =>
          REPOSITORY_ID_RE.test(key) &&
          isReceiptRegistryEntry(entry) &&
          entry.repositoryId === key
      )
    ) {
      return parsed as unknown as ProjectRegistry;
    }
  } catch {
    // Fall through to the explicit corruption error.
  }
  throw new Error(`Project registry is invalid: ${pathValue}`);
}

async function loadRegistry(homeDir: string): Promise<ProjectRegistry> {
  const pathValue = projectRegistryPath(homeDir);
  const snapshot = await canonicalFileSnapshot(pathValue);
  if (!snapshot) {
    return emptyRegistry();
  }
  return parseRegistryText(snapshot.content, pathValue);
}

async function loadRegistrySnapshot(homeDir: string): Promise<{
  before: string | null;
  beforeIdentity: { dev: number; ino: number } | null;
  beforeMode: number | null;
  registry: ProjectRegistry;
}> {
  const pathValue = projectRegistryPath(homeDir);
  const snapshot = await canonicalFileSnapshot(pathValue);
  const before = snapshot?.content ?? null;
  return {
    before,
    beforeIdentity: snapshot
      ? { dev: snapshot.metadata.dev, ino: snapshot.metadata.ino }
      : null,
    beforeMode: snapshot ? permissionMode(snapshot.metadata.mode) : null,
    registry:
      before === null ? emptyRegistry() : parseRegistryText(before, pathValue),
  };
}

function registryEntryMatchesIdentity(args: {
  entry: ProjectRegistryEntry;
  identity: RepositoryIdentity;
  key: string;
  projectRoot?: string;
  verifiedPortableAliases?: ReadonlySet<string>;
}): boolean {
  const recordedPrimaryIds = new Set([args.key, args.entry.repositoryId]);
  if (recordedPrimaryIds.has(args.identity.id)) {
    return true;
  }
  const recordedIds = new Set([
    ...recordedPrimaryIds,
    ...(args.entry.aliases ?? []),
  ]);
  if (
    args.identity.stability === "portable" &&
    recordedIds.has(args.identity.id) &&
    args.verifiedPortableAliases?.has(args.identity.id)
  ) {
    return true;
  }
  const identityProofs = [
    repositoryIdentityAliasForPrimary(args.identity),
    ...args.identity.aliases,
  ];
  const matchingCommonDirectory = identityProofs.some(
    (alias) => alias.kind === "git-common-dir" && recordedIds.has(alias.id)
  );
  const matchingRootAlias = identityProofs.some(
    (alias) => alias.kind === "root-commit" && recordedIds.has(alias.id)
  );
  if (matchingCommonDirectory && matchingRootAlias) {
    return true;
  }
  return matchingCommonDirectory;
}

function registryStoredLocationMatchesIdentity(args: {
  entry: ProjectRegistryEntry;
  identity: RepositoryIdentity;
  key: string;
  verifiedPortableAliases?: ReadonlySet<string>;
}): boolean {
  const recordedPrimaryIds = new Set([args.key, args.entry.repositoryId]);
  if (recordedPrimaryIds.has(args.identity.id)) {
    return true;
  }
  const recordedIds = new Set([
    ...recordedPrimaryIds,
    ...(args.entry.aliases ?? []),
  ]);
  if (
    args.identity.stability === "portable" &&
    recordedIds.has(args.identity.id) &&
    args.verifiedPortableAliases?.has(args.identity.id)
  ) {
    return true;
  }
  const identityProofs = [
    repositoryIdentityAliasForPrimary(args.identity),
    ...args.identity.aliases,
  ];
  const matchingCommonDirectory = identityProofs.some(
    (alias) => alias.kind === "git-common-dir" && recordedIds.has(alias.id)
  );
  const matchingRootAlias = identityProofs.some(
    (alias) => alias.kind === "root-commit" && recordedIds.has(alias.id)
  );
  return matchingCommonDirectory && matchingRootAlias;
}

async function verifiedPortableAliases(args: {
  entry: ProjectRegistryEntry;
  key: string;
}): Promise<Set<string>> {
  const recordedIds = new Set([
    args.key,
    args.entry.repositoryId,
    ...(args.entry.aliases ?? []),
  ]);
  const verified = new Set<string>();
  for (const location of args.entry.locations) {
    try {
      const identity = await resolveUnstabilizedRepositoryIdentity(
        location.path
      );
      if (identity.stability === "portable" && recordedIds.has(identity.id)) {
        const locationMatches = registryStoredLocationMatchesIdentity({
          entry: args.entry,
          identity,
          key: args.key,
        });
        if (locationMatches) {
          verified.add(identity.id);
        }
      }
    } catch {
      // Stale or inaccessible registry locations are not identity proof.
    }
  }
  return verified;
}

interface RepositoryStabilizationContext {
  registry: ProjectRegistry;
  portableAliasProofs: Map<string, Promise<Set<string>>>;
}

function requiresPortableAliasProof(args: {
  entry: ProjectRegistryEntry;
  identity: RepositoryIdentity;
  key: string;
}): boolean {
  return (
    args.identity.stability === "portable" &&
    args.key !== args.identity.id &&
    args.entry.repositoryId !== args.identity.id &&
    (args.entry.aliases ?? []).includes(args.identity.id)
  );
}

function cachedPortableAliases(
  context: RepositoryStabilizationContext,
  key: string,
  entry: ProjectRegistryEntry
): Promise<Set<string>> {
  const cached = context.portableAliasProofs.get(key);
  if (cached) {
    return cached;
  }
  const proof = verifiedPortableAliases({ entry, key });
  context.portableAliasProofs.set(key, proof);
  return proof;
}

async function stabilizeRepositoryIdentity(args: {
  homeDir: string;
  identity: RepositoryIdentity;
  projectRoot: string;
  context?: RepositoryStabilizationContext;
}): Promise<RepositoryIdentity> {
  const context = args.context ?? {
    registry: await loadRegistry(args.homeDir),
    portableAliasProofs: new Map<string, Promise<Set<string>>>(),
  };
  const matches: [string, ProjectRegistryEntry][] = [];
  for (const [key, entry] of Object.entries(context.registry.projects)) {
    const portableAliases = requiresPortableAliasProof({
      entry,
      identity: args.identity,
      key,
    })
      ? await cachedPortableAliases(context, key, entry)
      : undefined;
    if (
      registryEntryMatchesIdentity({
        verifiedPortableAliases: portableAliases,
        key,
        entry,
        identity: args.identity,
        projectRoot: args.projectRoot,
      })
    ) {
      matches.push([key, entry]);
    }
  }
  if (matches.length !== 1) {
    return args.identity;
  }
  const entry = matches[0]?.[1];
  if (!entry || entry.repositoryId === args.identity.id) {
    return args.identity;
  }
  const aliases = new Map(
    [
      repositoryIdentityAliasForPrimary(args.identity),
      ...args.identity.aliases,
    ].map((alias) => [alias.id, alias])
  );
  aliases.delete(entry.repositoryId);
  return {
    id: entry.repositoryId,
    kind: entry.identityKind,
    fingerprint: entry.identityFingerprint,
    stability:
      entry.identityKind === "git-common-dir" ? "machine-local" : "portable",
    aliases: [...aliases.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
  };
}

async function atomicWrite(
  pathValue: string,
  content: string,
  commitBoundary?: {
    beforeCommit?: () => Promise<void>;
    beforeExchange?: () => Promise<void>;
    expected?: {
      contents: string;
      identity?: { dev: number; ino: number };
      mode: number;
    } | null;
    mode?: number;
    safeRoot?: string;
    validate?: () => Promise<void>;
  }
): Promise<void> {
  if (commitBoundary?.safeRoot) {
    await assertSafeDescendantPath({
      root: commitBoundary.safeRoot,
      target: pathValue,
      targetKind: "file",
    });
  }
  await mkdir(dirname(pathValue), { recursive: true });
  if (commitBoundary && "expected" in commitBoundary) {
    await replaceVerifiedFileAt({
      beforeCommit: commitBoundary.beforeCommit,
      beforeExchange: commitBoundary.beforeExchange,
      contents: content,
      directoryPath: dirname(pathValue),
      expected: commitBoundary.expected ?? null,
      fileName: basename(pathValue),
      maxBytes: PROJECT_CANONICAL_FILE_MAX_BYTES,
      mode: commitBoundary.mode ?? MACHINE_LOCAL_FILE_MODE,
      safeRoot: commitBoundary.safeRoot,
    });
    return;
  }
  const temporary = `${pathValue}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: commitBoundary?.mode ?? MACHINE_LOCAL_FILE_MODE,
    });
    await chmod(temporary, commitBoundary?.mode ?? MACHINE_LOCAL_FILE_MODE);
    await commitBoundary?.beforeCommit?.();
    if (commitBoundary?.safeRoot) {
      await assertSafeDescendantPath({
        root: commitBoundary.safeRoot,
        target: pathValue,
        targetKind: "file",
      });
    }
    await commitBoundary?.validate?.();
    await rename(temporary, pathValue);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertSafeDescendantPath(args: {
  root: string;
  target: string;
  targetKind: "directory" | "file";
}): Promise<void> {
  const root = resolve(args.root);
  const target = resolve(args.target);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Machine-local state target escapes its root: ${target}`);
  }
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(`Refusing unsafe machine-local state root: ${root}`);
  }
  const parts = rel.split(PATH_PART_SPLIT_RE).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = await lstat(current).catch(() => null);
    if (!metadata) {
      continue;
    }
    const isTarget = index === parts.length - 1;
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Refusing symlinked machine-local state path: ${current}`
      );
    }
    if (
      !(isTarget || metadata.isDirectory()) ||
      (isTarget && args.targetKind === "file" && !metadata.isFile()) ||
      (isTarget && args.targetKind === "directory" && !metadata.isDirectory())
    ) {
      throw new Error(`Refusing unsafe machine-local state path: ${current}`);
    }
  }
}

async function prepareMachineLocalStateRoot(homeDir: string): Promise<string> {
  const root = facultLocalStateRoot(homeDir);
  await assertSafeDescendantPath({
    root: dirname(root),
    target: root,
    targetKind: "directory",
  });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing unsafe machine-local state root: ${root}`);
  }
  return root;
}

function projectMutationLockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function parseProjectMutationLockOwner(
  content: string
): ProjectMutationLockOwner | null {
  try {
    const parsed = JSON.parse(content) as Partial<ProjectMutationLockOwner>;
    if (
      parsed.version === 2 &&
      typeof parsed.endpoint === "string" &&
      typeof parsed.ownerId === "string" &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.acquiredAt === "string" &&
      parsed.transport === "ipc-socket"
    ) {
      return parsed as ProjectMutationLockOwner;
    }
  } catch {
    return null;
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function projectMutationLockEndpoint(ownerId: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\fclt-project-mutation-${ownerId}`
    : join(tmpdir(), `fclt-project-mutation-${ownerId}.sock`);
}

async function listenForProjectMutationLock(
  owner: ProjectMutationLockOwner
): Promise<Server> {
  const server = createServer((socket) => {
    socket.end(`${owner.ownerId}\n`);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(owner.endpoint, () => resolvePromise());
  });
  return server;
}

function projectMutationLockOwnerIsLive(
  owner: ProjectMutationLockOwner
): boolean {
  // A live PID is authoritative. Its event loop may be synchronously stalled,
  // so an IPC timeout is not proof that the owner is abandoned. Ambiguous PID
  // reuse therefore fails safe instead of risking concurrent mutation.
  return processIsAlive(owner.pid);
}

async function closeProjectMutationLockServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

async function removeProjectMutationLockEndpoint(
  owner: ProjectMutationLockOwner
): Promise<void> {
  if (
    process.platform === "win32" ||
    owner.endpoint !== projectMutationLockEndpoint(owner.ownerId)
  ) {
    return;
  }
  const entry = await lstat(owner.endpoint).catch(() => null);
  if (entry?.isSocket() && !entry.isSymbolicLink()) {
    await rm(owner.endpoint, { force: true });
  }
}

interface ProjectMutationLockObservation {
  content: string | null;
  dev: number;
  ino: number;
  mtimeMs: number;
  owner: ProjectMutationLockOwner | null;
}

class ProjectMutationLockObservationRaceError extends Error {
  constructor(lockPath: string, options?: { cause?: unknown }) {
    super(
      `Project enrollment mutation lock changed during observation: ${lockPath}`,
      {
        cause: options?.cause,
      }
    );
    this.name = "ProjectMutationLockObservationRaceError";
  }
}

async function observeProjectMutationLock(
  lockPath: string
): Promise<ProjectMutationLockObservation | null> {
  const lock = await lstatIfExists(lockPath);
  if (!lock) {
    return null;
  }
  if (lock.isSymbolicLink() || !lock.isDirectory()) {
    throw new Error(
      `Refusing unsafe project enrollment mutation lock: ${lockPath}`
    );
  }
  const ownerPath = projectMutationLockOwnerPath(lockPath);
  let ownerSnapshot: CanonicalFileSnapshot | null;
  try {
    ownerSnapshot = await canonicalFileSnapshot(ownerPath);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Canonical project file changed ") ||
        error.message.startsWith("Canonical project file parent changed "))
    ) {
      throw new ProjectMutationLockObservationRaceError(lockPath, {
        cause: error,
      });
    }
    throw error;
  }
  const lockAfter = await lstatIfExists(lockPath);
  if (
    !lockAfter ||
    lockAfter.isSymbolicLink() ||
    !lockAfter.isDirectory() ||
    !canonicalMetadataMatches(lock, lockAfter)
  ) {
    throw new ProjectMutationLockObservationRaceError(lockPath);
  }
  if (!ownerSnapshot) {
    return {
      content: null,
      dev: lock.dev,
      ino: lock.ino,
      mtimeMs: lock.mtimeMs,
      owner: null,
    };
  }
  const content = ownerSnapshot.content;
  return {
    content,
    dev: lock.dev,
    ino: lock.ino,
    mtimeMs: lock.mtimeMs,
    owner: parseProjectMutationLockOwner(content),
  };
}

function sameProjectMutationLockObservation(
  left: ProjectMutationLockObservation,
  right: ProjectMutationLockObservation
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.content === right.content
  );
}

async function reclaimAbandonedProjectMutationLock(args: {
  lockPath: string;
  observed: ProjectMutationLockObservation;
}): Promise<boolean> {
  const recoveryPath = join(args.lockPath, "recovery");
  try {
    await mkdir(recoveryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
  const quarantine = `${args.lockPath}.abandoned-${randomUUID()}`;
  try {
    let current: ProjectMutationLockObservation | null;
    try {
      current = await observeProjectMutationLock(args.lockPath);
    } catch (error) {
      if (error instanceof ProjectMutationLockObservationRaceError) {
        return false;
      }
      throw error;
    }
    if (
      !(
        current?.owner &&
        sameProjectMutationLockObservation(current, args.observed)
      )
    ) {
      return false;
    }
    if (await projectMutationLockOwnerIsLive(current.owner)) {
      return false;
    }
    await rename(args.lockPath, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    if (current.owner) {
      await removeProjectMutationLockEndpoint(current.owner);
    }
    return true;
  } finally {
    await rm(recoveryPath, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

async function releaseProjectMutationLock(args: {
  lockPath: string;
  ownerContent: string;
}): Promise<void> {
  const current = await observeProjectMutationLock(args.lockPath);
  if (!current || current.content !== args.ownerContent) {
    throw new Error(
      "Project enrollment mutation lock ownership changed before release"
    );
  }
  const quarantine = `${args.lockPath}.released-${randomUUID()}`;
  await rename(args.lockPath, quarantine);
  await rm(quarantine, { recursive: true, force: true });
}

async function withProjectsMutationLock<T>(
  homeDir: string,
  operation: () => Promise<T>,
  attempts = PROJECT_MUTATION_LOCK_ATTEMPTS
): Promise<T> {
  const stateRoot = await prepareMachineLocalStateRoot(homeDir);
  const projectsRoot = join(stateRoot, "projects");
  await assertSafeDescendantPath({
    root: stateRoot,
    target: projectsRoot,
    targetKind: "directory",
  });
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  const lockPath = projectMutationLockPath(homeDir);
  const ownerId = randomUUID();
  const owner: ProjectMutationLockOwner = {
    version: 2,
    endpoint: projectMutationLockEndpoint(ownerId),
    ownerId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    transport: "ipc-socket",
  };
  const ownerContent = `${JSON.stringify(owner, null, 2)}\n`;
  const server = await listenForProjectMutationLock(owner);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeFile(
            projectMutationLockOwnerPath(lockPath),
            ownerContent,
            {
              encoding: "utf8",
              flag: "wx",
              mode: 0o600,
            }
          );
        } catch (error) {
          const quarantine = `${lockPath}.incomplete-${randomUUID()}`;
          await rename(lockPath, quarantine);
          await rm(quarantine, { recursive: true, force: true });
          throw error;
        }
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      let observed: ProjectMutationLockObservation | null;
      try {
        observed = await observeProjectMutationLock(lockPath);
      } catch (error) {
        if (error instanceof ProjectMutationLockObservationRaceError) {
          // The winner may be publishing or releasing its lock. Waiting is
          // safe; reclaiming or treating a transient observation as fatal is
          // not.
          await Bun.sleep(PROJECT_MUTATION_LOCK_RETRY_MS);
          continue;
        }
        throw error;
      }
      if (!observed) {
        continue;
      }
      const liveOwner =
        observed.owner &&
        (await projectMutationLockOwnerIsLive(observed.owner));
      if (observed.owner && !liveOwner) {
        const reclaimed = await reclaimAbandonedProjectMutationLock({
          lockPath,
          observed,
        });
        if (!reclaimed) {
          await Bun.sleep(PROJECT_MUTATION_LOCK_RETRY_MS);
        }
        continue;
      }
      // An ownerless lock may still belong to a claimant paused between
      // directory creation and owner publication. Automatic reclamation cannot
      // distinguish that live initializer from a crash, so fail closed.
      await Bun.sleep(PROJECT_MUTATION_LOCK_RETRY_MS);
    }
    if (!acquired) {
      throw new Error(
        "Another project enrollment mutation is still in progress"
      );
    }
    return await operation();
  } finally {
    try {
      if (acquired) {
        await releaseProjectMutationLock({ lockPath, ownerContent });
      }
    } finally {
      await closeProjectMutationLockServer(server);
      await removeProjectMutationLockEndpoint(owner);
    }
  }
}

async function captureArtifact(args: {
  path: string;
  afterContent: string | null;
  afterMode?: number;
  safeRoot?: string;
}): Promise<TransactionArtifact> {
  const safeRootIdentity = args.safeRoot
    ? await captureSafeRootIdentity(args.safeRoot)
    : undefined;
  const before = await regularFileText(args.path);
  const beforeMetadata = before === null ? null : await lstat(args.path);
  if (
    beforeMetadata &&
    (beforeMetadata.isSymbolicLink() || !beforeMetadata.isFile())
  ) {
    throw new Error(`Refusing unsafe transaction artifact: ${args.path}`);
  }
  return {
    path: args.path,
    before,
    beforeIdentity: beforeMetadata
      ? { dev: beforeMetadata.dev, ino: beforeMetadata.ino }
      : null,
    beforeMode: beforeMetadata ? permissionMode(beforeMetadata.mode) : null,
    afterContent: args.afterContent,
    afterSha256: args.afterContent === null ? null : sha256(args.afterContent),
    afterMode:
      args.afterContent === null
        ? null
        : (args.afterMode ?? MACHINE_LOCAL_FILE_MODE),
    afterSize:
      args.afterContent === null ? null : Buffer.byteLength(args.afterContent),
    safeRoot: args.safeRoot,
    safeRootIdentity,
    written: false,
  };
}

async function captureSafeRootIdentity(
  safeRoot: string
): Promise<NonNullable<TransactionArtifact["safeRootIdentity"]>> {
  const metadata = await lstat(safeRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing unsafe transaction root: ${safeRoot}`);
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
  };
}

async function assertArtifactSafeRootIdentity(
  artifact: TransactionArtifact
): Promise<void> {
  if (!(artifact.safeRoot && artifact.safeRootIdentity)) {
    throw new Error(
      `Project enrollment cleanup is missing a safe root identity: ${artifact.path}`
    );
  }
  const metadata = await lstat(artifact.safeRoot);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== artifact.safeRootIdentity.dev ||
    metadata.ino !== artifact.safeRootIdentity.ino ||
    metadata.uid !== artifact.safeRootIdentity.uid
  ) {
    throw new Error(
      `Project enrollment cleanup safe root changed: ${artifact.safeRoot}`
    );
  }
}

async function artifactMatchesAfter(
  artifact: TransactionArtifact
): Promise<boolean> {
  const current = await regularFileText(artifact.path);
  if (artifact.afterSha256 === null) {
    return current === null;
  }
  if (
    current === null ||
    artifact.afterMode === null ||
    sha256(current) !== artifact.afterSha256
  ) {
    return false;
  }
  const metadata = await lstatIfExists(artifact.path);
  return (
    metadata !== null &&
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    permissionMode(metadata.mode) === artifact.afterMode
  );
}

async function restoreOwnedArtifacts(
  artifacts: TransactionArtifact[],
  beforeRestoreCommit?: (args: { path: string }) => Promise<void>
): Promise<string[]> {
  const preserved: string[] = [];
  for (const artifact of artifacts.toReversed()) {
    if (!artifact.written) {
      continue;
    }
    if (!(await artifactMatchesAfter(artifact))) {
      preserved.push(artifact.path);
      continue;
    }
    if (artifact.before === null) {
      if (
        artifact.afterSha256 === null ||
        artifact.afterSize === null ||
        !artifact.safeRoot
      ) {
        throw new Error(
          `Project enrollment cleanup cannot verify a new artifact: ${artifact.path}`
        );
      }
      await unlinkVerifiedFileAt({
        beforeCommit: async () => {
          await beforeRestoreCommit?.({ path: artifact.path });
          await assertArtifactSafeRootIdentity(artifact);
        },
        directoryPath: dirname(artifact.path),
        expectedSha256: artifact.afterSha256,
        fileName: basename(artifact.path),
        maxBytes: artifact.afterSize,
        safeRoot: artifact.safeRoot,
      });
    } else {
      await replaceVerifiedFileAt({
        beforeExchange: async () =>
          await beforeRestoreCommit?.({ path: artifact.path }),
        contents: artifact.before,
        directoryPath: dirname(artifact.path),
        expected:
          artifact.afterContent === null
            ? null
            : {
                contents: artifact.afterContent,
                mode: artifact.afterMode ?? MACHINE_LOCAL_FILE_MODE,
              },
        fileName: basename(artifact.path),
        maxBytes: Math.max(
          Buffer.byteLength(artifact.before),
          artifact.afterContent === null
            ? 0
            : Buffer.byteLength(artifact.afterContent)
        ),
        mode: artifact.beforeMode ?? MACHINE_LOCAL_FILE_MODE,
        safeRoot: artifact.safeRoot,
      });
    }
  }
  return preserved.sort();
}

async function verifyOwnedArtifacts(
  artifacts: TransactionArtifact[]
): Promise<void> {
  for (const artifact of artifacts) {
    if (!artifact.written) {
      continue;
    }
    if (!(await artifactMatchesAfter(artifact))) {
      throw new Error(
        `Project enrollment transaction verification failed: ${artifact.path}`
      );
    }
  }
}

async function saveRegistry(args: {
  homeDir: string;
  registry: ProjectRegistry;
  snapshot: Awaited<ReturnType<typeof loadRegistrySnapshot>>;
  now: string;
}): Promise<void> {
  args.registry.updatedAt = args.now;
  const pathValue = projectRegistryPath(args.homeDir);
  await atomicWrite(pathValue, `${JSON.stringify(args.registry, null, 2)}\n`, {
    expected:
      args.snapshot.before === null
        ? null
        : {
            contents: args.snapshot.before,
            identity: args.snapshot.beforeIdentity ?? undefined,
            mode: args.snapshot.beforeMode ?? MACHINE_LOCAL_FILE_MODE,
          },
    safeRoot: facultLocalStateRoot(args.homeDir),
  });
}

function planHashInput(
  plan: Omit<ProjectEnrollmentPlan, "planSha256">
): unknown {
  return plan;
}

async function knownLegacyStateRoots(args: {
  aiRoot: string;
  homeDir: string;
  identity: RepositoryIdentity;
  invocationProjectRoot: string;
  projectRoot: string;
}): Promise<string[]> {
  const roots = new Set<string>([args.aiRoot]);
  const addEquivalentRoot = async (
    candidateProjectRoot: string
  ): Promise<void> => {
    const spelling = resolve(candidateProjectRoot);
    let physical: string;
    try {
      physical = await realpath(spelling);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (physical === args.projectRoot) {
      roots.add(join(spelling, ".ai"));
    }
  };
  await addEquivalentRoot(args.invocationProjectRoot);
  const registry = await loadRegistry(args.homeDir);
  for (const [key, entry] of Object.entries(registry.projects)) {
    if (
      !registryStoredLocationMatchesIdentity({
        key,
        entry,
        identity: args.identity,
      })
    ) {
      continue;
    }
    for (const location of entry.locations) {
      await addEquivalentRoot(location.path);
    }
  }
  return uniqueSorted([...roots]);
}

export async function planProjectEnrollment(args: {
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeCanonicalPreviewRead?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeGuidanceRead?: () => Promise<void>;
  projectRoot: string;
  homeDir?: string;
  /** @internal Platform override for cross-platform regression tests. */
  platform?: NodeJS.Platform;
  sources?: ProjectSource[];
  cadence?: ProjectCadence;
  scheduling?: boolean;
  guidance?: string[];
}): Promise<ProjectEnrollmentPlan> {
  const homeDir = resolve(args.homeDir ?? process.env.HOME ?? homedir());
  const invocationProjectRoot = resolve(args.projectRoot);
  if ((args.platform ?? process.platform) === "win32") {
    throw new Error(
      "Project enrollment planning is unsupported on win32 because conditional canonical replacement is unavailable"
    );
  }
  const projectRoot = await gitRoot(invocationProjectRoot);
  const aiRoot = join(projectRoot, ".ai");
  const globalRoot = resolveCliContextRoot({
    homeDir,
    cwd: projectRoot,
    scope: "global",
  });
  if (
    pathsMayCollide(projectRoot, globalRoot) ||
    pathsMayCollide(aiRoot, globalRoot)
  ) {
    throw new Error(
      `Project enrollment refused because the repository or its .ai root collides with the configured global AI root: ${globalRoot}`
    );
  }
  await assertSafeCanonicalTargets(projectRoot, aiRoot);
  const rawIdentity = await resolveUnstabilizedRepositoryIdentity(projectRoot);
  const identity = await stabilizeRepositoryIdentity({
    homeDir,
    identity: rawIdentity,
    projectRoot,
  });
  const executionIdentity = repositoryExecutionIdentity(projectRoot);
  if (!REPOSITORY_ID_RE.test(identity.id)) {
    throw new Error("Unable to derive a valid repository identity");
  }
  const sources = uniqueSorted(args.sources ?? ["git", "writebacks"]);
  if (sources.some((source) => !PROJECT_SOURCES.has(source))) {
    throw new Error(`Unsupported project source: ${sources.join(", ")}`);
  }
  const cadence = args.cadence ?? "on-demand";
  if (!PROJECT_CADENCES.has(cadence)) {
    throw new Error(`Unsupported project cadence: ${cadence}`);
  }
  const scheduling = Boolean(args.scheduling);
  if (scheduling) {
    throw new Error(
      "Minimal project enrollment does not install scheduling; enroll first, then enable a reviewed project loop separately"
    );
  }
  const guidance = uniqueSorted(
    (args.guidance ?? []).map(ensureRepoRelativeMarkdown)
  );
  const guidancePreview = await previewGuidance({
    beforeRead: args.beforeGuidanceRead,
    projectRoot,
    paths: guidance,
  });
  await args.beforeCanonicalPreviewRead?.();
  const ignorePath = join(aiRoot, ".gitignore");
  const configPath = join(aiRoot, "config.toml");
  const [worktree, ignoreSnapshot, configSnapshot] = await Promise.all([
    inspectRepository(projectRoot, homeDir),
    canonicalFileSnapshot(ignorePath),
    canonicalFileSnapshot(configPath),
  ]);
  const existingIgnore = ignoreSnapshot?.content ?? null;
  const existingConfig = configSnapshot?.content ?? null;
  const ignoreContent = appendProtectiveIgnore(existingIgnore);
  const configSources =
    guidance.length > 0 ? uniqueSorted([...sources, "guidance"]) : sources;
  const enrollmentConfig = renderProjectConfig({
    repositoryId: identity.id,
    sources: configSources,
    guidance,
    cadence,
    scheduling,
  });
  const configContent = mergeProjectConfig(existingConfig, enrollmentConfig);
  const canonicalWrites = [
    {
      path: ignorePath,
      content: ignoreContent,
      reason:
        "Protect generated and machine-local fclt state before any index is built.",
      precondition: filePreconditionFromSnapshot(ignorePath, ignoreSnapshot),
    },
    {
      path: configPath,
      content: configContent,
      reason:
        "Create the minimal repo-owned enrollment contract without installing the operating-model pack.",
      precondition: filePreconditionFromSnapshot(configPath, configSnapshot),
    },
  ];
  const generatedWrites = [
    {
      path: join(executionMachineStateDir(homeDir, aiRoot), "ai", "index.json"),
      reason: "Machine-local generated capability index.",
    },
    {
      path: join(executionMachineStateDir(homeDir, aiRoot), "ai", "graph.json"),
      reason: "Machine-local generated capability graph.",
    },
  ];
  const machineLocalWrites = [
    {
      path: projectRegistryPath(homeDir),
      reason: "Machine-local portfolio decision and location history.",
    },
    {
      path: projectReceiptsDir(homeDir),
      reason: "Machine-local rollback receipt.",
    },
    {
      path: projectMutationLockPath(homeDir),
      reason: "Temporary machine-local transaction lock.",
    },
  ];
  const legacyStateRoots = await knownLegacyStateRoots({
    aiRoot,
    homeDir,
    identity,
    invocationProjectRoot,
    projectRoot,
  });
  const stateMigrations = await planLegacyProjectStateMigrations({
    aiRoot,
    homeDir,
    legacyAiRoots: legacyStateRoots,
  });
  const findings = [
    ...privacyFindings(ignoreContent, { gitIgnorePatterns: true }),
    ...privacyFindings(configContent),
  ];
  if (findings.length > 0) {
    throw new Error(
      `Planned canonical files failed privacy checks: ${findings.join(", ")}`
    );
  }
  const warnings = [
    ...(worktree.dirty
      ? [
          "The repository has unrelated working-tree changes. The plan will touch only the listed .ai files and will recheck their hashes before applying.",
        ]
      : []),
    ...(identity.stability === "machine-local"
      ? [
          "This repository has no portable remote; its machine-local primary prevents unrelated repositories with shared history from collapsing. Add a reviewed origin to correlate independent clones.",
        ]
      : []),
    ...(guidance.length === 0
      ? [
          "Existing AGENTS.md or CLAUDE.md files are not copied or adopted automatically.",
        ]
      : []),
  ];
  const withoutHash: Omit<ProjectEnrollmentPlan, "planSha256"> = {
    version: 1,
    operation: "project-init",
    projectRoot,
    aiRoot,
    identity,
    executionIdentity,
    worktree: {
      dirty: worktree.dirty,
      branch: worktree.branch,
      head: worktree.head,
    },
    options: {
      sources: configSources,
      cadence,
      scheduling,
      guidance,
    },
    guidancePreview,
    canonicalWrites,
    generatedWrites,
    machineLocalWrites,
    legacyStateRoots,
    stateMigrations,
    protections: {
      ignoreWrittenFirst: true,
      managedRendering: false,
      automaticGuidanceCopy: false,
      privacyFindings: [],
    },
    warnings,
    rollback: {
      command: "Available after apply as: fclt project rollback --receipt <id>",
      preservesReviewHistory: true,
    },
  };
  return {
    ...withoutHash,
    planSha256: sha256(stableJson(planHashInput(withoutHash))),
  };
}

async function verifyPreconditions(
  plan: ProjectEnrollmentPlan,
  homeDir: string
): Promise<void> {
  const { planSha256, ...withoutHash } = plan;
  const currentPlanSha256 = sha256(stableJson(planHashInput(withoutHash)));
  if (!PLAN_SHA_RE.test(planSha256) || currentPlanSha256 !== planSha256) {
    throw new Error("Enrollment plan content does not match its plan SHA");
  }
  const currentRoot = await gitRoot(plan.projectRoot);
  if (currentRoot !== plan.projectRoot) {
    throw new Error("Enrollment plan repository root changed");
  }
  const [currentIdentity, currentExecutionIdentity] = await Promise.all([
    resolveRepositoryIdentity(currentRoot, homeDir),
    resolveRepositoryExecutionIdentity(currentRoot),
  ]);
  if (
    currentIdentity.id !== plan.identity.id ||
    currentIdentity.kind !== plan.identity.kind ||
    currentIdentity.fingerprint !== plan.identity.fingerprint ||
    currentExecutionIdentity.id !== plan.executionIdentity.id ||
    currentExecutionIdentity.fingerprint !== plan.executionIdentity.fingerprint
  ) {
    throw new Error("Enrollment plan repository or execution identity changed");
  }
  if (
    plan.legacyStateRoots.length === 0 ||
    !plan.legacyStateRoots.includes(plan.aiRoot)
  ) {
    throw new Error("Enrollment plan legacy state candidates are invalid");
  }
  for (const legacyAiRoot of plan.legacyStateRoots) {
    if (
      basename(legacyAiRoot) !== ".ai" ||
      (await realpath(dirname(legacyAiRoot))) !== plan.projectRoot
    ) {
      throw new Error(
        `Enrollment plan legacy state candidate is unsafe: ${legacyAiRoot}`
      );
    }
  }
  const currentKnownRoots = await knownLegacyStateRoots({
    aiRoot: plan.aiRoot,
    homeDir,
    identity: currentIdentity,
    invocationProjectRoot: plan.projectRoot,
    projectRoot: plan.projectRoot,
  });
  if (
    currentKnownRoots.some(
      (candidate) => !plan.legacyStateRoots.includes(candidate)
    )
  ) {
    throw new Error(
      "Enrollment plan is stale because known legacy state candidates changed"
    );
  }
  await assertSafeCanonicalTargets(plan.projectRoot, plan.aiRoot);
  for (const write of plan.canonicalWrites) {
    await assertCanonicalWritePrecondition(write);
  }
  const guidance = await previewGuidance({
    projectRoot: plan.projectRoot,
    paths: plan.options.guidance,
  });
  for (const [index, preview] of plan.guidancePreview.entries()) {
    const current = guidance[index];
    if (
      current?.path !== preview.path ||
      current.sha256 !== preview.sha256 ||
      current.content !== preview.content
    ) {
      throw new Error(
        `Enrollment plan is stale because guidance changed: ${preview.path}`
      );
    }
  }
}

async function assertCanonicalWritePrecondition(
  write: ProjectEnrollmentPlan["canonicalWrites"][number]
): Promise<void> {
  const current = await filePrecondition(write.path);
  if (
    current.existed !== write.precondition.existed ||
    current.sha256 !== write.precondition.sha256 ||
    current.mode !== write.precondition.mode
  ) {
    throw new Error(
      `Enrollment plan is stale because ${write.path} changed; generate a new plan`
    );
  }
}

function registryEntryForIdentity(args: {
  registry: ProjectRegistry;
  identity: RepositoryIdentity;
  projectRoot: string;
}): ProjectRegistryEntry | null {
  const matches = Object.entries(args.registry.projects).filter(
    ([key, entry]) =>
      registryEntryMatchesIdentity({
        key,
        entry,
        identity: args.identity,
        projectRoot: args.projectRoot,
      })
  );
  if (matches.length === 0) {
    return null;
  }
  const primary =
    matches.find(([key]) => key === args.identity.id)?.[1] ?? matches[0]?.[1];
  if (!primary) {
    return null;
  }
  const locations = new Map<string, ProjectRegistryLocation>();
  const history: ProjectRegistryHistory[] = [];
  const aliases = new Set<string>(
    args.identity.aliases.map((alias) => alias.id)
  );
  const activeReceipts: Record<string, string> = {};
  for (const [key, entry] of matches) {
    if (key !== args.identity.id) {
      aliases.add(key);
    }
    for (const alias of entry.aliases ?? []) {
      if (alias !== args.identity.id) {
        aliases.add(alias);
      }
    }
    for (const location of entry.locations) {
      const current = locations.get(location.path);
      locations.set(location.path, {
        path: location.path,
        firstSeenAt:
          current && current.firstSeenAt < location.firstSeenAt
            ? current.firstSeenAt
            : location.firstSeenAt,
        lastSeenAt:
          current && current.lastSeenAt > location.lastSeenAt
            ? current.lastSeenAt
            : location.lastSeenAt,
      });
    }
    history.push(...entry.history);
    Object.assign(activeReceipts, entry.activeReceipts ?? {});
    delete args.registry.projects[key];
  }
  const merged: ProjectRegistryEntry = {
    ...primary,
    repositoryId: args.identity.id,
    aliases: [...aliases].sort(),
    identityKind: args.identity.kind,
    identityFingerprint: args.identity.fingerprint,
    locations: [...locations.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
    history: history.sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        left.root.localeCompare(right.root) ||
        (left.receiptId ?? "").localeCompare(right.receiptId ?? "")
    ),
    activeReceipts,
  };
  args.registry.projects[args.identity.id] = merged;
  return merged;
}

async function upsertRegistryEntry(args: {
  homeDir: string;
  registry: ProjectRegistry;
  plan: ProjectEnrollmentPlan;
  now: string;
  receiptId: string;
}): Promise<ProjectRegistryEntry | null> {
  const current = registryEntryForIdentity({
    registry: args.registry,
    identity: args.plan.identity,
    projectRoot: args.plan.projectRoot,
  });
  const reconciledCurrent = current ? structuredClone(current) : null;
  if (reconciledCurrent?.activeReceipts) {
    for (const pathValue of Object.keys(reconciledCurrent.activeReceipts)) {
      if (pathValue === args.plan.projectRoot) {
        continue;
      }
      if (pathsPhysicallyEquivalent(pathValue, args.plan.projectRoot)) {
        delete reconciledCurrent.activeReceipts[pathValue];
        continue;
      }
      if (!(await lstatIfExists(pathValue))) {
        delete reconciledCurrent.activeReceipts[pathValue];
        continue;
      }
      let inspected: DiscoveredProject;
      try {
        inspected = await inspectRepository(pathValue, args.homeDir, {
          stabilizeIdentity: false,
        });
      } catch (error) {
        if (!(await lstatIfExists(pathValue))) {
          delete reconciledCurrent.activeReceipts[pathValue];
          continue;
        }
        throw error;
      }
      if (
        !registryStoredLocationMatchesIdentity({
          key: args.plan.identity.id,
          entry: reconciledCurrent,
          identity: inspected.identity,
        })
      ) {
        delete reconciledCurrent.activeReceipts[pathValue];
        continue;
      }
      const receiptId = reconciledCurrent.activeReceipts[pathValue];
      if (!receiptId) {
        throw new Error(`Missing active receipt for ${pathValue}`);
      }
      const receipt = await readReceipt({
        homeDir: args.homeDir,
        receiptId,
      });
      if (
        receipt.projectRoot !== pathValue ||
        receipt.executionId !== inspected.executionIdentity.id
      ) {
        delete reconciledCurrent.activeReceipts[pathValue];
      }
    }
  }
  const location = reconciledCurrent?.locations.find(
    (candidate) => candidate.path === args.plan.projectRoot
  );
  const locations = [...(reconciledCurrent?.locations ?? [])];
  if (!location) {
    locations.push({
      path: args.plan.projectRoot,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
    });
    if (reconciledCurrent) {
      reconciledCurrent.locations = structuredClone(
        locations.sort((left, right) => left.path.localeCompare(right.path))
      );
    }
  }
  const registryEntryBefore = reconciledCurrent
    ? structuredClone(reconciledCurrent)
    : null;
  if (location) {
    location.lastSeenAt = args.now;
  }
  const sortedLocations = locations.sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  args.registry.projects[args.plan.identity.id] = {
    repositoryId: args.plan.identity.id,
    aliases: uniqueSorted([
      ...(current?.aliases ?? []),
      ...args.plan.identity.aliases.map((alias) => alias.id),
    ]),
    identityKind: args.plan.identity.kind,
    identityFingerprint: args.plan.identity.fingerprint,
    decision: "selected",
    sources: args.plan.options.sources,
    cadence: args.plan.options.cadence,
    scheduling: args.plan.options.scheduling,
    guidance: args.plan.options.guidance,
    locations: sortedLocations,
    lastSuccessfulRun: reconciledCurrent?.lastSuccessfulRun ?? null,
    pendingApprovals: [],
    history: [
      ...(reconciledCurrent?.history ?? []),
      {
        at: args.now,
        action: "enrolled",
        root: args.plan.projectRoot,
        receiptId: args.receiptId,
      },
    ],
    activeReceipts: {
      ...(reconciledCurrent?.activeReceipts ?? {}),
      [args.plan.projectRoot]: args.receiptId,
    },
  };
  return registryEntryBefore;
}

export async function applyProjectEnrollment(args: {
  plan: ProjectEnrollmentPlan;
  expectedPlanSha256: string;
  homeDir?: string;
  now?: Date;
  /** @internal Platform branch override for cross-platform regression tests. */
  platform?: NodeJS.Platform;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeCanonicalWrite?: (args: {
    index: number;
    path: string;
  }) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  afterGeneratedWrites?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeRegistryWrite?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeRegistryExchange?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  afterRegistryWrite?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  afterReceiptWrite?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeCleanupRestore?: (args: { path: string }) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  mutationLockAttempts?: number;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeLegacyStateRename?: (args: {
    destination: string;
    index: number;
    source: string;
  }) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeLegacyStateRestore?: (args: {
    destination: string;
    index: number;
    source: string;
  }) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeLegacyStateQuarantine?: (args: {
    destination: string;
    index: number;
    quarantine: string;
    source: string;
  }) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  afterLegacyStateQuarantine?: (args: {
    destination: string;
    index: number;
    quarantine: string;
    source: string;
  }) => Promise<void>;
}): Promise<{
  version: 1;
  applied: true;
  repositoryId: string;
  changedPaths: string[];
  generatedPaths: string[];
  registryPath: string;
  receiptId: string;
  rollbackCommand: string;
}> {
  if (args.plan.planSha256 !== args.expectedPlanSha256) {
    throw new Error(
      "Apply requires the exact plan SHA from the reviewed preview"
    );
  }
  assertProjectRegistryMutationSupported(args.platform ?? process.platform);
  const homeDir = resolve(args.homeDir ?? process.env.HOME ?? homedir());
  return await withProjectsMutationLock(
    homeDir,
    async () => {
      await verifyPreconditions(args.plan, homeDir);
      const stateRoot = facultLocalStateRoot(homeDir);
      const executionStateDir = executionMachineStateDir(
        homeDir,
        args.plan.aiRoot
      );
      const expectedGeneratedPaths = [
        join(executionStateDir, "ai", "index.json"),
        join(executionStateDir, "ai", "graph.json"),
      ];
      const expectedMachinePaths = [
        projectRegistryPath(homeDir),
        projectReceiptsDir(homeDir),
        projectMutationLockPath(homeDir),
      ];
      if (
        stableJson(args.plan.generatedWrites.map((write) => write.path)) !==
          stableJson(expectedGeneratedPaths) ||
        stableJson(args.plan.machineLocalWrites.map((write) => write.path)) !==
          stableJson(expectedMachinePaths) ||
        !executionStateDir.endsWith(args.plan.executionIdentity.id)
      ) {
        throw new Error(
          "Enrollment plan was created for a different machine-local execution state root"
        );
      }
      const currentStateMigrations = await planLegacyProjectStateMigrations({
        aiRoot: args.plan.aiRoot,
        homeDir,
        legacyAiRoots: args.plan.legacyStateRoots,
      });
      if (
        stableJson(currentStateMigrations) !==
        stableJson(args.plan.stateMigrations)
      ) {
        throw new Error(
          "Enrollment plan is stale because project state migrations changed"
        );
      }
      for (const pathValue of expectedGeneratedPaths) {
        await assertSafeDescendantPath({
          root: stateRoot,
          target: pathValue,
          targetKind: "file",
        });
      }
      const now = (args.now ?? new Date()).toISOString();
      const receiptId = `enroll-${now.replace(NON_DIGIT_RE, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      const receiptPath = join(
        projectReceiptsDir(homeDir),
        `${receiptId}.json`
      );
      const canonicalArtifacts = await Promise.all(
        args.plan.canonicalWrites.map(
          async (write) =>
            await captureArtifact({
              path: write.path,
              afterContent: write.content,
              afterMode: write.precondition.mode ?? CANONICAL_FILE_MODE,
              safeRoot: args.plan.projectRoot,
            })
        )
      );
      const artifacts: TransactionArtifact[] = [...canonicalArtifacts];
      const stateMigration = await migrateLegacyProjectState({
        afterQuarantine: args.afterLegacyStateQuarantine,
        beforeQuarantine: args.beforeLegacyStateQuarantine,
        expected: args.plan.stateMigrations,
        beforeRename: args.beforeLegacyStateRename,
        beforeRestore: args.beforeLegacyStateRestore,
      });
      try {
        for (const [index, write] of args.plan.canonicalWrites.entries()) {
          await assertSafeCanonicalTargets(
            args.plan.projectRoot,
            args.plan.aiRoot
          );
          await assertCanonicalWritePrecondition(write);
          const artifact = canonicalArtifacts[index];
          if (!artifact) {
            throw new Error(`Enrollment artifact is missing: ${write.path}`);
          }
          await mkdir(dirname(write.path), { recursive: true });
          await replaceVerifiedFileAt({
            beforeExchange: async () =>
              await args.beforeCanonicalWrite?.({ index, path: write.path }),
            contents: write.content,
            directoryPath: dirname(write.path),
            expected:
              artifact.before === null
                ? null
                : {
                    contents: artifact.before,
                    identity: artifact.beforeIdentity ?? undefined,
                    mode: artifact.beforeMode ?? CANONICAL_FILE_MODE,
                  },
            fileName: basename(write.path),
            maxBytes: PROJECT_CANONICAL_FILE_MAX_BYTES,
            mode: write.precondition.mode ?? CANONICAL_FILE_MODE,
            safeRoot: args.plan.projectRoot,
          });
          artifact.written = true;
        }

        const snapshot = await buildIndexSnapshot({
          homeDir,
          rootDir: args.plan.aiRoot,
          force: true,
          machineStateDir: executionStateDir,
        });
        const generatedContents = [
          `${JSON.stringify(snapshot.index, null, 2)}\n`,
          `${JSON.stringify(snapshot.graph, null, 2)}\n`,
        ];
        const generatedArtifacts = await Promise.all(
          expectedGeneratedPaths.map(
            async (pathValue, index) =>
              await captureArtifact({
                path: pathValue,
                afterContent: generatedContents[index] ?? "",
                safeRoot: stateRoot,
              })
          )
        );
        artifacts.push(...generatedArtifacts);
        for (const [index, artifact] of generatedArtifacts.entries()) {
          await atomicWrite(artifact.path, generatedContents[index] ?? "", {
            safeRoot: stateRoot,
          });
          artifact.written = true;
        }
        await args.afterGeneratedWrites?.();

        const registrySnapshot = await loadRegistrySnapshot(homeDir);
        const registry = registrySnapshot.registry;
        const registryEntryBefore = await upsertRegistryEntry({
          homeDir,
          registry,
          plan: args.plan,
          now,
          receiptId,
        });
        registry.updatedAt = now;
        const registryContent = `${JSON.stringify(registry, null, 2)}\n`;
        const registryArtifact: TransactionArtifact = {
          path: projectRegistryPath(homeDir),
          before: registrySnapshot.before,
          beforeIdentity: registrySnapshot.beforeIdentity,
          beforeMode: registrySnapshot.beforeMode,
          afterContent: registryContent,
          afterSha256: sha256(registryContent),
          afterMode: MACHINE_LOCAL_FILE_MODE,
          afterSize: Buffer.byteLength(registryContent),
          safeRoot: stateRoot,
          safeRootIdentity: await captureSafeRootIdentity(stateRoot),
          written: false,
        };
        artifacts.push(registryArtifact);
        await atomicWrite(registryArtifact.path, registryContent, {
          beforeCommit: async () => await args.beforeRegistryWrite?.(),
          beforeExchange: async () => await args.beforeRegistryExchange?.(),
          expected:
            registrySnapshot.before === null
              ? null
              : {
                  contents: registrySnapshot.before,
                  identity: registrySnapshot.beforeIdentity ?? undefined,
                  mode: registrySnapshot.beforeMode ?? MACHINE_LOCAL_FILE_MODE,
                },
          safeRoot: stateRoot,
        });
        registryArtifact.written = true;
        await args.afterRegistryWrite?.();

        const receipt: EnrollmentReceipt = {
          version: 1,
          id: receiptId,
          createdAt: now,
          repositoryId: args.plan.identity.id,
          executionId: args.plan.executionIdentity.id,
          projectRoot: args.plan.projectRoot,
          planSha256: args.plan.planSha256,
          registryEntryBefore,
          files: canonicalArtifacts.map((artifact) => {
            if (artifact.afterSha256 === null) {
              throw new Error(
                `Enrollment artifact is missing its written hash: ${artifact.path}`
              );
            }
            return {
              path: artifact.path,
              before: artifact.before,
              beforeMode: artifact.beforeMode,
              afterSha256: artifact.afterSha256,
              afterMode: artifact.afterMode ?? CANONICAL_FILE_MODE,
            };
          }),
        };
        const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
        const receiptArtifact = await captureArtifact({
          path: receiptPath,
          afterContent: receiptContent,
          safeRoot: stateRoot,
        });
        if (receiptArtifact.before !== null) {
          throw new Error(`Enrollment receipt already exists: ${receiptId}`);
        }
        artifacts.push(receiptArtifact);
        await atomicWrite(receiptPath, receiptContent, {
          safeRoot: stateRoot,
        });
        receiptArtifact.written = true;
        await args.afterReceiptWrite?.();
        await verifyOwnedArtifacts(artifacts);
        await readReceipt({ homeDir, receiptId });
        await stateMigration?.commit();
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        try {
          await restoreOwnedArtifacts(artifacts, args.beforeCleanupRestore);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await stateMigration?.restore();
        } catch (migrationError) {
          cleanupErrors.push(migrationError);
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Project enrollment failed and transaction cleanup was incomplete"
          );
        }
        throw error;
      }
      return {
        version: 1,
        applied: true,
        repositoryId: args.plan.identity.id,
        changedPaths: args.plan.canonicalWrites.map((write) => write.path),
        generatedPaths: expectedGeneratedPaths,
        registryPath: projectRegistryPath(homeDir),
        receiptId,
        rollbackCommand: `fclt project rollback --receipt ${receiptId} --apply`,
      };
    },
    args.mutationLockAttempts
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isReceiptRegistryEntry(value: unknown): value is ProjectRegistryEntry {
  if (!isRecord(value)) {
    return false;
  }
  const aliasesValid =
    value.aliases === undefined ||
    (Array.isArray(value.aliases) &&
      value.aliases.every(
        (alias) => typeof alias === "string" && REPOSITORY_ID_RE.test(alias)
      ));
  const locationsValid =
    Array.isArray(value.locations) &&
    value.locations.every(
      (location) =>
        isRecord(location) &&
        typeof location.path === "string" &&
        isAbsolute(location.path) &&
        typeof location.firstSeenAt === "string" &&
        typeof location.lastSeenAt === "string"
    );
  const historyValid =
    Array.isArray(value.history) &&
    value.history.every(
      (event) =>
        isRecord(event) &&
        typeof event.at === "string" &&
        typeof event.action === "string" &&
        PROJECT_HISTORY_ACTIONS.has(event.action) &&
        typeof event.root === "string" &&
        isAbsolute(event.root) &&
        (event.receiptId === undefined ||
          (typeof event.receiptId === "string" &&
            RECEIPT_ID_RE.test(event.receiptId)))
    );
  const activeReceiptsValid =
    value.activeReceipts === undefined ||
    (isRecord(value.activeReceipts) &&
      Object.entries(value.activeReceipts).every(
        ([root, receiptId]) =>
          isAbsolute(root) &&
          typeof receiptId === "string" &&
          RECEIPT_ID_RE.test(receiptId)
      ));
  return (
    typeof value.repositoryId === "string" &&
    REPOSITORY_ID_RE.test(value.repositoryId) &&
    aliasesValid &&
    typeof value.identityKind === "string" &&
    ["remote", "root-commit", "git-common-dir"].includes(value.identityKind) &&
    typeof value.identityFingerprint === "string" &&
    typeof value.decision === "string" &&
    PROJECT_DECISIONS.has(value.decision) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (source) => typeof source === "string" && PROJECT_SOURCES.has(source)
    ) &&
    typeof value.cadence === "string" &&
    PROJECT_CADENCES.has(value.cadence) &&
    typeof value.scheduling === "boolean" &&
    Array.isArray(value.guidance) &&
    value.guidance.every((guidance) => typeof guidance === "string") &&
    locationsValid &&
    (value.lastSuccessfulRun === null ||
      typeof value.lastSuccessfulRun === "string") &&
    Array.isArray(value.pendingApprovals) &&
    value.pendingApprovals.every((approval) => typeof approval === "string") &&
    historyValid &&
    activeReceiptsValid
  );
}

async function readReceipt(args: {
  homeDir: string;
  receiptId: string;
}): Promise<EnrollmentReceipt> {
  if (!RECEIPT_ID_RE.test(args.receiptId)) {
    throw new Error("Invalid enrollment receipt id");
  }
  const pathValue = join(
    projectReceiptsDir(args.homeDir),
    `${args.receiptId}.json`
  );
  const snapshot = await canonicalFileSnapshot(pathValue);
  if (!snapshot) {
    throw new Error(`Invalid enrollment receipt: ${args.receiptId}`);
  }
  const parsed = JSON.parse(snapshot.content) as EnrollmentReceipt;
  const validProjectRoot =
    typeof parsed.projectRoot === "string" && isAbsolute(parsed.projectRoot);
  const allowedFiles = new Set(
    validProjectRoot
      ? [
          join(parsed.projectRoot, ".ai", ".gitignore"),
          join(parsed.projectRoot, ".ai", "config.toml"),
        ]
      : []
  );
  if (
    parsed.version !== 1 ||
    parsed.id !== args.receiptId ||
    typeof parsed.repositoryId !== "string" ||
    !REPOSITORY_ID_RE.test(parsed.repositoryId) ||
    typeof parsed.executionId !== "string" ||
    !EXECUTION_ID_RE.test(parsed.executionId) ||
    !validProjectRoot ||
    typeof parsed.planSha256 !== "string" ||
    !PLAN_SHA_RE.test(parsed.planSha256) ||
    (parsed.registryEntryBefore !== undefined &&
      parsed.registryEntryBefore !== null &&
      !isReceiptRegistryEntry(parsed.registryEntryBefore)) ||
    (parsed.registryEntryBefore !== undefined &&
      parsed.registryEntryBefore !== null &&
      parsed.registryEntryBefore.repositoryId !== parsed.repositoryId) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length !== 2 ||
    parsed.files.some(
      (file) =>
        !file ||
        typeof file !== "object" ||
        typeof file.path !== "string" ||
        !allowedFiles.has(file.path) ||
        typeof file.afterSha256 !== "string" ||
        !PLAN_SHA_RE.test(file.afterSha256) ||
        (file.before !== null && typeof file.before !== "string") ||
        (file.beforeMode !== null &&
          (!Number.isSafeInteger(file.beforeMode) ||
            file.beforeMode < 0 ||
            file.beforeMode > 0o777)) ||
        (file.before === null && file.beforeMode !== null) ||
        (file.before !== null && file.beforeMode === null) ||
        !Number.isSafeInteger(file.afterMode) ||
        file.afterMode < 0 ||
        file.afterMode > 0o777
    )
  ) {
    throw new Error(`Invalid enrollment receipt: ${args.receiptId}`);
  }
  return parsed;
}

function effectiveDecisionFromLaterHistory(args: {
  activeReceipts: Record<string, string>;
  history: ProjectRegistryHistory[];
}): ProjectDecision | null {
  const activeReceiptIds = new Set(Object.values(args.activeReceipts));
  let decision: ProjectDecision | null = null;
  for (const event of args.history) {
    switch (event.action) {
      case "enrolled":
        if (event.receiptId && activeReceiptIds.has(event.receiptId)) {
          decision = "selected";
        }
        break;
      case "disabled":
      case "ignored":
      case "inactive":
      case "removed":
        decision = event.action;
        break;
      default:
        break;
    }
  }
  return decision;
}

function registryEntryAfterRollback(args: {
  current: ProjectRegistryEntry;
  now: string;
  receipt: EnrollmentReceipt;
}): ProjectRegistryEntry {
  const rollbackEvent: ProjectRegistryHistory = {
    at: args.now,
    action: "rolled-back",
    root: args.receipt.projectRoot,
    receiptId: args.receipt.id,
  };
  const enrollmentIndex = args.current.history.findLastIndex(
    (event) =>
      event.action === "enrolled" &&
      event.root === args.receipt.projectRoot &&
      event.receiptId === args.receipt.id
  );
  if (enrollmentIndex < 0) {
    throw new Error(
      "Rollback refused because the registry enrollment history is incomplete"
    );
  }
  const enrollmentEvent = args.current.history[enrollmentIndex];
  if (!enrollmentEvent) {
    throw new Error(
      "Rollback refused because the registry enrollment history is incomplete"
    );
  }
  const laterHistory = args.current.history.slice(enrollmentIndex + 1);
  const previous = args.receipt.registryEntryBefore;
  if (!previous) {
    const restored = structuredClone(args.current);
    delete restored.activeReceipts?.[args.receipt.projectRoot];
    restored.decision =
      effectiveDecisionFromLaterHistory({
        activeReceipts: restored.activeReceipts ?? {},
        history: laterHistory,
      }) ??
      (Object.keys(restored.activeReceipts ?? {}).length > 0
        ? "selected"
        : "disabled");
    restored.history.push(rollbackEvent);
    return restored;
  }

  const restored = structuredClone(previous);
  const activeReceipts = {
    ...(previous.activeReceipts ?? {}),
    ...Object.fromEntries(
      Object.entries(args.current.activeReceipts ?? {}).filter(
        ([root]) => root !== args.receipt.projectRoot
      )
    ),
  };
  const previousReceipt = previous.activeReceipts?.[args.receipt.projectRoot];
  if (previousReceipt) {
    activeReceipts[args.receipt.projectRoot] = previousReceipt;
  } else {
    delete activeReceipts[args.receipt.projectRoot];
  }
  if (laterHistory.length > 0) {
    const locations = new Map(
      args.current.locations
        .filter((location) => location.path !== args.receipt.projectRoot)
        .map((location) => [location.path, location])
    );
    const previousLocation = previous.locations.find(
      (location) => location.path === args.receipt.projectRoot
    );
    if (previousLocation) {
      locations.set(previousLocation.path, previousLocation);
    }
    restored.locations = [...locations.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    );
  }
  restored.activeReceipts = activeReceipts;
  restored.decision =
    effectiveDecisionFromLaterHistory({
      activeReceipts,
      history: laterHistory,
    }) ?? previous.decision;
  restored.history = [
    ...previous.history,
    enrollmentEvent,
    ...laterHistory,
    rollbackEvent,
  ];
  return restored;
}

export async function rollbackProjectEnrollment(args: {
  receiptId: string;
  homeDir?: string;
  apply?: boolean;
  now?: Date;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeCanonicalRemove?: (args: { path: string }) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeCanonicalRestore?: (args: { path: string }) => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeRegistryWrite?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeRegistryExchange?: () => Promise<void>;
  /** @internal Platform branch override for cross-platform regression tests. */
  platform?: NodeJS.Platform;
  /** @internal Platform branch override for removal regression tests. */
  removalPlatform?: NodeJS.Platform;
}): Promise<{
  version: 1;
  applied: boolean;
  receiptId: string;
  repositoryId: string;
  restores: Array<{ path: string; action: "restore" | "remove" }>;
  preserved: string[];
}> {
  const homeDir = resolve(args.homeDir ?? process.env.HOME ?? homedir());
  const receipt = await readReceipt({ homeDir, receiptId: args.receiptId });
  const restores = receipt.files.map((file) => ({
    path: file.path,
    action: file.before === null ? ("remove" as const) : ("restore" as const),
  }));
  if (!args.apply) {
    return {
      version: 1,
      applied: false,
      receiptId: receipt.id,
      repositoryId: receipt.repositoryId,
      restores,
      preserved: [
        projectRegistryPath(homeDir),
        join(projectReceiptsDir(homeDir), `${receipt.id}.json`),
      ],
    };
  }
  assertProjectRegistryMutationSupported(args.platform ?? process.platform);
  return await withProjectsMutationLock(homeDir, async () => {
    const currentReceipt = await readReceipt({
      homeDir,
      receiptId: args.receiptId,
    });
    const [currentIdentity, currentExecutionIdentity] = await Promise.all([
      resolveRepositoryIdentity(currentReceipt.projectRoot, homeDir),
      resolveRepositoryExecutionIdentity(currentReceipt.projectRoot),
    ]);
    if (
      currentIdentity.id !== currentReceipt.repositoryId ||
      currentExecutionIdentity.id !== currentReceipt.executionId
    ) {
      throw new Error(
        "Rollback refused because the receipt project root no longer identifies the enrolled repository"
      );
    }
    await assertSafeCanonicalTargets(
      currentReceipt.projectRoot,
      join(currentReceipt.projectRoot, ".ai")
    );
    const registryPath = projectRegistryPath(homeDir);
    const registrySnapshot = await loadRegistrySnapshot(homeDir);
    const registryBefore = registrySnapshot.before;
    if (registryBefore === null) {
      throw new Error(`Project registry is invalid: ${registryPath}`);
    }
    const registry = parseRegistryText(registryBefore, registryPath);
    const entryMatch =
      Object.entries(registry.projects).find(
        ([key]) => key === currentReceipt.repositoryId
      ) ??
      Object.entries(registry.projects).find(([, candidate]) =>
        candidate.aliases?.includes(currentReceipt.repositoryId)
      );
    const entryKey = entryMatch?.[0];
    const entry = entryMatch?.[1];
    if (
      !entry ||
      entry.activeReceipts?.[currentReceipt.projectRoot] !== currentReceipt.id
    ) {
      throw new Error(
        "Rollback refused because this receipt is not the active enrollment for its checkout"
      );
    }
    for (const file of currentReceipt.files) {
      const current = await regularFileText(file.path);
      const metadata = await lstatIfExists(file.path);
      if (
        current === null ||
        !metadata ||
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        sha256(current) !== file.afterSha256 ||
        permissionMode(metadata.mode) !== file.afterMode
      ) {
        throw new Error(
          `Rollback refused because an enrolled file changed after apply: ${file.path}`
        );
      }
    }
    const now = (args.now ?? new Date()).toISOString();
    if (!entryKey) {
      throw new Error(
        "Rollback refused because the active registry entry is missing"
      );
    }
    registry.projects[entryKey] = registryEntryAfterRollback({
      current: entry,
      now,
      receipt: currentReceipt,
    });
    registry.updatedAt = now;
    const registryContent = `${JSON.stringify(registry, null, 2)}\n`;
    const registryArtifact: TransactionArtifact = {
      path: registryPath,
      before: registryBefore,
      beforeIdentity: registrySnapshot.beforeIdentity,
      beforeMode: registrySnapshot.beforeMode,
      afterContent: registryContent,
      afterSha256: sha256(registryContent),
      afterMode: MACHINE_LOCAL_FILE_MODE,
      afterSize: Buffer.byteLength(registryContent),
      safeRoot: facultLocalStateRoot(homeDir),
      safeRootIdentity: await captureSafeRootIdentity(
        facultLocalStateRoot(homeDir)
      ),
      written: false,
    };
    const canonicalArtifacts = await Promise.all(
      currentReceipt.files.map(
        async (file) =>
          await captureArtifact({
            path: file.path,
            afterContent: file.before,
            afterMode: file.beforeMode ?? undefined,
            safeRoot: currentReceipt.projectRoot,
          })
      )
    );
    for (const [index, file] of currentReceipt.files.entries()) {
      const artifact = canonicalArtifacts[index];
      if (
        !artifact ||
        artifact.before === null ||
        artifact.beforeMode !== file.afterMode ||
        sha256(artifact.before) !== file.afterSha256
      ) {
        throw new Error(
          `Rollback refused because an enrolled file changed before its transaction snapshot: ${file.path}`
        );
      }
    }
    const artifactByPath = new Map(
      canonicalArtifacts.map((artifact) => [artifact.path, artifact])
    );
    const artifacts = [...canonicalArtifacts, registryArtifact];
    try {
      for (const file of currentReceipt.files.toReversed()) {
        const artifact = artifactByPath.get(file.path);
        if (!artifact) {
          throw new Error(`Rollback artifact is missing: ${file.path}`);
        }
        if (file.before === null) {
          await unlinkVerifiedFileAt({
            beforeCommit: async () =>
              await args.beforeCanonicalRemove?.({ path: file.path }),
            directoryPath: dirname(file.path),
            expectedSha256: file.afterSha256,
            fileName: basename(file.path),
            maxBytes: PROJECT_CANONICAL_FILE_MAX_BYTES,
            platform: args.removalPlatform,
            safeRoot: currentReceipt.projectRoot,
          });
        } else {
          if (artifact.before === null) {
            throw new Error(
              `Rollback artifact is missing its enrolled content: ${file.path}`
            );
          }
          await replaceVerifiedFileAt({
            beforeExchange: async () => {
              await args.beforeCanonicalRestore?.({ path: file.path });
              await assertSafeCanonicalTargets(
                currentReceipt.projectRoot,
                join(currentReceipt.projectRoot, ".ai")
              );
            },
            contents: file.before,
            directoryPath: dirname(file.path),
            expected: {
              contents: artifact.before,
              identity: artifact.beforeIdentity ?? undefined,
              mode: artifact.beforeMode ?? file.afterMode,
            },
            fileName: basename(file.path),
            maxBytes: PROJECT_CANONICAL_FILE_MAX_BYTES,
            mode: file.beforeMode ?? CANONICAL_FILE_MODE,
            safeRoot: currentReceipt.projectRoot,
          });
        }
        artifact.written = true;
      }
      await atomicWrite(registryPath, registryContent, {
        beforeCommit: async () => await args.beforeRegistryWrite?.(),
        beforeExchange: async () => await args.beforeRegistryExchange?.(),
        expected: {
          contents: registryBefore,
          identity: registrySnapshot.beforeIdentity ?? undefined,
          mode: registrySnapshot.beforeMode ?? MACHINE_LOCAL_FILE_MODE,
        },
        safeRoot: facultLocalStateRoot(homeDir),
      });
      registryArtifact.written = true;
      await verifyOwnedArtifacts(artifacts);
    } catch (error) {
      try {
        await restoreOwnedArtifacts(artifacts);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Project rollback failed and transaction cleanup was incomplete"
        );
      }
      throw error;
    }
    return {
      version: 1,
      applied: true,
      receiptId: currentReceipt.id,
      repositoryId: currentReceipt.repositoryId,
      restores,
      preserved: [
        projectRegistryPath(homeDir),
        join(projectReceiptsDir(homeDir), `${currentReceipt.id}.json`),
      ],
    };
  });
}

async function recordDecision(args: {
  projectRoot: string;
  homeDir: string;
  decision: Exclude<ProjectDecision, "selected">;
  now: Date;
  dryRun?: boolean;
  /** @internal Platform branch override for cross-platform regression tests. */
  platform?: NodeJS.Platform;
}): Promise<{
  version: 1;
  repositoryId: string;
  decision: Exclude<ProjectDecision, "selected">;
  preserved: string[];
}> {
  const projectRoot = await gitRoot(args.projectRoot);
  const identity = await resolveRepositoryIdentity(projectRoot, args.homeDir);
  if (args.dryRun) {
    return {
      version: 1,
      repositoryId: identity.id,
      decision: args.decision,
      preserved: [
        join(projectRoot, ".ai"),
        projectRegistryPath(args.homeDir),
        projectReceiptsDir(args.homeDir),
      ],
    };
  }
  assertProjectRegistryMutationSupported(args.platform ?? process.platform);
  return await withProjectsMutationLock(args.homeDir, async () => {
    const registrySnapshot = await loadRegistrySnapshot(args.homeDir);
    const registry = registrySnapshot.registry;
    const now = args.now.toISOString();
    const current = registryEntryForIdentity({
      registry,
      identity,
      projectRoot,
    });
    const locations = [...(current?.locations ?? [])];
    const location = locations.find(
      (candidate) => candidate.path === projectRoot
    );
    if (location) {
      location.lastSeenAt = now;
    } else {
      locations.push({
        path: projectRoot,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
    const action =
      args.decision === "disabled"
        ? "disabled"
        : args.decision === "removed"
          ? "removed"
          : args.decision;
    registry.projects[identity.id] = {
      repositoryId: identity.id,
      aliases: uniqueSorted([
        ...(current?.aliases ?? []),
        ...identity.aliases.map((alias) => alias.id),
      ]),
      identityKind: identity.kind,
      identityFingerprint: identity.fingerprint,
      decision: args.decision,
      sources: current?.sources ?? [],
      cadence: current?.cadence ?? "on-demand",
      scheduling: false,
      guidance: current?.guidance ?? [],
      locations: locations.sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
      lastSuccessfulRun: current?.lastSuccessfulRun ?? null,
      pendingApprovals: current?.pendingApprovals ?? [],
      history: [
        ...(current?.history ?? []),
        {
          at: now,
          action,
          root: projectRoot,
        },
      ],
      activeReceipts: current?.activeReceipts ?? {},
    };
    await saveRegistry({
      homeDir: args.homeDir,
      registry,
      snapshot: registrySnapshot,
      now,
    });
    return {
      version: 1,
      repositoryId: identity.id,
      decision: args.decision,
      preserved: [
        join(projectRoot, ".ai"),
        projectRegistryPath(args.homeDir),
        projectReceiptsDir(args.homeDir),
      ],
    };
  });
}

export async function buildProjectsStatus(args: {
  homeDir?: string;
  discoveryRoots?: string[];
}): Promise<{
  version: 1;
  registryPath: string;
  projects: ProjectStatusRow[];
}> {
  const homeDir = resolve(args.homeDir ?? process.env.HOME ?? homedir());
  const registry = await loadRegistry(homeDir);
  const discovered =
    args.discoveryRoots && args.discoveryRoots.length > 0
      ? await discoverProjects({
          roots: args.discoveryRoots,
          homeDir,
        })
      : null;
  const discoveredById = new Map<string, DiscoveredProject[]>();
  const rawDiscoveredIdentityByRoot = new Map<string, RepositoryIdentity>();
  for (const project of discovered?.projects ?? []) {
    const rows = discoveredById.get(project.identity.id) ?? [];
    rows.push(project);
    discoveredById.set(project.identity.id, rows);
    rawDiscoveredIdentityByRoot.set(
      project.root,
      await resolveUnstabilizedRepositoryIdentity(project.root)
    );
  }
  const rows: ProjectStatusRow[] = [];
  const entries = new Map(
    Object.values(registry.projects).map((entry) => [entry.repositoryId, entry])
  );
  for (const [repositoryId, projects] of discoveredById) {
    const first = projects[0];
    if (!first) {
      continue;
    }
    const rawIdentity =
      rawDiscoveredIdentityByRoot.get(first.root) ?? first.identity;
    const aliasedEntry = [...entries.entries()].find(([key, entry]) =>
      registryStoredLocationMatchesIdentity({
        key,
        entry,
        identity: rawIdentity,
      })
    );
    if (!entries.has(repositoryId) && aliasedEntry) {
      entries.delete(aliasedEntry[0]);
      entries.set(repositoryId, {
        ...aliasedEntry[1],
        repositoryId,
        aliases: uniqueSorted([
          ...(aliasedEntry[1].aliases ?? []),
          aliasedEntry[0],
          ...first.identity.aliases.map((alias) => alias.id),
        ]).filter((alias) => alias !== repositoryId),
        identityKind: first.identity.kind,
        identityFingerprint: first.identity.fingerprint,
      });
    }
    if (!entries.has(repositoryId)) {
      entries.set(repositoryId, {
        repositoryId,
        aliases: first.identity.aliases.map((alias) => alias.id),
        identityKind: first.identity.kind,
        identityFingerprint: first.identity.fingerprint,
        decision: "inactive",
        sources: [],
        cadence: "on-demand",
        scheduling: false,
        guidance: [],
        locations: projects.map((project) => ({
          path: project.root,
          firstSeenAt: "",
          lastSeenAt: "",
        })),
        lastSuccessfulRun: null,
        pendingApprovals: [],
        history: [],
        activeReceipts: {},
      });
    }
  }
  for (const entry of entries.values()) {
    const locations = new Map(
      entry.locations.map((location) => [
        location.path,
        {
          path: location.path,
          exists: false,
          dirty: null as boolean | null,
        },
      ])
    );
    for (const project of discoveredById.get(entry.repositoryId) ?? []) {
      const rawIdentity =
        rawDiscoveredIdentityByRoot.get(project.root) ?? project.identity;
      if (
        !registryStoredLocationMatchesIdentity({
          key: entry.repositoryId,
          entry,
          identity: rawIdentity,
        })
      ) {
        continue;
      }
      locations.set(project.root, {
        path: project.root,
        exists: true,
        dirty: project.dirty,
      });
    }
    for (const location of locations.values()) {
      if (!location.exists) {
        location.exists = await pathExists(location.path);
        if (location.exists) {
          const inspected = await inspectRepository(location.path, homeDir, {
            stabilizeIdentity: false,
          });
          const identityMatches = registryStoredLocationMatchesIdentity({
            key: entry.repositoryId,
            entry,
            identity: inspected.identity,
          });
          location.exists = identityMatches;
          location.dirty = identityMatches ? inspected.dirty : null;
        }
      }
    }
    const receiptLocations = Object.keys(entry.activeReceipts ?? {}).map(
      (pathValue) =>
        locations.get(pathValue) ?? {
          path: pathValue,
          exists: false,
          dirty: null,
        }
    );
    const fallbackLocation = [...locations.values()].find(
      (location) => location.exists
    );
    for (const receiptLocation of receiptLocations) {
      if (!locations.has(receiptLocation.path)) {
        locations.set(receiptLocation.path, receiptLocation);
      }
    }
    const activeLocations =
      receiptLocations.length > 0
        ? receiptLocations
        : fallbackLocation
          ? [fallbackLocation]
          : [];
    const activeLocation = activeLocations.find((location) => location.exists);
    const canonicalRoot = activeLocation
      ? join(activeLocation.path, ".ai")
      : null;
    const activeHealth = await Promise.all(
      activeLocations.map(async (location) => {
        const aiRoot = join(location.path, ".ai");
        if (!location.exists) {
          return {
            aiRoot,
            config: false,
            generatedGraph: false,
            generatedIndex: false,
            protectiveIgnore: false,
          };
        }
        const [config, protectiveIgnore, generatedIndex, generatedGraph] =
          await Promise.all([
            validProjectEnrollmentConfig(join(aiRoot, "config.toml"), entry),
            hasEffectiveProtectiveIgnore(location.path),
            validBoundedGeneratedJson(
              facultAiIndexPath(homeDir, aiRoot),
              isGeneratedIndex
            ),
            validBoundedGeneratedJson(
              facultAiGraphPath(homeDir, aiRoot),
              isGeneratedGraph
            ),
          ]);
        return {
          aiRoot,
          config,
          generatedGraph,
          generatedIndex,
          protectiveIgnore,
        };
      })
    );
    const config =
      activeHealth.length > 0 &&
      activeHealth.every((location) => location.config);
    const protectiveIgnore =
      activeHealth.length > 0 &&
      activeHealth.every((location) => location.protectiveIgnore);
    const generatedIndex =
      activeHealth.length > 0 &&
      activeHealth.every((location) => location.generatedIndex);
    const generatedGraph =
      activeHealth.length > 0 &&
      activeHealth.every((location) => location.generatedGraph);
    const inactive = entry.decision !== "selected";
    const exists =
      activeHealth.length > 0 &&
      (
        await Promise.all(
          activeHealth.map((location) => pathExists(location.aiRoot))
        )
      ).every(Boolean);
    const coverage = inactive
      ? ("inactive" as const)
      : config && protectiveIgnore
        ? ("covered" as const)
        : ("partial" as const);
    const health = activeLocation
      ? coverage === "covered" && generatedIndex && generatedGraph
        ? ("healthy" as const)
        : ("degraded" as const)
      : ("unavailable" as const);
    rows.push({
      repositoryId: entry.repositoryId,
      decision: entry.decision,
      coverage,
      health,
      canonicalRoot,
      canonical: {
        exists,
        config,
        protectiveIgnore,
        guidance: entry.guidance,
      },
      generated: {
        index: generatedIndex,
        graph: generatedGraph,
        health: generatedIndex && generatedGraph ? "ready" : "missing",
      },
      sources: entry.sources,
      scheduler: {
        cadence: entry.cadence,
        enabled: entry.scheduling,
        health:
          entry.cadence === "on-demand"
            ? "on-demand"
            : entry.scheduling
              ? "configured"
              : "not-enabled",
        lastSuccessfulRun: entry.lastSuccessfulRun,
      },
      pendingApprovals: entry.pendingApprovals,
      locations: [...locations.values()].sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
    });
  }
  return {
    version: 1,
    registryPath: projectRegistryPath(homeDir),
    projects: rows.sort((left, right) =>
      left.repositoryId.localeCompare(right.repositoryId)
    ),
  };
}

function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === flag) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${flag} requires a value`);
      }
      values.push(value);
      index += 1;
    } else if (arg?.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const values = flagValues(argv, flag);
  if (values.length > 1) {
    throw new Error(`${flag} may be provided only once`);
  }
  return values[0];
}

function positiveIntegerFlag(argv: string[], flag: string): number | undefined {
  const value = flagValue(argv, flag);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function printProjectsHelp(): void {
  console.log(`fclt projects — bounded portfolio discovery and status

Usage:
  fclt projects discover --root PATH [--root PATH] [--since 30d] [--json]
  fclt projects status [--root PATH] [--json]

Discovery is read-only and requires explicit roots. It never enrolls repositories.`);
}

function printProjectHelp(): void {
  console.log(`fclt project — preview-first project enrollment

Usage:
  fclt project init [--project-root PATH] [--guidance PATH] [--source SOURCE] [--cadence on-demand|weekly|daily] [--json]
  fclt project init --apply --plan-sha SHA [same options] [--dry-run]
  fclt project rollback --receipt ID [--apply] [--dry-run] [--json]
  fclt project disable --project-root PATH [--dry-run] [--json]
  fclt project ignore --project-root PATH [--dry-run] [--json]
  fclt project inactive --project-root PATH [--dry-run] [--json]
  fclt project remove --project-root PATH [--dry-run] [--json]

Init prints an exact plan and performs no writes by default. Apply requires the
SHA from that plan. Existing guidance is referenced only when explicitly
selected, tracked, clean, and privacy-safe; it is never copied automatically.`);
}

export async function projectsCommand(
  argv: string[],
  context: ProjectCommandContext = {}
): Promise<void> {
  if (
    argv.length === 0 ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printProjectsHelp();
    return;
  }
  const command = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes("--json");
  try {
    if (command === "discover") {
      const result = await discoverProjects({
        roots: flagValues(rest, "--root"),
        homeDir: context.homeDir,
        since: flagValue(rest, "--since"),
        maxVisits: positiveIntegerFlag(rest, "--max-visits"),
        maxResults: positiveIntegerFlag(rest, "--max-results"),
        now: context.now?.(),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "status") {
      const result = await buildProjectsStatus({
        homeDir: context.homeDir,
        discoveryRoots: flagValues(rest, "--root"),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          result.projects.length === 0
            ? "No project decisions recorded."
            : result.projects
                .map(
                  (project) =>
                    `${project.repositoryId} ${project.decision} ${project.coverage} ${project.health}`
                )
                .join("\n")
        );
      }
      return;
    }
    throw new Error(`Unknown projects command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function projectCommand(
  argv: string[],
  context: ProjectCommandContext = {}
): Promise<void> {
  if (
    argv.length === 0 ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printProjectHelp();
    return;
  }
  const command = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes("--json");
  const dryRun = rest.includes("--dry-run");
  const homeDir = resolve(context.homeDir ?? process.env.HOME ?? homedir());
  const projectRoot = resolve(
    flagValue(rest, "--project-root") ?? context.cwd ?? process.cwd()
  );
  try {
    if (command === "init" || command === "plan") {
      const sources = flagValues(rest, "--source") as ProjectSource[];
      const plan = await planProjectEnrollment({
        projectRoot,
        homeDir,
        sources: sources.length > 0 ? sources : undefined,
        cadence: flagValue(rest, "--cadence") as ProjectCadence | undefined,
        scheduling: rest.includes("--schedule"),
        guidance: flagValues(rest, "--guidance"),
      });
      if (!rest.includes("--apply")) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      const expectedPlanSha256 = flagValue(rest, "--plan-sha");
      if (!expectedPlanSha256) {
        throw new Error("--apply requires --plan-sha from the reviewed plan");
      }
      if (dryRun) {
        if (plan.planSha256 !== expectedPlanSha256) {
          throw new Error(
            "Apply requires the exact plan SHA from the reviewed preview"
          );
        }
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      const result = await applyProjectEnrollment({
        plan,
        expectedPlanSha256,
        homeDir,
        now: context.now?.(),
        platform: context.platform,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "rollback") {
      const receiptId = flagValue(rest, "--receipt");
      if (!receiptId) {
        throw new Error("project rollback requires --receipt");
      }
      const result = await rollbackProjectEnrollment({
        receiptId,
        homeDir,
        apply: rest.includes("--apply") && !dryRun,
        now: context.now?.(),
        platform: context.platform,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const decisions: Record<string, Exclude<ProjectDecision, "selected">> = {
      disable: "disabled",
      ignore: "ignored",
      inactive: "inactive",
      remove: "removed",
    };
    const decision = decisions[command ?? ""];
    if (decision) {
      const result = await recordDecision({
        projectRoot,
        homeDir,
        decision,
        now: context.now?.() ?? new Date(),
        dryRun,
        platform: context.platform,
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `${result.repositoryId}: ${result.decision}; canonical files and review history preserved`
        );
      }
      return;
    }
    throw new Error(`Unknown project command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
