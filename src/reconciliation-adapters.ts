import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveCliContextRoot } from "./cli-context";
import {
  facultAiStateDir,
  facultAiWritebackQueuePath,
  legacyFacultAiStateDirs,
  projectRootFromAiRoot,
} from "./paths";
import type {
  AdapterScanResult,
  EvidenceExportSourceConfig,
  FileSourceConfig,
  GitSourceConfig,
  ReconciliationAdapter,
  ReconciliationAdapterContext,
  ReconciliationSourceType,
  SignalClassification,
  SourceRecord,
  WritebackSourceConfig,
} from "./reconciliation-types";

const ISSUE_REF_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const WRITEBACK_REF_RE = /\bWB-\d{5}\b/g;
const ASSET_REF_RE =
  /(?:@(?:ai|project)\/[^\s)`\]}>"']+|(?:instructions|skills|agents|automations|snippets|mcp)\/[\w./-]+)/g;
const TRAILING_REF_PUNCTUATION_RE = /[.,;:!?]+$/;
const SECRET_VALUE_RE =
  /(bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s"']+/gi;
const JSON_SECRET_VALUE_RE =
  /("[^"]*(?:api[_-]?key|token|secret|password|authorization)[^"]*"\s*:\s*")[^"]*(")/gi;
const AUTHORIZATION_VALUE_RE =
  /\b(authorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s"']+/gi;
const SECRET_TOKEN_RE =
  /\b(?:sk[-_]|ghp_|github_pat_|lin_api_)[A-Za-z0-9_-]{12,}\b/g;
const AWS_ACCESS_KEY_RE =
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const PEM_PRIVATE_KEY_BEGIN_RE = /-----BEGIN ([^-\r\n]*PRIVATE KEY)-----/g;
const PEM_PRIVATE_KEY_MARKER_RE =
  /-----(?:BEGIN|END) [^-\r\n]*PRIVATE KEY-----/g;
const PEM_BLANK_LINE_RE = /\r?\n[\t ]*\r?\n/;
const PEM_HEADER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*:\s*\S.*$/;
const LINE_SPLIT_RE = /\r?\n/;
const PATH_SEGMENT_RE = /[\\/]/;
const MARKDOWN_SECTION_RE = /(?=^#{1,3}\s+)/m;
const MARKDOWN_HEADING_RE = /^#{1,3}\s+(.+)$/m;
const DATE_HEADING_RE = /^(\d{4}-\d{2}-\d{2})\b/;
const LOG_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/;
const UNBORN_GIT_RE =
  /does not have any commits yet|bad default revision 'HEAD'/i;
const ISSUE_CAPABILITY_RE =
  /capabilit|writeback|evolution|instruction|skill|agent|runbook|reconcil/;
const ISSUE_OUTCOME_RE = /proof|verified|released|deployed|completed/;
const FILE_RELEVANCE_RE =
  /capabilit|writeback|evolution|instruction|skill|runbook|verification|reconcil|outcome|signal/i;
const WHITESPACE_RE = /\s+/g;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 500;
const MAX_BODY_CHARS = 4000;
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/i;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function partialPrivateKeyEnd(value: string, bodyStart: number): number {
  const body = value.slice(bodyStart);
  const firstBoundary = PEM_BLANK_LINE_RE.exec(body);
  if (!firstBoundary) {
    return value.length;
  }
  const precedingLines = body
    .slice(0, firstBoundary.index)
    .split(LINE_SPLIT_RE)
    .map((line) => line.trim())
    .filter(Boolean);
  const boundaryEndsPemHeaders =
    precedingLines.length === 0 ||
    precedingLines.every((line) => PEM_HEADER_LINE_RE.test(line));
  if (!boundaryEndsPemHeaders) {
    return bodyStart + firstBoundary.index;
  }
  const keyBodyStart =
    bodyStart + firstBoundary.index + firstBoundary[0].length;
  const nextBoundary = PEM_BLANK_LINE_RE.exec(value.slice(keyBodyStart));
  return nextBoundary ? keyBodyStart + nextBoundary.index : value.length;
}

function redactPrivateKeyMaterial(value: string): string {
  let cursor = 0;
  let output = "";
  for (const match of value.matchAll(PEM_PRIVATE_KEY_BEGIN_RE)) {
    const beginIndex = match.index;
    if (beginIndex < cursor) {
      continue;
    }
    const label = match[1];
    if (!label) {
      continue;
    }
    const bodyStart = beginIndex + match[0].length;
    const endMarker = `-----END ${label}-----`;
    const endIndex = value.indexOf(endMarker, bodyStart);
    const redactionEnd =
      endIndex >= 0
        ? endIndex + endMarker.length
        : partialPrivateKeyEnd(value, bodyStart);
    output += `${value.slice(cursor, beginIndex)}<redacted-private-key>`;
    cursor = redactionEnd;
  }
  return output + value.slice(cursor);
}

export function redactReconciliationText(value: string): string {
  return redactPrivateKeyMaterial(value)
    .replace(PEM_PRIVATE_KEY_MARKER_RE, "<redacted-private-key>")
    .replace(URL_USERINFO_RE, "$1<redacted>@")
    .replace(JSON_SECRET_VALUE_RE, "$1<redacted>$2")
    .replace(AUTHORIZATION_VALUE_RE, "$1<redacted>")
    .replace(SECRET_VALUE_RE, "$1<redacted>")
    .replace(SECRET_TOKEN_RE, "<redacted-token>")
    .replace(AWS_ACCESS_KEY_RE, "<redacted-aws-access-key>")
    .replace(JWT_RE, "<redacted-jwt>")
    .slice(0, MAX_BODY_CHARS);
}

function safeEvidenceSourceUri(value?: string): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return redactReconciliationText(
      `${parsed.protocol}//${parsed.host}${parsed.pathname}`
    );
  } catch {
    return redactReconciliationText(value);
  }
}

