import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { getAdapter } from "./adapters";
import { facultBuiltinPackRoot } from "./builtin";
import {
  parseCliContextArgs,
  resolveCliContextRoot,
  resolveCliContextScope,
} from "./cli-context";
import {
  type AssetScope,
  type AssetSourceKind,
  extractExplicitReferences,
  type FacultGraph,
  type GraphEdge,
  makeGraphNodeId,
  snippetMarkerToSnippetRef,
} from "./graph";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  facultMachineStateDir,
  facultRootDir,
  projectRootFromAiRoot,
  projectSlugFromAiRoot,
  withFacultRootScope,
} from "./paths";
import { lastModified } from "./util/skills";

interface AssetEntryBase {
  sourceKind?: AssetSourceKind;
  scope?: AssetScope;
  canonicalRef?: string;
  projectRoot?: string;
  projectSlug?: string;
  sourceRoot?: string;
  shadow?: boolean;
}

function managedAgentFileExtension(tool: string): string {
  return getAdapter(tool)?.agentFileExtension ?? ".toml";
}

export interface SkillEntry {
  name: string;
  path: string;
  description: string;
  tags: string[];
  lastModifiedAt?: string;
  enabledFor?: string[];
  trusted?: boolean;
  trustedAt?: string;
  trustedBy?: string;
  auditStatus?: "pending" | "passed" | "flagged";
  lastAuditAt?: string;
}

export interface McpEntry {
  name: string;
  path: string;
  lastModifiedAt?: string;
  /** The raw server definition from servers.json (lossless). */
  definition: unknown;
  enabledFor?: string[];
  trusted?: boolean;
  trustedAt?: string;
  trustedBy?: string;
  auditStatus?: "pending" | "passed" | "flagged";
  lastAuditAt?: string;
}

export interface AgentEntry {
  name: string;
  path: string;
  description?: string;
  lastModifiedAt?: string;
  enabledFor?: string[];
  trusted?: boolean;
  trustedAt?: string;
  trustedBy?: string;
  auditStatus?: "pending" | "passed" | "flagged";
  lastAuditAt?: string;
}

export interface AutomationEntry {
  name: string;
  path: string;
  lastModifiedAt?: string;
}

export interface SnippetEntry {
  name: string;
  path: string;
  description?: string;
  tags?: string[];
  lastModifiedAt?: string;
}

export interface InstructionEntry {
  name: string;
  path: string;
  description: string;
  tags: string[];
  lastModifiedAt?: string;
}

interface ToolAssetEntry extends AssetEntryBase {
  name: string;
  path: string;
  lastModifiedAt?: string;
}

export interface SkillEntry extends AssetEntryBase {}
export interface McpEntry extends AssetEntryBase {}
export interface AgentEntry extends AssetEntryBase {}
export interface AutomationEntry extends AssetEntryBase {}
export interface SnippetEntry extends AssetEntryBase {}
export interface InstructionEntry extends AssetEntryBase {}

export interface FacultIndex {
  version: number;
  updatedAt: string;
  skills: Record<string, SkillEntry>;
  mcp: { servers: Record<string, McpEntry> };
  agents: Record<string, AgentEntry>;
  automations?: Record<string, AutomationEntry>;
  snippets: Record<string, SnippetEntry>;
  instructions: Record<string, InstructionEntry>;
}

interface IndexedSource {
  sourceKind: AssetSourceKind;
  scope: AssetScope;
  rootDir: string;
  projectRoot?: string;
  projectSlug?: string;
}

interface SourceAssets {
  skills: Record<string, SkillEntry>;
  mcpServers: Record<string, McpEntry>;
  agents: Record<string, AgentEntry>;
  automations: Record<string, AutomationEntry>;
  snippets: Record<string, SnippetEntry>;
  instructions: Record<string, InstructionEntry>;
  toolConfigs: Record<string, ToolAssetEntry>;
  toolRules: Record<string, ToolAssetEntry>;
}

interface ManagedToolStateLite {
  tool: string;
  agentsDir?: string;
  toolHome?: string;
  globalAgentsPath?: string;
  globalAgentsOverridePath?: string;
  mcpConfig?: string;
  rulesDir?: string;
  toolConfig?: string;
}

interface ManagedStateLite {
  version?: number;
  tools?: Record<string, ManagedToolStateLite>;
}

