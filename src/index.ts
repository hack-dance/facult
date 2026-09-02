#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityScopeMode,
  parseCliContextArgs,
  resolveCliContextRoot,
  resolveCliContextScope,
} from "./cli-context";
import {
  renderBadge,
  renderBullets,
  renderCatalog,
  renderCode,
  renderJsonBlock,
  renderKeyValue,
  renderPage,
  renderTable,
} from "./cli-ui";
import type { AssetScope, AssetSourceKind } from "./graph";
import {
  graphDependencies,
  graphDependents,
  loadGraph,
  resolveGraphNode,
} from "./graph-query";
import type {
  AgentEntry,
  AutomationEntry,
  FacultIndex,
  InstructionEntry,
  McpEntry,
  SkillEntry,
  SnippetEntry,
} from "./index-builder";
import { withFacultRootScope } from "./paths";
import type { QueryFilters } from "./query";
import {
  filterAgents,
  filterInstructions,
  filterMcp,
  filterSkills,
  filterSnippets,
  findCapabilities,
  loadIndex,
} from "./query";
import { parseJsonLenient } from "./util/json";

type ListKind =
  | "skills"
  | "mcp"
  | "agents"
  | "automations"
  | "snippets"
  | "instructions";

const LIST_KINDS: ListKind[] = [
  "skills",
  "mcp",
  "agents",
  "automations",
  "snippets",
  "instructions",
];

export interface ListCommandOptions {
  kind: ListKind;
  filters: QueryFilters;
  json: boolean;
}

export interface FindCommandOptions {
  text: string;
  json: boolean;
}

type GraphCommandKind = "show" | "deps" | "dependents";
type ShowKind = ListKind | "mcp";

interface ContextualCommandOptions {
  rootArg?: string;
  scopeMode: CapabilityScopeMode;
  sourceKind?: AssetSourceKind;
}

interface GraphCommandOptions {
  kind: GraphCommandKind;
  target: string;
  json: boolean;
}

function printHelp() {
  console.log(
    renderPage({
      title: "fclt",
      subtitle:
        "Manage canonical AI capability, rendered tool surfaces, and evolution state.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            `${renderCode("fclt list")} defaults to ${renderCode("skills")} when you do not specify a type.`,
            `${renderCode("fclt graph <asset>")} is shorthand for ${renderCode("fclt graph show <asset>")}.`,
            `${renderCode("fclt templates init ...")} is the main entry for scaffolding new canonical capability.`,
          ]),
        },
        {
          title: "Core Commands",
          lines: renderTable({
            headers: ["Command", "Purpose"],
            rows: [
              ["scan", "Scan local tool configs and discovered assets"],
              [
                "inventory",
                "Print a JSON inventory of usable skills, instructions, and MCP servers",
              ],
              [
                "status",
                "Show active roots, managed tools, graph/index, and sync risks",
              ],
              ["paths", "Show canonical, generated, runtime, and review paths"],
              ["protocol", "Report the CLI/plugin compatibility contract"],
              [
                "audit",
                "Run security audits with interactive or scripted flows",
              ],
              [
                "consolidate",
                "Import existing skills and MCP configs into canonical state",
              ],
              ["index", "Rebuild the generated capability index"],
              [
                "list",
                "List indexed skills, MCP, agents, snippets, or instructions",
              ],
              ["show", "Inspect one indexed asset and its source contents"],
              ["find", "Search indexed capability across asset types"],
              ["graph", "Inspect capability graph nodes, deps, and dependents"],
              [
                "templates",
                "Scaffold skills, MCP, agents, snippets, and automations",
              ],
              ["search/install/update", "Work with remote capability indices"],
              ["manage/sync", "Preview deprecated broad managed-mode output"],
              ["deploy plan", "Build one immutable per-asset deployment plan"],
              [
                "project plan/render",
                "Compile, check, apply, or roll back a hermetic project tree",
              ],
              [
                "setup",
                "Install narrow agent integrations without full managed mode",
              ],
              [
                "projects/project",
                "Discover repositories and preview/apply minimal project enrollment",
              ],
              ["ai", "Capture writeback and evolve canonical assets"],
            ],
          }),
        },
        {
          title: "Common Options",
          lines: renderTable({
            headers: ["Option", "Meaning"],
            rows: [
              [
                "--json",
                "Machine-readable output instead of formatted terminal UI",
              ],
              ["--dry-run", "Show intended writes without mutating files"],
              [
                "--root / --global / --project",
                "Pick the canonical root explicitly",
              ],
              [
                "--scope / --source",
                "Narrow merged views by scope or provenance",
              ],
              [
                "--non-interactive / --yes",
                "Suppress prompts where the command supports inferred defaults",
              ],
            ],
          }),
        },
        {
          title: "Examples",
          lines: renderBullets([
            renderCode("fclt list"),
            renderCode("fclt graph skills:capability-evolution"),
            renderCode("fclt templates init skill review-checklist"),
            renderCode("fclt templates init agent writeback-curator"),
          ]),
        },
      ],
    })
  );
}

