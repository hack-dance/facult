import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import { resolveRepositoryExecutionIdentitySync } from "./repository-identity";
import { parseJsonLenient } from "./util/json";

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

export interface FacultConfig {
  /**
   * Override the canonical root directory.
   *
   * This is where fclt stores the consolidated "canonical" skill + MCP state
   * (skills/, mcp/, snippets/, index.json, ...).
   */
  rootDir?: string;

  /**
   * Default scan roots (equivalent to passing `fclt scan --from <path>`).
   * Example: ["~", "~/dev", "~/work"]
   */
  scanFrom?: string[];

  /**
   * Extra ignore directory basenames applied under `scanFrom` roots.
   * Example: ["vendor", ".venv"]
   */
  scanFromIgnore?: string[];

  /** Disable the default ignore list for `scanFrom` roots. */
  scanFromNoDefaultIgnore?: boolean;

  /** Default max directories visited per scanFrom root (same as --from-max-visits). */
  scanFromMaxVisits?: number;

  /** Default max discovered paths per scanFrom root (same as --from-max-results). */
  scanFromMaxResults?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isSafePathString(p: string): boolean {
  // Protect filesystem APIs from null-byte paths.
  return !p.includes("\0");
}

function defaultHomeDir(): string {
  const fromEnv = process.env.HOME?.trim();
  return fromEnv || homedir();
}

function expandHomePath(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/")) {
    return join(home, p.slice(2));
  }
  return p;
}

function resolvePath(p: string, home: string): string {
  const expanded = expandHomePath(p, home);
  return expanded.startsWith("/") ? expanded : resolve(expanded);
}