function isSafePathString(p: string): boolean {
  return !p.includes("\0");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseAuditStatus(
  raw: unknown
): "pending" | "passed" | "flagged" | null {
  if (typeof raw !== "string") {
    return null;
  }
  const v = raw.trim().toLowerCase();
  if (v === "pending" || v === "passed" || v === "flagged") {
    return v;
  }
  return null;
}

function extractIndexMeta(entry: unknown): {
  enabledFor?: string[];
  trusted?: boolean;
  trustedAt?: string;
  trustedBy?: string;
  auditStatus?: "pending" | "passed" | "flagged";
  lastAuditAt?: string;
} {
  if (!isPlainObject(entry)) {
    return {};
  }
  const obj = entry as Record<string, unknown>;
  const enabledFor = Array.isArray(obj.enabledFor)
    ? obj.enabledFor.map((t) => String(t))
    : undefined;
  const trusted = typeof obj.trusted === "boolean" ? obj.trusted : undefined;
  const trustedAt =
    typeof obj.trustedAt === "string" ? obj.trustedAt : undefined;
  const trustedBy =
    typeof obj.trustedBy === "string" ? obj.trustedBy : undefined;
  const auditStatus = parseAuditStatus(obj.auditStatus) ?? undefined;
  const lastAuditAt =
    typeof obj.lastAuditAt === "string" ? obj.lastAuditAt : undefined;
  return {
    enabledFor,
    trusted,
    trustedAt,
    trustedBy,
    auditStatus,
    lastAuditAt,
  };
}

function findPreviousEntryByCanonicalRef(
  previous: Record<string, unknown> | undefined,
  canonicalRef: string | undefined,
  fallbackName: string,
  source: IndexedSource
): unknown {
  if (!previous) {
    return undefined;
  }
  if (typeof canonicalRef === "string") {
    for (const value of Object.values(previous)) {
      if (!isPlainObject(value)) {
        continue;
      }
      if (value.canonicalRef === canonicalRef) {
        return value;
      }
    }
  }
  const legacyFallback = previous[fallbackName];
  if (
    isPlainObject(legacyFallback) &&
    typeof legacyFallback.canonicalRef !== "string" &&
    legacyFallbackMatchesSource(legacyFallback, source)
  ) {
    return legacyFallback;
  }
  return undefined;
}

function findPreviousMcpEntry(
  previous: Record<string, unknown> | undefined,
  canonicalRef: string | undefined,
  name: string,
  source: IndexedSource
): unknown {
  if (!previous) {
    return undefined;
  }
  const candidate = previous[name];
  if (!isPlainObject(candidate)) {
    return undefined;
  }
  if (typeof candidate.canonicalRef !== "string") {
    return legacyFallbackMatchesSource(candidate, source)
      ? candidate
      : undefined;
  }
  if (
    typeof canonicalRef === "string" &&
    candidate.canonicalRef === canonicalRef
  ) {
    return candidate;
  }
  return undefined;
}

function pathIsWithinRoot(pathValue: string, rootDir: string): boolean {
  if (!isAbsolute(pathValue)) {
    return false;
  }
  const rel = relative(rootDir, pathValue);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

function legacyFallbackMatchesSource(
  entry: Record<string, unknown>,
  source: IndexedSource
): boolean {
  let hasSourceSignal = false;

  const entrySourceKind = entry.sourceKind;
  if (typeof entrySourceKind === "string") {
    hasSourceSignal = true;
    if (entrySourceKind !== source.sourceKind) {
      return false;
    }
  }

  const entryScope = entry.scope;
  if (typeof entryScope === "string") {
    hasSourceSignal = true;
    if (entryScope !== source.scope) {
      return false;
    }
  }

  const entryProjectRoot = entry.projectRoot;
  if (typeof entryProjectRoot === "string") {
    hasSourceSignal = true;
    if (entryProjectRoot !== source.projectRoot) {
      return false;
    }
  }

  const entrySourceRoot = entry.sourceRoot;
  if (typeof entrySourceRoot === "string") {
    hasSourceSignal = true;
    if (entrySourceRoot !== source.rootDir) {
      return false;
    }
  }

  const entryPath = entry.path;
  if (typeof entryPath === "string") {
    hasSourceSignal = true;
    return pathIsWithinRoot(entryPath, source.rootDir);
  }

  return hasSourceSignal;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

const NEWLINE_RE = /\r?\n/;
const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const FRONTMATTER_LIST_ITEM_RE = /^\s*-\s*(.+)$/;
const MARKDOWN_FILE_SUFFIX_RE = /\.md$/i;
const REFS_PREFIX_RE = /^refs\./;

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
}

function firstParagraphDescription(mdBody: string): string {
  const lines = mdBody.split(NEWLINE_RE);

  // Find first paragraph of non-empty lines, skipping headings.
  const para: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      if (para.length) {
        break;
      }
      continue;
    }

    // Skip headings and separators; they aren't a description.
    if (line.startsWith("#") || line === "---") {
      continue;
    }

    para.push(line);
  }

  return para.join(" ").trim();
}

function parseTagsValue(value: string, followingLines: string[]): string[] {
  const out: string[] = [];
  const v = value.trim();

  if (!v) {
    // Parse list-style tags:
    // tags:\n  - a\n  - b
    for (const l of followingLines) {
      const li = FRONTMATTER_LIST_ITEM_RE.exec(l);
      if (!li) {
        break;
      }
      const tag = li[1];
      if (tag) {
        out.push(stripQuotes(tag));
      }
    }
    return out;
  }

  // Inline styles.
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1);
    for (const part of inner.split(",")) {
      out.push(stripQuotes(part));
    }
    return out;
  }

  // Comma-separated or single.
  if (v.includes(",")) {
    for (const part of v.split(",")) {
      out.push(stripQuotes(part));
    }
    return out;
  }

  return [stripQuotes(v)];
}

function extractFrontmatterBlock(md: string): {
  fmLines: string[];
  body: string;
} | null {
  if (!(md.startsWith("---\n") || md.startsWith("---\r\n"))) {
    return null;
  }

  const lines = md.split(NEWLINE_RE);

  // lines[0] is ---
  let i = 1;
  const fmLines: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    if (line === "---") {
      i += 1;
      break;
    }
    fmLines.push(line);
  }

  return { fmLines, body: lines.slice(i).join("\n") };
}

function countListItems(lines: string[]): number {
  let n = 0;
  for (const l of lines) {
    if (!FRONTMATTER_LIST_ITEM_RE.test(l)) {
      break;
    }
    n++;
  }
  return n;
}

function parseFrontmatter(md: string): {
  description?: string;
  tags: string[];
  body: string;
} {
  const block = extractFrontmatterBlock(md);
  if (!block) {
    return { tags: [], body: md };
  }

  const tags: string[] = [];
  let description: string | undefined;

  const fmLines = block.fmLines;
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (line === undefined) {
      continue;
    }
    const m = FRONTMATTER_KEY_RE.exec(line);
    if (!m) {
      continue;
    }

    const key = m[1];
    const value = m[2] ?? "";

    if (key === "description") {
      description = stripQuotes(value);
      continue;
    }

    if (key === "tags") {
      const rest = fmLines.slice(j + 1);
      tags.push(...parseTagsValue(value, rest));

      if (!value.trim()) {
        j += countListItems(rest);
      }
    }
  }

  return { description, tags, body: block.body };
}

function parseMarkdownAsset(md: string): {
  description: string;
  tags: string[];
} {
  const fm = parseFrontmatter(md);

  const description =
    fm.description?.trim() || firstParagraphDescription(fm.body) || "";

  return { description, tags: normalizeTags(fm.tags) };
}

export function parseSkillMarkdown(md: string): {
  description: string;
  tags: string[];
} {
  return parseMarkdownAsset(md);
}