function printListHelp() {
  console.log(
    renderPage({
      title: "fclt list",
      subtitle: "List indexed entries from the canonical store.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode(
              "fclt list [skills|mcp|agents|automations|snippets|instructions] [options]"
            ),
            renderCode("fclt list"),
          ]),
        },
        {
          title: "Options",
          lines: renderTable({
            headers: ["Option", "Meaning"],
            rows: [
              [
                "--enabled-for TOOL",
                "Only include entries enabled for one tool",
              ],
              ["--untrusted", "Only include entries without trust approval"],
              ["--flagged", "Only include entries flagged by audit"],
              ["--pending", "Only include entries still pending audit"],
              ["--root / --global / --project", "Choose the canonical root"],
              ["--scope", "merged, global, or project"],
              ["--source", "builtin, global, or project provenance"],
              ["--json", "Print the raw JSON array"],
            ],
          }),
        },
      ],
    })
  );
}

function printShowHelp() {
  console.log(
    renderPage({
      title: "fclt show",
      subtitle: "Inspect one indexed entry and the source file behind it.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode("fclt show <name>"),
            renderCode("fclt show mcp:<name> [--show-secrets]"),
            renderCode("fclt show instruction:<name>"),
          ]),
        },
        {
          title: "Options",
          lines: renderTable({
            headers: ["Option", "Meaning"],
            rows: [
              [
                "--show-secrets",
                "For MCP configs, print raw secrets instead of redacting",
              ],
              ["--root / --global / --project", "Choose the canonical root"],
              ["--scope", "merged, global, or project"],
              ["--source", "builtin, global, or project provenance"],
            ],
          }),
        },
      ],
    })
  );
}

function printFindHelp() {
  console.log(
    renderPage({
      title: "fclt find",
      subtitle:
        "Search indexed capability across skills, MCP, agents, snippets, and instructions.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([renderCode("fclt find <query> [--json]")]),
        },
        {
          title: "Options",
          lines: renderTable({
            headers: ["Option", "Meaning"],
            rows: [
              ["--root / --global / --project", "Choose the canonical root"],
              ["--scope", "merged, global, or project"],
              ["--source", "builtin, global, or project provenance"],
              ["--json", "Print the raw JSON array"],
            ],
          }),
        },
      ],
    })
  );
}

function printGraphHelp() {
  console.log(
    renderPage({
      title: "fclt graph",
      subtitle: "Inspect explicit capability graph nodes and relations.",
      sections: [
        {
          title: "Usage",
          lines: renderBullets([
            renderCode("fclt graph <asset> [--json]"),
            renderCode("fclt graph show <asset> [--json]"),
            renderCode("fclt graph deps <asset> [--json]"),
            renderCode("fclt graph dependents <asset> [--json]"),
          ]),
        },
        {
          title: "Notes",
          lines: renderBullets([
            `${renderCode("fclt graph <asset>")} defaults to ${renderCode("show")}.`,
            "Selectors can be canonical refs, names, or graph node ids.",
          ]),
        },
        {
          title: "Options",
          lines: renderTable({
            headers: ["Option", "Meaning"],
            rows: [
              ["--root / --global / --project", "Choose the canonical root"],
              ["--scope", "merged, global, or project"],
              ["--source", "builtin, global, or project provenance"],
              ["--json", "Print raw graph JSON"],
            ],
          }),
        },
      ],
    })
  );
}

function parseListKind(argv: string[]): { kind: ListKind; startIndex: number } {
  const first = argv[0];
  if (!first || first.startsWith("-")) {
    return { kind: "skills", startIndex: 0 };
  }
  if (LIST_KINDS.includes(first as ListKind)) {
    return { kind: first as ListKind, startIndex: 1 };
  }
  throw new Error(`Unknown list type: ${first}`);
}

