import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
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
import { buildIndex } from "./index-builder";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  facultLocalStateRoot,
} from "./paths";

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
const PROTECTIVE_IGNORE_LINES = [
  "# fclt machine-local and generated state",
  "/.facult/",
  "/config.local.toml",
];
const SECRET_SHAPE_RE =
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"'#]{8,}/i;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LOCAL_ABSOLUTE_PATH_RE =
  /(?:^|[\s"'`(])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/m;
const REPOSITORY_ID_RE = /^repo_[a-f0-9]{24}$/;
const SCP_REMOTE_RE = /^([^@/\s]+@)?([^:/\s]+):(.+)$/;
const GIT_PROTOCOL_PREFIX_RE = /^git\+/;
const GIT_SUFFIX_RE = /\.git\/?$/;
const TRAILING_SLASH_RE = /\/+$/;
const LINE_SPLIT_RE = /\r?\n/;
const SINCE_RE = /^(\d+)([dhw])$/;
const PATH_PART_SPLIT_RE = /[\\/]/;
const RECEIPT_ID_RE = /^enroll-[a-zA-Z0-9-]+$/;
const NON_DIGIT_RE = /[^0-9]/g;
const PLAN_SHA_RE = /^[a-f0-9]{64}$/;

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

export interface RepositoryIdentity {
  id: string;
  kind: "remote" | "root-commit" | "git-common-dir";
  fingerprint: string;
  stability: "portable" | "machine-local";
}

export interface DiscoveredProject {
  root: string;
  name: string;
  identity: RepositoryIdentity;
  branch: string | null;
  head: string | null;
  lastCommitAt: string | null;
  dirty: boolean;
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
}

export interface ProjectEnrollmentPlan {
  version: 1;
  operation: "project-init";
  projectRoot: string;
  aiRoot: string;
  identity: RepositoryIdentity;
  worktree: {
    dirty: boolean;
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
  projectRoot: string;
  planSha256: string;
  files: Array<{
    path: string;
    before: string | null;
    afterSha256: string;
  }>;
}

export interface ProjectCommandContext {
  cwd?: string;
  homeDir?: string;
  now?: () => Date;
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
}): Promise<GitCommandResult> {
  const gitBinary = Bun.which("git") ?? "/usr/bin/git";
  const proc = Bun.spawn({
    cmd: [gitBinary, ...args.argv],
    cwd: args.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  return await stat(pathValue)
    .then(() => true)
    .catch(() => false);
}

async function fileText(pathValue: string): Promise<string | null> {
  return await readFile(pathValue, "utf8").catch(() => null);
}

async function filePrecondition(pathValue: string): Promise<FilePrecondition> {
  const content = await fileText(pathValue);
  return {
    path: pathValue,
    existed: content !== null,
    sha256: content === null ? null : sha256(content),
  };
}

function normalizeRemote(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith("/") || value.startsWith("./")) {
    return null;
  }
  const scpMatch = value.includes("://") ? null : value.match(SCP_REMOTE_RE);
  const asUrl = scpMatch
    ? `ssh://${scpMatch[2]}/${scpMatch[3]}`
    : value.replace(GIT_PROTOCOL_PREFIX_RE, "");
  try {
    const parsed = new URL(asUrl);
    if (parsed.protocol === "file:") {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname
      .replace(GIT_SUFFIX_RE, "")
      .replace(TRAILING_SLASH_RE, "");
    const port =
      parsed.port &&
      !(
        (parsed.protocol === "https:" && parsed.port === "443") ||
        (parsed.protocol === "http:" && parsed.port === "80") ||
        (parsed.protocol === "ssh:" && parsed.port === "22")
      )
        ? `:${parsed.port}`
        : "";
    return `${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return null;
  }
}

async function gitRoot(pathValue: string): Promise<string> {
  const result = await runGit({
    cwd: resolve(pathValue),
    argv: ["rev-parse", "--show-toplevel"],
  });
  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(`Not a Git repository: ${resolve(pathValue)}`);
  }
  return await realpath(result.stdout).catch(() => resolve(result.stdout));
}

export async function resolveRepositoryIdentity(
  projectRoot: string
): Promise<RepositoryIdentity> {
  const root = await gitRoot(projectRoot);
  const remotes = await runGit({ cwd: root, argv: ["remote"] });
  if (remotes.exitCode === 0) {
    for (const name of remotes.stdout.split("\n").filter(Boolean).sort()) {
      const remote = await runGit({
        cwd: root,
        argv: ["remote", "get-url", name],
      });
      const normalized =
        remote.exitCode === 0 ? normalizeRemote(remote.stdout) : null;
      if (normalized) {
        return {
          id: `repo_${sha256(`remote:${normalized}`).slice(0, 24)}`,
          kind: "remote",
          fingerprint: normalized,
          stability: "portable",
        };
      }
    }
  }

  const roots = await runGit({
    cwd: root,
    argv: ["rev-list", "--max-parents=0", "HEAD"],
  });
  const rootCommit = roots.stdout.split("\n").filter(Boolean).sort()[0];
  if (roots.exitCode === 0 && rootCommit) {
    return {
      id: `repo_${sha256(`root-commit:${rootCommit}`).slice(0, 24)}`,
      kind: "root-commit",
      fingerprint: rootCommit,
      stability: "portable",
    };
  }

  const commonDir = await runGit({
    cwd: root,
    argv: ["rev-parse", "--git-common-dir"],
  });
  const commonPath = resolve(root, commonDir.stdout || ".git");
  return {
    id: `repo_${sha256(`git-common-dir:${commonPath}`).slice(0, 24)}`,
    kind: "git-common-dir",
    fingerprint: sha256(commonPath),
    stability: "machine-local",
  };
}

async function inspectRepository(
  rootValue: string
): Promise<DiscoveredProject> {
  const root = await gitRoot(rootValue);
  const [identity, branch, head, lastCommit, statusResult] = await Promise.all([
    resolveRepositoryIdentity(root),
    runGit({ cwd: root, argv: ["branch", "--show-current"] }),
    runGit({ cwd: root, argv: ["rev-parse", "--verify", "HEAD"] }),
    runGit({ cwd: root, argv: ["log", "-1", "--format=%cI"] }),
    runGit({
      cwd: root,
      argv: ["status", "--porcelain=v1", "--untracked-files=all"],
    }),
  ]);
  const aiRoot = join(root, ".ai");
  const ignoreText = await fileText(join(aiRoot, ".gitignore"));
  return {
    root,
    name: basename(root),
    identity,
    branch: branch.exitCode === 0 && branch.stdout ? branch.stdout : null,
    head: head.exitCode === 0 && head.stdout ? head.stdout : null,
    lastCommitAt:
      lastCommit.exitCode === 0 && lastCommit.stdout ? lastCommit.stdout : null,
    dirty: statusResult.exitCode === 0 && Boolean(statusResult.stdout),
    canonicalAiRoot: aiRoot,
    canonicalAiExists: await pathExists(aiRoot),
    protectiveIgnore: PROTECTIVE_IGNORE_LINES.slice(1).every((line) =>
      ignoreText?.split(LINE_SPLIT_RE).includes(line)
    ),
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
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => []
    );
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
  const inspected = await Promise.all(
    discovered.roots.map(async (root) => await inspectRepository(root))
  );
  const projects = inspected
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
  const out = [...lines];
  while (out.at(-1) === "") {
    out.pop();
  }
  for (const line of PROTECTIVE_IGNORE_LINES) {
    if (!out.includes(line)) {
      if (line.startsWith("#") && out.length > 0 && out.at(-1) !== "") {
        out.push("");
      }
      out.push(line);
    }
  }
  return `${out.join("\n")}\n`;
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
  if ("project" in (parsed as Record<string, unknown>)) {
    throw new Error(
      "Refusing to replace existing canonical project enrollment config"
    );
  }
  const projectTable = enrollmentConfig.slice(
    enrollmentConfig.indexOf("[project]")
  );
  return `${existing.trimEnd()}\n\n${projectTable}`;
}

function privacyFindings(content: string): string[] {
  const findings: string[] = [];
  if (SECRET_SHAPE_RE.test(content) || PRIVATE_KEY_RE.test(content)) {
    findings.push("secret-shaped content");
  }
  if (LOCAL_ABSOLUTE_PATH_RE.test(content)) {
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
    const guidanceStat = await lstat(absolutePath).catch(() => null);
    if (!guidanceStat?.isFile() || guidanceStat.isSymbolicLink()) {
      throw new Error(
        `Refusing guidance adoption from ${pathValue}: the source must be a regular file`
      );
    }
    const tracked = await runGit({
      cwd: args.projectRoot,
      argv: ["ls-files", "--error-unmatch", "--", pathValue],
    });
    const dirty = await runGit({
      cwd: args.projectRoot,
      argv: ["status", "--porcelain=v1", "--", pathValue],
    });
    if (tracked.exitCode !== 0 || dirty.exitCode !== 0 || dirty.stdout) {
      throw new Error(
        `Refusing guidance adoption from ${pathValue}: the source must be tracked and clean`
      );
    }
    const content = await readFile(absolutePath, "utf8").catch(() => {
      throw new Error(`Unable to read guidance source: ${pathValue}`);
    });
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

function emptyRegistry(): ProjectRegistry {
  return {
    version: 1,
    updatedAt: "",
    projects: {},
  };
}

async function loadRegistry(homeDir: string): Promise<ProjectRegistry> {
  const pathValue = projectRegistryPath(homeDir);
  const text = await fileText(pathValue);
  if (!text) {
    return emptyRegistry();
  }
  try {
    const parsed = JSON.parse(text) as ProjectRegistry;
    if (parsed.version === 1 && parsed.projects) {
      return parsed;
    }
  } catch {
    // Fall through to the explicit corruption error.
  }
  throw new Error(`Project registry is invalid: ${pathValue}`);
}

async function atomicWrite(pathValue: string, content: string): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  const temporary = `${pathValue}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, pathValue);
}

async function saveRegistry(args: {
  homeDir: string;
  registry: ProjectRegistry;
  now: string;
}): Promise<void> {
  args.registry.updatedAt = args.now;
  await atomicWrite(
    projectRegistryPath(args.homeDir),
    `${JSON.stringify(args.registry, null, 2)}\n`
  );
}

function planHashInput(
  plan: Omit<ProjectEnrollmentPlan, "planSha256">
): unknown {
  return plan;
}

export async function planProjectEnrollment(args: {
  projectRoot: string;
  homeDir?: string;
  sources?: ProjectSource[];
  cadence?: ProjectCadence;
  scheduling?: boolean;
  guidance?: string[];
}): Promise<ProjectEnrollmentPlan> {
  const homeDir = resolve(args.homeDir ?? process.env.HOME ?? homedir());
  const projectRoot = await gitRoot(args.projectRoot);
  const aiRoot = join(projectRoot, ".ai");
  await assertSafeCanonicalTargets(projectRoot, aiRoot);
  const identity = await resolveRepositoryIdentity(projectRoot);
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
    projectRoot,
    paths: guidance,
  });
  const [worktree, existingIgnore, existingConfig] = await Promise.all([
    inspectRepository(projectRoot),
    fileText(join(aiRoot, ".gitignore")),
    fileText(join(aiRoot, "config.toml")),
  ]);
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
      path: join(aiRoot, ".gitignore"),
      content: ignoreContent,
      reason:
        "Protect generated and machine-local fclt state before any index is built.",
      precondition: await filePrecondition(join(aiRoot, ".gitignore")),
    },
    {
      path: join(aiRoot, "config.toml"),
      content: configContent,
      reason:
        "Create the minimal repo-owned enrollment contract without installing the operating-model pack.",
      precondition: await filePrecondition(join(aiRoot, "config.toml")),
    },
  ];
  const generatedWrites = [
    {
      path: facultAiIndexPath(homeDir, aiRoot),
      reason: "Machine-local generated capability index.",
    },
    {
      path: facultAiGraphPath(homeDir, aiRoot),
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
  ];
  const findings = [
    ...privacyFindings(ignoreContent),
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
          "This repository has no portable remote or root commit; its fallback identity cannot correlate independent clones until the repository has a commit.",
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

async function verifyPreconditions(plan: ProjectEnrollmentPlan): Promise<void> {
  const { planSha256, ...withoutHash } = plan;
  if (
    !PLAN_SHA_RE.test(planSha256) ||
    sha256(stableJson(planHashInput(withoutHash))) !== planSha256
  ) {
    throw new Error("Enrollment plan content does not match its plan SHA");
  }
  const currentRoot = await gitRoot(plan.projectRoot);
  if (currentRoot !== plan.projectRoot) {
    throw new Error("Enrollment plan repository root changed");
  }
  const currentIdentity = await resolveRepositoryIdentity(currentRoot);
  if (
    currentIdentity.id !== plan.identity.id ||
    currentIdentity.kind !== plan.identity.kind ||
    currentIdentity.fingerprint !== plan.identity.fingerprint
  ) {
    throw new Error("Enrollment plan repository identity changed");
  }
  await assertSafeCanonicalTargets(plan.projectRoot, plan.aiRoot);
  for (const write of plan.canonicalWrites) {
    const current = await filePrecondition(write.path);
    if (
      current.existed !== write.precondition.existed ||
      current.sha256 !== write.precondition.sha256
    ) {
      throw new Error(
        `Enrollment plan is stale because ${write.path} changed; generate a new plan`
      );
    }
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

function upsertRegistryEntry(args: {
  registry: ProjectRegistry;
  plan: ProjectEnrollmentPlan;
  now: string;
  receiptId: string;
}): void {
  const current = args.registry.projects[args.plan.identity.id];
  const location = current?.locations.find(
    (candidate) => candidate.path === args.plan.projectRoot
  );
  const locations = current?.locations ?? [];
  if (location) {
    location.lastSeenAt = args.now;
  } else {
    locations.push({
      path: args.plan.projectRoot,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
    });
  }
  args.registry.projects[args.plan.identity.id] = {
    repositoryId: args.plan.identity.id,
    identityKind: args.plan.identity.kind,
    identityFingerprint: args.plan.identity.fingerprint,
    decision: "selected",
    sources: args.plan.options.sources,
    cadence: args.plan.options.cadence,
    scheduling: args.plan.options.scheduling,
    guidance: args.plan.options.guidance,
    locations: locations.sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
    lastSuccessfulRun: current?.lastSuccessfulRun ?? null,
    pendingApprovals: [],
    history: [
      ...(current?.history ?? []),
      {
        at: args.now,
        action: "enrolled",
        root: args.plan.projectRoot,
        receiptId: args.receiptId,
      },
    ],
  };
}

export async function applyProjectEnrollment(args: {
  plan: ProjectEnrollmentPlan;
  expectedPlanSha256: string;
  homeDir?: string;
  now?: Date;
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
  await verifyPreconditions(args.plan);
  const homeDir = resolve(args.homeDir ?? process.env.HOME ?? homedir());
  const expectedGeneratedPaths = [
    facultAiIndexPath(homeDir, args.plan.aiRoot),
    facultAiGraphPath(homeDir, args.plan.aiRoot),
  ];
  const expectedMachinePaths = [
    projectRegistryPath(homeDir),
    projectReceiptsDir(homeDir),
  ];
  if (
    stableJson(args.plan.generatedWrites.map((write) => write.path)) !==
      stableJson(expectedGeneratedPaths) ||
    stableJson(args.plan.machineLocalWrites.map((write) => write.path)) !==
      stableJson(expectedMachinePaths)
  ) {
    throw new Error(
      "Enrollment plan was created for a different machine-local state root"
    );
  }
  const now = (args.now ?? new Date()).toISOString();
  const receiptId = `enroll-${now.replace(NON_DIGIT_RE, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const before = await Promise.all(
    args.plan.canonicalWrites.map(async (write) => ({
      path: write.path,
      before: await fileText(write.path),
      afterSha256: sha256(write.content),
    }))
  );
  const registry = await loadRegistry(homeDir);
  const written: string[] = [];
  try {
    for (const write of args.plan.canonicalWrites) {
      await atomicWrite(write.path, write.content);
      written.push(write.path);
    }
    await buildIndex({
      homeDir,
      rootDir: args.plan.aiRoot,
      force: false,
    });
    const receipt: EnrollmentReceipt = {
      version: 1,
      id: receiptId,
      createdAt: now,
      repositoryId: args.plan.identity.id,
      projectRoot: args.plan.projectRoot,
      planSha256: args.plan.planSha256,
      files: before,
    };
    const receiptPath = join(projectReceiptsDir(homeDir), `${receiptId}.json`);
    await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    upsertRegistryEntry({ registry, plan: args.plan, now, receiptId });
    await saveRegistry({ homeDir, registry, now });
  } catch (error) {
    for (const original of before.toReversed()) {
      if (original.before === null) {
        await rm(original.path, { force: true }).catch(() => undefined);
      } else {
        await atomicWrite(original.path, original.before).catch(
          () => undefined
        );
      }
    }
    throw error;
  }
  return {
    version: 1,
    applied: true,
    repositoryId: args.plan.identity.id,
    changedPaths: written,
    generatedPaths: args.plan.generatedWrites.map((entry) => entry.path),
    registryPath: projectRegistryPath(homeDir),
    receiptId,
    rollbackCommand: `fclt project rollback --receipt ${receiptId} --apply`,
  };
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
  const parsed = JSON.parse(
    await readFile(pathValue, "utf8")
  ) as EnrollmentReceipt;
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
    !validProjectRoot ||
    typeof parsed.planSha256 !== "string" ||
    !PLAN_SHA_RE.test(parsed.planSha256) ||
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
        (file.before !== null && typeof file.before !== "string")
    )
  ) {
    throw new Error(`Invalid enrollment receipt: ${args.receiptId}`);
  }
  return parsed;
}

export async function rollbackProjectEnrollment(args: {
  receiptId: string;
  homeDir?: string;
  apply?: boolean;
  now?: Date;
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
  await assertSafeCanonicalTargets(
    receipt.projectRoot,
    join(receipt.projectRoot, ".ai")
  );
  for (const file of receipt.files) {
    const current = await fileText(file.path);
    if (current === null || sha256(current) !== file.afterSha256) {
      throw new Error(
        `Rollback refused because an enrolled file changed after apply: ${file.path}`
      );
    }
  }
  for (const file of receipt.files.toReversed()) {
    if (file.before === null) {
      await rm(file.path, { force: true });
    } else {
      await atomicWrite(file.path, file.before);
    }
  }
  const registry = await loadRegistry(homeDir);
  const entry = registry.projects[receipt.repositoryId];
  if (entry) {
    const now = (args.now ?? new Date()).toISOString();
    entry.decision = "disabled";
    entry.history.push({
      at: now,
      action: "rolled-back",
      root: receipt.projectRoot,
      receiptId: receipt.id,
    });
    await saveRegistry({ homeDir, registry, now });
  }
  return {
    version: 1,
    applied: true,
    receiptId: receipt.id,
    repositoryId: receipt.repositoryId,
    restores,
    preserved: [
      projectRegistryPath(homeDir),
      join(projectReceiptsDir(homeDir), `${receipt.id}.json`),
    ],
  };
}

async function recordDecision(args: {
  projectRoot: string;
  homeDir: string;
  decision: Exclude<ProjectDecision, "selected">;
  now: Date;
}): Promise<{
  version: 1;
  repositoryId: string;
  decision: Exclude<ProjectDecision, "selected">;
  preserved: string[];
}> {
  const projectRoot = await gitRoot(args.projectRoot);
  const identity = await resolveRepositoryIdentity(projectRoot);
  const registry = await loadRegistry(args.homeDir);
  const now = args.now.toISOString();
  const current = registry.projects[identity.id];
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
  };
  await saveRegistry({ homeDir: args.homeDir, registry, now });
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
      ? await discoverProjects({ roots: args.discoveryRoots })
      : null;
  const discoveredById = new Map<string, DiscoveredProject[]>();
  for (const project of discovered?.projects ?? []) {
    const rows = discoveredById.get(project.identity.id) ?? [];
    rows.push(project);
    discoveredById.set(project.identity.id, rows);
  }
  const rows: ProjectStatusRow[] = [];
  const entries = new Map(
    Object.values(registry.projects).map((entry) => [entry.repositoryId, entry])
  );
  for (const [repositoryId, projects] of discoveredById) {
    if (!entries.has(repositoryId)) {
      const first = projects[0];
      if (!first) {
        continue;
      }
      entries.set(repositoryId, {
        repositoryId,
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
          const inspected = await inspectRepository(location.path).catch(
            () => null
          );
          location.exists = inspected !== null;
          location.dirty = inspected?.dirty ?? null;
        }
      }
    }
    const activeLocation = [...locations.values()].find(
      (location) => location.exists
    );
    const canonicalRoot = activeLocation
      ? join(activeLocation.path, ".ai")
      : null;
    const config = canonicalRoot
      ? await pathExists(join(canonicalRoot, "config.toml"))
      : false;
    const ignoreText = canonicalRoot
      ? await fileText(join(canonicalRoot, ".gitignore"))
      : null;
    const protectiveIgnore = PROTECTIVE_IGNORE_LINES.slice(1).every((line) =>
      ignoreText?.split(LINE_SPLIT_RE).includes(line)
    );
    const generatedIndex = canonicalRoot
      ? await pathExists(facultAiIndexPath(homeDir, canonicalRoot))
      : false;
    const generatedGraph = canonicalRoot
      ? await pathExists(facultAiGraphPath(homeDir, canonicalRoot))
      : false;
    const inactive = entry.decision !== "selected";
    const exists = canonicalRoot !== null && (await pathExists(canonicalRoot));
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
  fclt project init --apply --plan-sha SHA [same options]
  fclt project rollback --receipt ID [--apply] [--json]
  fclt project disable --project-root PATH [--json]
  fclt project ignore --project-root PATH [--json]
  fclt project inactive --project-root PATH [--json]
  fclt project remove --project-root PATH [--json]

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
      const result = await applyProjectEnrollment({
        plan,
        expectedPlanSha256,
        homeDir,
        now: context.now?.(),
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
        apply: rest.includes("--apply"),
        now: context.now?.(),
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