function physicalPathComparisonKey(
  pathValue: string,
  platform: NodeJS.Platform
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const resolved = pathApi.resolve(pathValue);

  // Cross-platform callers use this only to exercise the platform's lexical
  // comparison rule. Native callers additionally resolve every existing
  // ancestor so symlink spellings converge.
  if (platform !== process.platform) {
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  const missingParts: string[] = [];
  let existingAncestor = resolved;
  while (true) {
    try {
      const physicalAncestor = realpathSync.native(existingAncestor);
      const comparisonPath = missingParts.reduce(
        (current, part) => pathApi.join(current, part),
        physicalAncestor
      );
      return platform === "win32"
        ? comparisonPath.toLowerCase()
        : comparisonPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = pathApi.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return platform === "win32" ? resolved.toLowerCase() : resolved;
      }
      missingParts.unshift(pathApi.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

export function pathsPhysicallyEquivalent(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    physicalPathComparisonKey(left, platform) ===
    physicalPathComparisonKey(right, platform)
  );
}

export function pathsMayCollide(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const leftKey = physicalPathComparisonKey(left, platform);
  const rightKey = physicalPathComparisonKey(right, platform);
  return (
    leftKey === rightKey || leftKey.toLowerCase() === rightKey.toLowerCase()
  );
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeMachineStateDirExists(pathValue: string): boolean {
  try {
    const metadata = lstatSync(pathValue);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `Refusing unsafe machine-local project state directory: ${pathValue}`
      );
    }
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

function safePathEntryExists(pathValue: string): boolean {
  try {
    lstatSync(pathValue);
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

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function legacyPreferredRoot(home: string): string {
  return join(home, "agents", ".facult");
}

export function preferredGlobalAiRoot(home: string = defaultHomeDir()): string {
  return join(home, ".ai");
}

function looksLikeWindowsAbsolutePath(pathValue: string): boolean {
  return (
    WINDOWS_ABSOLUTE_PATH_RE.test(pathValue) || pathValue.startsWith("\\\\")
  );
}

function relativePathIsInsideOrEqual(args: {
  rel: string;
  isAbsolutePath: (pathValue: string) => boolean;
}): boolean {
  const { isAbsolutePath, rel } = args;
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolutePath(rel));
}

export function pathIsInsideOrEqual(
  pathValue: string,
  rootDir: string
): boolean {
  if (
    looksLikeWindowsAbsolutePath(pathValue) &&
    looksLikeWindowsAbsolutePath(rootDir)
  ) {
    return relativePathIsInsideOrEqual({
      isAbsolutePath: win32.isAbsolute,
      rel: win32.relative(rootDir, pathValue),
    });
  }

  const rel = relative(rootDir, pathValue);
  return relativePathIsInsideOrEqual({
    isAbsolutePath: isAbsolute,
    rel,
  });
}

export function preferredGlobalFacultStateDir(
  home: string = defaultHomeDir()
): string {
  return join(preferredGlobalAiRoot(home), ".facult");
}

export function facultLocalStateRoot(home: string = defaultHomeDir()): string {
  const override = process.env.FACULT_LOCAL_STATE_DIR?.trim();
  if (override) {
    return resolvePath(override, home);
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "fclt");
  }
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return xdg
    ? join(resolvePath(xdg, home), "fclt")
    : join(home, ".local", "state", "fclt");
}

export function facultLocalCacheRoot(home: string = defaultHomeDir()): string {
  const override = process.env.FACULT_CACHE_DIR?.trim();
  if (override) {
    return resolvePath(override, home);
  }
  if (process.platform === "darwin") {
    return join(facultLocalStateRoot(home), "cache");
  }
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return xdg
    ? join(resolvePath(xdg, home), "fclt")
    : join(home, ".cache", "fclt");
}

export function legacyExternalFacultStateDir(
  home: string = defaultHomeDir()
): string {
  return join(home, ".facult");
}

function isLegacyConfiguredRoot(root: string, home: string): boolean {
  return resolve(root) === resolve(legacyPreferredRoot(home));
}

function looksLikeFacultRoot(root: string): boolean {
  if (!dirExists(root)) {
    return false;
  }
  // Heuristic: treat as a fclt store if it contains something we'd create.
  return (
    dirExists(join(root, "rules")) ||
    dirExists(join(root, "instructions")) ||
    dirExists(join(root, "agents")) ||
    dirExists(join(root, "skills")) ||
    dirExists(join(root, "mcp")) ||
    dirExists(join(root, "snippets"))
  );
}

function isProjectAiRoot(root: string): boolean {
  if (!dirExists(root)) {
    return false;
  }

  if (looksLikeFacultRoot(root)) {
    return true;
  }

  if (fileExists(join(root, "config.toml"))) {
    return true;
  }

  if (dirExists(join(root, ".facult", "ai"))) {
    return true;
  }

  return false;
}

function detectLegacyStoreUnderAgents(home: string): string | null {
  const agentsDir = join(home, "agents");
  let entries: any[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: string[] = [];
  for (const ent of entries) {
    if (!ent?.isDirectory?.()) {
      continue;
    }
    const name = String(ent.name ?? "");
    if (!name || name === ".facult") {
      continue;
    }
    const abs = join(agentsDir, name);
    if (looksLikeFacultRoot(abs)) {
      candidates.push(abs);
    }
  }

  // Only auto-select when there is exactly one candidate.
  // If there are multiple, require explicit config/env to choose.
  candidates.sort();
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function legacyFacultStateDirForRoot(
  rootDir: string,
  home: string = defaultHomeDir(),
  config?: FacultConfig | null
): string {
  const projectRoot = projectRootFromAiRoot(rootDir, home, config);
  return projectRoot
    ? join(projectRoot, ".facult")
    : legacyExternalFacultStateDir(home);
}

function shouldUsePreferredGlobalStateDir(
  rootDir: string,
  home: string,
  config?: FacultConfig | null
): boolean {
  const resolved = resolve(rootDir);
  if (projectRootFromAiRoot(resolved, home, config)) {
    return false;
  }
  if (resolved === resolve(preferredGlobalAiRoot(home))) {
    return true;
  }
  if (resolved === resolve(legacyPreferredRoot(home))) {
    return true;
  }
  return resolved.startsWith(`${resolve(join(home, "agents"))}/`);
}

export function facultStateDir(
  home: string = defaultHomeDir(),
  rootDir?: string,
  config?: FacultConfig | null
): string {
  const resolvedRoot = rootDir ?? facultRootDir(home, config);
  if (projectRootFromAiRoot(resolvedRoot, home, config)) {
    return facultMachineStateDir(home, resolvedRoot, config);
  }
  if (shouldUsePreferredGlobalStateDir(resolvedRoot, home, config)) {
    return preferredGlobalFacultStateDir(home);
  }
  return join(resolvedRoot, ".facult");
}

export function machineStateProjectKey(
  rootDir: string,
  home: string = defaultHomeDir(),
  config?: FacultConfig | null
): string {
  const executionKey = executionMachineStateProjectKey(rootDir, home, config);
  const legacyKey = legacyMachineStateProjectKey(rootDir, home, config);
  const projectsRoot = join(facultLocalStateRoot(home), "projects");
  if (executionKey === legacyKey) {
    safeMachineStateDirExists(join(projectsRoot, executionKey));
    return executionKey;
  }
  const legacyExists = safeMachineStateDirExists(join(projectsRoot, legacyKey));
  const executionExists = safeMachineStateDirExists(
    join(projectsRoot, executionKey)
  );
  if (legacyExists && executionExists) {
    throw new Error(
      `Conflicting legacy and execution machine-local project state directories require enrollment reconciliation: ${join(projectsRoot, legacyKey)} and ${join(projectsRoot, executionKey)}`
    );
  }
  if (legacyExists) {
    return legacyKey;
  }
  return executionKey;
}

export function executionMachineStateProjectKey(
  rootDir: string,
  home: string = defaultHomeDir(),
  config?: FacultConfig | null
): string {
  const projectRoot = projectRootFromAiRoot(rootDir, home, config);
  if (projectRoot) {
    const executionIdentity =
      resolveRepositoryExecutionIdentitySync(projectRoot);
    if (executionIdentity) {
      return executionIdentity.id;
    }
    if (safePathEntryExists(join(projectRoot, ".git"))) {
      throw new Error(
        `Unable to resolve machine-local execution identity for project state: ${projectRoot}`
      );
    }
  }
  return legacyMachineStateProjectKey(rootDir, home, config);
}

export function legacyMachineStateProjectKey(
  rootDir: string,
  home: string = defaultHomeDir(),
  config?: FacultConfig | null
): string {
  const projectRoot = projectRootFromAiRoot(rootDir, home, config);
  const labelSource = projectRoot ?? rootDir;
  const label = basename(labelSource).trim().toLowerCase();
  const slug = label.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const digest = createHash("sha256")
    .update(resolve(rootDir))
    .digest("hex")
    .slice(0, 12);
  return `${slug || "project"}-${digest}`;
}

export function machineStateProjectScopeId(machineKey: string): string {
  return `project:${createHash("sha256").update(machineKey).digest("hex").slice(0, 16)}`;
}

export function facultMachineStateDir(
  home: string = defaultHomeDir(),
  rootDir?: string,
  config?: FacultConfig | null
): string {
  const resolvedRoot = rootDir ?? facultRootDir(home, config);
  const projectRoot = projectRootFromAiRoot(resolvedRoot, home, config);
  return projectRoot
    ? join(
        facultLocalStateRoot(home),
        "projects",
        machineStateProjectKey(resolvedRoot, home, config)
      )
    : join(facultLocalStateRoot(home), "global");
}

export function facultInstallStatePath(
  home: string = defaultHomeDir()
): string {
  return join(facultLocalStateRoot(home), "install.json");
}

export function facultRuntimeCacheDir(home: string = defaultHomeDir()): string {
  return join(facultLocalCacheRoot(home), "runtime");
}

export function projectRootFromAiRoot(
  rootDir: string,
  home: string = defaultHomeDir(),
  config?: FacultConfig | null
): string | null {
  const pathApi =
    looksLikeWindowsAbsolutePath(rootDir) || looksLikeWindowsAbsolutePath(home)
      ? win32
      : { basename, dirname, join, resolve };
  const resolved = pathApi.resolve(rootDir);
  const scoped = facultRootScope.getStore();
  if (scoped && pathApi.resolve(scoped.rootDir) === resolved) {
    return scoped.scope === "global"
      ? null
      : pathApi.basename(resolved) === ".ai"
        ? pathApi.dirname(resolved)
        : null;
  }
  const envRoot = process.env.FACULT_ROOT_DIR?.trim();
  if (envRoot) {
    const expandedEnvRoot = expandHomePath(envRoot, home);
    if (pathApi.resolve(expandedEnvRoot) === resolved) {
      if (process.env.FACULT_ROOT_SCOPE?.trim() !== "project") {
        return null;
      }
      return pathApi.basename(resolved) === ".ai"
        ? pathApi.dirname(resolved)
        : null;
    }
  } else if (pathApi.resolve(facultRootDir(home, config)) === resolved) {
    return null;
  }
  if (resolved === pathApi.resolve(pathApi.join(home, ".ai"))) {
    return null;
  }
  if (resolved === pathApi.resolve(pathApi.join(home, "agents", ".facult"))) {
    return null;
  }
  return pathApi.basename(resolved) === ".ai"
    ? pathApi.dirname(resolved)
    : null;
}

const facultRootScope = new AsyncLocalStorage<{
  rootDir: string;
  scope: "global" | "project";
}>();

export function withFacultRootScope<T>(
  context: { rootDir: string; scope: "global" | "project" },
  operation: () => T
): T {
  return facultRootScope.run(context, operation);
}

export function projectSlugFromAiRoot(
  rootDir: string,
  home: string = defaultHomeDir()
): string | null {
  const projectRoot = projectRootFromAiRoot(rootDir, home);
  if (!projectRoot) {
    return null;
  }
  const base = basename(projectRoot).trim().toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function facultGeneratedStateDir(args?: {
  home?: string;
  rootDir?: string;
}): string {
  const home = args?.home ?? defaultHomeDir();
  return facultStateDir(home, args?.rootDir);
}

export function facultAiStateDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultGeneratedStateDir({ home, rootDir }), "ai");
}

export function legacyRepoLocalFacultAiStateDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string | null {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  return projectRootFromAiRoot(resolvedRoot, home)
    ? join(resolvedRoot, ".facult", "ai")
    : null;
}

export function legacyFacultAiStateDirs(
  home: string = defaultHomeDir(),
  rootDir?: string
): string[] {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  const current = resolve(facultAiStateDir(home, resolvedRoot));
  const legacyDirs = [
    legacyRepoLocalFacultAiStateDir(home, resolvedRoot),
    join(legacyFacultStateDirForRoot(resolvedRoot, home), "ai"),
  ];

  return [
    ...new Set(
      legacyDirs
        .filter((pathValue): pathValue is string => Boolean(pathValue))
        .filter((pathValue) => resolve(pathValue) !== current)
    ),
  ];
}

export function facultAiIndexPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiStateDir(home, rootDir), "index.json");
}

export function facultAiGraphPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiStateDir(home, rootDir), "graph.json");
}

export function facultAiRuntimeScopeDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultMachineStateDir(home, rootDir),
    "ai",
    projectRootFromAiRoot(rootDir ?? facultRootDir(home), home)
      ? "project"
      : "global"
  );
}

export function facultAiRuntimeCoordinationDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  return projectRootFromAiRoot(resolvedRoot, home)
    ? join(
        facultLocalStateRoot(home),
        "projects",
        "coordination",
        executionMachineStateProjectKey(resolvedRoot, home)
      )
    : join(facultLocalStateRoot(home), "global", "coordination");
}

export function facultAiReconciliationLockPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  if (!projectRootFromAiRoot(resolvedRoot, home)) {
    return `${facultAiReconciliationStatePath(home, resolvedRoot)}.lock`;
  }
  return join(
    facultAiRuntimeCoordinationDir(home, resolvedRoot),
    "reconciliation.lock"
  );
}

export function facultAiEvolutionLoopLockPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  if (!projectRootFromAiRoot(resolvedRoot, home)) {
    return `${facultAiEvolutionLoopStatePath(home, resolvedRoot)}.lock`;
  }
  return join(
    facultAiRuntimeCoordinationDir(home, resolvedRoot),
    "evolution-loop.lock"
  );
}

export function facultAiJournalPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "journal",
    "events.jsonl"
  );
}

export function facultAiWritebackQueuePath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "writeback",
    "queue.jsonl"
  );
}

export function facultAiProposalDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiRuntimeScopeDir(home, rootDir), "evolution", "proposals");
}