function parseEnabledForArg(
  arg: string,
  nextArg?: string
): { tool: string; advance: number } | null {
  if (arg === "--enabled-for") {
    if (!nextArg) {
      throw new Error("--enabled-for requires a tool name");
    }
    return { tool: nextArg, advance: 1 };
  }
  if (arg.startsWith("--enabled-for=")) {
    const tool = arg.slice("--enabled-for=".length);
    if (!tool) {
      throw new Error("--enabled-for requires a tool name");
    }
    return { tool, advance: 0 };
  }
  return null;
}

export function parseListArgs(argv: string[]): ListCommandOptions {
  const { kind, startIndex } = parseListKind(argv);
  const filters: QueryFilters = {};
  let json = false;

  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--untrusted") {
      filters.untrusted = true;
      continue;
    }
    if (arg === "--flagged") {
      filters.flagged = true;
      continue;
    }
    if (arg === "--pending") {
      filters.pending = true;
      continue;
    }

    const enabledFor = parseEnabledForArg(arg, argv[i + 1]);
    if (enabledFor) {
      filters.enabledFor = enabledFor.tool;
      i += enabledFor.advance;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { kind, filters, json };
}

export function parseFindArgs(argv: string[]): FindCommandOptions {
  let json = false;
  const terms: string[] = [];

  for (const arg of argv) {
    if (!arg) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    terms.push(arg);
  }

  const text = terms.join(" ").trim();
  if (!text) {
    throw new Error("find requires a query");
  }

  return { text, json };
}

export function parseGraphArgs(argv: string[]): GraphCommandOptions {
  const [first, ...rest] = argv;
  const hasExplicitKind =
    first === "show" || first === "deps" || first === "dependents";
  const kind: GraphCommandKind = hasExplicitKind ? first : "show";
  const args = hasExplicitKind ? rest : argv;

  let json = false;
  let target: string | null = null;
  for (const arg of args) {
    if (!arg) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (target) {
      throw new Error(`graph ${kind} accepts a single asset selector`);
    }
    target = arg;
  }

  if (!target) {
    throw new Error(`graph ${kind} requires an asset selector`);
  }

  return { kind, target, json };
}

function scopeFilterForMode(
  scopeMode: CapabilityScopeMode
): AssetScope | undefined {
  return scopeMode === "project" ? "project" : undefined;
}

function sourceLabel(entry: { sourceKind?: string; scope?: string }): string {
  const source = entry.sourceKind?.trim();
  const scope = entry.scope?.trim();
  if (source && scope) {
    return `${source}/${scope}`;
  }
  return source ?? scope ?? "merged";
}

function describeFilters(filters: QueryFilters): string {
  const parts: string[] = [];

  if (filters.enabledFor) {
    parts.push(`enabled for ${filters.enabledFor}`);
  }
  if (filters.untrusted) {
    parts.push("untrusted only");
  }
  if (filters.flagged) {
    parts.push("flagged only");
  }
  if (filters.pending) {
    parts.push("pending only");
  }
  if (filters.sourceKind) {
    parts.push(`source ${filters.sourceKind}`);
  }
  if (filters.scope) {
    parts.push(`scope ${filters.scope}`);
  }

  return parts.join(" • ");
}

function trustBadge(trusted?: boolean): string {
  return trusted
    ? renderBadge("trusted", "success")
    : renderBadge("untrusted", "warn");
}

function auditBadge(status?: string): string {
  const normalized = (status ?? "pending").trim().toLowerCase();
  if (normalized === "passed") {
    return renderBadge("audit passed", "success");
  }
  if (normalized === "flagged") {
    return renderBadge("audit flagged", "danger");
  }
  return renderBadge("audit pending", "warn");
}

function showKindForToken(token: string): ShowKind | null {
  switch (token) {
    case "agent":
    case "agents":
      return "agents";
    case "automation":
    case "automations":
      return "automations";
    case "instruction":
    case "instructions":
      return "instructions";
    case "mcp":
    case "mcp-server":
    case "mcp-servers":
      return "mcp";
    case "skill":
    case "skills":
      return "skills";
    case "snippet":
    case "snippets":
      return "snippets";
    default:
      return null;
  }
}

