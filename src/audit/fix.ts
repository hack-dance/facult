import { closeSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { extractServersObject, isInlineMcpSecretValue } from "../mcp-config";
import { facultRootDir } from "../paths";
import { parseJsonLenient } from "../util/json";
import type { AgentAuditReport } from "./agent";
import {
  type AuditMcpRemediationBinding,
  auditFindingIdentity,
  auditSnapshotCanonicalPath,
  loadVerifiedAuditReportEnvelope,
  type VerifiedAuditReportEnvelope,
} from "./report-persistence";
import {
  openBoundPrivateSubdirectory,
  replaceBoundPrivateFilePairAt,
} from "./safe-openat";
import {
  type AuditSourceSnapshot,
  validateAuditSourceSnapshot,
} from "./source-provenance";
import type { AuditFinding, AuditItemResult, StaticAuditReport } from "./types";

type AuditFixSource = "static" | "agent" | "combined";
const RULE_ID_PREFIX_RE = /^(static|agent):/;
const INLINE_SECRET_RULE_ID = "mcp-env-inline-secret";
const ARG_VALUE_SPLIT_RE = /=(.*)/s;
const MAX_MCP_CONFIG_BYTES = 2 * 1024 * 1024;

interface AuditFixArgs {
  all: boolean;
  dryRun: boolean;
  itemSelectors: string[];
  json: boolean;
  paths: string[];
  reportPaths: string[];
  source?: AuditFixSource;
  yes: boolean;
}

interface FindingSelection {
  result: AuditItemResult;
  finding: AuditFinding;
}

function requestedAuditPath(
  snapshot: AuditSourceSnapshot,
  canonicalPath: string
): string {
  return (
    snapshot.requestedPaths.find(
      (entry) => entry.canonicalPath === canonicalPath
    )?.requestedPath ??
    snapshot.absentPaths.find((entry) => entry.path === canonicalPath)
      ?.requestedPath ??
    canonicalPath
  );
}

function normalizeRuleId(ruleId: string): string {
  return ruleId.replace(RULE_ID_PREFIX_RE, "");
}

function parseSource(value: string): AuditFixSource {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "static" ||
    normalized === "agent" ||
    normalized === "combined"
  ) {
    return normalized;
  }
  throw new Error(`Unknown audit fix source: ${value}`);
}

function parseAuditFixArgs(argv: string[]): AuditFixArgs {
  const args: AuditFixArgs = {
    all: false,
    dryRun: false,
    itemSelectors: [],
    json: false,
    paths: [],
    reportPaths: [],
    yes: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--all") {
      args.all = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      args.yes = true;
      continue;
    }
    if (
      arg === "--source" ||
      arg === "--item" ||
      arg === "--path" ||
      arg === "--report"
    ) {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--source") {
        args.source = parseSource(next);
      } else if (arg === "--item") {
        args.itemSelectors.push(next);
      } else if (arg === "--path") {
        args.paths.push(next);
      } else {
        args.reportPaths.push(next);
      }
      i += 1;
      continue;
    }

    if (
      arg.startsWith("--source=") ||
      arg.startsWith("--item=") ||
      arg.startsWith("--path=") ||
      arg.startsWith("--report=")
    ) {
      const [flag, rawValue] = arg.split(ARG_VALUE_SPLIT_RE, 2);
      const value = rawValue ?? "";
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === "--source") {
        args.source = parseSource(value);
      } else if (flag === "--item") {
        args.itemSelectors.push(value);
      } else if (flag === "--path") {
        args.paths.push(value);
      } else {
        args.reportPaths.push(value);
      }
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    args.itemSelectors.push(arg);
  }

  if (!args.all && args.itemSelectors.length === 0 && args.paths.length === 0) {
    throw new Error("Specify what to fix with --item, --path, or use --all.");
  }
  if (args.reportPaths.length === 0) {
    throw new Error(
      "audit fix requires --report <exact persisted report path>; legacy latest reports are not trusted"
    );
  }

  return args;
}