export function facultAiDraftDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiRuntimeScopeDir(home, rootDir), "evolution", "drafts");
}

export function facultAiReconciliationStatePath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "reconciliation",
    "state.json"
  );
}

export function facultAiEvolutionLoopConfigPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "evolution",
    "loop",
    "config.json"
  );
}

export function facultAiEvolutionLoopStatePath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "evolution",
    "loop",
    "state.json"
  );
}

export function facultAiEvolutionLoopAuditPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "evolution",
    "loop",
    "audit.jsonl"
  );
}

export function facultAiEvolutionLoopReportDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "evolution",
    "loop",
    "reports"
  );
}

export function facultAiActivityHistoryDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "evolution",
    "loop",
    "history"
  );
}

export function facultAiActivityHistoryManifestPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiActivityHistoryDir(home, rootDir), "manifest.json");
}

export function facultAiActivityHistorySegmentDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiActivityHistoryDir(home, rootDir), "segments");
}

export function facultAiReconciliationConfigPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(rootDir ?? facultRootDir(home), "reconciliation.json");
}

export function facultAiReviewScopeDir(
  artifactDir: "writebacks" | "evolution" | "reconciliation",
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  const projectRoot = projectRootFromAiRoot(resolvedRoot, home);
  return projectRoot
    ? join(
        preferredGlobalAiRoot(home),
        artifactDir,
        "projects",
        machineStateProjectKey(resolvedRoot, home)
      )
    : join(preferredGlobalAiRoot(home), artifactDir, "global");
}

export function facultAiReconciliationReviewDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return facultAiReviewScopeDir("reconciliation", home, rootDir);
}

export function facultAiWritebackReviewDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return facultAiReviewScopeDir("writebacks", home, rootDir);
}

export function facultAiEvolutionReviewDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return facultAiReviewScopeDir("evolution", home, rootDir);
}

export function facultConfigPath(home: string = defaultHomeDir()): string {
  return join(preferredGlobalFacultStateDir(home), "config.json");
}

export function parseFacultConfigText(txt: string): FacultConfig | null {
  try {
    const parsed = parseJsonLenient(txt) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }
    const rootDir =
      typeof parsed.rootDir === "string" ? parsed.rootDir : undefined;

    const scanFromRaw = parsed.scanFrom;
    const scanFrom = Array.isArray(scanFromRaw)
      ? scanFromRaw
          .filter((v) => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      : undefined;

    const scanFromIgnoreRaw = parsed.scanFromIgnore;
    const scanFromIgnore = Array.isArray(scanFromIgnoreRaw)
      ? scanFromIgnoreRaw
          .filter((v) => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      : undefined;

    const scanFromNoDefaultIgnore =
      typeof parsed.scanFromNoDefaultIgnore === "boolean"
        ? parsed.scanFromNoDefaultIgnore
        : undefined;

    const scanFromMaxVisitsRaw = parsed.scanFromMaxVisits;
    const scanFromMaxVisits =
      typeof scanFromMaxVisitsRaw === "number" &&
      Number.isFinite(scanFromMaxVisitsRaw) &&
      scanFromMaxVisitsRaw > 0
        ? Math.floor(scanFromMaxVisitsRaw)
        : undefined;

    const scanFromMaxResultsRaw = parsed.scanFromMaxResults;
    const scanFromMaxResults =
      typeof scanFromMaxResultsRaw === "number" &&
      Number.isFinite(scanFromMaxResultsRaw) &&
      scanFromMaxResultsRaw > 0
        ? Math.floor(scanFromMaxResultsRaw)
        : undefined;

    return {
      rootDir,
      scanFrom,
      scanFromIgnore,
      scanFromNoDefaultIgnore,
      scanFromMaxVisits,
      scanFromMaxResults,
    };
  } catch {
    return null;
  }
}

export function readFacultConfig(
  home: string = defaultHomeDir()
): FacultConfig | null {
  const candidates = [
    facultConfigPath(home),
    join(legacyExternalFacultStateDir(home), "config.json"),
  ];

  for (const p of candidates) {
    if (!(isSafePathString(p) && fileExists(p))) {
      continue;
    }

    try {
      const txt = readFileSync(p, "utf8");
      const parsed = parseFacultConfigText(txt);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Ignore invalid config files and continue to the next fallback path.
    }
  }

  return null;
}

/**
 * Return the canonical fclt root directory.
 *
 * Precedence:
 * 1) `FACULT_ROOT_DIR` env var
 * 2) `~/.ai/.facult/config.json` { "rootDir": "..." } (falls back to legacy `~/.facult/config.json`)
 * 3) `~/.ai` (if it looks like a store)
 * 4) `~/agents/.facult` (if it looks like a store)
 * 5) a legacy store under `~/agents/` (if it looks like a store)
 * 6) default: `~/.ai`
 */
export function facultRootDir(
  home: string = defaultHomeDir(),
  config?: FacultConfig | null
): string {
  const envRoot = process.env.FACULT_ROOT_DIR?.trim();
  const preferred = join(home, ".ai");

  if (envRoot) {
    const resolved = resolvePath(envRoot, home);
    return isSafePathString(resolved) ? resolved : preferred;
  }

  const cfg = config === undefined ? readFacultConfig(home) : config;
  const cfgRoot = cfg?.rootDir?.trim();
  if (cfgRoot) {
    const resolved = resolvePath(cfgRoot, home);
    if (!isSafePathString(resolved)) {
      return preferred;
    }
    if (
      isLegacyConfiguredRoot(resolved, home) &&
      looksLikeFacultRoot(preferred)
    ) {
      return preferred;
    }
    return resolved;
  }

  if (looksLikeFacultRoot(preferred)) {
    return preferred;
  }
  const legacyPreferred = legacyPreferredRoot(home);
  if (looksLikeFacultRoot(legacyPreferred)) {
    return legacyPreferred;
  }
  const legacy = detectLegacyStoreUnderAgents(home);
  if (legacy) {
    return legacy;
  }
  return preferred;
}

export function findNearestProjectAiRoot(
  start: string,
  home: string = defaultHomeDir(),
  config?: FacultConfig | null
): string | null {
  const configuredRoot = facultRootDir(home, config);
  const globalRoots = new Set([resolve(join(home, ".ai"))]);
  if (!projectRootFromAiRoot(configuredRoot, home, config)) {
    globalRoots.add(resolve(configuredRoot));
  }
  let current = resolve(start);
  while (true) {
    const candidate = join(current, ".ai");
    if (!globalRoots.has(resolve(candidate)) && isProjectAiRoot(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function facultContextRootDir(args?: {
  home?: string;
  cwd?: string;
  config?: FacultConfig | null;
}): string {
  const home = args?.home ?? defaultHomeDir();
  const envRoot = process.env.FACULT_ROOT_DIR?.trim();
  if (envRoot) {
    const resolved = resolvePath(envRoot, home);
    return isSafePathString(resolved) ? resolved : join(home, ".ai");
  }

  const cwd = args?.cwd?.trim() || process.cwd();
  const config = args && "config" in args ? args.config : undefined;
  const projectRoot = findNearestProjectAiRoot(cwd, home, config);
  if (projectRoot) {
    return projectRoot;
  }

  return facultRootDir(home, config);
}