function displayDescription(value?: string): string {
  const normalized = value
    ?.trim()
    .replaceAll('\\"', '"')
    .replace(INLINE_NAME_DESCRIPTION_RE, "");
  if (!normalized || normalized === ">") {
    return "No description.";
  }
  return normalized;
}

function resolveContextualOptions(
  argv: string[],
  opts?: { allowSource?: boolean }
): { argv: string[]; context: ContextualCommandOptions } {
  const parsed = parseCliContextArgs(argv, {
    allowSource: opts?.allowSource,
  });
  return {
    argv: parsed.argv,
    context: {
      rootArg: parsed.rootArg,
      scopeMode: parsed.scope,
      sourceKind: parsed.sourceKind,
    },
  };
}

async function withContextualCommandScope<T>(
  context: ContextualCommandOptions,
  operation: (rootDir: string) => Promise<T>
): Promise<T> {
  const homeDir = process.env.HOME?.trim() || homedir();
  const rootDir = resolveCliContextRoot({
    homeDir,
    rootArg: context.rootArg,
    scope: context.scopeMode,
    cwd: process.cwd(),
  });
  const scope = resolveCliContextScope({
    homeDir,
    rootDir,
    scope: context.scopeMode,
  });
  return await withFacultRootScope({ rootDir, scope }, async () =>
    operation(rootDir)
  );
}