function references(value: string): {
  assetRefs: string[];
  issueRefs: string[];
  writebackRefs: string[];
} {
  return {
    assetRefs: unique(
      (value.match(ASSET_REF_RE) ?? []).map((entry) =>
        entry.replace(TRAILING_REF_PUNCTUATION_RE, "")
      )
    ),
    issueRefs: unique(
      (value.match(ISSUE_REF_RE) ?? []).filter(
        (entry) => !(entry.startsWith("WB-") || entry.startsWith("EV-"))
      )
    ),
    writebackRefs: unique(value.match(WRITEBACK_REF_RE) ?? []),
  };
}

function inWindow(
  value: string,
  context: ReconciliationAdapterContext
): boolean {
  const observed = Date.parse(value);
  return (
    Number.isFinite(observed) &&
    observed >= Date.parse(context.window.since) &&
    observed <= Date.parse(context.window.until)
  );
}

function latestTimestamp(records: SourceRecord[]): string | undefined {
  return records.reduce<string | undefined>((latest, record) => {
    if (!latest || Date.parse(record.observedAt) > Date.parse(latest)) {
      return record.observedAt;
    }
    return latest;
  }, undefined);
}

function resultFromRecords(
  records: SourceRecord[],
  latestSourceAt?: string
): AdapterScanResult {
  const watermark = latestTimestamp(records);
  if (records.length > 0) {
    return {
      state: "changed",
      records,
      watermark,
      latestSourceAt: latestSourceAt ?? watermark,
    };
  }
  return { state: "checked", records, latestSourceAt };
}

function record(args: {
  context: ReconciliationAdapterContext;
  recordId: string;
  dedupeKey: string;
  observedAt: string;
  title: string;
  body: string;
  classification?: SignalClassification;
  provenance: SourceRecord["provenance"];
  extraRefs?: string[];
}): SourceRecord {
  const body = redactReconciliationText(args.body);
  const refs = references(
    `${args.title}\n${body}\n${(args.extraRefs ?? []).join(" ")}`
  );
  return {
    sourceId: args.context.config.id,
    sourceType: args.context.config.type,
    recordId: args.recordId,
    dedupeKey: args.dedupeKey,
    observedAt: args.observedAt,
    title: redactReconciliationText(args.title),
    body,
    classification: args.classification,
    ...refs,
    provenance: args.provenance,
  };
}

interface WritebackQueueRecord {
  id?: string;
  ts?: string;
  updatedAt?: string;
  summary?: string;
  kind?: string;
  assetRef?: string;
  suggestedDestination?: string;
  evidence?: Array<{ ref?: string }>;
  issueLinks?: string[];
  disposition?: string;
  dispositionTarget?: string;
  status?: string;
}

