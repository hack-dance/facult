import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderCanonicalText } from "./agents";
import {
  ensureAiGraphPath,
  ensureAiIndexPath,
  legacyAiIndexPath,
} from "./ai-state";
import {
  type AutosyncRecoveryConfigInspection,
  type AutosyncRecoveryInspection,
  assertAutosyncRepairAllowed,
  inspectAutosyncRecovery,
  type RecoveryInspectionCoverage,
  repairAutosyncServices,
} from "./autosync";
import {
  facultBuiltinAgentsGlobalSourcePath,
  facultBuiltinPackRoot,
} from "./builtin";
import {
  parseCliContextArgs,
  resolveCliContextRoot,
  resolveCliContextScope,
} from "./cli-context";
import { diagnoseEvolutionLoop } from "./evolution-loop";
import {
  LEGACY_MANAGED_MUTATION_FLAG,
  legacyManagedMutationApproved,
} from "./legacy-mutation-policy";
import {
  inspectManagedStateRecords,
  loadManagedState,
  type ManagedStateRecordInspection,
} from "./manage";
import { extractServersObject } from "./mcp-config";
import {
  facultAiEvolutionLoopAuditPath,
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionLoopStatePath,
  facultAiEvolutionReviewDir,
  facultAiGraphPath,
  facultAiIndexPath,
  facultAiReconciliationConfigPath,
  facultAiReconciliationReviewDir,
  facultAiReconciliationStatePath,
  facultAiWritebackReviewDir,
  facultConfigPath,
  facultRootDir,
  facultStateDir,
  legacyExternalFacultStateDir,
  legacyFacultStateDirForRoot,
  projectRootFromAiRoot,
  withFacultRootScope,
} from "./paths";
import {
  loadConfiguredProjectSyncTools,
  writeProjectSyncPolicy,
} from "./project-sync";
import { reconciliationStatus } from "./reconciliation";
import { renderSnippetText } from "./snippets";
import { packageVersion } from "./status";

const TOML_FILE_SUFFIX_RE = /\.toml$/;
const ISO_MILLIS_SUFFIX_RE = /\..+$/;
const CURRENT_AUTOSYNC_LABEL_PREFIX_RE = /^com\.fclt\.autosync\./;
const LEGACY_AUTOSYNC_LABEL_PREFIX_RE = /^com\.facult\.autosync\./;

type DoctorHealthState =
  | "healthy"
  | "uninitialized"
  | "canonical_source_attention"
  | "loop_blocked"
  | "scheduled_loop_attention"
  | "partial_global_config"
  | "project_generated_only"
  | "project_policy_attention"
  | "stale_or_missing_generated_state"
  | "legacy_state_attention";

interface DoctorIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  fix?: string;
}

interface DoctorAction {
  id: string;
  label: string;
  command: string;
  risk:
    | "read_only"
    | "generated_state_write"
    | "canonical_write"
    | "runtime_state_write"
    | "tool_home_write";
}

export type DoctorLegacyRecoveryState =
  | "clear"
  | "contained"
  | "cleanup_required"
  | "blocked";

export interface DoctorLegacyRecovery {
  state: DoctorLegacyRecoveryState;
  mutationPolicy: "disabled_by_default";
  reasonCodes: string[];
  coverage: {
    managed: "checked" | "unavailable";
    autosyncConfigs: RecoveryInspectionCoverage;
    launchAgents: RecoveryInspectionCoverage;
    launchd: RecoveryInspectionCoverage;
  };
  managed: {
    records: ManagedStateRecordInspection[];
  };
  autosync: {
    configured: AutosyncRecoveryConfigInspection[];
    ownedPlists: AutosyncRecoveryInspection["ownedPlists"];
    ownedLoadedLabels: string[];
    orphanedLabels: string[];
  };
  recovery: {
    boundary: "none" | "owned_autosync_runtime_only" | "manual_review";
    requiresApproval: boolean;
    actions: Array<{
      id: "cleanup-autosync";
      service: string;
      planId: string;
      argv: string[];
    }>;
    preserves: Array<
      "canonical_capability" | "live_tool_state" | "managed_state" | "backups"
    >;
  };
}

type LoopReadinessState = "ready" | "degraded" | "blocked";

interface CodexReadiness {
  state: "ready" | "not_installed" | "registered_unverified" | "misconfigured";
  pluginPayloadPresent: boolean;
  mcpDeclared: boolean;
  registered: boolean;
  freshSessionDiscovery: "not_applicable" | "requires_fresh_session";
  repair?: string;
}

interface LoopReadiness {
  state: LoopReadinessState;
  ready: boolean;
  blockers: string[];
  capabilities: {
    canonicalRoot: boolean;
    generatedIndex: boolean;
    generatedGraph: boolean;
    runtimeStateWritable: boolean;
    reviewArtifactsWritable: boolean;
    assetTargeting: boolean;
    writebackSkill: boolean;
    evolutionSkill: boolean;
    automationTemplates: string[];
    reconciliation: {
      configured: boolean;
      configurationState: "ready" | "not_configured" | "invalid";
      configurationError?: string;
      stateError?: string;
      sourceCount: number;
      coverageState?: "complete" | "degraded";
      lastReviewId?: string;
    };
    scheduling: {
      configured: boolean;
      configurationState: "ready" | "not_configured" | "invalid";
      configurationError?: string;
      stateError?: string;
      schedulerError?: string;
      enabled: boolean;
      health?: "disabled" | "ready" | "degraded";
      schedulerRegistered?: boolean;
      schedulerStatus?: "ACTIVE" | "PAUSED";
      observationState?: "never_observed" | "healthy" | "stale";
      lastObservedRunAt?: string;
    };
  };
  integrations: {
    codex: CodexReadiness;
  };
}

export interface DoctorReport {
  version: 2;
  packageVersion: string;
  cwd: string;
  homeDir: string;
  rootDir: string;
  projectRoot: string | null;
  health: {
    state: DoctorHealthState;
    ok: boolean;
  };
  paths: {
    configPath: string;
    generatedIndex: string;
    generatedGraph: string;
    stateDir: string;
    legacyIndex: string;
    writebackReviewDir: string;
    evolutionReviewDir: string;
    reconciliationConfigPath: string;
    reconciliationStatePath: string;
    reconciliationReviewDir: string;
    evolutionLoopConfigPath: string;
    evolutionLoopStatePath: string;
    evolutionLoopAuditPath: string;
    evolutionLoopReportDir: string;
  };
  checks: {
    rootExists: boolean;
    canonicalSourceExists: boolean;
    generatedOnlyProjectRoot: boolean;
    generatedIndexSource: "generated" | "legacy" | "rebuilt" | "missing";
    generatedGraphExists: boolean;
    writebackReviewDirExists: boolean;
    evolutionReviewDirExists: boolean;
    reconciliationConfigured: boolean;
    reconciliationSourceCount: number;
    evolutionLoopConfigured: boolean;
    evolutionLoopEnabled: boolean;
    canonicalGlobalDocsValid: boolean;
    canonicalGlobalDocsIssueCodes: string[];
    canonicalTemplateRefsValid: boolean;
    canonicalTemplateRefsIssueCodes: string[];
    canonicalTemplateRefsIssuePaths: string[];
    projectSyncRepairNeeded: boolean;
    projectSyncRepairTools: string[];
  };
  legacyRecovery: DoctorLegacyRecovery;
  loop: LoopReadiness;
  issues: DoctorIssue[];
  actions: DoctorAction[];
}

function legacyDefaultRoot(home: string): string {
  return join(home, "agents", ".facult");
}