async function listCommand(argv: string[]) {
  const { argv: contextualArgv, context } = resolveContextualOptions(argv, {
    allowSource: true,
  });

  if (
    contextualArgv.includes("--help") ||
    contextualArgv.includes("-h") ||
    contextualArgv[0] === "help"
  ) {
    printListHelp();
    return;
  }

  let opts: ListCommandOptions;
  try {
    opts = parseListArgs(contextualArgv);
    if (context.sourceKind) {
      opts.filters.sourceKind = context.sourceKind;
    }
    const scopeFilter = scopeFilterForMode(context.scopeMode);
    if (scopeFilter) {
      opts.filters.scope = scopeFilter;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let index: FacultIndex;
  try {
    index = await withContextualCommandScope(context, async (rootDir) =>
      loadIndex({ rootDir })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let entries:
    | SkillEntry[]
    | McpEntry[]
    | AgentEntry[]
    | AutomationEntry[]
    | SnippetEntry[]
    | InstructionEntry[] = [];

  switch (opts.kind) {
    case "skills":
      entries = filterSkills(index.skills, opts.filters);
      break;
    case "mcp":
      entries = filterMcp(index.mcp?.servers ?? {}, opts.filters);
      break;
    case "agents":
      entries = filterAgents(index.agents ?? {}, opts.filters);
      break;
    case "automations":
      entries = Object.values(index.automations ?? {}).filter((entry) => {
        if (
          opts.filters.sourceKind &&
          entry.sourceKind !== opts.filters.sourceKind
        ) {
          return false;
        }
        if (opts.filters.scope && entry.scope !== opts.filters.scope) {
          return false;
        }
        return true;
      });
      break;
    case "snippets":
      entries = filterSnippets(index.snippets ?? {}, opts.filters);
      break;
    case "instructions":
      entries = filterInstructions(index.instructions ?? {}, opts.filters);
      break;
    default:
      entries = [];
      break;
  }

  if (opts.json) {
    console.log(`${JSON.stringify(entries, null, 2)}`);
    return;
  }

  if (entries.length === 0) {
    console.log(
      renderPage({
        title: `fclt list ${opts.kind}`,
        subtitle: "No matching entries.",
        sections: [
          {
            title: "Next Steps",
            lines: renderBullets([
              renderCode("fclt index --force"),
              renderCode("fclt templates list"),
            ]),
          },
        ],
        footer: describeFilters(opts.filters)
          ? [describeFilters(opts.filters)]
          : undefined,
      })
    );
    return;
  }

  const items = entries.map((entry) => {
    if (opts.kind === "skills") {
      const skill = entry as SkillEntry;
      return {
        title: skill.name,
        meta: sourceLabel(skill),
        badges: [trustBadge(skill.trusted), auditBadge(skill.auditStatus)],
        description: displayDescription(skill.description),
      };
    }

    if (opts.kind === "mcp") {
      const server = entry as McpEntry;
      return {
        title: server.name,
        meta: sourceLabel(server),
        badges: [trustBadge(server.trusted), auditBadge(server.auditStatus)],
        description:
          Array.isArray(server.enabledFor) && server.enabledFor.length > 0
            ? `Enabled for ${server.enabledFor.join(", ")}.`
            : "No enabled-for restrictions recorded.",
      };
    }

    const detailEntry = entry as
      | AgentEntry
      | AutomationEntry
      | SnippetEntry
      | InstructionEntry;
    return {
      title: entry.name,
      meta: sourceLabel(entry),
      description: displayDescription(
        "description" in detailEntry ? detailEntry.description : undefined
      ),
    };
  });

  console.log(
    renderPage({
      title: `fclt list ${opts.kind}`,
      subtitle: `${entries.length} matching entr${entries.length === 1 ? "y" : "ies"}`,
      sections: [{ title: "Entries", lines: renderCatalog(items) }],
      footer: describeFilters(opts.filters)
        ? [describeFilters(opts.filters)]
        : undefined,
    })
  );
}

async function readEntryContents(entryPath: string): Promise<string> {
  const file = Bun.file(entryPath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${entryPath}`);
  }
  return file.text();
}

async function findCommand(argv: string[]) {
  const { argv: contextualArgv, context } = resolveContextualOptions(argv, {
    allowSource: true,
  });

  if (
    contextualArgv.includes("--help") ||
    contextualArgv.includes("-h") ||
    contextualArgv[0] === "help"
  ) {
    printFindHelp();
    return;
  }

  let opts: FindCommandOptions;
  try {
    opts = parseFindArgs(contextualArgv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let index: FacultIndex;
  try {
    index = await withContextualCommandScope(context, async (rootDir) =>
      loadIndex({ rootDir })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const matches = findCapabilities(index, {
    text: opts.text,
    sourceKind: context.sourceKind,
    scope: scopeFilterForMode(context.scopeMode),
  });
  if (opts.json) {
    console.log(`${JSON.stringify(matches, null, 2)}`);
    return;
  }

  if (matches.length === 0) {
    console.log(
      renderPage({
        title: "fclt find",
        subtitle: `No matches for "${opts.text}".`,
        sections: [
          {
            title: "Try",
            lines: renderBullets([
              renderCode("fclt list"),
              renderCode("fclt index --force"),
            ]),
          },
        ],
      })
    );
    return;
  }

  console.log(
    renderPage({
      title: "fclt find",
      subtitle: `${matches.length} match${matches.length === 1 ? "" : "es"} for "${opts.text}"`,
      sections: [
        {
          title: "Results",
          lines: renderCatalog(
            matches.map((entry) => ({
              title: `${entry.kind}:${entry.name}`,
              meta: sourceLabel(entry),
              description: displayDescription(entry.description),
            }))
          ),
        },
      ],
    })
  );
}

const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)/i;
const SECRETY_STRING_RE =
  /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;
const INLINE_NAME_DESCRIPTION_RE = /^name:\s+\S+\s+description:\s*/i;
const TRAILING_NEWLINE_RE = /\n$/;

function redactPossibleSecrets(value: string): string {
  return value.replace(SECRETY_STRING_RE, "<redacted>");
}

function sanitizeForDisplay(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPossibleSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForDisplay);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "<redacted>";
    } else {
      out[k] = sanitizeForDisplay(v);
    }
  }
  return out;
}

async function showCommand(argv: string[]) {
  const { argv: contextualArgv, context } = resolveContextualOptions(argv, {
    allowSource: true,
  });

  if (
    contextualArgv.includes("--help") ||
    contextualArgv.includes("-h") ||
    contextualArgv[0] === "help"
  ) {
    printShowHelp();
    return;
  }

  let showSecrets = false;
  let raw: string | null = null;
  for (const arg of contextualArgv) {
    if (!arg) {
      continue;
    }
    if (arg === "--show-secrets") {
      showSecrets = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      process.exitCode = 1;
      return;
    }
    if (raw) {
      console.error("show accepts a single name");
      process.exitCode = 1;
      return;
    }
    raw = arg;
  }
  if (!raw) {
    console.error("show requires a name");
    process.exitCode = 1;
    return;
  }

  let index: FacultIndex;
  try {
    index = await withContextualCommandScope(context, async (rootDir) =>
      loadIndex({ rootDir })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let kind: ShowKind = "skills";
  let name = raw;
  const colonIndex = raw.indexOf(":");
  if (colonIndex > 0) {
    const tokenKind = showKindForToken(raw.slice(0, colonIndex));
    if (tokenKind) {
      kind = tokenKind;
      name = raw.slice(colonIndex + 1);
    }
  }

  try {
    const graph = await withContextualCommandScope(context, async (rootDir) =>
      loadGraph({ rootDir })
    );
    const node = resolveGraphNode(graph, raw, {
      sourceKind: context.sourceKind,
      scope: scopeFilterForMode(context.scopeMode),
    });
    const graphKind = node ? showKindForToken(node.kind) : null;
    if (node && graphKind) {
      kind = graphKind;
      name = node.name;
    }
  } catch {
    // A missing or stale graph should not make basic index-backed show fail.
  }

  let entry:
    | SkillEntry
    | McpEntry
    | AgentEntry
    | AutomationEntry
    | SnippetEntry
    | InstructionEntry
    | null = null;
  const skill = index.skills[name];
  const mcpServer = index.mcp?.servers?.[name];
  const agent = index.agents?.[name];
  const automation = index.automations?.[name];
  const snippet = index.snippets?.[name];
  const instruction = index.instructions?.[name];
  const matchesContext = (candidate: {
    sourceKind?: string;
    scope?: string;
  }): boolean => {
    if (context.sourceKind && candidate.sourceKind !== context.sourceKind) {
      return false;
    }
    const scopeFilter = scopeFilterForMode(context.scopeMode);
    if (scopeFilter && candidate.scope !== scopeFilter) {
      return false;
    }
    return true;
  };

  if (kind === "skills" && skill && matchesContext(skill)) {
    entry = skill;
  } else if (kind === "mcp" && mcpServer && matchesContext(mcpServer)) {
    entry = mcpServer;
  } else if (kind === "skills" && agent && matchesContext(agent)) {
    kind = "agents";
    entry = agent;
  } else if (
    kind === "automations" &&
    automation &&
    matchesContext(automation)
  ) {
    entry = automation;
  } else if (kind === "skills" && automation && matchesContext(automation)) {
    kind = "automations";
    entry = automation;
  } else if (kind === "skills" && snippet && matchesContext(snippet)) {
    kind = "snippets";
    entry = snippet;
  } else if (
    kind === "instructions" &&
    instruction &&
    matchesContext(instruction)
  ) {
    entry = instruction;
  } else if (kind === "skills" && instruction && matchesContext(instruction)) {
    kind = "instructions";
    entry = instruction;
  } else if (kind === "skills" && mcpServer && matchesContext(mcpServer)) {
    kind = "mcp";
    entry = mcpServer;
  }

  if (!entry) {
    console.error(`Entry not found: ${raw}`);
    process.exitCode = 1;
    return;
  }

  let contentPath = entry.path;
  if (kind === "skills") {
    contentPath = join(entry.path, "SKILL.md");
  }

  let contents = "";
  try {
    contents = await readEntryContents(contentPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const displayEntry =
    kind === "mcp" && !showSecrets ? sanitizeForDisplay(entry) : entry;
  let displayContents = contents;
  if (kind === "mcp" && !showSecrets) {
    if (contentPath.endsWith(".json")) {
      try {
        const parsed = parseJsonLenient(contents);
        displayContents = `${JSON.stringify(sanitizeForDisplay(parsed), null, 2)}\n`;
      } catch {
        displayContents = redactPossibleSecrets(contents);
      }
    } else {
      displayContents = redactPossibleSecrets(contents);
    }
  }

  console.log(
    renderPage({
      title: `fclt show ${kind}:${entry.name}`,
      subtitle: contentPath,
      sections: [
        {
          title: "Metadata",
          lines: renderJsonBlock(displayEntry),
        },
        {
          title: "Contents",
          lines: displayContents.replace(TRAILING_NEWLINE_RE, "").split("\n"),
        },
      ],
      footer:
        kind === "mcp" && !showSecrets
          ? [
              "Secrets are redacted. Re-run with --show-secrets only when you need raw values.",
            ]
          : undefined,
    })
  );
}

async function graphCommand(argv: string[]) {
  const { argv: contextualArgv, context } = resolveContextualOptions(argv, {
    allowSource: true,
  });

  if (
    contextualArgv.includes("--help") ||
    contextualArgv.includes("-h") ||
    contextualArgv[0] === "help"
  ) {
    printGraphHelp();
    return;
  }

  let opts: GraphCommandOptions;
  try {
    opts = parseGraphArgs(contextualArgv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  try {
    const graph = await withContextualCommandScope(context, async (rootDir) =>
      loadGraph({ rootDir })
    );
    const node = resolveGraphNode(graph, opts.target, {
      sourceKind: context.sourceKind,
      scope: scopeFilterForMode(context.scopeMode),
    });
    if (!node) {
      throw new Error(`Graph node not found: ${opts.target}`);
    }

    const deps = graphDependencies(graph, node.id);
    const dependents = graphDependents(graph, node.id);

    if (opts.json) {
      if (opts.kind === "show") {
        console.log(
          JSON.stringify({ node, dependencies: deps, dependents }, null, 2)
        );
      } else if (opts.kind === "deps") {
        console.log(JSON.stringify(deps, null, 2));
      } else {
        console.log(JSON.stringify(dependents, null, 2));
      }
      return;
    }

    if (opts.kind === "show") {
      console.log(
        renderPage({
          title: `fclt graph ${node.id}`,
          subtitle: `${node.kind} • ${sourceLabel(node)}`,
          sections: [
            {
              title: "Node",
              lines: renderKeyValue([
                ["id", node.id],
                ["kind", node.kind],
                ["name", node.name],
                ["path", node.path ?? "—"],
                ["canonicalRef", node.canonicalRef ?? "—"],
              ]),
            },
            {
              title: "Dependencies",
              lines:
                deps.length > 0
                  ? renderCatalog(
                      deps.map((dep) => ({
                        title: dep.node.id,
                        meta: dep.edge.kind,
                        details: [dep.edge.locator],
                      }))
                    )
                  : ["No dependencies."],
            },
            {
              title: "Dependents",
              lines:
                dependents.length > 0
                  ? renderCatalog(
                      dependents.map((dependent) => ({
                        title: dependent.node.id,
                        meta: dependent.edge.kind,
                        details: [dependent.edge.locator],
                      }))
                    )
                  : ["No dependents."],
            },
          ],
        })
      );
      return;
    }

    const relations = opts.kind === "deps" ? deps : dependents;
    console.log(
      renderPage({
        title: `fclt graph ${opts.kind}`,
        subtitle: `${relations.length} relation${relations.length === 1 ? "" : "s"} for ${node.id}`,
        sections: [
          {
            title: opts.kind === "deps" ? "Dependencies" : "Dependents",
            lines:
              relations.length > 0
                ? renderCatalog(
                    relations.map((relation) => ({
                      title: relation.node.id,
                      meta: relation.edge.kind,
                      details: [relation.edge.locator],
                    }))
                  )
                : ["No relations found."],
          },
        ],
      })
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function adaptersCommand(argv: string[]) {
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(
      renderPage({
        title: "fclt adapters",
        subtitle: "List registered tool adapters.",
        sections: [
          {
            title: "Usage",
            lines: renderBullets([renderCode("fclt adapters")]),
          },
        ],
      })
    );
    return;
  }
  const { getAllAdapters } = await import("./adapters");
  const adapters = getAllAdapters();
  if (json) {
    console.log(
      JSON.stringify(
        adapters.map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          versions: adapter.versions,
          defaultPaths: adapter.getDefaultPaths?.() ?? {},
        })),
        null,
        2
      )
    );
    return;
  }
  if (!adapters.length) {
    console.log(
      renderPage({
        title: "fclt adapters",
        subtitle: "No adapters registered.",
        sections: [],
      })
    );
    return;
  }
  console.log(
    renderPage({
      title: "fclt adapters",
      subtitle: `${adapters.length} registered adapter${adapters.length === 1 ? "" : "s"}`,
      sections: [
        {
          title: "Adapters",
          lines: renderCatalog(
            adapters.map((adapter) => ({
              title: adapter.id,
              description: `Versions: ${adapter.versions.join(", ")}`,
            }))
          ),
        },
      ],
    })
  );
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const { packageVersion } = await import("./status");
    console.log(await packageVersion());
    return;
  }

  // Convenience: allow `fclt --show-duplicates` as shorthand for `fclt scan --show-duplicates`.
  if (cmd === "--show-duplicates") {
    const { scanCommand } = await import("./scan");
    await scanCommand([cmd, ...rest]);
    return;
  }

  switch (cmd) {
    case "scan":
      await import("./scan").then(({ scanCommand }) => scanCommand(rest));
      return;
    case "inventory":
      await import("./inventory").then(({ inventoryCommand }) =>
        inventoryCommand(rest)
      );
      return;
    case "status":
      await import("./status").then(({ statusCommand }) => statusCommand(rest));
      return;
    case "paths":
      await import("./paths-command").then(({ pathsCommand }) =>
        pathsCommand(rest)
      );
      return;
    case "protocol":
      await import("./protocol").then(({ protocolCommand }) =>
        protocolCommand(rest)
      );
      return;
    case "audit":
      await import("./audit").then(({ auditCommand }) => auditCommand(rest));
      return;
    case "migrate":
      await import("./migrate").then(({ migrateCommand }) =>
        migrateCommand(rest)
      );
      return;
    case "doctor":
      await import("./doctor").then(({ doctorCommand }) => doctorCommand(rest));
      return;
    case "consolidate":
      await import("./consolidate").then(({ consolidateCommand }) =>
        consolidateCommand(rest)
      );
      return;
    case "index":
      await import("./index-builder").then(({ indexCommand }) =>
        indexCommand(rest)
      );
      return;
    case "list":
      await listCommand(rest);
      return;
    case "show":
      await showCommand(rest);
      return;
    case "find":
      await findCommand(rest);
      return;
    case "graph":
      await graphCommand(rest);
      return;
    case "ai":
      await import("./ai").then(({ aiCommand }) => aiCommand(rest));
      return;
    case "adapters":
      await adaptersCommand(rest);
      return;
    case "trust":
      await import("./trust").then(({ trustCommand }) => trustCommand(rest));
      return;
    case "untrust":
      await import("./trust").then(({ untrustCommand }) =>
        untrustCommand(rest)
      );
      return;
    case "manage":
      await import("./manage").then(({ manageCommand }) => manageCommand(rest));
      return;
    case "deploy":
      await import("./deployment-plan").then(({ deployCommand }) =>
        deployCommand(rest)
      );
      return;
    case "project":
      await import("./project-render").then(({ projectCommand }) =>
        projectCommand(rest)
      );
      return;
    case "unmanage":
      await import("./manage").then(({ unmanageCommand }) =>
        unmanageCommand(rest)
      );
      return;
    case "managed":
      await import("./manage").then(({ managedCommand }) =>
        managedCommand(rest)
      );
      return;
    case "enable":
      await import("./enable-disable").then(({ enableCommand }) =>
        enableCommand(rest)
      );
      return;
    case "disable":
      await import("./enable-disable").then(({ disableCommand }) =>
        disableCommand(rest)
      );
      return;
    case "sync":
      await import("./manage").then(({ syncCommand }) => syncCommand(rest));
      return;
    case "setup":
      await import("./setup").then(({ setupCommand }) => setupCommand(rest));
      return;
    case "projects":
      await import("./projects").then(({ projectsCommand }) =>
        projectsCommand(rest)
      );
      return;
    case "project":
      await import("./projects").then(({ projectCommand }) =>
        projectCommand(rest)
      );
      return;
    case "autosync":
      await import("./autosync").then(({ autosyncCommand }) =>
        autosyncCommand(rest)
      );
      return;
    case "search":
      await import("./remote").then(({ searchCommand }) => searchCommand(rest));
      return;
    case "install":
      await import("./remote").then(({ installCommand }) =>
        installCommand(rest)
      );
      return;
    case "update":
      if (rest.includes("--self")) {
        await import("./self-update").then(({ selfUpdateCommand }) =>
          selfUpdateCommand(rest.filter((arg) => arg !== "--self"))
        );
        return;
      }
      await import("./remote").then(({ updateCommand }) => updateCommand(rest));
      return;
    case "self-update":
      await import("./self-update").then(({ selfUpdateCommand }) =>
        selfUpdateCommand(rest)
      );
      return;
    case "verify-source":
      await import("./remote").then(({ verifySourceCommand }) =>
        verifySourceCommand(rest)
      );
      return;
    case "templates":
      await import("./remote").then(({ templatesCommand }) =>
        templatesCommand(rest)
      );
      return;
    case "sources":
      await import("./remote").then(({ sourcesCommand }) =>
        sourcesCommand(rest)
      );
      return;
    case "snippets":
      await import("./snippets-cli").then(({ snippetsCommand }) =>
        snippetsCommand(rest)
      );
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