async function statIsoTime(p: string): Promise<string | undefined> {
  const lm = await lastModified(p);
  return lm ? lm.toISOString() : undefined;
}

async function readJsonSafe(p: string): Promise<unknown> {
  const txt = await Bun.file(p).text();
  return JSON.parse(txt);
}

function canonicalRefForPath(
  source: IndexedSource,
  _category:
    | "skills"
    | "agents"
    | "automations"
    | "snippets"
    | "instructions"
    | "mcp"
    | "doc"
    | "rendered",
  filePath: string
): string | undefined {
  const rel = relative(source.rootDir, filePath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) {
    return undefined;
  }
  if (source.sourceKind === "global") {
    return `@ai/${rel}`;
  }
  if (source.sourceKind === "project") {
    return `@project/${rel}`;
  }
  if (source.sourceKind === "builtin") {
    return `@builtin/facult-operating-model/${rel}`;
  }
  return undefined;
}

function entryScopeMeta(
  source: IndexedSource
): Pick<
  AssetEntryBase,
  "sourceKind" | "scope" | "projectRoot" | "projectSlug" | "sourceRoot"
> {
  return {
    sourceKind: source.sourceKind,
    scope: source.scope,
    projectRoot: source.projectRoot,
    projectSlug: source.projectSlug,
    sourceRoot: source.rootDir,
  };
}

async function listDirFiles(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name))
      .filter(isSafePathString)
      .sort();
  } catch {
    return [];
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
      .filter(isSafePathString)
      .sort();
  } catch {
    return [];
  }
}

async function indexSkills(
  skillsDir: string,
  source: IndexedSource,
  previous?: Record<string, unknown>
): Promise<Record<string, SkillEntry>> {
  const out: Record<string, SkillEntry> = {};
  const dirs = await listSubdirs(skillsDir);
  for (const d of dirs) {
    const skillMd = join(d, "SKILL.md");
    try {
      const st = await Bun.file(skillMd).stat();
      if (!st.isFile()) {
        continue;
      }

      const md = await Bun.file(skillMd).text();
      const { description, tags } = parseSkillMarkdown(md);
      const name = basename(d);
      const canonicalRef = canonicalRefForPath(source, "skills", d);
      const prev = findPreviousEntryByCanonicalRef(
        previous,
        canonicalRef,
        name,
        source
      );
      const meta = extractIndexMeta(prev);

      out[name] = {
        name,
        path: d,
        description,
        tags,
        canonicalRef,
        lastModifiedAt: await statIsoTime(skillMd),
        enabledFor: meta.enabledFor,
        trusted: meta.trusted ?? false,
        trustedAt: meta.trustedAt,
        trustedBy: meta.trustedBy,
        auditStatus: meta.auditStatus ?? "pending",
        lastAuditAt: meta.lastAuditAt,
        ...entryScopeMeta(source),
      };
    } catch {
      // Ignore missing/invalid skill entries.
    }
  }
  return out;
}

async function indexMcpServers(
  mcpConfigPath: string,
  source: IndexedSource,
  previous?: Record<string, unknown>
): Promise<Record<string, McpEntry>> {
  const out: Record<string, McpEntry> = {};

  try {
    const st = await Bun.file(mcpConfigPath).stat();
    if (!st.isFile()) {
      return out;
    }

    const data = (await readJsonSafe(mcpConfigPath)) as Record<
      string,
      unknown
    > | null;

    // Accept a few shapes:
    // 1) { servers: { name: {...} } }
    // 2) { mcp: { servers: {...} } }
    // 3) { mcpServers: {...} }
    const serversObj =
      (data?.servers as Record<string, unknown> | undefined) ??
      ((data?.mcp as Record<string, unknown> | undefined)?.servers as
        | Record<string, unknown>
        | undefined) ??
      (data?.mcpServers as Record<string, unknown> | undefined);

    if (!serversObj || typeof serversObj !== "object") {
      return out;
    }

    const lm = await statIsoTime(mcpConfigPath);
    for (const name of Object.keys(serversObj).sort()) {
      const canonicalRef = canonicalRefForPath(source, "mcp", mcpConfigPath);
      const prev = findPreviousMcpEntry(previous, canonicalRef, name, source);
      const meta = extractIndexMeta(prev);
      out[name] = {
        name,
        path: mcpConfigPath,
        canonicalRef,
        lastModifiedAt: lm,
        definition: serversObj[name],
        enabledFor: meta.enabledFor,
        trusted: meta.trusted ?? false,
        trustedAt: meta.trustedAt,
        trustedBy: meta.trustedBy,
        auditStatus: meta.auditStatus ?? "pending",
        lastAuditAt: meta.lastAuditAt,
        ...entryScopeMeta(source),
      };
    }
  } catch {
    return out;
  }

  return out;
}

async function indexAgents(
  agentsDir: string,
  source: IndexedSource,
  previous?: Record<string, unknown>
): Promise<Record<string, AgentEntry>> {
  const out: Record<string, AgentEntry> = {};
  const files: string[] = [];
  const directFiles = await listDirFiles(agentsDir);
  files.push(...directFiles);
  for (const dir of await listSubdirs(agentsDir)) {
    const candidate = join(dir, "agent.toml");
    try {
      const st = await Bun.file(candidate).stat();
      if (st.isFile()) {
        files.push(candidate);
      }
    } catch {
      // Ignore missing nested manifests.
    }
  }
  for (const p of files) {
    const name =
      basename(p) === "agent.toml" ? basename(dirname(p)) : basename(p);
    const canonicalRef = canonicalRefForPath(source, "agents", p);
    const prev = findPreviousEntryByCanonicalRef(
      previous,
      canonicalRef,
      name,
      source
    );
    const meta = extractIndexMeta(prev);
    let description: string | undefined;
    try {
      const raw = await Bun.file(p).text();
      const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
      const parsedDescription = parsed.description;
      if (typeof parsedDescription === "string" && parsedDescription.trim()) {
        description = parsedDescription.trim();
      }
    } catch {
      description = undefined;
    }
    out[name] = {
      name,
      path: p,
      description,
      canonicalRef,
      lastModifiedAt: await statIsoTime(p),
      enabledFor: meta.enabledFor,
      trusted: meta.trusted ?? false,
      trustedAt: meta.trustedAt,
      trustedBy: meta.trustedBy,
      auditStatus: meta.auditStatus ?? "pending",
      lastAuditAt: meta.lastAuditAt,
      ...entryScopeMeta(source),
    };
  }
  return out;
}