const writebackAdapter: ReconciliationAdapter = {
  type: "writebacks",
  version: 1,
  async scan(context): Promise<AdapterScanResult> {
    const config = context.config as WritebackSourceConfig;
    const sourceRoot =
      config.scope === "global"
        ? context.projectRoot
          ? resolveCliContextRoot({
              homeDir: context.homeDir,
              scope: "global",
            })
          : context.rootDir
        : context.rootDir;
    const scope = projectRootFromAiRoot(sourceRoot, context.homeDir)
      ? "project"
      : "global";
    const paths = [
      ...legacyFacultAiStateDirs(context.homeDir, sourceRoot).map((dir) =>
        join(dir, scope, "writeback", "queue.jsonl")
      ),
      join(
        facultAiStateDir(context.homeDir, sourceRoot),
        scope,
        "writeback",
        "queue.jsonl"
      ),
      facultAiWritebackQueuePath(context.homeDir, sourceRoot),
    ];
    const existingPaths = [
      ...new Set(
        (
          await Promise.all(
            paths.map(async (path) =>
              (await Bun.file(path).exists()) ? path : null
            )
          )
        ).filter((path): path is string => Boolean(path))
      ),
    ];
    if (existingPaths.length === 0) {
      return resultFromRecords([]);
    }
    const entriesById = new Map<string, WritebackQueueRecord[]>();
    const malformed: SourceRecord[] = [];
    let unreadablePaths = 0;
    for (const path of existingPaths) {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        unreadablePaths += 1;
        continue;
      }
      for (const [index, line] of text.split(LINE_SPLIT_RE).entries()) {
        if (!line.trim()) {
          continue;
        }
        try {
          const value: unknown = JSON.parse(line);
          if (!isPlainObject(value)) {
            throw new Error("record is not an object");
          }
          const parsed = value as WritebackQueueRecord;
          const timestamp = parsed.updatedAt ?? parsed.ts;
          if (
            typeof parsed.id !== "string" ||
            !parsed.id ||
            typeof timestamp !== "string" ||
            !Number.isFinite(Date.parse(timestamp))
          ) {
            throw new Error("record is missing a valid id or timestamp");
          }
          entriesById.set(parsed.id, [
            ...(entriesById.get(parsed.id) ?? []),
            parsed,
          ]);
        } catch {
          malformed.push(
            record({
              context,
              recordId: `malformed-line-${index + 1}`,
              dedupeKey: `writeback-malformed:${sha256(line)}`,
              observedAt: context.window.since,
              title: `Malformed writeback queue line ${index + 1}`,
              body: line,
              classification: "noise",
              provenance: { path, line: index + 1, parseError: true },
            })
          );
        }
      }
    }
    const records = [...entriesById.values()].flatMap((entries) => {
      const entry = entries
        .filter((candidate) => {
          const timestamp = candidate.updatedAt ?? candidate.ts;
          return (
            timestamp &&
            Date.parse(timestamp) <= Date.parse(context.window.until)
          );
        })
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt ?? right.ts ?? "") -
            Date.parse(left.updatedAt ?? left.ts ?? "")
        )[0];
      const observedAt = entry?.updatedAt ?? entry?.ts;
      if (!(entry?.id && observedAt && inWindow(observedAt, context))) {
        return [];
      }
      const terminal = ["resolved", "dismissed", "superseded"].includes(
        entry.status ?? ""
      );
      return [
        record({
          context,
          recordId: entry.id,
          dedupeKey: `writeback:${scope}:${entry.id}`,
          observedAt,
          title: entry.summary ?? entry.id,
          body: JSON.stringify({
            kind: entry.kind,
            status: entry.status,
            disposition: entry.disposition,
            dispositionTarget: entry.dispositionTarget,
          }),
          classification: terminal ? "noise" : "capability-source",
          provenance: {
            path: existingPaths,
            writebackId: entry.id,
            terminal,
            disposition: entry.disposition ?? null,
            dispositionTarget: entry.dispositionTarget ?? null,
            status: entry.status ?? null,
          },
          extraRefs: [
            entry.id,
            entry.assetRef ?? "",
            entry.suggestedDestination ?? "",
            ...(entry.evidence ?? []).map((item) => item.ref ?? ""),
            ...(entry.issueLinks ?? []),
          ],
        }),
      ];
    });
    records.push(...malformed);
    if (unreadablePaths > 0) {
      return {
        state: "unavailable",
        records,
        unavailableReason: `${unreadablePaths} writeback queue path(s) could not be read`,
      };
    }
    if (malformed.length > 0) {
      return {
        state: "unavailable",
        records,
        unavailableReason: `${malformed.length} malformed writeback queue line(s) prevented complete coverage`,
      };
    }
    return resultFromRecords(records);
  },
};

function safeGitEnvironment(projectRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) {
      env[name] = value;
    }
  }
  env.GIT_CEILING_DIRECTORIES = dirname(projectRoot);
  env.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: [Bun.which("git") ?? "/usr/bin/git", ...args],
    cwd,
    env: safeGitEnvironment(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
  return stdout;
}