function parseInlineSecretLocation(args: {
  location: string;
  result: AuditItemResult;
}): {
  configPath: string;
  serverName: string;
  envKey: string;
} | null {
  const prefix = `${args.result.path}:${args.result.item}:env:`;
  if (!args.location.startsWith(prefix)) {
    return null;
  }
  const envKey = args.location.slice(prefix.length).trim();
  return envKey
    ? {
        configPath: args.result.path,
        envKey,
        serverName: args.result.item,
      }
    : null;
}

function findingKey(args: {
  result: AuditItemResult;
  finding: AuditFinding;
}): string {
  const parsed = args.finding.location
    ? parseInlineSecretLocation({
        location: args.finding.location,
        result: args.result,
      })
    : null;
  return [
    args.result.type,
    args.result.item,
    args.result.path,
    parsed?.serverName ?? "",
    parsed?.envKey ?? "",
    normalizeRuleId(args.finding.ruleId),
  ].join("\0");
}

function keyForResult(result: AuditItemResult): string {
  return `${result.type}\0${result.item}\0${result.path}`;
}

function prefixRuleId(
  finding: AuditFinding,
  prefix: "static" | "agent"
): AuditFinding {
  return finding.ruleId.startsWith(`${prefix}:`)
    ? finding
    : { ...finding, ruleId: `${prefix}:${finding.ruleId}` };
}

function uniqueByKey<T>(items: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) {
      continue;
    }
    seen.add(itemKey);
    out.push(item);
  }
  return out;
}

function mergeStaticAndAgentResults(args: {
  static: AuditItemResult[];
  agent: AuditItemResult[];
}): AuditItemResult[] {
  const byKey = new Map<
    string,
    { static?: AuditItemResult; agent?: AuditItemResult }
  >();

  for (const result of args.static) {
    const key = keyForResult(result);
    const previous = byKey.get(key) ?? {};
    byKey.set(key, { ...previous, static: result });
  }
  for (const result of args.agent) {
    const key = keyForResult(result);
    const previous = byKey.get(key) ?? {};
    byKey.set(key, { ...previous, agent: result });
  }

  const out: AuditItemResult[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const entry = byKey.get(key);
    if (!entry) {
      continue;
    }
    if (entry.static && entry.agent) {
      out.push({
        ...entry.agent,
        passed: entry.static.passed && entry.agent.passed,
        findings: [
          ...entry.agent.findings.map((finding) =>
            prefixRuleId(finding, "agent")
          ),
          ...entry.static.findings.map((finding) =>
            prefixRuleId(finding, "static")
          ),
        ],
      });
      continue;
    }
    out.push(entry.agent ?? entry.static!);
  }
  return out;
}

function matchesItemSelector(
  result: AuditItemResult,
  selector: string
): boolean {
  const normalized = selector.trim();
  if (!normalized) {
    return false;
  }
  const labels = [
    result.item,
    `${result.type}:${result.item}`,
    result.type === "mcp" ? `mcp:${result.item}` : null,
    basename(result.path),
  ].filter(Boolean) as string[];
  return labels.some(
    (label) => label.toLowerCase() === normalized.toLowerCase()
  );
}

function matchesPath(result: AuditItemResult, candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const path = result.path.toLowerCase();
  return path === normalized || path.endsWith(`/${normalized}`);
}

function matchesSelection(args: {
  result: AuditItemResult;
  filters: AuditFixArgs;
}): boolean {
  if (
    args.filters.itemSelectors.length > 0 &&
    !args.filters.itemSelectors.some((selector) =>
      matchesItemSelector(args.result, selector)
    )
  ) {
    return false;
  }

  if (
    args.filters.paths.length > 0 &&
    !args.filters.paths.some((candidate) => matchesPath(args.result, candidate))
  ) {
    return false;
  }

  return true;
}

function inferSource(args: {
  requested?: AuditFixSource;
  staticReport: StaticAuditReport | null;
  agentReport: AgentAuditReport | null;
}): AuditFixSource {
  if (args.requested) {
    return args.requested;
  }
  if (args.staticReport && args.agentReport) {
    return "combined";
  }
  if (args.agentReport) {
    return "agent";
  }
  return "static";
}