async function indexAutomations(
  automationsDir: string,
  source: IndexedSource
): Promise<Record<string, AutomationEntry>> {
  const out: Record<string, AutomationEntry> = {};
  const dirs = await listSubdirs(automationsDir);
  for (const d of dirs) {
    const automationToml = join(d, "automation.toml");
    try {
      const st = await Bun.file(automationToml).stat();
      if (!st.isFile()) {
        continue;
      }

      const name = basename(d);
      out[name] = {
        name,
        path: automationToml,
        canonicalRef: canonicalRefForPath(
          source,
          "automations",
          automationToml
        ),
        lastModifiedAt: await statIsoTime(automationToml),
        ...entryScopeMeta(source),
      };
    } catch {
      // Ignore malformed automation entries.
    }
  }
  return out;
}

async function indexSnippets(
  snippetsDir: string,
  source: IndexedSource
): Promise<Record<string, SnippetEntry>> {
  const out: Record<string, SnippetEntry> = {};
  try {
    const st = await Bun.file(snippetsDir).stat();
    if (!st.isDirectory()) {
      return out;
    }
  } catch {
    return out;
  }
  // Snippets live under snippets/global/** and snippets/projects/**.
  // Index all files under snippets/ so names don't collide across scopes.
  const glob = new Bun.Glob("**/*");
  const files: string[] = [];
  for await (const rel of glob.scan({ cwd: snippetsDir, onlyFiles: true })) {
    files.push(join(snippetsDir, rel));
  }

  for (const p of files.sort()) {
    const rel = relative(snippetsDir, p);
    const name = rel || basename(p);
    let description: string | undefined;
    let tags: string[] | undefined;
    try {
      const raw = await Bun.file(p).text();
      const parsed = parseMarkdownAsset(raw);
      description = parsed.description || undefined;
      tags = parsed.tags.length ? parsed.tags : undefined;
    } catch {
      description = undefined;
      tags = undefined;
    }
    out[name] = {
      name,
      path: p,
      description,
      tags,
      canonicalRef: canonicalRefForPath(source, "snippets", p),
      lastModifiedAt: await statIsoTime(p),
      ...entryScopeMeta(source),
    };
  }
  return out;
}

function instructionNameFromRelativePath(relPath: string): string {
  return relPath.replace(MARKDOWN_FILE_SUFFIX_RE, "");
}

async function indexInstructions(
  instructionsDir: string,
  source: IndexedSource
): Promise<Record<string, InstructionEntry>> {
  const out: Record<string, InstructionEntry> = {};
  try {
    const st = await Bun.file(instructionsDir).stat();
    if (!st.isDirectory()) {
      return out;
    }
  } catch {
    return out;
  }

  const glob = new Bun.Glob("**/*.md");
  const files: string[] = [];
  for await (const rel of glob.scan({
    cwd: instructionsDir,
    onlyFiles: true,
  })) {
    files.push(join(instructionsDir, rel));
  }

  for (const p of files.sort()) {
    try {
      const rel = relative(instructionsDir, p);
      const raw = await Bun.file(p).text();
      const parsed = parseMarkdownAsset(raw);
      const name = instructionNameFromRelativePath(rel || basename(p));
      out[name] = {
        name,
        path: p,
        description: parsed.description,
        tags: parsed.tags,
        canonicalRef: canonicalRefForPath(source, "instructions", p),
        lastModifiedAt: await statIsoTime(p),
        ...entryScopeMeta(source),
      };
    } catch {
      // Ignore unreadable instruction files.
    }
  }

  return out;
}

async function indexToolAssets(
  toolsDir: string,
  source: IndexedSource
): Promise<{
  toolConfigs: Record<string, ToolAssetEntry>;
  toolRules: Record<string, ToolAssetEntry>;
}> {
  const toolConfigs: Record<string, ToolAssetEntry> = {};
  const toolRules: Record<string, ToolAssetEntry> = {};
  try {
    const st = await Bun.file(toolsDir).stat();
    if (!st.isDirectory()) {
      return { toolConfigs, toolRules };
    }
  } catch {
    return { toolConfigs, toolRules };
  }

  const configGlob = new Bun.Glob("*/config.toml");
  for await (const rel of configGlob.scan({ cwd: toolsDir, onlyFiles: true })) {
    const pathValue = join(toolsDir, rel);
    const name = rel.replace(/\\/g, "/");
    toolConfigs[name] = {
      name,
      path: pathValue,
      canonicalRef: canonicalRefForPath(source, "rendered", pathValue),
      lastModifiedAt: await statIsoTime(pathValue),
      ...entryScopeMeta(source),
    };
  }

  const ruleGlob = new Bun.Glob("*/rules/**/*.rules");
  for await (const rel of ruleGlob.scan({ cwd: toolsDir, onlyFiles: true })) {
    const pathValue = join(toolsDir, rel);
    const name = rel.replace(/\\/g, "/");
    toolRules[name] = {
      name,
      path: pathValue,
      canonicalRef: canonicalRefForPath(source, "rendered", pathValue),
      lastModifiedAt: await statIsoTime(pathValue),
      ...entryScopeMeta(source),
    };
  }

  return { toolConfigs, toolRules };
}