async function gitRefExists(ref: string, cwd: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: [
      Bun.which("git") ?? "/usr/bin/git",
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ],
    cwd,
    env: safeGitEnvironment(cwd),
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function configuredDefaultBranch(args: {
  config: GitSourceConfig;
  projectRoot: string;
}): Promise<{ display: string; ref: string }> {
  if (args.config.defaultBranch) {
    const candidates = args.config.defaultBranch.startsWith("refs/")
      ? [args.config.defaultBranch]
      : [
          `refs/heads/${args.config.defaultBranch}`,
          `refs/remotes/origin/${args.config.defaultBranch}`,
        ];
    for (const ref of unique(candidates)) {
      if (await gitRefExists(ref, args.projectRoot)) {
        return { display: args.config.defaultBranch, ref };
      }
    }
    throw new Error(
      `Configured default Git branch is unavailable: ${args.config.defaultBranch}`
    );
  }
  for (const remote of ["origin", "upstream"]) {
    try {
      const ref = (
        await runGit(
          ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
          args.projectRoot
        )
      ).trim();
      if (ref && (await gitRefExists(ref, args.projectRoot))) {
        return { display: ref, ref };
      }
    } catch {
      // Fall through to bounded local defaults.
    }
  }
  for (const branch of ["main", "master"]) {
    const ref = `refs/heads/${branch}`;
    if (await gitRefExists(ref, args.projectRoot)) {
      return { display: branch, ref };
    }
  }
  if (!(await gitRefExists("HEAD", args.projectRoot))) {
    throw new Error("Git repository does not have any commits yet");
  }
  throw new Error(
    "Git default branch is unavailable; configure defaultBranch or provide a proven remote HEAD, main, or master"
  );
}

export async function gitDefaultBranchContainment(args: {
  commit: string;
  config: GitSourceConfig;
  projectRoot: string;
}): Promise<{ defaultBranch: string; onDefaultBranch: boolean }> {
  const defaultBranch = await configuredDefaultBranch({
    config: args.config,
    projectRoot: args.projectRoot,
  });
  return {
    defaultBranch: defaultBranch.display,
    onDefaultBranch: await gitIsAncestor({
      commit: args.commit,
      ancestorOf: defaultBranch.ref,
      projectRoot: args.projectRoot,
    }),
  };
}

export async function gitDefaultBranchContainments(args: {
  commits: string[];
  config: GitSourceConfig;
  projectRoot: string;
}): Promise<{
  defaultBranch: string;
  onDefaultBranch: Record<string, boolean>;
}> {
  const defaultBranch = await configuredDefaultBranch({
    config: args.config,
    projectRoot: args.projectRoot,
  });
  const candidates = unique(
    args.commits.filter((commit) => GIT_OBJECT_ID_RE.test(commit))
  );
  const reachable = new Set(
    (await runGit(["rev-list", defaultBranch.ref], args.projectRoot))
      .split(LINE_SPLIT_RE)
      .filter(Boolean)
  );
  return {
    defaultBranch: defaultBranch.display,
    onDefaultBranch: Object.fromEntries(
      candidates.map((commit) => [commit, reachable.has(commit)])
    ),
  };
}

async function gitIsAncestor(args: {
  commit: string;
  ancestorOf: string;
  projectRoot: string;
}): Promise<boolean> {
  if (!GIT_OBJECT_ID_RE.test(args.commit)) {
    return false;
  }
  const verify = Bun.spawn({
    cmd: [
      Bun.which("git") ?? "/usr/bin/git",
      "rev-parse",
      "--verify",
      "--quiet",
      `${args.commit}^{commit}`,
    ],
    cwd: args.projectRoot,
    env: safeGitEnvironment(args.projectRoot),
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await verify.exited) !== 0) {
    return false;
  }
  const proc = Bun.spawn({
    cmd: [
      Bun.which("git") ?? "/usr/bin/git",
      "merge-base",
      "--is-ancestor",
      args.commit,
      args.ancestorOf,
    ],
    cwd: args.projectRoot,
    env: safeGitEnvironment(args.projectRoot),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === 1) {
    return false;
  }
  throw new Error(stderr.trim() || "git merge-base containment check failed");
}

function parseGitRecords(args: {
  context: ReconciliationAdapterContext;
  config: GitSourceConfig;
  output: string;
  projectRoot: string;
}): Array<Omit<SourceRecord, "dedupeKey"> & { commit: string }> {
  const entries: Array<Omit<SourceRecord, "dedupeKey"> & { commit: string }> =
    [];
  for (const raw of args.output.split("\u001e")) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const [header = "", changes = ""] = trimmed.split("\0", 2);
    const [commit, observedAt, subject, body = ""] = header.split("\u001f");
    if (!(commit && observedAt && subject)) {
      continue;
    }
    const files = changes
      .split(LINE_SPLIT_RE)
      .map((line) => line.trim().split("\t"))
      .filter((parts) => parts.length >= 2)
      .map((parts) => (parts[0]?.startsWith("R") ? parts.at(-1) : parts[1]))
      .filter((pathValue): pathValue is string => Boolean(pathValue));
    const text = `${subject}\n${body}\n${files.join("\n")}`;
    const refs = references(text);
    entries.push({
      sourceId: args.context.config.id,
      sourceType: "git",
      recordId: commit,
      commit,
      observedAt,
      title: redactReconciliationText(subject),
      body: redactReconciliationText(`${body}\nChanged: ${files.join(", ")}`),
      ...refs,
      provenance: {
        repository: args.projectRoot,
        commit,
        files,
        allBranches: args.config.allBranches === true,
      },
    });
  }
  return entries;
}

const gitAdapter: ReconciliationAdapter = {
  type: "git",
  version: 1,
  async scan(context): Promise<AdapterScanResult> {
    const config = context.config as GitSourceConfig;
    const projectRoot = context.projectRoot;
    if (!projectRoot) {
      return {
        state: "unavailable",
        records: [],
        unavailableReason: "No project repository is available",
      };
    }
    try {
      const isRepo = (
        await runGit(["rev-parse", "--is-inside-work-tree"], projectRoot)
      ).trim();
      if (isRepo !== "true") {
        throw new Error("Configured project is not a Git worktree");
      }
      const defaultBranch = await configuredDefaultBranch({
        config,
        projectRoot,
      });
      const latestDefaultBranch = (
        await runGit(
          [
            "log",
            "-1",
            `--until=${context.window.until}`,
            "--format=%H%x1f%cI",
            defaultBranch.ref,
          ],
          projectRoot
        )
      ).trim();
      const [, latestSourceAt] = latestDefaultBranch.split("\u001f");
      const pathArgs = config.paths?.length ? ["--", ...config.paths] : [];
      let output: string;
      try {
        output = await runGit(
          [
            "log",
            ...(config.allBranches ? ["--all"] : [defaultBranch.ref]),
            `--since=${context.window.since}`,
            `--until=${context.window.until}`,
            "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x00",
            "--name-status",
            "--find-renames",
            ...pathArgs,
          ],
          projectRoot
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (UNBORN_GIT_RE.test(message)) {
          return resultFromRecords([]);
        }
        throw error;
      }
      const parsed = parseGitRecords({ context, config, output, projectRoot });
      const records: SourceRecord[] = [];
      for (const entry of parsed) {
        const patch = await runGit(
          [
            "show",
            "--format=",
            "--no-ext-diff",
            "--no-textconv",
            entry.commit,
            ...pathArgs,
          ],
          projectRoot
        );
        const onDefaultBranch = await gitIsAncestor({
          commit: entry.commit,
          ancestorOf: defaultBranch.ref,
          projectRoot,
        });
        const { commit: _commit, ...base } = entry;
        records.push({
          ...base,
          dedupeKey: `git-patch:${sha256(patch)}`,
          provenance: {
            ...base.provenance,
            defaultBranch: defaultBranch.display,
            onDefaultBranch,
            terminal: onDefaultBranch,
          },
        });
      }
      return resultFromRecords(records, latestSourceAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (UNBORN_GIT_RE.test(message)) {
        return resultFromRecords([]);
      }
      return {
        state: "unavailable",
        records: [],
        unavailableReason: message,
      };
    }
  },
};

type EvidenceEventKind = "work-item" | "comment" | "status-change";

interface EvidenceExportEvent {
  id: string;
  kind: EvidenceEventKind;
  observedAt: string;
  title?: string;
  body?: string;
  refs?: string[];
  terminal?: boolean;
  status?: string;
  sourceUri?: string;
}

interface EvidenceExportEnvelope {
  version: 1;
  producer: string;
  generatedAt: string;
  coverage: {
    since: string;
    until: string;
    complete: boolean;
    partialReasons?: string[];
  };
  cursor?: string;
  events: EvidenceExportEvent[];
}

const MAX_EVIDENCE_EVENTS = 1000;
const MAX_EVIDENCE_FIELD_LENGTH = 16_384;
const EVIDENCE_EVENT_KINDS = new Set<EvidenceEventKind>([
  "work-item",
  "comment",
  "status-change",
]);
const TERMINAL_EVIDENCE_STATUSES = new Set([
  "done",
  "completed",
  "complete",
  "canceled",
  "cancelled",
  "obsolete",
  "duplicate",
  "duplicated",
  "resolved",
  "closed",
  "superseded",
]);

function parseEvidenceExport(value: unknown): EvidenceExportEnvelope {
  if (!isPlainObject(value) || value.version !== 1) {
    throw new Error("Evidence export must be a version 1 object");
  }
  if (
    typeof value.producer !== "string" ||
    !value.producer.trim() ||
    value.producer.length > 200
  ) {
    throw new Error("Evidence export producer must be a bounded string");
  }
  if (
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt))
  ) {
    throw new Error("Evidence export generatedAt must be an ISO timestamp");
  }
  if (!isPlainObject(value.coverage)) {
    throw new Error("Evidence export coverage is required");
  }
  const { since, until, complete, partialReasons } = value.coverage;
  if (
    typeof since !== "string" ||
    typeof until !== "string" ||
    !Number.isFinite(Date.parse(since)) ||
    !Number.isFinite(Date.parse(until)) ||
    typeof complete !== "boolean"
  ) {
    throw new Error("Evidence export coverage window is invalid");
  }
  if (
    partialReasons !== undefined &&
    (!Array.isArray(partialReasons) ||
      partialReasons.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error("Evidence export partialReasons must be strings");
  }
  if (
    !Array.isArray(value.events) ||
    value.events.length > MAX_EVIDENCE_EVENTS
  ) {
    throw new Error(
      `Evidence export events must contain at most ${MAX_EVIDENCE_EVENTS} records`
    );
  }
  const seenIds = new Set<string>();
  const events = value.events.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`Evidence export event ${index + 1} must be an object`);
    }
    const {
      id,
      kind,
      observedAt,
      title,
      body,
      refs,
      terminal,
      status,
      sourceUri,
    } = entry;
    if (typeof id !== "string" || !id || id.length > 500 || seenIds.has(id)) {
      throw new Error(`Evidence export event ${index + 1} has an invalid id`);
    }
    seenIds.add(id);
    if (
      typeof kind !== "string" ||
      !EVIDENCE_EVENT_KINDS.has(kind as EvidenceEventKind)
    ) {
      throw new Error(`Evidence export event ${id} has an invalid kind`);
    }
    if (
      typeof observedAt !== "string" ||
      !Number.isFinite(Date.parse(observedAt))
    ) {
      throw new Error(`Evidence export event ${id} has an invalid observedAt`);
    }
    for (const [field, fieldValue] of [
      ["title", title],
      ["body", body],
      ["status", status],
      ["sourceUri", sourceUri],
    ] as const) {
      if (
        fieldValue !== undefined &&
        (typeof fieldValue !== "string" ||
          fieldValue.length > MAX_EVIDENCE_FIELD_LENGTH)
      ) {
        throw new Error(`Evidence export event ${id} has an invalid ${field}`);
      }
    }
    if (
      refs !== undefined &&
      (!Array.isArray(refs) ||
        refs.length > 100 ||
        refs.some((ref) => typeof ref !== "string" || !ref || ref.length > 500))
    ) {
      throw new Error(`Evidence export event ${id} has invalid refs`);
    }
    if (terminal !== undefined && typeof terminal !== "boolean") {
      throw new Error(`Evidence export event ${id} has invalid terminal state`);
    }
    return {
      id,
      kind: kind as EvidenceEventKind,
      observedAt,
      title: title as string | undefined,
      body: body as string | undefined,
      refs: refs as string[] | undefined,
      terminal: terminal as boolean | undefined,
      status: status as string | undefined,
      sourceUri: sourceUri as string | undefined,
    };
  });
  return {
    version: 1,
    producer: value.producer.trim(),
    generatedAt: value.generatedAt,
    coverage: {
      since,
      until,
      complete,
      partialReasons: partialReasons as string[] | undefined,
    },
    cursor: typeof value.cursor === "string" ? value.cursor : undefined,
    events,
  };
}