function selectFixableFindings(args: {
  results: AuditItemResult[];
  filters: AuditFixArgs;
}): FindingSelection[] {
  return uniqueByKey(
    args.results.flatMap((result) =>
      result.findings
        .filter(
          (finding) =>
            normalizeRuleId(finding.ruleId) === INLINE_SECRET_RULE_ID &&
            result.type === "mcp" &&
            matchesSelection({ result, filters: args.filters })
        )
        .map((finding) => ({ result, finding }))
    ),
    (selection) => findingKey(selection)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertOutsideGitWorktree(pathValue: string): void {
  let current = dirname(resolve(pathValue));
  while (true) {
    const marker = join(current, ".git");
    try {
      lstatSync(marker);
      throw new Error(
        "Audit fix destination must remain outside a Git worktree"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function transformBoundMcpConfigs(args: {
  bindings: AuditMcpRemediationBinding[];
  destinationContents: string | null;
  sourceContents: string;
}): { destinationContents: string; sourceContents: string } {
  const sourceRoot = parseJsonLenient(args.sourceContents);
  if (!isPlainObject(sourceRoot)) {
    throw new Error("Bound MCP source is not a JSON object");
  }
  const sourceServers = extractServersObject(sourceRoot);
  if (!sourceServers) {
    throw new Error("Bound MCP source has no servers object");
  }
  const destinationRoot: Record<string, unknown> = args.destinationContents
    ? (() => {
        const parsed = parseJsonLenient(args.destinationContents);
        if (!isPlainObject(parsed)) {
          throw new Error("Bound MCP destination is not a JSON object");
        }
        if (!extractServersObject(parsed)) {
          if (Object.keys(parsed).length === 0) {
            parsed.servers = {};
          } else {
            throw new Error("Bound MCP destination has no servers object");
          }
        }
        return parsed;
      })()
    : { servers: {} };
  const destinationServers = extractServersObject(destinationRoot)!;

  for (const binding of args.bindings) {
    const sourceServer = sourceServers[binding.serverName];
    if (!isPlainObject(sourceServer)) {
      throw new Error(
        `Bound MCP source server is missing: ${binding.serverName}`
      );
    }
    const sourceEnv = sourceServer.env;
    if (!isPlainObject(sourceEnv)) {
      throw new Error(`Bound MCP source env is missing: ${binding.serverName}`);
    }
    const secret = sourceEnv[binding.envKey];
    if (!isInlineMcpSecretValue(secret)) {
      throw new Error(
        `Bound MCP source secret changed: ${binding.serverName}:${binding.envKey}`
      );
    }

    const currentDestinationServer = destinationServers[binding.serverName];
    if (
      currentDestinationServer !== undefined &&
      !isPlainObject(currentDestinationServer)
    ) {
      throw new Error(
        `Bound MCP destination server is invalid: ${binding.serverName}`
      );
    }
    const destinationServer = currentDestinationServer ?? {};
    const currentDestinationEnv = destinationServer.env;
    if (
      currentDestinationEnv !== undefined &&
      !isPlainObject(currentDestinationEnv)
    ) {
      throw new Error(
        `Bound MCP destination env is invalid: ${binding.serverName}`
      );
    }
    if (
      currentDestinationEnv &&
      Object.hasOwn(currentDestinationEnv, binding.envKey) &&
      currentDestinationEnv[binding.envKey] !== secret
    ) {
      throw new Error(
        `Bound MCP destination secret conflicts: ${binding.serverName}:${binding.envKey}`
      );
    }
    destinationServer.env = {
      ...(currentDestinationEnv ?? {}),
      [binding.envKey]: secret,
    };
    destinationServers[binding.serverName] = destinationServer;
    Reflect.deleteProperty(sourceEnv, binding.envKey);
    if (Object.keys(sourceEnv).length === 0) {
      Reflect.deleteProperty(sourceServer, "env");
    }
  }

  return {
    destinationContents: `${JSON.stringify(destinationRoot, null, 2)}\n`,
    sourceContents: `${JSON.stringify(sourceRoot, null, 2)}\n`,
  };
}

function exactStaticBindings(args: {
  envelope: VerifiedAuditReportEnvelope<StaticAuditReport>;
  selections: FindingSelection[];
}): AuditMcpRemediationBinding[] {
  const byIdentity = new Map(
    args.envelope.receipt.remediationBindings.map((binding) => [
      binding.findingIdentity,
      binding,
    ])
  );
  const bindings = args.selections.map((selection) => {
    const identity = auditFindingIdentity(selection);
    const binding = byIdentity.get(identity);
    if (!binding) {
      throw new Error(
        "Selected finding has no exact report-authorized remediation binding"
      );
    }
    return binding;
  });
  const first = bindings[0];
  if (
    !first ||
    bindings.some(
      (binding) =>
        binding.canonicalRootPath !== first.canonicalRootPath ||
        binding.sourcePath !== first.sourcePath ||
        binding.destinationPath !== first.destinationPath
    )
  ) {
    throw new Error(
      "Selected findings do not share one exact bound MCP transaction"
    );
  }
  return bindings;
}

export async function runAuditFix(args: {
  /** @internal Adversarial test hook; production callers must not set this. */
  afterBoundOpen?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  afterReportValidation?: () => Promise<void>;
  argv: string[];
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeSourceCommit?: () => Promise<void>;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeSourceValidation?: () => Promise<void>;
  homeDir?: string;
  cwd?: string;
}): Promise<{
  fixed: number;
  localPath: string | null;
  matched: number;
  riskyManagedOutputs: { path: string; state: "tracked" | "untracked" }[];
  skipped: { label: string; reason: string }[];
  source: AuditFixSource;
  syncedTools: string[];
  trackedPath: string | null;
}> {
  const parsed = parseAuditFixArgs(args.argv);

  let staticReport: StaticAuditReport | null = null;
  let agentReport: AgentAuditReport | null = null;
  let staticEnvelope: VerifiedAuditReportEnvelope<StaticAuditReport> | null =
    null;
  for (const reportPath of parsed.reportPaths) {
    const envelope = await loadVerifiedAuditReportEnvelope<
      StaticAuditReport | AgentAuditReport
    >({
      beforeSourceValidation: args.beforeSourceValidation,
      reportPath,
    });
    const report = envelope.report;
    if (report.mode === "static") {
      if (staticReport) {
        throw new Error("Only one exact static audit report may be supplied");
      }
      staticReport = report;
      staticEnvelope =
        envelope as VerifiedAuditReportEnvelope<StaticAuditReport>;
    } else {
      if (agentReport) {
        throw new Error("Only one exact agent audit report may be supplied");
      }
      agentReport = report;
    }
  }

  const source = inferSource({
    requested: parsed.source,
    staticReport,
    agentReport,
  });
  if (
    (source === "static" && !staticReport) ||
    (source === "agent" && !agentReport) ||
    (source === "combined" && !(staticReport && agentReport))
  ) {
    throw new Error(`Exact report input does not satisfy --source ${source}`);
  }
  const reportResults =
    source === "static"
      ? (staticReport?.results ?? [])
      : source === "agent"
        ? (agentReport?.results ?? [])
        : mergeStaticAndAgentResults({
            static: staticReport?.results ?? [],
            agent: agentReport?.results ?? [],
          });

  const selections = selectFixableFindings({
    results: reportResults,
    filters: parsed,
  });
  if (selections.length === 0) {
    throw new Error(
      "No inline MCP secret findings matched the requested filters."
    );
  }

  if (parsed.dryRun) {
    return {
      fixed: 0,
      localPath: null,
      matched: selections.length,
      riskyManagedOutputs: [],
      skipped: [],
      source,
      syncedTools: [],
      trackedPath: null,
    };
  }
  if (!parsed.yes) {
    throw new Error("audit fix mutation requires explicit --yes approval");
  }
  if (source === "agent" || !staticReport || !staticEnvelope) {
    throw new Error(
      "Audit fix mutation requires an exact static report with remediation bindings"
    );
  }

  const staticSelections = selectFixableFindings({
    results: staticReport.results,
    filters: parsed,
  });
  if (staticSelections.length === 0) {
    throw new Error(
      "No exact static finding authorizes the requested MCP mutation"
    );
  }
  const bindings = exactStaticBindings({
    envelope: staticEnvelope,
    selections: staticSelections,
  });
  const firstBinding = bindings[0]!;
  assertOutsideGitWorktree(firstBinding.destinationPath);
  const snapshot = staticEnvelope.receipt.sourceSnapshot;
  const currentRoot = auditSnapshotCanonicalPath(
    snapshot,
    facultRootDir(args.homeDir ?? homedir())
  );
  if (currentRoot !== firstBinding.canonicalRootPath) {
    throw new Error(
      "Current audit fix scope does not match the report-authorized canonical root"
    );
  }

  const rootIdentity = snapshot.evaluatedDirectories.find(
    (identity) => identity.path === firstBinding.canonicalRootPath
  );
  const mcpRoot = dirname(firstBinding.sourcePath);
  const directoryIdentity = snapshot.evaluatedDirectories.find(
    (identity) => identity.path === mcpRoot
  );
  const sourceIdentity = snapshot.evaluatedFiles.find(
    (identity) => identity.path === firstBinding.sourcePath
  );
  const destinationIdentity =
    snapshot.evaluatedFiles.find(
      (identity) => identity.path === firstBinding.destinationPath
    ) ?? null;
  if (
    !(rootIdentity && directoryIdentity && sourceIdentity) ||
    mcpRoot !== join(firstBinding.canonicalRootPath, "mcp")
  ) {
    throw new Error("Audit remediation binding has incomplete object identity");
  }

  if (args.afterReportValidation) {
    await args.afterReportValidation();
  }
  const bound = openBoundPrivateSubdirectory({
    directoryIdentity,
    directoryName: "mcp",
    rootIdentity,
    rootPath: firstBinding.canonicalRootPath,
  });
  try {
    if (args.afterBoundOpen) {
      await args.afterBoundOpen();
    }
    await validateAuditSourceSnapshot(snapshot);
    await replaceBoundPrivateFilePairAt({
      assertCommitPolicy: () =>
        assertOutsideGitWorktree(firstBinding.destinationPath),
      beforeSourceCommit: args.beforeSourceCommit,
      destinationIdentity,
      destinationName: basename(firstBinding.destinationPath),
      directoryFd: bound.directoryFd,
      directoryIdentity,
      maxBytes: MAX_MCP_CONFIG_BYTES,
      rootFd: bound.rootFd,
      rootIdentity,
      rootPath: firstBinding.canonicalRootPath,
      sourceIdentity,
      sourceName: basename(firstBinding.sourcePath),
      transform: (sourceContents, destinationContents) =>
        transformBoundMcpConfigs({
          bindings,
          destinationContents,
          sourceContents,
        }),
    });
  } finally {
    closeSync(bound.directoryFd);
    closeSync(bound.rootFd);
  }

  return {
    fixed: bindings.length,
    localPath: requestedAuditPath(snapshot, firstBinding.destinationPath),
    matched: selections.length,
    riskyManagedOutputs: [],
    skipped: [],
    source,
    syncedTools: [],
    trackedPath: requestedAuditPath(snapshot, firstBinding.sourcePath),
  };
}

function printHelp() {
  console.log(`fclt audit fix — remediate exact report-authorized findings

Usage:
  fclt audit fix <item> --report <exact-report.json> --dry-run
  fclt audit fix --item <item> --report <exact-report.json> [--path <path>] [--source <static|agent|combined>] --yes
  fclt audit fix --all --report <exact-report.json> [--report <second-report.json>] [--source <static|agent|combined>] --yes

Notes:
  - Dry-run inspection remains available for exact persisted reports.
  - Mutation requires explicit --yes approval and an exact static remediation binding.
  - Source and destination objects remain descriptor-bound and are revalidated at commit.
  - Requires a fresh, content-hashed report-and-receipt envelope created by --report-root.
  - Legacy static-latest.json and agent-latest.json files never authorize mutation.
`);
}

export async function auditFixCommand(
  argv: string[],
  opts?: { cwd?: string; homeDir?: string }
) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  try {
    const result = await runAuditFix({
      argv,
      cwd: opts?.cwd,
      homeDir: opts?.homeDir,
    });

    if (argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      `Matched ${result.matched} inline MCP secret finding${result.matched === 1 ? "" : "s"} in the ${result.source} audit view.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