async function indexSourceAssets(
  source: IndexedSource,
  previousIndex?: Record<string, unknown> | null
): Promise<SourceAssets> {
  const skillsDir = join(source.rootDir, "skills");
  const agentsDir = join(source.rootDir, "agents");
  const automationsDir = join(source.rootDir, "automations");
  const snippetsDir = join(source.rootDir, "snippets");
  const instructionsDir = join(source.rootDir, "instructions");
  const toolsDir = join(source.rootDir, "tools");
  const serversJsonPath = join(source.rootDir, "mcp", "servers.json");
  const mcpJsonPath = join(source.rootDir, "mcp", "mcp.json");
  const canonicalMcpPath = (await Bun.file(serversJsonPath).exists())
    ? serversJsonPath
    : mcpJsonPath;

  const prevSkills = isPlainObject(previousIndex?.skills)
    ? (previousIndex?.skills as Record<string, unknown>)
    : undefined;
  const prevAgents = isPlainObject(previousIndex?.agents)
    ? (previousIndex?.agents as Record<string, unknown>)
    : undefined;
  const prevMcpMap =
    isPlainObject(previousIndex?.mcp) &&
    isPlainObject((previousIndex.mcp as Record<string, unknown>).servers)
      ? ((previousIndex.mcp as Record<string, unknown>).servers as Record<
          string,
          unknown
        >)
      : undefined;

  const [
    skills,
    mcpServers,
    agents,
    automations,
    snippets,
    instructions,
    toolAssets,
  ] = await Promise.all([
    indexSkills(skillsDir, source, prevSkills),
    indexMcpServers(canonicalMcpPath, source, prevMcpMap),
    indexAgents(agentsDir, source, prevAgents),
    indexAutomations(automationsDir, source),
    indexSnippets(snippetsDir, source),
    indexInstructions(instructionsDir, source),
    indexToolAssets(toolsDir, source),
  ]);

  return {
    skills,
    mcpServers,
    agents,
    automations,
    snippets,
    instructions,
    toolConfigs: toolAssets.toolConfigs,
    toolRules: toolAssets.toolRules,
  };
}

function mergeByName<T extends { name: string }>(
  sources: Record<string, T>[]
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const source of sources) {
    for (const [name, entry] of Object.entries(source)) {
      merged[name] = entry;
    }
  }
  return merged;
}

function registerGraphEntries<
  T extends AssetEntryBase & {
    name: string;
    path: string;
  },
>(
  graph: FacultGraph,
  entries: Record<string, T>,
  kind:
    | "skill"
    | "mcp"
    | "agent"
    | "automation"
    | "snippet"
    | "instruction"
    | "doc"
    | "tool-config"
    | "tool-rule",
  activeSelections?: Map<string, string>
) {
  for (const entry of Object.values(entries)) {
    const sourceKind = entry.sourceKind ?? "global";
    const scope = entry.scope ?? "global";
    const activeIdentity = activeSelections?.get(
      activeEntryKey(kind, entry.name)
    );
    const shadow =
      entry.shadow ??
      (activeIdentity
        ? sourceIdentity({ sourceKind, scope }) !== activeIdentity
        : false);
    const id = makeGraphNodeId({
      kind,
      sourceKind,
      scope,
      name: entry.name,
    });
    graph.nodes[id] = {
      id,
      kind,
      name: entry.name,
      sourceKind,
      scope,
      path: entry.path,
      canonicalRef: entry.canonicalRef,
      projectRoot: entry.projectRoot,
      projectSlug: entry.projectSlug,
      shadow,
    };
  }
}

async function readTomlRefs(rootDir: string): Promise<Record<string, string>> {
  const file = Bun.file(join(rootDir, "config.toml"));
  if (!(await file.exists())) {
    return {};
  }
  try {
    const parsed = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    const refs = parsed.refs;
    if (!isPlainObject(refs)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(refs)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, String(value)])
    );
  } catch {
    return {};
  }
}

function graphNodeIdByCanonicalRef(graph: FacultGraph): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of Object.values(graph.nodes)) {
    if (node.canonicalRef) {
      out[node.canonicalRef] = node.id;
    }
  }
  return out;
}

function activeEntryKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

function sourceIdentity(entry: {
  sourceKind?: AssetSourceKind;
  scope?: AssetScope;
}): string {
  return `${entry.sourceKind ?? "global"}:${entry.scope ?? "global"}`;
}