async function repairLegacyRootConfig(home: string): Promise<boolean> {
  const configPath = facultConfigPath(home);
  const legacyConfigPath = join(
    legacyExternalFacultStateDir(home),
    "config.json"
  );
  const preferredRoot = join(home, ".ai");
  const legacyRoot = legacyDefaultRoot(home);

  let parsed: Record<string, unknown> | null = null;
  for (const candidate of [configPath, legacyConfigPath]) {
    try {
      const text = await Bun.file(candidate).text();
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch {
      // Ignore missing or malformed legacy config files and keep searching.
    }
  }

  if (!parsed) {
    return false;
  }

  if (parsed?.rootDir !== legacyRoot) {
    return false;
  }

  try {
    const stat = await Bun.file(preferredRoot).stat();
    if (!stat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  const next = {
    ...parsed,
    rootDir: preferredRoot,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function pathEntryExists(pathValue: string): Promise<boolean> {
  try {
    await lstat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingPath(pathValue: string): Promise<string | null> {
  let current = pathValue;
  while (true) {
    if (await pathExists(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function pathCanBeWritten(pathValue: string): Promise<boolean> {
  const existing = await nearestExistingPath(pathValue);
  if (!existing) {
    return false;
  }
  try {
    await access(existing, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function configuredCodexPlugins(home: string): Promise<Set<string>> {
  const configPath = join(home, ".codex", "config.toml");
  try {
    const parsed = Bun.TOML.parse(await readFile(configPath, "utf8"));
    if (!(isObject(parsed) && isObject(parsed.plugins))) {
      return new Set();
    }
    return new Set(
      Object.entries(parsed.plugins)
        .filter(([, value]) => !isObject(value) || value.enabled !== false)
        .map(([name]) => name)
    );
  } catch {
    return new Set();
  }
}

async function inspectCodexReadiness(home: string): Promise<CodexReadiness> {
  const pluginRoot = join(home, "plugins", "fclt");
  const pluginPayloadPresent = await pathExists(
    join(pluginRoot, ".codex-plugin", "plugin.json")
  );
  let mcpDeclared = false;
  try {
    const parsed = JSON.parse(
      await readFile(join(pluginRoot, ".mcp.json"), "utf8")
    ) as unknown;
    mcpDeclared = Boolean(
      isObject(parsed) &&
        isObject(parsed.mcpServers) &&
        isObject(parsed.mcpServers.fclt)
    );
  } catch {
    mcpDeclared = false;
  }
  const configured = await configuredCodexPlugins(home);
  const registered = [...configured].some((name) => name.startsWith("fclt@"));

  if (!(pluginPayloadPresent || registered)) {
    return {
      state: "not_installed",
      pluginPayloadPresent,
      mcpDeclared,
      registered,
      freshSessionDiscovery: "not_applicable",
      repair: "Run `fclt setup codex-plugin` if Codex integration is wanted.",
    };
  }
  if (!(pluginPayloadPresent && mcpDeclared && registered)) {
    return {
      state: "misconfigured",
      pluginPayloadPresent,
      mcpDeclared,
      registered,
      freshSessionDiscovery: "not_applicable",
      repair:
        "Run `fclt setup codex-plugin`, then inspect `codex plugin list --json`.",
    };
  }
  return {
    state: "registered_unverified",
    pluginPayloadPresent,
    mcpDeclared,
    registered,
    freshSessionDiscovery: "requires_fresh_session",
    repair:
      "Start a fresh Codex session and confirm the `fclt_status` and `fclt_setup` tools are discoverable.",
  };
}

async function hasCanonicalSource(rootDir: string): Promise<boolean> {
  const fileCandidates = [
    "config.toml",
    "config.local.toml",
    "AGENTS.global.md",
    "AGENTS.override.global.md",
  ];
  for (const relPath of fileCandidates) {
    if (await pathExists(join(rootDir, relPath))) {
      return true;
    }
  }

  const dirCandidates = [
    "agents",
    "automations",
    "instructions",
    "mcp",
    "rules",
    "skills",
    "snippets",
    "tools",
  ];
  for (const relPath of dirCandidates) {
    const entries = await readdir(join(rootDir, relPath)).catch(
      () => [] as string[]
    );
    if (entries.some((entry) => !entry.startsWith("."))) {
      return true;
    }
  }

  return false;
}

async function isGeneratedOnlyProjectRoot(args: {
  home: string;
  rootDir: string;
}): Promise<boolean> {
  if (projectRootFromAiRoot(args.rootDir, args.home) == null) {
    return false;
  }
  return !(await hasCanonicalSource(args.rootDir));
}

async function hashFile(pathValue: string): Promise<string> {
  const data = await readFile(pathValue);
  return createHash("sha256").update(data).digest("hex");
}

async function moveLeafIfPossible(
  src: string,
  dst: string,
  conflicts: string[]
): Promise<boolean> {
  await mkdir(dirname(dst), { recursive: true });
  if (!(await pathExists(dst))) {
    try {
      await rename(src, dst);
    } catch {
      await copyFile(src, dst);
      await rm(src, { force: true });
    }
    return true;
  }
  const [sourceHash, targetHash] = await Promise.all([
    hashFile(src),
    hashFile(dst),
  ]);
  if (sourceHash === targetHash) {
    await rm(src, { force: true });
    return true;
  }
  conflicts.push(src);
  return false;
}

async function moveSymlinkIfPossible(
  src: string,
  dst: string,
  conflicts: string[]
): Promise<boolean> {
  const sourceTarget = await readlink(src);
  await mkdir(dirname(dst), { recursive: true });
  if (!(await pathEntryExists(dst))) {
    await symlink(sourceTarget, dst);
    await rm(src, { force: true });
    return true;
  }
  try {
    const targetLink = await readlink(dst);
    if (targetLink === sourceTarget) {
      await rm(src, { force: true });
      return true;
    }
  } catch {
    // fall through to conflict
  }
  conflicts.push(src);
  return false;
}

async function moveMissingTree(
  src: string,
  dst: string,
  conflicts: string[],
  options?: { skipTopLevelNames?: string[] }
): Promise<boolean> {
  let srcStat: Stats;
  try {
    srcStat = await lstat(src);
  } catch {
    return false;
  }

  if (srcStat.isSymbolicLink()) {
    return await moveSymlinkIfPossible(src, dst, conflicts);
  }

  if (!srcStat.isDirectory()) {
    return await moveLeafIfPossible(src, dst, conflicts);
  }

  await mkdir(dst, { recursive: true });
  let changed = false;
  const entries = await readdir(src, { withFileTypes: true });
  const skip = new Set(options?.skipTopLevelNames ?? []);
  for (const entry of entries) {
    const name = String(entry.name ?? "");
    if (!name || skip.has(name)) {
      continue;
    }
    if (await moveMissingTree(join(src, name), join(dst, name), conflicts)) {
      changed = true;
    }
  }
  const remaining = await readdir(src).catch(() => [] as string[]);
  if (remaining.length === 0) {
    await rm(src, { recursive: true, force: true }).catch(() => null);
  }
  return changed;
}

async function repairLegacyState(args: {
  home: string;
  rootDir: string;
}): Promise<{ changed: boolean; conflicts: string[] }> {
  const { home, rootDir } = args;
  let changed = false;
  const conflicts: string[] = [];

  const globalLegacy = legacyExternalFacultStateDir(home);
  const globalTarget = facultStateDir(home, join(home, ".ai"));
  if (
    await moveMissingTree(globalLegacy, globalTarget, conflicts, {
      // Keep legacy PATH shims stable. New installs use ~/.ai/.facult/bin.
      skipTopLevelNames: ["bin"],
    })
  ) {
    changed = true;
  }

  const scopedLegacy = legacyFacultStateDirForRoot(rootDir, home);
  const scopedTarget = facultStateDir(home, rootDir);
  if (
    (scopedLegacy !== globalLegacy || scopedTarget !== globalTarget) &&
    (await moveMissingTree(scopedLegacy, scopedTarget, conflicts))
  ) {
    changed = true;
  }

  return { changed, conflicts };
}

function normalizeCodexMarketplaceText(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return text.endsWith("\n") ? text : `${text}\n`;
    }
    const plugins = Array.isArray((parsed as { plugins?: unknown[] }).plugins)
      ? ((parsed as { plugins: unknown[] }).plugins ?? [])
      : null;
    if (plugins) {
      (parsed as { plugins: unknown[] }).plugins = plugins.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return entry;
        }
        const source =
          "source" in entry &&
          (entry as { source?: unknown }).source &&
          typeof (entry as { source?: unknown }).source === "object" &&
          !Array.isArray((entry as { source?: unknown }).source)
            ? {
                ...((entry as { source: Record<string, unknown> }).source ??
                  {}),
              }
            : null;
        if (
          source?.source === "local" &&
          typeof source.path === "string" &&
          source.path.startsWith("./.codex/plugins/")
        ) {
          source.path = source.path.replace("./.codex/plugins/", "./plugins/");
        }
        return source
          ? { ...(entry as Record<string, unknown>), source }
          : entry;
      });
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
}

function timestampForBackup(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(ISO_MILLIS_SUFFIX_RE, "Z");
}

async function repairLegacyCodexAuthoringLayout(args: {
  home: string;
  rootDir: string;
}): Promise<{ changed: boolean; conflicts: string[] }> {
  const liveRoot = projectRootFromAiRoot(args.rootDir, args.home) ?? args.home;
  const legacySkillsDir = join(liveRoot, ".codex", "skills");
  const preferredSkillsDir = join(liveRoot, ".agents", "skills");
  const legacyPluginsDir = join(liveRoot, ".codex", "plugins");
  const preferredPluginsDir = join(liveRoot, "plugins");
  const marketplacePath = join(
    liveRoot,
    ".agents",
    "plugins",
    "marketplace.json"
  );
  const conflicts: string[] = [];
  let changed = false;

  if (await moveMissingTree(legacySkillsDir, preferredSkillsDir, conflicts)) {
    changed = true;
  }

  if (await moveMissingTree(legacyPluginsDir, preferredPluginsDir, conflicts)) {
    changed = true;
  }

  try {
    const current = await readFile(marketplacePath, "utf8");
    const normalized = normalizeCodexMarketplaceText(current);
    if (normalized !== current) {
      await mkdir(dirname(marketplacePath), { recursive: true });
      await writeFile(marketplacePath, normalized, "utf8");
      changed = true;
    }
  } catch {
    // Ignore missing or unreadable marketplace files.
  }

  return { changed, conflicts };
}

interface CanonicalTemplateIssue {
  path: string;
  relPath: string;
  code: string;
  message: string;
}

interface CanonicalTemplateRefsInspection {
  valid: boolean;
  issues: CanonicalTemplateIssue[];
}

interface CanonicalTemplateRefsRepair {
  changed: boolean;
  repairedPaths: string[];
  backupPaths: string[];
}

async function repairCanonicalGlobalDocs(args: {
  home: string;
  rootDir: string;
}): Promise<{ changed: boolean; backupPath?: string }> {
  if (projectRootFromAiRoot(args.rootDir, args.home)) {
    return { changed: false };
  }
  const inspected = await inspectCanonicalGlobalDocs(args.rootDir, {
    projectRoot: null,
  });
  if (!(inspected.exists && !inspected.valid)) {
    return { changed: false };
  }

  const sourcePath = facultBuiltinAgentsGlobalSourcePath();
  const targetPath = join(args.rootDir, "AGENTS.global.md");
  const backupPath = join(
    args.rootDir,
    ".facult",
    "backups",
    "doctor",
    `AGENTS.global.${timestampForBackup()}.md`
  );
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(targetPath, backupPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, await readFile(sourcePath, "utf8"), "utf8");
  await repairBuiltinOperatingModelSnippets(args.rootDir);
  await ensureAiIndexPath({ homeDir: args.home, rootDir: args.rootDir });
  await ensureAiGraphPath({ homeDir: args.home, rootDir: args.rootDir });
  return { changed: true, backupPath };
}

async function repairBuiltinOperatingModelSnippets(
  rootDir: string
): Promise<void> {
  const relPaths = [
    "snippets/global/baseline.md",
    "snippets/global/core/work-units.md",
    "snippets/global/core/feedback-loops.md",
    "snippets/global/core/verification.md",
    "snippets/global/core/writeback.md",
  ];
  const sourceRoot = facultBuiltinPackRoot();

  for (const relPath of relPaths) {
    const sourcePath = join(sourceRoot, relPath);
    const targetPath = join(rootDir, relPath);
    const existing = (await pathExists(targetPath))
      ? await readFile(targetPath, "utf8")
      : null;
    if (existing !== null && existing.trim().length > 0) {
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

async function listProjectSkillNames(rootDir: string): Promise<string[]> {
  const skillsDir = join(rootDir, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function listProjectAgentNames(rootDir: string): Promise<string[]> {
  const agentsDir = join(rootDir, "agents");
  const entries = await readdir(agentsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  return entries
    .flatMap((entry) => {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        return [entry.name];
      }
      if (entry.isFile() && entry.name.endsWith(".toml")) {
        return [entry.name.replace(TOML_FILE_SUFFIX_RE, "")];
      }
      return [];
    })
    .sort((a, b) => a.localeCompare(b));
}

async function listProjectAutomationNames(rootDir: string): Promise<string[]> {
  const automationsDir = join(rootDir, "automations");
  const entries = await readdir(automationsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    if (await pathExists(join(automationsDir, entry.name, "automation.toml"))) {
      names.push(entry.name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

async function listProjectMcpNames(rootDir: string): Promise<string[]> {
  const trackedPaths = [
    join(rootDir, "mcp", "servers.json"),
    join(rootDir, "mcp", "mcp.json"),
  ];

  for (const candidate of trackedPaths) {
    try {
      const raw = await Bun.file(candidate).text();
      const parsed = JSON.parse(raw) as unknown;
      const servers = extractServersObject(parsed) ?? {};
      return Object.keys(servers).sort((a, b) => a.localeCompare(b));
    } catch {
      // Try next candidate.
    }
  }

  return [];
}

async function hasProjectGlobalDocs(rootDir: string): Promise<boolean> {
  return (
    (await pathExists(join(rootDir, "AGENTS.global.md"))) ||
    (await pathExists(join(rootDir, "AGENTS.override.global.md")))
  );
}

const UNRESOLVED_TEMPLATE_REF_RE = /\$\{[^}\n]+\}/g;
const UNRESOLVED_REFS_TEMPLATE_RE = /\$\{refs\.([A-Za-z0-9_.-]+)\}/g;
const FCLTY_BLOCK_RE =
  /<!--\s*fclty:([^>]+?)\s*-->([\s\S]*?)<!--\s*\/fclty:\1\s*-->/g;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

async function inspectLegacyRecovery(args: {
  home: string;
  rootDir: string;
  scope: "global" | "project";
}): Promise<DoctorLegacyRecovery> {
  const [managedRecords, autosync] = await Promise.all([
    inspectManagedStateRecords({
      homeDir: args.home,
      rootDir: args.rootDir,
    }),
    inspectAutosyncRecovery({
      homeDir: args.home,
      rootDir: args.rootDir,
    }),
  ]);
  const reasonCodes = new Set(autosync.reasonCodes);
  const managedUnavailable = managedRecords.some(
    (record) => record.state === "unavailable"
  );
  const managedInvalid = managedRecords.some(
    (record) => record.state === "invalid"
  );
  if (managedRecords.length > 0) {
    reasonCodes.add("managed_state_present");
  }
  if (managedUnavailable) {
    reasonCodes.add("managed_state_inspection_unavailable");
  }
  if (managedInvalid) {
    reasonCodes.add("managed_state_invalid");
  }
  if (autosync.configured.length > 0) {
    reasonCodes.add("autosync_config_present");
  }
  if (
    autosync.ownedPlists.length > 0 ||
    autosync.ownedLoadedLabels.length > 0
  ) {
    reasonCodes.add("autosync_runtime_active");
  }
  if (autosync.configured.some((record) => record.location !== "machine")) {
    reasonCodes.add("autosync_legacy_config");
  }

  // An unavailable launchd probe is only recovery-blocking when durable state
  // indicates that a service could belong to this root. Fresh installs have no
  // such state and must remain usable in launchd-less verification contexts.
  const hasAutosyncDiskRecoverySignal =
    autosync.configured.length > 0 || autosync.ownedPlists.length > 0;

  const blocked =
    managedUnavailable ||
    managedInvalid ||
    autosync.coverage.configs === "unavailable" ||
    autosync.coverage.launchAgents === "unavailable" ||
    (hasAutosyncDiskRecoverySignal &&
      autosync.coverage.launchd === "unavailable") ||
    autosync.orphanedLabels.length > 0 ||
    autosync.configured.some((record) => record.state !== "valid") ||
    autosync.reasonCodes.some((code) =>
      [
        "autosync_config_conflict",
        "autosync_launch_agent_ownership_mismatch",
        "autosync_loaded_ownership_unproven",
        "autosync_loaded_root_mismatch",
      ].includes(code)
    );
  const activeServices = new Set(
    [
      ...autosync.ownedPlists.map((plist) => plist.label),
      ...autosync.ownedLoadedLabels,
    ].map((label) => {
      if (label === "com.fclt.autosync" || label === "com.facult.autosync") {
        return "all";
      }
      return label
        .replace(CURRENT_AUTOSYNC_LABEL_PREFIX_RE, "")
        .replace(LEGACY_AUTOSYNC_LABEL_PREFIX_RE, "");
    })
  );
  const cleanupCandidates = blocked
    ? []
    : autosync.configured.filter(
        (record) =>
          record.state === "valid" &&
          Boolean(record.planId) &&
          activeServices.has(record.service)
      );
  const cleanupByService = new Map(
    cleanupCandidates.map((record) => [record.service, record] as const)
  );
  const actions = [...cleanupByService.values()]
    .sort((a, b) => a.service.localeCompare(b.service))
    .map((record) => ({
      id: "cleanup-autosync" as const,
      service: record.service,
      planId: record.planId ?? "",
      argv: [
        "fclt",
        "autosync",
        "cleanup",
        "--service",
        record.service,
        "--expected-plan",
        record.planId ?? "",
        `--${args.scope}`,
        "--root",
        args.rootDir,
        LEGACY_MANAGED_MUTATION_FLAG,
        "--json",
      ],
    }));
  const hasContainedState =
    managedRecords.length > 0 || autosync.configured.length > 0;
  const state: DoctorLegacyRecoveryState = blocked
    ? "blocked"
    : actions.length > 0
      ? "cleanup_required"
      : hasContainedState
        ? "contained"
        : "clear";

  return {
    state,
    mutationPolicy: "disabled_by_default",
    reasonCodes: [...reasonCodes].sort((a, b) => a.localeCompare(b)),
    coverage: {
      managed: managedUnavailable ? "unavailable" : "checked",
      autosyncConfigs: autosync.coverage.configs,
      launchAgents: autosync.coverage.launchAgents,
      launchd: autosync.coverage.launchd,
    },
    managed: { records: managedRecords },
    autosync: {
      configured: autosync.configured,
      ownedPlists: autosync.ownedPlists,
      ownedLoadedLabels: autosync.ownedLoadedLabels,
      orphanedLabels: autosync.orphanedLabels,
    },
    recovery: {
      boundary: blocked
        ? "manual_review"
        : actions.length > 0
          ? "owned_autosync_runtime_only"
          : "none",
      requiresApproval: actions.length > 0,
      actions,
      preserves: [
        "canonical_capability",
        "live_tool_state",
        "managed_state",
        "backups",
      ],
    },
  };
}

function projectAiInitCommand(rootDir: string): string {
  const projectRoot = projectRootFromAiRoot(rootDir);
  const rootValue = projectRoot ?? rootDir;
  return ["fclt project init", "--project-root", shellQuote(rootValue)].join(
    " "
  );
}

async function inspectCanonicalGlobalDocs(
  rootDir: string,
  opts: { projectRoot?: string | null } = {}
): Promise<{
  exists: boolean;
  valid: boolean;
  issues: DoctorIssue[];
}> {
  const pathValue = join(rootDir, "AGENTS.global.md");
  if (!(await pathExists(pathValue))) {
    return { exists: false, valid: true, issues: [] };
  }

  const text = await readFile(pathValue, "utf8");
  const issues: DoctorIssue[] = [];
  const refreshCommand = opts.projectRoot
    ? `fclt templates init operating-model --root ${shellQuote(rootDir)} --force`
    : "fclt templates init operating-model --global --force";
  const docLabel = opts.projectRoot
    ? "project AGENTS.global.md"
    : "AGENTS.global.md";
  const withSnippets = await renderSnippetText({
    text,
    filePath: pathValue,
    rootDir,
  });
  for (const error of withSnippets.errors) {
    issues.push({
      severity: "warning",
      code: "canonical-global-docs-render-error",
      message: error,
      fix: `Review ${docLabel} snippet markers or refresh the selected capability root with \`${refreshCommand}\`.`,
    });
  }
  const rendered = await renderCanonicalText(withSnippets.text, {
    rootDir,
  });
  const unresolvedRefs = new Set(
    rendered.match(UNRESOLVED_TEMPLATE_REF_RE) ?? []
  );
  if (unresolvedRefs.size > 0) {
    issues.push({
      severity: "warning",
      code: "canonical-global-docs-unresolved-template",
      message: `Rendered ${docLabel} contains unresolved template references.`,
      fix: `Review ${docLabel} refs or refresh the selected capability root with \`${refreshCommand}\`.`,
    });
  }

  const emptySections: string[] = [];
  for (const match of rendered.matchAll(FCLTY_BLOCK_RE)) {
    const key = match[1]?.trim();
    const body = match[2]?.trim();
    if (key && !body) {
      emptySections.push(key);
    }
  }
  if (emptySections.length > 0) {
    issues.push({
      severity: "warning",
      code: "canonical-global-docs-empty-managed-sections",
      message: `Rendered ${docLabel} has empty fclty managed sections: ${emptySections.join(", ")}.`,
      fix: `Add the missing snippets or refresh the selected capability root with \`${refreshCommand}\`.`,
    });
  }

  return {
    exists: true,
    valid: issues.length === 0,
    issues,
  };
}

const CANONICAL_TEMPLATE_REF_DIRS = ["instructions"] as const;

function canonicalRefValues(rootDir: string): Record<string, string> {
  return {
    evolution: join(rootDir, "instructions", "EVOLUTION.md"),
    feedback_loops: join(rootDir, "instructions", "FEEDBACK_LOOPS.md"),
    integration: join(rootDir, "instructions", "INTEGRATION.md"),
    learning_writeback: join(
      rootDir,
      "instructions",
      "LEARNING_AND_WRITEBACK.md"
    ),
    project_capability: join(rootDir, "instructions", "PROJECT_CAPABILITY.md"),
    verification: join(rootDir, "instructions", "VERIFICATION.md"),
    work_units: join(rootDir, "instructions", "WORK_UNITS.md"),
  };
}

function resolveKnownCanonicalRefs(text: string, rootDir: string): string {
  const refs = canonicalRefValues(rootDir);
  return text.replace(UNRESOLVED_REFS_TEMPLATE_RE, (match, key: string) => {
    return refs[key] ?? match;
  });
}

async function listCanonicalMarkdownFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      () => [] as import("node:fs").Dirent[]
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const pathValue = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(pathValue);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(pathValue);
      }
    }
  }

  for (const relDir of CANONICAL_TEMPLATE_REF_DIRS) {
    await visit(join(rootDir, relDir));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function relPathFromRoot(rootDir: string, pathValue: string): string {
  return pathValue.startsWith(`${rootDir}/`)
    ? pathValue.slice(rootDir.length + 1)
    : pathValue;
}

async function inspectCanonicalTemplateRefs(
  rootDir: string
): Promise<CanonicalTemplateRefsInspection> {
  const files = await listCanonicalMarkdownFiles(rootDir);
  const issues: CanonicalTemplateIssue[] = [];

  for (const pathValue of files) {
    const text = await readFile(pathValue, "utf8");
    const refs = new Set(text.match(UNRESOLVED_REFS_TEMPLATE_RE) ?? []);
    if (refs.size === 0) {
      continue;
    }
    const relPath = relPathFromRoot(rootDir, pathValue);
    issues.push({
      path: pathValue,
      relPath,
      code: "canonical-source-unresolved-template-ref",
      message: `${relPath} contains unresolved template refs: ${[...refs].join(", ")}.`,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

async function repairCanonicalTemplateRefs(
  rootDir: string
): Promise<CanonicalTemplateRefsRepair> {
  const files = await listCanonicalMarkdownFiles(rootDir);
  const repairedPaths: string[] = [];
  const backupPaths: string[] = [];

  for (const pathValue of files) {
    const before = await readFile(pathValue, "utf8");
    const after = resolveKnownCanonicalRefs(before, rootDir);
    if (after === before) {
      continue;
    }
    const relPath = relPathFromRoot(rootDir, pathValue);
    const backupPath = join(
      rootDir,
      ".facult",
      "backups",
      "doctor",
      `${relPath.replaceAll("/", "__")}.${timestampForBackup()}`
    );
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(pathValue, backupPath);
    await writeFile(pathValue, after, "utf8");
    repairedPaths.push(relPath);
    backupPaths.push(backupPath);
  }

  return {
    changed: repairedPaths.length > 0,
    repairedPaths,
    backupPaths,
  };
}

async function hasProjectToolRules(
  rootDir: string,
  tool: string
): Promise<boolean> {
  const rulesDir = join(rootDir, "tools", tool, "rules");
  const entries = await readdir(rulesDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  return entries.some(
    (entry) => entry.isFile() && entry.name.endsWith(".rules")
  );
}

async function hasProjectToolConfig(
  rootDir: string,
  tool: string
): Promise<boolean> {
  return (
    (await pathExists(join(rootDir, "tools", tool, "config.toml"))) ||
    (await pathExists(join(rootDir, "tools", tool, "config.local.toml")))
  );
}

async function planProjectSyncPolicyRepair(args: {
  home: string;
  rootDir: string;
}): Promise<{
  needed: boolean;
  toolPolicies: Record<
    string,
    {
      skills?: string[];
      agents?: string[];
      automations?: string[];
      mcpServers?: string[];
      globalDocs?: boolean;
      toolRules?: boolean;
      toolConfig?: boolean;
    }
  >;
}> {
  if (projectRootFromAiRoot(args.rootDir, args.home) == null) {
    return { needed: false, toolPolicies: {} };
  }

  const managedState = await loadManagedState(args.home, args.rootDir);
  const managedTools = Object.keys(managedState.tools).sort((a, b) =>
    a.localeCompare(b)
  );
  if (managedTools.length === 0) {
    return { needed: false, toolPolicies: {} };
  }

  const configuredTools = new Set(
    await loadConfiguredProjectSyncTools({ rootDir: args.rootDir })
  );
  const [skills, agents, automations, mcpServers, globalDocs] =
    await Promise.all([
      listProjectSkillNames(args.rootDir),
      listProjectAgentNames(args.rootDir),
      listProjectAutomationNames(args.rootDir),
      listProjectMcpNames(args.rootDir),
      hasProjectGlobalDocs(args.rootDir),
    ]);

  const toolPolicies: Record<
    string,
    {
      skills?: string[];
      agents?: string[];
      automations?: string[];
      mcpServers?: string[];
      globalDocs?: boolean;
      toolRules?: boolean;
      toolConfig?: boolean;
    }
  > = {};

  for (const tool of managedTools) {
    if (configuredTools.has(tool)) {
      continue;
    }
    const [toolRules, toolConfig] = await Promise.all([
      hasProjectToolRules(args.rootDir, tool),
      hasProjectToolConfig(args.rootDir, tool),
    ]);

    if (
      skills.length === 0 &&
      agents.length === 0 &&
      automations.length === 0 &&
      mcpServers.length === 0 &&
      !globalDocs &&
      !toolRules &&
      !toolConfig
    ) {
      continue;
    }

    toolPolicies[tool] = {
      ...(skills.length > 0 ? { skills } : {}),
      ...(agents.length > 0 ? { agents } : {}),
      ...(automations.length > 0 ? { automations } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(globalDocs ? { globalDocs: true } : {}),
      ...(toolRules ? { toolRules: true } : {}),
      ...(toolConfig ? { toolConfig: true } : {}),
    };
  }

  return {
    needed: Object.keys(toolPolicies).length > 0,
    toolPolicies,
  };
}

async function repairProjectSyncPolicy(args: {
  home: string;
  rootDir: string;
}): Promise<{ changed: boolean; path?: string; tools: string[] }> {
  const plan = await planProjectSyncPolicyRepair(args);
  if (!plan.needed) {
    return { changed: false, tools: [] };
  }
  const result = await writeProjectSyncPolicy({
    rootDir: args.rootDir,
    toolPolicies: plan.toolPolicies,
    targetFile: "config.local.toml",
  });
  return {
    changed: result.changed,
    path: result.path,
    tools: Object.keys(plan.toolPolicies).sort((a, b) => a.localeCompare(b)),
  };
}

function printHelp() {
  console.log(`fclt doctor — inspect and repair local fclt state

Usage:
  fclt doctor [--json] [--repair] [${LEGACY_MANAGED_MUTATION_FLAG}] [--root <path> | --global | --project]

Options:
  --json     Print read-only setup health, issues, and recommended actions
  --repair   Reconcile legacy state and remove contained background autosync launch agents
  ${LEGACY_MANAGED_MUTATION_FLAG}  Approve stopping a detected legacy autosync launch agent before other repair writes
`);
}

export async function buildDoctorReport(opts?: {
  cwd?: string;
  homeDir?: string;
  rootArg?: string;
  scope?: "merged" | "global" | "project";
}): Promise<DoctorReport> {
  const home = opts?.homeDir ?? process.env.HOME?.trim() ?? homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const globalRoot = resolveCliContextRoot({
    scope: "global",
    cwd,
    homeDir: home,
  });
  const rootDir =
    opts?.rootArg || opts?.scope === "project" || opts?.scope === "global"
      ? resolveCliContextRoot({
          rootArg: opts?.rootArg,
          scope: opts?.scope ?? "merged",
          cwd,
          homeDir: home,
        })
      : facultRootDir(home);
  const rootScope =
    opts?.scope === "global"
      ? "global"
      : opts?.scope === "project"
        ? "project"
        : projectRootFromAiRoot(rootDir, home)
          ? "project"
          : "global";
  return await withFacultRootScope({ rootDir, scope: rootScope }, async () => {
    const projectRoot = projectRootFromAiRoot(rootDir, home);
    const generated = facultAiIndexPath(home, rootDir);
    const generatedGraph = facultAiGraphPath(home, rootDir);
    const legacy = legacyAiIndexPath(rootDir);
    const writebackReviewDir = facultAiWritebackReviewDir(home, rootDir);
    const evolutionReviewDir = facultAiEvolutionReviewDir(home, rootDir);
    const reconciliationConfigPath = facultAiReconciliationConfigPath(
      home,
      rootDir
    );
    const reconciliationStatePath = facultAiReconciliationStatePath(
      home,
      rootDir
    );
    const reconciliationReviewDir = facultAiReconciliationReviewDir(
      home,
      rootDir
    );
    const evolutionLoopConfigPath = facultAiEvolutionLoopConfigPath(
      home,
      rootDir
    );
    const evolutionLoopStatePath = facultAiEvolutionLoopStatePath(
      home,
      rootDir
    );
    const evolutionLoopAuditPath = facultAiEvolutionLoopAuditPath(
      home,
      rootDir
    );
    const evolutionLoopReportDir = facultAiEvolutionLoopReportDir(
      home,
      rootDir
    );

    const [
      rootExists,
      canonicalSourceExists,
      generatedOnlyProjectRoot,
      result,
      generatedGraphExists,
      writebackReviewDirExists,
      evolutionReviewDirExists,
      canonicalGlobalDocs,
      canonicalTemplateRefs,
      projectSyncPlan,
      reconciliation,
      scheduledLoop,
      legacyRecovery,
    ] = await Promise.all([
      pathExists(rootDir),
      hasCanonicalSource(rootDir),
      isGeneratedOnlyProjectRoot({ home, rootDir }),
      ensureAiIndexPath({ homeDir: home, rootDir, repair: false }),
      pathExists(generatedGraph),
      pathExists(writebackReviewDir),
      pathExists(evolutionReviewDir),
      inspectCanonicalGlobalDocs(rootDir, { projectRoot }),
      inspectCanonicalTemplateRefs(rootDir),
      planProjectSyncPolicyRepair({ home, rootDir }),
      reconciliationStatus({ homeDir: home, rootDir }),
      diagnoseEvolutionLoop({ homeDir: home, rootDir, scope: rootScope }),
      inspectLegacyRecovery({
        home,
        rootDir,
        scope: rootScope,
      }),
    ]);

    const projectSyncRepairTools = Object.keys(
      projectSyncPlan.toolPolicies
    ).sort((a, b) => a.localeCompare(b));
    const scheduledLoopStatus = scheduledLoop.status;
    const scheduledLoopConfigurationState = scheduledLoop.configurationState;
    const scheduledLoopConfigured =
      scheduledLoop.configurationState === "ready";
    const scheduledLoopEnabled = Boolean(
      scheduledLoopStatus?.config?.enabled ?? scheduledLoop.config?.enabled
    );
    const stateDir = facultStateDir(home, rootDir);
    const [
      runtimeStateWritable,
      reviewArtifactsWritable,
      writebackSkill,
      evolutionSkill,
      codexReadiness,
    ] = await Promise.all([
      pathCanBeWritten(stateDir),
      Promise.all([
        pathCanBeWritten(writebackReviewDir),
        pathCanBeWritten(evolutionReviewDir),
        pathCanBeWritten(reconciliationReviewDir),
      ]).then((values) => values.every(Boolean)),
      Promise.all([
        pathExists(join(rootDir, "skills", "fclt-writeback", "SKILL.md")),
        projectRoot
          ? pathExists(join(globalRoot, "skills", "fclt-writeback", "SKILL.md"))
          : Promise.resolve(false),
      ]).then((values) => values.some(Boolean)),
      Promise.all([
        pathExists(join(rootDir, "skills", "capability-evolution", "SKILL.md")),
        projectRoot
          ? pathExists(
              join(globalRoot, "skills", "capability-evolution", "SKILL.md")
            )
          : Promise.resolve(false),
      ]).then((values) => values.some(Boolean)),
      inspectCodexReadiness(home),
    ]);
    const generatedIndexReady = result.source !== "missing";
    const assetTargeting =
      generatedIndexReady &&
      generatedGraphExists &&
      writebackSkill &&
      evolutionSkill;
    const loopBlockers: string[] = [];
    if (!(rootExists && canonicalSourceExists)) {
      loopBlockers.push("canonical_root");
    }
    if (!runtimeStateWritable) {
      loopBlockers.push("runtime_state_not_writable");
    }
    if (!reviewArtifactsWritable) {
      loopBlockers.push("review_artifacts_not_writable");
    }
    if (reconciliation.configurationState === "invalid") {
      loopBlockers.push("reconciliation_config_invalid");
    }
    if (reconciliation.configured && reconciliation.sourceCount === 0) {
      loopBlockers.push("reconciliation_sources_missing");
    }
    if (reconciliation.stateError) {
      loopBlockers.push("reconciliation_state_invalid");
    }
    if (!writebackSkill) {
      loopBlockers.push("writeback_skill_missing");
    }
    if (!evolutionSkill) {
      loopBlockers.push("evolution_skill_missing");
    }
    const loopState: LoopReadinessState =
      loopBlockers.length > 0
        ? "blocked"
        : assetTargeting &&
            writebackReviewDirExists &&
            evolutionReviewDirExists &&
            reconciliation.configured
          ? "ready"
          : "degraded";
    const issues: DoctorIssue[] = [];
    const actions: DoctorAction[] = [];

    if (legacyRecovery.state === "cleanup_required") {
      issues.push({
        severity: "warning",
        code: "legacy-autosync-cleanup-required",
        message:
          "A root-owned legacy background autosync service remains contained but active.",
        fix: "Run the exact approval-gated cleanup action from legacyRecovery.recovery.actions after reviewing its selected root and plan id.",
      });
      for (const recoveryAction of legacyRecovery.recovery.actions) {
        actions.push({
          id: `cleanup-autosync-${recoveryAction.service}`,
          label: `Contain legacy autosync service ${recoveryAction.service}`,
          command: shellCommand(recoveryAction.argv),
          risk: "runtime_state_write",
        });
      }
    } else if (legacyRecovery.state === "blocked") {
      issues.push({
        severity: "error",
        code: "legacy-recovery-manual-review-required",
        message:
          "Legacy managed/autosync state could not be proven safe for automatic cleanup.",
        fix: "Review legacyRecovery coverage and reason codes. No cleanup action is emitted until ownership and source coverage are complete.",
      });
    } else if (legacyRecovery.state === "contained") {
      issues.push({
        severity: "info",
        code: "legacy-managed-state-contained",
        message:
          "Legacy managed records are present, but broad mutation is disabled and no background autosync cleanup is pending.",
      });
    }

    if (!rootExists) {
      issues.push({
        severity: "error",
        code: "missing-root",
        message: "Canonical .ai root does not exist.",
        fix: "Initialize the global operating model or project .ai root.",
      });
      actions.push({
        id: "init-global-operating-model",
        label: "Initialize global operating model",
        command: "fclt templates init operating-model --global",
        risk: "canonical_write",
      });
    }

    if (!canonicalSourceExists) {
      issues.push({
        severity: projectRoot ? "error" : "warning",
        code: "missing-canonical-source",
        message:
          "No canonical capability source was found in the selected .ai root.",
        fix: projectRoot
          ? `Run ${projectAiInitCommand(rootDir)} or restore canonical project assets.`
          : "Run fclt templates init operating-model --global.",
      });
    }

    for (const issue of canonicalGlobalDocs.issues) {
      issues.push(issue);
    }
    if (canonicalGlobalDocs.exists && !canonicalGlobalDocs.valid) {
      actions.push({
        id: projectRoot
          ? "refresh-project-operating-model"
          : "refresh-global-operating-model",
        label: projectRoot
          ? "Refresh project operating model"
          : "Refresh global operating model",
        command: projectRoot
          ? `fclt templates init operating-model --root ${shellQuote(rootDir)} --force`
          : "fclt templates init operating-model --global --force",
        risk: "canonical_write",
      });
    }

    for (const issue of canonicalTemplateRefs.issues) {
      issues.push({
        severity: "warning",
        code: issue.code,
        message: issue.message,
        fix: "Run fclt doctor --repair to resolve known refs into concrete paths, then review any remaining placeholders.",
      });
    }
    if (!canonicalTemplateRefs.valid) {
      actions.push({
        id: "repair-canonical-template-refs",
        label: "Repair unresolved canonical template refs",
        command: "fclt doctor --repair",
        risk: "canonical_write",
      });
    }

    if (generatedOnlyProjectRoot) {
      issues.push({
        severity: "error",
        code: "project-generated-only",
        message:
          "Project .ai contains generated state but no canonical project source.",
        fix: "Initialize, restore, or detach canonical project capability before managed project sync.",
      });
      actions.push({
        id: "init-project-ai",
        label: "Preview minimal project enrollment",
        command: projectAiInitCommand(rootDir),
        risk: "read_only",
      });
    }

    if (result.source === "missing") {
      issues.push({
        severity: "warning",
        code: "missing-generated-index",
        message: "Generated AI index is missing.",
        fix: "Run fclt index or fclt doctor --repair.",
      });
      actions.push({
        id: "rebuild-index",
        label: "Rebuild generated index",
        command: "fclt index",
        risk: "generated_state_write",
      });
    } else if (result.source === "legacy") {
      issues.push({
        severity: "warning",
        code: "legacy-generated-index",
        message: "Generated AI index is still in a legacy location.",
        fix: "Run fclt doctor --repair.",
      });
      actions.push({
        id: "repair-generated-state",
        label: "Repair generated state",
        command: "fclt doctor --repair",
        risk: "generated_state_write",
      });
    }

    if (!generatedGraphExists) {
      issues.push({
        severity: "info",
        code: "missing-generated-graph",
        message: "Generated capability graph is missing.",
        fix: "Run fclt index or fclt doctor --repair.",
      });
    }

    if (!writebackReviewDirExists) {
      issues.push({
        severity: "info",
        code: "missing-writeback-review-dir",
        message: "Global writeback review directory is not present yet.",
        fix: "It will be created when writebacks are recorded or the operating model is initialized.",
      });
    }

    if (!evolutionReviewDirExists) {
      issues.push({
        severity: "info",
        code: "missing-evolution-review-dir",
        message: "Global evolution review directory is not present yet.",
        fix: "It will be created when proposals are drafted or the operating model is initialized.",
      });
    }

    if (reconciliation.configurationState === "not_configured") {
      issues.push({
        severity: "warning",
        code: "reconciliation-not-configured",
        message:
          "Automatic source reconciliation is not configured, so an empty writeback queue cannot prove an empty review window.",
        fix: "Run `fclt ai review init` or `fclt setup`.",
      });
      actions.push({
        id: "init-reconciliation",
        label: "Initialize automatic source reconciliation",
        command: "fclt ai review init",
        risk: "canonical_write",
      });
    }

    if (reconciliation.configurationState === "invalid") {
      issues.push({
        severity: "error",
        code: "reconciliation-config-invalid",
        message:
          reconciliation.configurationError ??
          "Automatic source reconciliation configuration is invalid.",
        fix: "Review the invalid file or run `fclt ai review init --force` to back it up and replace it.",
      });
      actions.push({
        id: "replace-invalid-reconciliation-config",
        label: "Back up and replace invalid reconciliation configuration",
        command: "fclt ai review init --force",
        risk: "canonical_write",
      });
    }

    if (reconciliation.stateError) {
      issues.push({
        severity: "error",
        code: "reconciliation-state-invalid",
        message: reconciliation.stateError,
        fix: "Preserve the state file for inspection, then explicitly move or repair it before reconciling again.",
      });
    }

    if (!(writebackSkill && evolutionSkill)) {
      issues.push({
        severity: "error",
        code: "missing-loop-skills",
        message:
          "Required writeback/evolution skills are missing from the selected root.",
        fix: projectRoot
          ? "Run `fclt templates init operating-model --project` for an explicit full-pack install."
          : "Run `fclt setup`.",
      });
      actions.push({
        id: "bootstrap-loop-assets",
        label: "Install required writeback/evolution assets",
        command: projectRoot
          ? "fclt templates init operating-model --project"
          : "fclt setup",
        risk: "canonical_write",
      });
    }

    if (!(runtimeStateWritable && reviewArtifactsWritable)) {
      issues.push({
        severity: "error",
        code: "loop-state-not-writable",
        message:
          "Writeback runtime state or review artifact paths are not writable.",
        fix: `Restore write access to ${stateDir}, ${writebackReviewDir}, ${evolutionReviewDir}, and ${reconciliationReviewDir}, then run \`fclt setup\` again.`,
      });
    }

    if (scheduledLoopConfigurationState === "invalid") {
      issues.push({
        severity: "error",
        code: "evolution-loop-config-invalid",
        message:
          scheduledLoop.configurationError ??
          "Scheduled evolution-loop configuration is invalid.",
        fix: `Preserve ${evolutionLoopConfigPath} for inspection, then repair or move it before running \`fclt ai loop enable\` again.`,
      });
    } else if (
      scheduledLoopEnabled &&
      scheduledLoopStatus?.health === "degraded"
    ) {
      issues.push({
        severity: "warning",
        code: "evolution-loop-degraded",
        message:
          "The scheduled evolution loop is enabled but its owned scheduler, observed execution, or reconciliation readiness is degraded.",
        fix: "Run `fclt ai loop status --json`, repair the reported boundary, then run one bounded loop review.",
      });
      actions.push({
        id: "inspect-evolution-loop",
        label: "Inspect scheduled evolution-loop health",
        command: "fclt ai loop status --json",
        risk: "read_only",
      });
    }
    if (scheduledLoop.stateError) {
      issues.push({
        severity: "error",
        code: "evolution-loop-state-invalid",
        message: scheduledLoop.stateError,
        fix: `Preserve ${evolutionLoopStatePath} for inspection, then explicitly repair or move it before rerunning the loop.`,
      });
    }
    if (scheduledLoop.schedulerError) {
      issues.push({
        severity: "warning",
        code: "evolution-loop-scheduler-invalid",
        message: scheduledLoop.schedulerError,
        fix: "Inspect the owned Codex automation. Core disable remains safe even when scheduler ownership has drifted.",
      });
    }

    if (codexReadiness.state === "misconfigured") {
      issues.push({
        severity: "warning",
        code: "codex-plugin-misconfigured",
        message:
          "Codex plugin payload, MCP declaration, and registration are inconsistent.",
        fix: codexReadiness.repair,
      });
      actions.push({
        id: "repair-codex-plugin",
        label: "Repair Codex plugin installation",
        command: "fclt setup codex-plugin",
        risk: "tool_home_write",
      });
    }

    if (projectSyncPlan.needed) {
      issues.push({
        severity: "warning",
        code: "implicit-project-sync-policy",
        message: `Project sync is still implicit for managed tools: ${projectSyncRepairTools.join(", ")}.`,
        fix: "Run fclt doctor --repair to materialize explicit project sync policy.",
      });
      actions.push({
        id: "materialize-project-sync-policy",
        label: "Materialize project sync policy",
        command: "fclt doctor --repair",
        risk: "canonical_write",
      });
    }

    let state: DoctorHealthState = "healthy";
    if (generatedOnlyProjectRoot) {
      state = "project_generated_only";
    } else if (!(rootExists && canonicalSourceExists)) {
      state = "uninitialized";
    } else if (
      legacyRecovery.state === "cleanup_required" ||
      legacyRecovery.state === "blocked"
    ) {
      state = "legacy_state_attention";
    } else if (!(canonicalGlobalDocs.valid && canonicalTemplateRefs.valid)) {
      state = "canonical_source_attention";
    } else if (loopState === "blocked") {
      state = "loop_blocked";
    } else if (
      scheduledLoopConfigurationState === "invalid" ||
      scheduledLoop.stateError ||
      scheduledLoop.schedulerError ||
      (scheduledLoopEnabled && scheduledLoopStatus?.health === "degraded")
    ) {
      state = "scheduled_loop_attention";
    } else if (!(writebackReviewDirExists && evolutionReviewDirExists)) {
      state = "partial_global_config";
    } else if (projectSyncPlan.needed) {
      state = "project_policy_attention";
    } else if (result.source === "missing") {
      state = "stale_or_missing_generated_state";
    } else if (result.source === "legacy") {
      state = "legacy_state_attention";
    }

    return {
      version: 2,
      packageVersion: await packageVersion(),
      cwd,
      homeDir: home,
      rootDir,
      projectRoot,
      health: {
        state,
        ok: state === "healthy" || state === "partial_global_config",
      },
      paths: {
        configPath: facultConfigPath(home),
        generatedIndex: generated,
        generatedGraph,
        stateDir: facultStateDir(home, rootDir),
        legacyIndex: legacy,
        writebackReviewDir,
        evolutionReviewDir,
        reconciliationConfigPath,
        reconciliationStatePath,
        reconciliationReviewDir,
        evolutionLoopConfigPath,
        evolutionLoopStatePath,
        evolutionLoopAuditPath,
        evolutionLoopReportDir,
      },
      checks: {
        rootExists,
        canonicalSourceExists,
        generatedOnlyProjectRoot,
        generatedIndexSource: result.source,
        generatedGraphExists,
        writebackReviewDirExists,
        evolutionReviewDirExists,
        reconciliationConfigured: reconciliation.configured,
        reconciliationSourceCount: reconciliation.sourceCount,
        evolutionLoopConfigured: scheduledLoopConfigured,
        evolutionLoopEnabled: scheduledLoopEnabled,
        canonicalGlobalDocsValid: canonicalGlobalDocs.valid,
        canonicalGlobalDocsIssueCodes: canonicalGlobalDocs.issues.map(
          (issue) => issue.code
        ),
        canonicalTemplateRefsValid: canonicalTemplateRefs.valid,
        canonicalTemplateRefsIssueCodes: canonicalTemplateRefs.issues.map(
          (issue) => issue.code
        ),
        canonicalTemplateRefsIssuePaths: canonicalTemplateRefs.issues.map(
          (issue) => issue.relPath
        ),
        projectSyncRepairNeeded: projectSyncPlan.needed,
        projectSyncRepairTools,
      },
      legacyRecovery,
      loop: {
        state: loopState,
        ready: loopState === "ready",
        blockers: loopBlockers,
        capabilities: {
          canonicalRoot: rootExists && canonicalSourceExists,
          generatedIndex: generatedIndexReady,
          generatedGraph: generatedGraphExists,
          runtimeStateWritable,
          reviewArtifactsWritable,
          assetTargeting,
          writebackSkill,
          evolutionSkill,
          automationTemplates: [
            "learning-review",
            "evolution-review",
            "tool-call-audit",
            "closed-loop-review",
          ],
          reconciliation: {
            configured: reconciliation.configured,
            configurationState: reconciliation.configurationState,
            configurationError: reconciliation.configurationError,
            stateError: reconciliation.stateError,
            sourceCount: reconciliation.sourceCount,
            coverageState: reconciliation.coverageState,
            lastReviewId: reconciliation.lastReviewId,
          },
          scheduling: {
            configured: scheduledLoopConfigured,
            configurationState: scheduledLoopConfigurationState,
            configurationError: scheduledLoop.configurationError,
            stateError: scheduledLoop.stateError,
            schedulerError: scheduledLoop.schedulerError,
            enabled: scheduledLoopEnabled,
            health: scheduledLoopStatus?.health,
            schedulerRegistered: scheduledLoopStatus?.scheduler.registered,
            schedulerStatus: scheduledLoopStatus?.scheduler.status,
            observationState: scheduledLoopStatus?.schedulerObservation.state,
            lastObservedRunAt:
              scheduledLoopStatus?.schedulerObservation.lastObservedRunAt,
          },
        },
        integrations: {
          codex: codexReadiness,
        },
      },
      issues,
      actions,
    };
  });
}

export async function doctorCommand(argv: string[]) {
  await doctorCommandWithScope(argv, false);
}

async function doctorCommandWithScope(
  argv: string[],
  rootScopeActive: boolean
) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  const json = argv.includes("--json");
  const repair = argv.includes("--repair");
  const allowLegacyManagedMutation = legacyManagedMutationApproved({ argv });
  const home = process.env.HOME?.trim() || homedir();
  const contextArgv = argv.filter(
    (arg) =>
      arg !== "--json" &&
      arg !== "--repair" &&
      arg !== LEGACY_MANAGED_MUTATION_FLAG
  );

  try {
    const parsed = parseCliContextArgs(contextArgv);
    const unknown = parsed.argv[0];
    if (unknown) {
      console.error(`Unknown option: ${unknown}`);
      process.exitCode = 1;
      return;
    }
    if (json) {
      if (repair) {
        console.error(
          "doctor --json is read-only; run doctor --repair without --json to mutate state."
        );
        process.exitCode = 1;
        return;
      }
      const report = await buildDoctorReport({
        cwd: process.cwd(),
        homeDir: home,
        rootArg: parsed.rootArg,
        scope: parsed.scope,
      });
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const rootDir =
      parsed.rootArg || parsed.scope !== "merged"
        ? resolveCliContextRoot({
            rootArg: parsed.rootArg,
            scope: parsed.scope,
            cwd: process.cwd(),
            homeDir: home,
          })
        : facultRootDir(home);
    const rootScope = resolveCliContextScope({
      homeDir: home,
      rootDir,
      scope: parsed.scope,
    });
    if (!rootScopeActive) {
      await withFacultRootScope({ rootDir, scope: rootScope }, async () =>
        doctorCommandWithScope(argv, true)
      );
      return;
    }
    let rootConfigRepaired = false;
    let stateRepaired = false;
    let stateConflicts: string[] = [];
    let autosyncRepaired = false;
    let codexAuthoringRepaired = false;
    let codexAuthoringConflicts: string[] = [];
    let canonicalGlobalDocsRepaired = false;
    let canonicalGlobalDocsBackupPath: string | undefined;
    let canonicalTemplateRefsRepair: CanonicalTemplateRefsRepair | undefined;
    let reviewArtifactsRefreshed:
      | {
          writebackCount: number;
          proposalCount: number;
          writebackReviewDir: string;
          evolutionReviewDir: string;
        }
      | undefined;
    let projectSyncRepairNeeded = false;
    let projectSyncRepaired = false;
    let projectSyncRepairTools: string[] = [];
    let projectSyncRepairPath: string | undefined;
    if (repair) {
      await assertAutosyncRepairAllowed(
        home,
        rootDir,
        allowLegacyManagedMutation
      );
      const autosyncTargetRoot =
        !parsed.rootArg &&
        parsed.scope === "merged" &&
        resolve(rootDir) === resolve(legacyDefaultRoot(home))
          ? join(home, ".ai")
          : rootDir;
      autosyncRepaired = await repairAutosyncServices(home, rootDir, {
        allowLegacyManagedMutation,
        targetRootDir: autosyncTargetRoot,
      });
      rootConfigRepaired = await repairLegacyRootConfig(home);
      const stateRepair = await repairLegacyState({ home, rootDir });
      stateRepaired = stateRepair.changed;
      stateConflicts = stateRepair.conflicts;
      const authoringRepair = await repairLegacyCodexAuthoringLayout({
        home,
        rootDir,
      });
      codexAuthoringRepaired = authoringRepair.changed;
      codexAuthoringConflicts = authoringRepair.conflicts;
      const globalDocsRepair = await repairCanonicalGlobalDocs({
        home,
        rootDir,
      });
      canonicalGlobalDocsRepaired = globalDocsRepair.changed;
      canonicalGlobalDocsBackupPath = globalDocsRepair.backupPath;
      canonicalTemplateRefsRepair = await repairCanonicalTemplateRefs(rootDir);
      const { refreshAiReviewArtifacts } = await import("./ai");
      reviewArtifactsRefreshed = await refreshAiReviewArtifacts({
        homeDir: home,
        rootDir,
      });
      const projectSyncRepair = await repairProjectSyncPolicy({
        home,
        rootDir,
      });
      projectSyncRepaired = projectSyncRepair.changed;
      projectSyncRepairTools = projectSyncRepair.tools;
      projectSyncRepairPath = projectSyncRepair.path;
    } else {
      const projectSyncPlan = await planProjectSyncPolicyRepair({
        home,
        rootDir,
      });
      projectSyncRepairNeeded = projectSyncPlan.needed;
      projectSyncRepairTools = Object.keys(projectSyncPlan.toolPolicies).sort(
        (a, b) => a.localeCompare(b)
      );
    }
    const generated = facultAiIndexPath(home, rootDir);
    const generatedGraph = facultAiGraphPath(home, rootDir);
    const legacy = legacyAiIndexPath(rootDir);
    const result = await ensureAiIndexPath({
      homeDir: home,
      rootDir,
      repair,
    });
    const graphResult = await ensureAiGraphPath({
      homeDir: home,
      rootDir,
      repair,
    });

    console.log(`Canonical root: ${rootDir}`);
    console.log(`Generated AI index: ${generated}`);
    console.log(`Generated AI graph: ${generatedGraph}`);
    console.log(`Facult state dir: ${facultStateDir(home, rootDir)}`);
    console.log(`Legacy root index: ${legacy}`);

    if (rootConfigRepaired) {
      console.log(`Updated fclt root config to ${join(home, ".ai")}`);
    }
    if (stateRepaired) {
      console.log(
        "Migrated legacy Facult state into the canonical .ai state directory."
      );
    }
    if (stateConflicts.length) {
      console.log("Skipped conflicting legacy state paths:");
      for (const conflict of stateConflicts) {
        console.log(`- ${conflict}`);
      }
    }
    if (autosyncRepaired) {
      console.log(
        "Removed contained background autosync launch agents and preserved one-shot recovery configuration."
      );
    }
    if (codexAuthoringRepaired) {
      console.log(
        "Migrated legacy Codex authoring paths to .agents/skills, .agents/plugins/marketplace.json, and plugins/."
      );
    }
    if (codexAuthoringConflicts.length) {
      console.log("Skipped conflicting Codex authoring paths:");
      for (const conflict of codexAuthoringConflicts) {
        console.log(`- ${conflict}`);
      }
    }
    if (canonicalGlobalDocsRepaired) {
      console.log(
        `Repaired canonical AGENTS.global.md from the built-in operating model. Backup: ${canonicalGlobalDocsBackupPath}`
      );
    }
    if (canonicalTemplateRefsRepair?.changed) {
      console.log("Resolved canonical template refs in:");
      for (const repairedPath of canonicalTemplateRefsRepair.repairedPaths) {
        console.log(`- ${repairedPath}`);
      }
    }
    if (reviewArtifactsRefreshed) {
      console.log(
        `Refreshed AI review artifacts: ${reviewArtifactsRefreshed.writebackCount} writebacks in ${reviewArtifactsRefreshed.writebackReviewDir}, ${reviewArtifactsRefreshed.proposalCount} proposals in ${reviewArtifactsRefreshed.evolutionReviewDir}.`
      );
    }
    if (projectSyncRepaired && projectSyncRepairPath) {
      console.log(
        `Materialized explicit project sync policy in ${projectSyncRepairPath} for: ${projectSyncRepairTools.join(", ")}`
      );
    }
    if (!repair && projectSyncRepairNeeded) {
      console.log(
        `Project sync is still implicit for managed tools (${projectSyncRepairTools.join(", ")}). Run \`fclt doctor --repair\` to write explicit [project_sync.<tool>] entries.`
      );
    }
    const canonicalGlobalDocs = await inspectCanonicalGlobalDocs(rootDir, {
      projectRoot: projectRootFromAiRoot(rootDir, home),
    });
    if (canonicalGlobalDocs.exists && !canonicalGlobalDocs.valid) {
      for (const issue of canonicalGlobalDocs.issues) {
        console.log(`${issue.message} ${issue.fix ?? ""}`.trim());
      }
      if (!repair) {
        process.exitCode = 1;
        return;
      }
    }
    const canonicalTemplateRefs = await inspectCanonicalTemplateRefs(rootDir);
    if (!canonicalTemplateRefs.valid) {
      for (const issue of canonicalTemplateRefs.issues) {
        console.log(
          `${issue.message} Run \`fclt doctor --repair\` to resolve known refs into concrete paths, then review any remaining placeholders.`
        );
      }
      if (!repair) {
        process.exitCode = 1;
        return;
      }
    }
    if (await isGeneratedOnlyProjectRoot({ home, rootDir })) {
      console.log(
        "Project .ai root contains generated state only. Canonical project source is missing, so managed project sync should be treated as unsafe until source is initialized, restored, or management is detached."
      );
      process.exitCode = 1;
      return;
    }

    if (result.source === "generated") {
      console.log("AI index is healthy.");
      return;
    }

    if (repair && result.source === "legacy") {
      console.log(
        `Repaired generated AI index from legacy root index: ${generated}`
      );
      return;
    }

    if (repair && result.source === "rebuilt") {
      console.log(
        `Rebuilt generated AI index from canonical source: ${generated}`
      );
    }
    if (repair && graphResult.rebuilt) {
      console.log(`Repaired generated AI graph: ${generatedGraph}`);
    }
    if (repair && result.source === "rebuilt") {
      return;
    }

    if (
      result.source === "legacy" &&
      projectRootFromAiRoot(rootDir, home) &&
      (await hasCanonicalSource(rootDir))
    ) {
      console.log(
        "Legacy repo-local generated AI state detected. Run `fclt doctor --repair` or `fclt index` to migrate it into machine-local project state."
      );
      return;
    }

    if (result.source === "legacy") {
      console.log(
        "Legacy root index detected. Run `fclt doctor --repair` to reconcile it."
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      "Generated AI index is missing. Run `fclt doctor --repair` or `fclt index`."
    );
    process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