async function loadEvidenceExport(args: {
  config: EvidenceExportSourceConfig;
  context: ReconciliationAdapterContext;
}): Promise<EvidenceExportEnvelope> {
  if (isAbsolute(args.config.path) || args.config.path.includes("..")) {
    throw new Error(
      "Evidence export path must be relative to the project root"
    );
  }
  const base = args.context.projectRoot ?? args.context.rootDir;
  const baseReal = await realpath(base).catch(() => resolve(base));
  const exportReal = await realpath(resolve(base, args.config.path));
  const rel = relative(baseReal, exportReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Evidence export path resolves outside the project root");
  }
  const info = await stat(exportReal);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`Evidence export exceeds ${MAX_FILE_BYTES} bytes`);
  }
  return parseEvidenceExport(JSON.parse(await readFile(exportReal, "utf8")));
}

function evidenceClassification(
  event: EvidenceExportEvent
): SignalClassification {
  if (isTerminalEvidenceEvent(event)) {
    return "outcome-proof";
  }
  const text = `${event.title ?? ""} ${event.body ?? ""}`.toLowerCase();
  if (ISSUE_CAPABILITY_RE.test(text)) {
    return "capability-implementation";
  }
  if (ISSUE_OUTCOME_RE.test(text)) {
    return "outcome-proof";
  }
  return "implementation-only";
}