function buildActiveEntryMap(
  sourceIndexes: {
    source: IndexedSource;
    assets: SourceAssets;
    docs: Record<string, AgentEntry>;
  }[]
): Map<string, string> {
  const active = new Map<string, string>();
  for (const sourceEntry of sourceIndexes) {
    for (const [name, entry] of Object.entries(sourceEntry.assets.skills)) {
      active.set(activeEntryKey("skill", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(sourceEntry.assets.mcpServers)) {
      active.set(activeEntryKey("mcp", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(sourceEntry.assets.agents)) {
      active.set(activeEntryKey("agent", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(
      sourceEntry.assets.automations
    )) {
      active.set(activeEntryKey("automation", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(sourceEntry.assets.snippets)) {
      active.set(activeEntryKey("snippet", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(
      sourceEntry.assets.instructions
    )) {
      active.set(activeEntryKey("instruction", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(
      sourceEntry.assets.toolConfigs
    )) {
      active.set(activeEntryKey("tool-config", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(sourceEntry.assets.toolRules)) {
      active.set(activeEntryKey("tool-rule", name), sourceIdentity(entry));
    }
    for (const [name, entry] of Object.entries(sourceEntry.docs)) {
      active.set(activeEntryKey("doc", name), sourceIdentity(entry));
    }
  }
  return active;
}

function addGraphEdge(
  graph: FacultGraph,
  edge: { from: string; to: string; kind: GraphEdge["kind"]; locator: string }
) {
  if (!(graph.nodes[edge.from] && graph.nodes[edge.to])) {
    return;
  }
  if (
    graph.edges.some(
      (existing) =>
        existing.from === edge.from &&
        existing.to === edge.to &&
        existing.kind === edge.kind &&
        existing.locator === edge.locator
    )
  ) {
    return;
  }
  graph.edges.push(edge);
}

function renderedTargetNodeName(
  targetPath: string,
  renderRoot: string
): string {
  const rel = relative(renderRoot, targetPath).replace(/\\/g, "/");
  return rel || basename(targetPath);
}

async function readManagedState(
  homeDir: string,
  rootDir: string,
  machineStateDir?: string
): Promise<ManagedStateLite | null> {
  const statePath = join(
    machineStateDir ?? facultMachineStateDir(homeDir, rootDir),
    "managed.json"
  );
  try {
    const file = Bun.file(statePath);
    if (!(await file.exists())) {
      return null;
    }
    const parsed = JSON.parse(await file.text()) as ManagedStateLite;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function addReferenceEdgesForEntries<
  T extends AssetEntryBase & {
    name: string;
    path: string;
  },
>(
  graph: FacultGraph,
  entries: Record<string, T>,
  kind:
    | "skill"
    | "agent"
    | "automation"
    | "snippet"
    | "instruction"
    | "doc"
    | "tool-config"
    | "tool-rule",
  refsByRoot: Map<string, Record<string, string>>
) {
  const refsByCanonical = graphNodeIdByCanonicalRef(graph);
  for (const entry of Object.values(entries)) {
    const sourceKind = entry.sourceKind ?? "global";
    const scope = entry.scope ?? "global";
    const from = makeGraphNodeId({
      kind,
      sourceKind,
      scope,
      name: entry.name,
    });
    let raw = "";
    try {
      raw = await Bun.file(entry.path).text();
    } catch {
      continue;
    }
    const refs = extractExplicitReferences(raw);
    const refsConfig = refsByRoot.get(entry.sourceRoot ?? "") ?? {};
    for (const ref of refs) {
      if (ref.kind === "snippet_marker") {
        const targetName = snippetMarkerToSnippetRef(ref.value);
        const target = Object.values(graph.nodes).find(
          (node) =>
            node.kind === "snippet" &&
            (node.name === targetName ||
              node.name === `global/${targetName}` ||
              node.name.endsWith(`/${targetName}`))
        );
        if (target) {
          addGraphEdge(graph, {
            from,
            to: target.id,
            kind: "snippet_marker",
            locator: ref.value,
          });
        }
        continue;
      }

      if (ref.kind === "ref_symbol") {
        const key = ref.value.replace(REFS_PREFIX_RE, "");
        const targetRef = refsConfig[key];
        const target = targetRef ? refsByCanonical[targetRef] : undefined;
        if (target) {
          addGraphEdge(graph, {
            from,
            to: target,
            kind: "ref_symbol",
            locator: ref.value,
          });
        }
        continue;
      }

      const target = refsByCanonical[ref.value];
      if (target) {
        addGraphEdge(graph, {
          from,
          to: target,
          kind: ref.kind === "project_ref" ? "project_ref" : "canonical_ref",
          locator: ref.value,
        });
      }
    }
  }
}

async function discoverDocs(
  source: IndexedSource
): Promise<Record<string, AgentEntry>> {
  const out: Record<string, AgentEntry> = {};
  const candidates = [
    join(source.rootDir, "AGENTS.global.md"),
    join(source.rootDir, "AGENTS.override.global.md"),
  ];
  for (const filePath of candidates) {
    try {
      const st = await Bun.file(filePath).stat();
      if (!st.isFile()) {
        continue;
      }
      const name = basename(filePath);
      out[name] = {
        name,
        path: filePath,
        description: undefined,
        canonicalRef: canonicalRefForPath(source, "doc", filePath),
        lastModifiedAt: await statIsoTime(filePath),
        ...entryScopeMeta(source),
      };
    } catch {
      // Ignore missing docs.
    }
  }
  return out;
}

function registerRenderedTargetNode(args: {
  graph: FacultGraph;
  currentScope: IndexedSource;
  targetPath: string;
  targetType: string;
  sourceNodeId: string;
  sourceName: string;
  sourceKind: AssetSourceKind;
  sourceScope: AssetScope;
  renderRoot: string;
  targetTool: string;
}) {
  const id = makeGraphNodeId({
    kind: "rendered-target",
    sourceKind: args.currentScope.sourceKind,
    scope: args.currentScope.scope,
    name: renderedTargetNodeName(args.targetPath, args.renderRoot),
  });
  args.graph.nodes[id] = {
    id,
    kind: "rendered-target",
    name: renderedTargetNodeName(args.targetPath, args.renderRoot),
    sourceKind: args.currentScope.sourceKind,
    scope: args.currentScope.scope,
    path: args.targetPath,
    projectRoot: args.currentScope.projectRoot,
    projectSlug: args.currentScope.projectSlug,
    shadow: true,
    meta: {
      targetTool: args.targetTool,
      targetType: args.targetType,
      sourceKind: args.sourceKind,
      sourceScope: args.sourceScope,
      sourceName: args.sourceName,
    },
  };

  addGraphEdge(args.graph, {
    from: args.sourceNodeId,
    to: id,
    kind: "render_source",
    locator: args.targetPath,
  });
}

function sourceNodeIdForEntry(args: {
  kind:
    | "skill"
    | "mcp"
    | "agent"
    | "automation"
    | "snippet"
    | "instruction"
    | "doc"
    | "tool-config"
    | "tool-rule";
  entry: {
    name: string;
    sourceKind?: AssetSourceKind;
    scope?: AssetScope;
  };
}): string {
  return makeGraphNodeId({
    kind: args.kind,
    sourceKind: args.entry.sourceKind ?? "global",
    scope: args.entry.scope ?? "global",
    name: args.entry.name,
  });
}

function registerManagedRenderedTargets(args: {
  graph: FacultGraph;
  index: FacultIndex;
  sourceIndexes: {
    source: IndexedSource;
    assets: SourceAssets;
    docs: Record<string, AgentEntry>;
  }[];
  currentScope: IndexedSource;
  renderRoot: string;
  managedState: ManagedStateLite | null;
}) {
  const mergedDocs = mergeByName(args.sourceIndexes.map((entry) => entry.docs));
  const mergedToolConfigs = mergeByName(
    args.sourceIndexes.map((entry) => entry.assets.toolConfigs)
  );
  const mergedToolRules = mergeByName(
    args.sourceIndexes.map((entry) => entry.assets.toolRules)
  );
  const toolStates = Object.values(args.managedState?.tools ?? {});
  if (!toolStates.length) {
    return;
  }

  const nodes = args.graph.nodes;
  for (const toolState of toolStates) {
    if (toolState.agentsDir) {
      const extension = managedAgentFileExtension(toolState.tool);
      for (const entry of Object.values(args.index.agents)) {
        const sourceNodeId = sourceNodeIdForEntry({
          kind: "agent",
          entry,
        });
        if (!nodes[sourceNodeId]) {
          continue;
        }
        const targetPath = join(
          toolState.agentsDir,
          `${entry.name}${extension}`
        );
        registerRenderedTargetNode({
          graph: args.graph,
          currentScope: args.currentScope,
          targetPath,
          targetType: "agent",
          sourceNodeId,
          sourceName: entry.name,
          sourceKind: entry.sourceKind ?? "global",
          sourceScope: entry.scope ?? "global",
          renderRoot: args.renderRoot,
          targetTool: toolState.tool,
        });
      }
    }

    const globalDocTargets = [
      {
        name: "AGENTS.global.md",
        path: toolState.globalAgentsPath,
      },
      {
        name: "AGENTS.override.global.md",
        path: toolState.globalAgentsOverridePath,
      },
    ];
    for (const target of globalDocTargets) {
      if (!target.path) {
        continue;
      }
      const entry = mergedDocs[target.name];
      if (!entry) {
        continue;
      }
      const sourceNodeId = sourceNodeIdForEntry({
        kind: "doc",
        entry,
      });
      if (!nodes[sourceNodeId]) {
        continue;
      }
      registerRenderedTargetNode({
        graph: args.graph,
        currentScope: args.currentScope,
        targetPath: target.path,
        targetType: "doc",
        sourceNodeId,
        sourceName: entry.name,
        sourceKind: entry.sourceKind ?? "global",
        sourceScope: entry.scope ?? "global",
        renderRoot: args.renderRoot,
        targetTool: toolState.tool,
      });
    }

    if (toolState.mcpConfig) {
      for (const entry of Object.values(args.index.mcp.servers)) {
        const sourceNodeId = sourceNodeIdForEntry({
          kind: "mcp",
          entry,
        });
        if (!nodes[sourceNodeId]) {
          continue;
        }
        registerRenderedTargetNode({
          graph: args.graph,
          currentScope: args.currentScope,
          targetPath: toolState.mcpConfig,
          targetType: "mcp",
          sourceNodeId,
          sourceName: entry.name,
          sourceKind: entry.sourceKind ?? "global",
          sourceScope: entry.scope ?? "global",
          renderRoot: args.renderRoot,
          targetTool: toolState.tool,
        });
      }
    }

    if (toolState.toolConfig) {
      const entry = mergedToolConfigs[`${toolState.tool}/config.toml`];
      if (entry) {
        const sourceNodeId = sourceNodeIdForEntry({
          kind: "tool-config",
          entry,
        });
        if (nodes[sourceNodeId]) {
          registerRenderedTargetNode({
            graph: args.graph,
            currentScope: args.currentScope,
            targetPath: toolState.toolConfig,
            targetType: "tool-config",
            sourceNodeId,
            sourceName: entry.name,
            sourceKind: entry.sourceKind ?? "global",
            sourceScope: entry.scope ?? "global",
            renderRoot: args.renderRoot,
            targetTool: toolState.tool,
          });
        }
      }
    }

    if (toolState.rulesDir) {
      for (const entry of Object.values(mergedToolRules)) {
        if (!entry.name.startsWith(`${toolState.tool}/rules/`)) {
          continue;
        }
        const relativeRulePath = entry.name.slice(
          `${toolState.tool}/rules/`.length
        );
        const sourceNodeId = sourceNodeIdForEntry({
          kind: "tool-rule",
          entry,
        });
        if (!nodes[sourceNodeId]) {
          continue;
        }
        registerRenderedTargetNode({
          graph: args.graph,
          currentScope: args.currentScope,
          targetPath: join(toolState.rulesDir, relativeRulePath),
          targetType: "tool-rule",
          sourceNodeId,
          sourceName: entry.name,
          sourceKind: entry.sourceKind ?? "global",
          sourceScope: entry.scope ?? "global",
          renderRoot: args.renderRoot,
          targetTool: toolState.tool,
        });
      }
    }
  }
}

interface BuildIndexOptions {
  force?: boolean;
  /** Override the default canonical root dir (useful for tests). */
  rootDir?: string;
  /** Override home directory for generated state placement (useful for tests). */
  homeDir?: string;
  /** Use an enrollment-validated machine state destination. */
  machineStateDir?: string;
}

interface BuildIndexResult {
  index: FacultIndex;
  outputPath: string;
  graph: FacultGraph;
  graphPath: string;
}

async function buildIndexInternal(
  opts?: BuildIndexOptions & { persist?: boolean }
): Promise<BuildIndexResult> {
  const force = Boolean(opts?.force);
  const persist = opts?.persist !== false;
  const homeDir = opts?.homeDir ?? process.env.HOME ?? "";
  const rootDir =
    opts?.rootDir ?? (homeDir ? facultRootDir(homeDir) : facultRootDir());
  const outputPath = opts?.machineStateDir
    ? join(opts.machineStateDir, "ai", "index.json")
    : facultAiIndexPath(homeDir, rootDir);
  const graphPath = opts?.machineStateDir
    ? join(opts.machineStateDir, "ai", "graph.json")
    : facultAiGraphPath(homeDir, rootDir);
  const projectRoot = projectRootFromAiRoot(rootDir, homeDir);
  const projectSlug = projectSlugFromAiRoot(rootDir, homeDir);
  const currentScope: IndexedSource = projectRoot
    ? {
        sourceKind: "project",
        scope: "project",
        rootDir,
        projectRoot,
        projectSlug: projectSlug ?? undefined,
      }
    : {
        sourceKind: "global",
        scope: "global",
        rootDir,
      };
  const managedState = await readManagedState(
    homeDir,
    rootDir,
    opts?.machineStateDir
  );

  let previousIndex: Record<string, unknown> | null = null;
  if (!force) {
    try {
      const existing = Bun.file(outputPath);
      if (await existing.exists()) {
        previousIndex = JSON.parse(await existing.text()) as Record<
          string,
          unknown
        >;
      }
    } catch {
      previousIndex = null;
    }
  }

  if (force && persist) {
    try {
      await Bun.write(outputPath, "");
    } catch {
      // ignore
    }
  }

  const globalRoot = projectRoot
    ? resolveCliContextRoot({ homeDir, scope: "global" })
    : rootDir;
  const sources: IndexedSource[] = [];
  const builtinRoot = facultBuiltinPackRoot();
  try {
    const st = await Bun.file(builtinRoot).stat();
    if (st.isDirectory()) {
      sources.push({
        sourceKind: "builtin",
        scope: "global",
        rootDir: builtinRoot,
      });
    }
  } catch {
    // Ignore missing builtin asset packs in development.
  }
  sources.push({
    sourceKind: "global",
    scope: "global",
    rootDir: globalRoot,
  });
  if (projectRoot) {
    sources.push({
      ...currentScope,
    });
  }

  const sourceIndexes = await Promise.all(
    sources.map(async (source) => ({
      source,
      assets: await indexSourceAssets(source, previousIndex),
      docs: await discoverDocs(source),
      refs: await readTomlRefs(source.rootDir),
    }))
  );

  const skills = mergeByName(sourceIndexes.map((entry) => entry.assets.skills));
  const servers = mergeByName(
    sourceIndexes.map((entry) => entry.assets.mcpServers)
  );
  const agents = mergeByName(sourceIndexes.map((entry) => entry.assets.agents));
  const automations = mergeByName(
    sourceIndexes.map((entry) => entry.assets.automations)
  );
  const snippets = mergeByName(
    sourceIndexes.map((entry) => entry.assets.snippets)
  );
  const instructions = mergeByName(
    sourceIndexes.map((entry) => entry.assets.instructions)
  );

  const index: FacultIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills,
    mcp: { servers },
    agents,
    automations,
    snippets,
    instructions,
  };

  const graph: FacultGraph = {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodes: {},
    edges: [],
  };

  const activeSelections = buildActiveEntryMap(sourceIndexes);

  for (const sourceEntry of sourceIndexes) {
    registerGraphEntries(
      graph,
      sourceEntry.assets.skills,
      "skill",
      activeSelections
    );
    registerGraphEntries(
      graph,
      sourceEntry.assets.mcpServers,
      "mcp",
      activeSelections
    );
    registerGraphEntries(
      graph,
      sourceEntry.assets.agents,
      "agent",
      activeSelections
    );
    registerGraphEntries(
      graph,
      sourceEntry.assets.automations,
      "automation",
      activeSelections
    );
    registerGraphEntries(
      graph,
      sourceEntry.assets.snippets,
      "snippet",
      activeSelections
    );
    registerGraphEntries(
      graph,
      sourceEntry.assets.instructions,
      "instruction",
      activeSelections
    );
    registerGraphEntries(
      graph,
      sourceEntry.assets.toolConfigs,
      "tool-config",
      activeSelections
    );
    registerGraphEntries(
      graph,
      sourceEntry.assets.toolRules,
      "tool-rule",
      activeSelections
    );
    registerGraphEntries(graph, sourceEntry.docs, "doc", activeSelections);
  }

  registerManagedRenderedTargets({
    graph,
    index,
    sourceIndexes,
    currentScope,
    renderRoot: projectRoot ?? homeDir,
    managedState,
  });

  const refsByRoot = new Map<string, Record<string, string>>();
  for (const sourceEntry of sourceIndexes) {
    refsByRoot.set(sourceEntry.source.rootDir, sourceEntry.refs);
  }

  for (const sourceEntry of sourceIndexes) {
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.assets.skills,
      "skill",
      refsByRoot
    );
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.assets.agents,
      "agent",
      refsByRoot
    );
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.assets.automations,
      "automation",
      refsByRoot
    );
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.assets.snippets,
      "snippet",
      refsByRoot
    );
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.assets.instructions,
      "instruction",
      refsByRoot
    );
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.assets.toolConfigs,
      "tool-config",
      refsByRoot
    );
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.assets.toolRules,
      "tool-rule",
      refsByRoot
    );
    await addReferenceEdgesForEntries(
      graph,
      sourceEntry.docs,
      "doc",
      refsByRoot
    );
  }

  if (persist) {
    await mkdir(dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, `${JSON.stringify(index, null, 2)}\n`);
    await Bun.write(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  }

  return { index, outputPath, graph, graphPath };
}

export async function buildIndex(
  opts?: BuildIndexOptions
): Promise<BuildIndexResult> {
  return await buildIndexInternal({ ...opts, persist: true });
}

export async function buildIndexSnapshot(
  opts?: BuildIndexOptions
): Promise<Pick<BuildIndexResult, "graph" | "index">> {
  const { graph, index } = await buildIndexInternal({
    ...opts,
    persist: false,
  });
  return { graph, index };
}

export async function indexCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  if (
    parsed.argv.includes("--help") ||
    parsed.argv.includes("-h") ||
    parsed.argv[0] === "help"
  ) {
    console.log(`fclt index — rebuild the generated index for the canonical store

Usage:
  fclt index [--force] [--root PATH|--global|--project]

Options:
  --force   Rebuild index from scratch (ignore existing metadata)
`);
    return;
  }
  const force = parsed.argv.includes("--force");
  const homeDir = process.env.HOME?.trim() || homedir();
  const rootDir = resolveCliContextRoot({
    homeDir,
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });
  const scope = resolveCliContextScope({
    homeDir,
    rootDir,
    scope: parsed.scope,
  });
  const { outputPath } = await withFacultRootScope(
    { rootDir, scope },
    async () => buildIndex({ force, homeDir, rootDir })
  );
  console.log(`Index written to ${outputPath}`);
}
