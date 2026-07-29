import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  facultAiReconciliationConfigPath,
  projectRootFromAiRoot,
} from "./paths";
import type {
  EvidenceExportSourceConfig,
  FileSourceConfig,
  GitSourceConfig,
  ReconciliationConfig,
  ReconciliationSourceConfig,
} from "./reconciliation-types";

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const PATH_SEGMENT_RE = /[\\/]/;
const GIT_BRANCH_RE = /^[a-z0-9][a-z0-9._/-]*$/i;
export const DEFAULT_SOURCE_FRESHNESS_THRESHOLD_HOURS = 168;
const MAX_SOURCE_FRESHNESS_THRESHOLD_HOURS = 24 * 365;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: string[],
  context: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${context} has unknown fields: ${unknown.join(", ")}`);
  }
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID_RE.test(value)) {
    throw new Error(
      "Reconciliation source ids must use letters, numbers, dots, dashes, or underscores"
    );
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value.map((entry) => String(entry).trim());
}

function parseFreshnessThreshold(
  value: unknown,
  sourceId: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SOURCE_FRESHNESS_THRESHOLD_HOURS
  ) {
    throw new Error(
      `Reconciliation source ${sourceId} freshnessThresholdHours must be an integer between 1 and ${MAX_SOURCE_FRESHNESS_THRESHOLD_HOURS}`
    );
  }
  return value;
}

function parseSource(value: unknown): ReconciliationSourceConfig {
  if (!isPlainObject(value)) {
    throw new Error("Reconciliation sources must be objects");
  }
  const id = validateId(value.id);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`Reconciliation source ${id} enabled must be boolean`);
  }
  const enabled = value.enabled !== false;
  const freshnessThresholdHours = parseFreshnessThreshold(
    value.freshnessThresholdHours,
    id
  );
  if (value.type === "writebacks") {
    assertKnownFields(
      value,
      ["id", "type", "enabled", "scope", "freshnessThresholdHours"],
      `Writeback source ${id}`
    );
    if (
      value.scope !== undefined &&
      value.scope !== "context" &&
      value.scope !== "global"
    ) {
      throw new Error(`Writeback source ${id} scope must be context or global`);
    }
    return {
      id,
      type: "writebacks",
      enabled,
      scope: value.scope ?? "context",
      freshnessThresholdHours,
    };
  }
  if (value.type === "git") {
    assertKnownFields(
      value,
      [
        "id",
        "type",
        "enabled",
        "repository",
        "paths",
        "allBranches",
        "defaultBranch",
        "freshnessThresholdHours",
      ],
      `Git source ${id}`
    );
    const source: GitSourceConfig = {
      id,
      type: "git",
      enabled,
      freshnessThresholdHours,
    };
    if (value.repository !== undefined && value.repository !== "project") {
      throw new Error(`Git source ${id} repository must be project`);
    }
    if (value.paths !== undefined) {
      source.paths = stringArray(value.paths, `Git source ${id} paths`);
      for (const path of source.paths) {
        if (
          isAbsolute(path) ||
          path.split(PATH_SEGMENT_RE).includes("..") ||
          path.includes("\0")
        ) {
          throw new Error(
            `Git source ${id} path must stay inside the project: ${path}`
          );
        }
      }
    }
    if (value.allBranches !== undefined) {
      if (typeof value.allBranches !== "boolean") {
        throw new Error(`Git source ${id} allBranches must be a boolean`);
      }
      source.allBranches = value.allBranches;
    }
    if (value.defaultBranch !== undefined) {
      if (
        typeof value.defaultBranch !== "string" ||
        !GIT_BRANCH_RE.test(value.defaultBranch) ||
        value.defaultBranch.includes("..") ||
        value.defaultBranch.includes("@{") ||
        value.defaultBranch.endsWith("/") ||
        value.defaultBranch.includes("//")
      ) {
        throw new Error(
          `Git source ${id} defaultBranch must be a safe Git branch or ref`
        );
      }
      source.defaultBranch = value.defaultBranch;
    }
    return source;
  }
  if (value.type === "evidence-export") {
    assertKnownFields(
      value,
      ["id", "type", "enabled", "path", "freshnessThresholdHours"],
      `Evidence export source ${id}`
    );
    if (typeof value.path !== "string" || !value.path.trim()) {
      throw new Error(
        `Evidence export source ${id} path must be a non-empty string`
      );
    }
    const source: EvidenceExportSourceConfig = {
      id,
      type: "evidence-export",
      enabled,
      path: value.path.trim(),
      freshnessThresholdHours,
    };
    if (
      isAbsolute(source.path) ||
      source.path.split(PATH_SEGMENT_RE).includes("..") ||
      source.path.includes("\0")
    ) {
      throw new Error(
        `Evidence export source ${id} path must stay inside the project`
      );
    }
    return source;
  }
  if (value.type === "automation" || value.type === "markdown") {
    assertKnownFields(
      value,
      ["id", "type", "enabled", "root", "paths", "freshnessThresholdHours"],
      `${value.type} source ${id}`
    );
    const root =
      value.root ?? (value.type === "automation" ? "home" : "project");
    if (root !== "home" && root !== "project") {
      throw new Error(
        `${value.type} source ${id} root must be home or project`
      );
    }
    const source: FileSourceConfig = {
      id,
      type: value.type,
      enabled,
      root,
      paths: stringArray(value.paths, `${value.type} source ${id} paths`),
      freshnessThresholdHours,
    };
    for (const path of source.paths) {
      if (
        isAbsolute(path) ||
        path.split(PATH_SEGMENT_RE).includes("..") ||
        path.includes("\0")
      ) {
        throw new Error(
          `${value.type} source ${id} path must stay inside its configured root: ${path}`
        );
      }
    }
    return source;
  }
  throw new Error(
    `Unsupported reconciliation source type: ${String(value.type)}`
  );
}

export function defaultReconciliationConfig(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
}): ReconciliationConfig {
  const sources: ReconciliationSourceConfig[] = [
    { id: "writebacks", type: "writebacks", enabled: true },
  ];
  const isProject =
    args.scope === "project" ||
    (args.scope === undefined &&
      Boolean(projectRootFromAiRoot(args.rootDir, args.homeDir)));
  if (isProject) {
    sources.push({
      id: "git",
      type: "git",
      enabled: true,
      repository: "project",
      allBranches: true,
      paths: [".ai", "AGENTS.md", "docs"],
    });
  }
  return { version: 1, sources };
}

export function parseReconciliationConfig(
  value: unknown
): ReconciliationConfig {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sources)
  ) {
    throw new Error(
      "Reconciliation config must have version 1 and a sources array"
    );
  }
  assertKnownFields(value, ["version", "sources"], "Reconciliation config");
  const sources = value.sources.map(parseSource);
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new Error(`Duplicate reconciliation source id: ${source.id}`);
    }
    ids.add(source.id);
  }
  return { version: 1, sources };
}

export async function loadReconciliationConfig(args: {
  homeDir: string;
  rootDir: string;
  configPath?: string;
}): Promise<{ config: ReconciliationConfig; path: string }> {
  const path =
    args.configPath ??
    facultAiReconciliationConfigPath(args.homeDir, args.rootDir);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Reconciliation config not found: ${path}. Run fclt ai review init.`
    );
  }
  return {
    config: parseReconciliationConfig(JSON.parse(await file.text())),
    path,
  };
}

export async function initializeReconciliationConfig(args: {
  homeDir: string;
  rootDir: string;
  scope?: "global" | "project";
  dryRun?: boolean;
  force?: boolean;
}): Promise<{
  path: string;
  created: boolean;
  config: ReconciliationConfig;
  backupPath?: string;
}> {
  const path = facultAiReconciliationConfigPath(args.homeDir, args.rootDir);
  const config = defaultReconciliationConfig(args);
  if (await Bun.file(path).exists()) {
    try {
      return {
        path,
        created: false,
        config: parseReconciliationConfig(
          JSON.parse(await Bun.file(path).text())
        ),
      };
    } catch (error) {
      if (!args.force) {
        throw new Error(
          `Existing reconciliation config is invalid: ${error instanceof Error ? error.message : String(error)}. Review it or run fclt ai review init --force to back it up and replace it.`
        );
      }
      const backupPath = `${path}.invalid-${new Date()
        .toISOString()
        .replaceAll(":", "-")}`;
      if (!args.dryRun) {
        await copyFile(path, backupPath);
        await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
      }
      return { path, created: true, config, backupPath };
    }
  }
  if (!args.dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { path, created: true, config };
}