function isTerminalEvidenceEvent(event: EvidenceExportEvent): boolean {
  return (
    event.terminal === true ||
    (typeof event.status === "string" &&
      TERMINAL_EVIDENCE_STATUSES.has(event.status.trim().toLowerCase()))
  );
}

const evidenceExportAdapter: ReconciliationAdapter = {
  type: "evidence-export",
  version: 1,
  async scan(context): Promise<AdapterScanResult> {
    const config = context.config as EvidenceExportSourceConfig;
    try {
      const envelope = await loadEvidenceExport({ config, context });
      const coversWindow =
        Date.parse(envelope.coverage.since) <=
          Date.parse(context.window.since) &&
        Date.parse(envelope.coverage.until) >= Date.parse(context.window.until);
      const generatedAfterWindow =
        Date.parse(envelope.generatedAt) >= Date.parse(context.window.until);
      const records = envelope.events
        .filter((event) => inWindow(event.observedAt, context))
        .map((event) =>
          record({
            context,
            recordId: event.id,
            dedupeKey: `evidence-export:${envelope.producer}:${event.id}`,
            observedAt: event.observedAt,
            title: event.title ?? `${event.kind} ${event.id}`,
            body: event.body ?? "",
            classification: evidenceClassification(event),
            provenance: {
              producer: envelope.producer,
              generatedAt: envelope.generatedAt,
              kind: event.kind,
              status: event.status ?? null,
              terminal: isTerminalEvidenceEvent(event),
              sourceUri: safeEvidenceSourceUri(event.sourceUri),
            },
            extraRefs: event.refs ?? [],
          })
        );
      if (
        !(envelope.coverage.complete && coversWindow && generatedAfterWindow)
      ) {
        return {
          state: "unavailable",
          records,
          unavailableReason:
            envelope.coverage.partialReasons
              ?.map((reason) => redactReconciliationText(reason))
              .join("; ") ||
            "Evidence export does not prove complete coverage for the requested window",
        };
      }
      const result = resultFromRecords(records);
      result.cursor = envelope.cursor ?? result.cursor;
      return result;
    } catch (error) {
      return {
        state: "unavailable",
        records: [],
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
  },
};

function safeFileRoot(
  context: ReconciliationAdapterContext,
  config: FileSourceConfig
): string | null {
  if (config.root === "home") {
    return context.homeDir;
  }
  return context.projectRoot;
}

function validateGlob(pattern: string): void {
  if (
    isAbsolute(pattern) ||
    pattern.split(PATH_SEGMENT_RE).includes("..") ||
    pattern.includes("\0")
  ) {
    throw new Error(`Unsafe reconciliation path pattern: ${pattern}`);
  }
}

function splitTextRecords(
  text: string,
  path: string
): Array<{
  id: string;
  title: string;
  body: string;
  observedAt?: string;
  timestampMissing?: boolean;
}> {
  if (path.endsWith(".jsonl") || path.endsWith(".log")) {
    return text
      .split(LINE_SPLIT_RE)
      .map((body, index) => {
        let observedAt = body.match(LOG_TIMESTAMP_RE)?.[0];
        if (path.endsWith(".jsonl")) {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const value = [
              parsed.updatedAt,
              parsed.createdAt,
              parsed.ts,
              parsed.timestamp,
              parsed.startedAt,
              parsed.completedAt,
            ].find(
              (candidate): candidate is string =>
                typeof candidate === "string" &&
                Number.isFinite(Date.parse(candidate))
            );
            observedAt = value ?? observedAt;
          } catch {
            // Malformed JSONL remains an undated extraction decision below.
          }
        }
        return {
          id: `line-${index + 1}`,
          title: `${path}:${index + 1}`,
          body,
          observedAt,
          timestampMissing: !observedAt,
        };
      })
      .filter((entry) => entry.body.trim());
  }
  const sections = text
    .split(MARKDOWN_SECTION_RE)
    .filter((entry) => entry.trim());
  const mapped = sections.map((body, index) => {
    const heading = body.match(MARKDOWN_HEADING_RE)?.[1]?.trim();
    const headingDate = heading?.match(DATE_HEADING_RE)?.[1];
    return {
      id: `section-${index + 1}`,
      title: heading ?? `${path} section ${index + 1}`,
      body,
      observedAt: headingDate ? `${headingDate}T12:00:00.000Z` : undefined,
    };
  });
  if (!mapped.some((entry) => entry.observedAt)) {
    return mapped;
  }
  return mapped.filter(
    (entry) =>
      entry.observedAt || entry.body.replace(MARKDOWN_HEADING_RE, "").trim()
  );
}

function fileAdapter(type: "automation" | "markdown"): ReconciliationAdapter {
  return {
    type,
    version: 1,
    async scan(context): Promise<AdapterScanResult> {
      const config = context.config as FileSourceConfig;
      const root = safeFileRoot(context, config);
      if (!root) {
        return {
          state: "unavailable",
          records: [],
          unavailableReason: `No ${config.root ?? "project"} root is available`,
        };
      }
      try {
        const paths = new Set<string>();
        let truncated = false;
        for (const pattern of config.paths) {
          if (truncated) {
            break;
          }
          validateGlob(pattern);
          const glob = new Bun.Glob(pattern);
          for await (const path of glob.scan({
            cwd: root,
            onlyFiles: true,
            dot: true,
          })) {
            if (paths.has(path)) {
              continue;
            }
            if (paths.size >= MAX_FILES) {
              truncated = true;
              break;
            }
            paths.add(path);
          }
        }
        if (paths.size === 0) {
          return {
            state: "unavailable",
            records: [],
            unavailableReason: "No configured files matched this source",
          };
        }
        const records: SourceRecord[] = [];
        const contentDigests: string[] = [];
        let missingTimestamps = 0;
        let skippedFiles = 0;
        let latestMtime = 0;
        let latestObserved = 0;
        for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
          const rootReal = await realpath(root).catch(() => resolve(root));
          const absolutePath = await realpath(resolve(root, path));
          const rel = relative(rootReal, absolutePath);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            skippedFiles += 1;
            continue;
          }
          const info = await stat(absolutePath);
          latestMtime = Math.max(latestMtime, info.mtimeMs);
          if (info.size > MAX_FILE_BYTES) {
            skippedFiles += 1;
            continue;
          }
          const text = await readFile(absolutePath, "utf8");
          contentDigests.push(`${path}:${sha256(text)}`);
          if (text.includes("\0")) {
            skippedFiles += 1;
            continue;
          }
          for (const fragment of splitTextRecords(text, path)) {
            if (type === "automation" && fragment.timestampMissing) {
              missingTimestamps += 1;
              records.push(
                record({
                  context,
                  recordId: `${path}#${fragment.id}`,
                  dedupeKey: `${type}-undated:${sha256(fragment.body)}`,
                  observedAt: context.window.since,
                  title: fragment.title,
                  body: fragment.body,
                  classification: "noise",
                  provenance: {
                    path,
                    root: config.root ?? "project",
                    bytes: info.size,
                    timestampMissing: true,
                  },
                })
              );
              continue;
            }
            const observedAt = fragment.observedAt ?? info.mtime.toISOString();
            if (!inWindow(observedAt, context)) {
              continue;
            }
            latestObserved = Math.max(latestObserved, Date.parse(observedAt));
            const fragmentRefs = references(fragment.body);
            const looksRelevant =
              fragmentRefs.issueRefs.length > 0 ||
              fragmentRefs.writebackRefs.length > 0 ||
              fragmentRefs.assetRefs.length > 0 ||
              FILE_RELEVANCE_RE.test(fragment.body);
            records.push(
              record({
                context,
                recordId: `${path}#${fragment.id}`,
                dedupeKey: `${type}-content:${sha256(fragment.body.replace(WHITESPACE_RE, " ").trim())}`,
                observedAt,
                title: fragment.title,
                body: fragment.body,
                classification: looksRelevant ? "capability-source" : "noise",
                provenance: {
                  path,
                  root: config.root ?? "project",
                  bytes: info.size,
                },
              })
            );
          }
        }
        const latestSourceAt =
          Math.max(latestMtime, latestObserved) > 0
            ? new Date(Math.max(latestMtime, latestObserved)).toISOString()
            : undefined;
        const cursor = sha256(contentDigests.sort().join("\n"));
        if (missingTimestamps > 0) {
          return {
            state: "unavailable",
            records,
            cursor,
            unavailableReason: `${missingTimestamps} automation record(s) lacked a parseable timestamp`,
          };
        }
        if (truncated) {
          return {
            state: "stale",
            records,
            cursor,
            staleReason: `File scan truncated at the ${MAX_FILES}-file safety cap`,
            latestSourceAt,
          };
        }
        if (skippedFiles > 0) {
          return {
            state: "unavailable",
            records,
            cursor,
            unavailableReason: `${skippedFiles} configured file(s) could not be safely extracted`,
          };
        }
        return { ...resultFromRecords(records, latestSourceAt), cursor };
      } catch (error) {
        return {
          state: "unavailable",
          records: [],
          unavailableReason:
            error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

const adapters = new Map<ReconciliationSourceType, ReconciliationAdapter>([
  [writebackAdapter.type, writebackAdapter],
  [gitAdapter.type, gitAdapter],
  [evidenceExportAdapter.type, evidenceExportAdapter],
  ["automation", fileAdapter("automation")],
  ["markdown", fileAdapter("markdown")],
]);

export function reconciliationAdapterFor(
  type: ReconciliationSourceType
): ReconciliationAdapter {
  const adapter = adapters.get(type);
  if (!adapter) {
    throw new Error(`No reconciliation adapter registered for ${type}`);
  }
  return adapter;
}
