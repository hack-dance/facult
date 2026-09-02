import { parse as parseYaml } from "yaml";

const CLAUDE_AGENT_DESTINATION_RE =
  /^\.claude\/agents\/([a-z0-9][a-z0-9-]*?)\.md$/;
const CLAUDE_SKILL_DESTINATION_RE =
  /^\.claude\/skills\/([a-z0-9][a-z0-9-]*?)\/SKILL\.md$/;
const ENVIRONMENT_REFERENCE_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const HEADER_ENVIRONMENT_REFERENCE_RE =
  /^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const PORTABLE_CAPABILITY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const PORTABLE_MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_VALUE_RE =
  /(?:\bsk-[A-Za-z0-9_-]{10,}|\bghp_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,})/;
const CLAUDE_MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]*$/;

const CLAUDE_AGENT_FIELDS = new Set([
  "background",
  "color",
  "description",
  "disallowedTools",
  "effort",
  "experimental",
  "initialPrompt",
  "isolation",
  "maxTurns",
  "mcpServers",
  "memory",
  "model",
  "name",
  "permissionMode",
  "skills",
  "tools",
]);
const CLAUDE_SKILL_FIELDS = new Set([
  "agent",
  "allowed-tools",
  "argument-hint",
  "context",
  "description",
  "disable-model-invocation",
  "model",
  "name",
  "user-invocable",
]);
const CLAUDE_SETTINGS_FIELDS = new Set([
  "$schema",
  "agent",
  "disabledMcpjsonServers",
  "enabledMcpjsonServers",
  "enabledPlugins",
  "extraKnownMarketplaces",
  "includeCoAuthoredBy",
  "permissions",
]);
const CLAUDE_AGENT_MODELS = new Set([
  "fable",
  "haiku",
  "inherit",
  "opus",
  "sonnet",
]);
const CLAUDE_PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "manual",
  "plan",
]);
const CLAUDE_MEMORY_SCOPES = new Set(["local", "project", "user"]);
const CLAUDE_EFFORT_LEVELS = new Set(["high", "low", "max", "medium", "xhigh"]);
const CLAUDE_ISOLATION_MODES = new Set(["worktree"]);
const CLAUDE_AGENT_COLORS = new Set([
  "blue",
  "cyan",
  "green",
  "orange",
  "pink",
  "purple",
  "red",
  "yellow",
]);
const CLAUDE_CACHE_TTLS = new Set(["1h", "5m"]);

export type ClaudeProjectRenderProducer =
  | "claude-agent-md"
  | "claude-mcp-json"
  | "claude-root-claude-md"
  | "claude-settings-json"
  | "claude-skill-md";

export type ClaudeProjectRenderDiagnosticCode =
  | "FCLT_PR_CLAUDE_INVALID_TARGET"
  | "FCLT_PR_CLAUDE_SECRET_VALUE"
  | "FCLT_PR_CLAUDE_UNSUPPORTED_CAPABILITY";

export class ClaudeProjectRenderDiagnosticError extends Error {
  readonly code: ClaudeProjectRenderDiagnosticCode;

  constructor(code: ClaudeProjectRenderDiagnosticCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ClaudeProjectRenderDiagnosticError";
    this.code = code;
  }
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

function invalid(message: string): never {
  throw new ClaudeProjectRenderDiagnosticError(
    "FCLT_PR_CLAUDE_INVALID_TARGET",
    message
  );
}

function unsupported(message: string): never {
  throw new ClaudeProjectRenderDiagnosticError(
    "FCLT_PR_CLAUDE_UNSUPPORTED_CAPABILITY",
    message
  );
}

function secret(message: string): never {
  throw new ClaudeProjectRenderDiagnosticError(
    "FCLT_PR_CLAUDE_SECRET_VALUE",
    message
  );
}

function parseJson(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid(`${label} must be strict JSON.`);
  }
  if (!isPlainObject(parsed)) {
    invalid(`${label} must contain a JSON object.`);
  }
  return parsed;
}

function parseFrontmatter(
  text: string,
  label: string
): { body: string; frontmatter: Record<string, unknown> } {
  if (!text.startsWith("---\n")) {
    invalid(`${label} must start with YAML frontmatter.`);
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    invalid(`${label} has unterminated YAML frontmatter.`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text.slice(4, end));
  } catch {
    invalid(`${label} frontmatter must be valid YAML.`);
  }
  if (!isPlainObject(parsed)) {
    invalid(`${label} frontmatter must be a mapping.`);
  }
  return { body: text.slice(end + 5), frontmatter: parsed };
}

function assertNoRecognizableSecretValues(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (SECRET_VALUE_RE.test(value)) {
      secret(`${label} contains a secret-shaped literal.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertNoRecognizableSecretValues(child, `${label}[${index}]`);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertNoRecognizableSecretValues(child, `${label}.${key}`);
    }
  }
}

function assertSupportedFields(args: {
  allowed: ReadonlySet<string>;
  label: string;
  value: Record<string, unknown>;
}): void {
  const unsupportedFields = Object.keys(args.value)
    .filter((key) => !args.allowed.has(key))
    .sort();
  if (unsupportedFields.length > 0) {
    unsupported(
      `${args.label} contains unsupported fields: ${unsupportedFields.join(", ")}.`
    );
  }
}

function assertPortableName(value: unknown, label: string): string {
  if (typeof value !== "string" || !PORTABLE_CAPABILITY_NAME_RE.test(value)) {
    invalid(`${label} must use lowercase letters, numbers, and hyphens.`);
  }
  return value;
}

function assertNonEmptyDescription(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${label} must be a non-empty string.`);
  }
}

function assertOptionalStringList(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0 ||
    values.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    invalid(`${label} must be a non-empty string or list of strings.`);
  }
}

function assertOptionalEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !allowed.has(value))
  ) {
    invalid(`${label} has an unsupported value.`);
  }
}

function assertOptionalExperimental(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!(isPlainObject(value) && hasExactKeys(value, ["cacheTtl"]))) {
    invalid(
      "Claude agent experimental must contain only cacheTtl set to 5m or 1h."
    );
  }
  assertOptionalEnum(
    value.cacheTtl,
    CLAUDE_CACHE_TTLS,
    "Claude agent experimental cacheTtl"
  );
}

function validateClaudeAgentFrontmatter(
  frontmatter: Record<string, unknown>
): void {
  assertOptionalStringList(frontmatter.tools, "Claude agent tools");
  assertOptionalStringList(
    frontmatter.disallowedTools,
    "Claude agent disallowedTools"
  );
  assertOptionalStringList(frontmatter.skills, "Claude agent skills");
  if (
    frontmatter.model !== undefined &&
    (typeof frontmatter.model !== "string" ||
      !(
        CLAUDE_AGENT_MODELS.has(frontmatter.model) ||
        CLAUDE_MODEL_ID_RE.test(frontmatter.model)
      ))
  ) {
    invalid("Claude agent model has an unsupported value.");
  }
  assertOptionalEnum(
    frontmatter.permissionMode,
    CLAUDE_PERMISSION_MODES,
    "Claude agent permissionMode"
  );
  if (
    frontmatter.maxTurns !== undefined &&
    (!Number.isSafeInteger(frontmatter.maxTurns) ||
      Number(frontmatter.maxTurns) < 1)
  ) {
    invalid("Claude agent maxTurns must be a positive integer.");
  }
  assertOptionalEnum(
    frontmatter.memory,
    CLAUDE_MEMORY_SCOPES,
    "Claude agent memory"
  );
  if (
    frontmatter.background !== undefined &&
    typeof frontmatter.background !== "boolean"
  ) {
    invalid("Claude agent background must be a boolean.");
  }
  assertOptionalEnum(
    frontmatter.effort,
    CLAUDE_EFFORT_LEVELS,
    "Claude agent effort"
  );
  assertOptionalEnum(
    frontmatter.isolation,
    CLAUDE_ISOLATION_MODES,
    "Claude agent isolation"
  );
  assertOptionalEnum(
    frontmatter.color,
    CLAUDE_AGENT_COLORS,
    "Claude agent color"
  );
  if (
    frontmatter.initialPrompt !== undefined &&
    (typeof frontmatter.initialPrompt !== "string" ||
      !frontmatter.initialPrompt.trim())
  ) {
    invalid("Claude agent initialPrompt must be a non-empty string.");
  }
  assertOptionalExperimental(frontmatter.experimental);
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

function stableJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function mergeDisjointObjects(args: {
  label: string;
  values: Record<string, unknown>[];
}): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const value of args.values) {
    for (const [key, child] of Object.entries(value)) {
      if (key in merged) {
        invalid(`${args.label} key has multiple source owners: ${key}.`);
      }
      merged[key] = child;
    }
  }
  return merged;
}

function validateClaudeSkill(text: string, destination: string): void {
  const match = CLAUDE_SKILL_DESTINATION_RE.exec(destination);
  if (!match) {
    invalid(
      "claude-skill-md destination must be .claude/skills/<name>/SKILL.md."
    );
  }
  const { body, frontmatter } = parseFrontmatter(text, "Claude skill SKILL.md");
  assertSupportedFields({
    allowed: CLAUDE_SKILL_FIELDS,
    label: "Claude skill frontmatter",
    value: frontmatter,
  });
  const name = assertPortableName(
    frontmatter.name,
    "Claude skill frontmatter name"
  );
  if (name !== match[1]) {
    invalid(
      "Claude skill frontmatter name must match its destination directory."
    );
  }
  assertNonEmptyDescription(
    frontmatter.description,
    "Claude skill frontmatter description"
  );
  if (!body.trim()) {
    invalid("Claude skill body must not be empty.");
  }
  assertNoRecognizableSecretValues(text, "Claude skill");
}

function validateClaudeAgent(text: string, destination: string): void {
  const match = CLAUDE_AGENT_DESTINATION_RE.exec(destination);
  if (!match) {
    invalid("claude-agent-md destination must be .claude/agents/<name>.md.");
  }
  const { body, frontmatter } = parseFrontmatter(text, "Claude agent");
  assertSupportedFields({
    allowed: CLAUDE_AGENT_FIELDS,
    label: "Claude agent frontmatter",
    value: frontmatter,
  });
  const name = assertPortableName(frontmatter.name, "Claude agent name");
  if (name !== match[1]) {
    invalid("Claude agent name must match its destination filename.");
  }
  assertNonEmptyDescription(
    frontmatter.description,
    "Claude agent description"
  );
  validateClaudeAgentFrontmatter(frontmatter);
  if (!body.trim()) {
    invalid("Claude agent body must not be empty.");
  }
  if (
    frontmatter.mcpServers !== undefined &&
    (!Array.isArray(frontmatter.mcpServers) ||
      frontmatter.mcpServers.some(
        (entry) =>
          typeof entry !== "string" || !PORTABLE_MCP_NAME_RE.test(entry)
      ))
  ) {
    unsupported(
      "Claude agent mcpServers supports configured server-name references only; inline servers are not supported by producer version 1."
    );
  }
  assertNoRecognizableSecretValues(text, "Claude agent");
}

function validateMcpEnvironment(
  value: unknown,
  label: string,
  referencePattern: RegExp
): void {
  if (!isPlainObject(value)) {
    invalid(`${label} must be an object.`);
  }
  for (const [key, environmentReference] of Object.entries(value)) {
    if (!key.trim()) {
      invalid(`${label} contains an empty key.`);
    }
    if (
      typeof environmentReference !== "string" ||
      !referencePattern.test(environmentReference)
    ) {
      secret(`${label}.${key} must use a runtime environment reference.`);
    }
  }
}

function validateMcpServer(value: unknown, label: string): void {
  if (!isPlainObject(value)) {
    invalid(`${label} must be an object.`);
  }
  const allowed = new Set([
    "args",
    "command",
    "env",
    "headers",
    "timeout",
    "type",
    "url",
  ]);
  assertSupportedFields({ allowed, label, value });
  const hasCommand =
    typeof value.command === "string" && Boolean(value.command.trim());
  const hasUrl = typeof value.url === "string" && Boolean(value.url.trim());
  if (hasCommand === hasUrl) {
    invalid(`${label} must define exactly one of command or url.`);
  }
  if (hasCommand && value.type !== undefined && value.type !== "stdio") {
    invalid(`${label}.type must be stdio when command is used.`);
  }
  if (
    hasUrl &&
    value.type !== "http" &&
    value.type !== "sse" &&
    value.type !== "ws"
  ) {
    invalid(`${label}.type must be http, sse, or ws when url is used.`);
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      value.args.some((argument) => typeof argument !== "string"))
  ) {
    invalid(`${label}.args must be an array of strings.`);
  }
  if (value.timeout !== undefined && typeof value.timeout !== "number") {
    invalid(`${label}.timeout must be a number.`);
  }
  if (value.env !== undefined) {
    validateMcpEnvironment(value.env, `${label}.env`, ENVIRONMENT_REFERENCE_RE);
  }
  if (value.headers !== undefined) {
    validateMcpEnvironment(
      value.headers,
      `${label}.headers`,
      HEADER_ENVIRONMENT_REFERENCE_RE
    );
  }
  assertNoRecognizableSecretValues(value, label);
}

function renderClaudeMcp(sourceTexts: string[]): string {
  const fragments = sourceTexts.map((source, index) => {
    const parsed = parseJson(source, `Claude MCP source ${index + 1}`);
    if (!hasExactKeys(parsed, ["mcpServers"])) {
      invalid(
        `Claude MCP source ${index + 1} must contain exactly mcpServers.`
      );
    }
    if (!isPlainObject(parsed.mcpServers)) {
      invalid(`Claude MCP source ${index + 1}.mcpServers must be an object.`);
    }
    return parsed.mcpServers;
  });
  const mcpServers = mergeDisjointObjects({
    label: "Claude MCP server",
    values: fragments,
  });
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!PORTABLE_MCP_NAME_RE.test(name)) {
      invalid(`Claude MCP server name is not portable: ${name}.`);
    }
    validateMcpServer(server, `Claude MCP server ${name}`);
  }
  return stableJson({ mcpServers });
}

function validateStringArray(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    invalid(`${label} must be an array of non-empty strings.`);
  }
}

function validateClaudePermissions(value: unknown): void {
  if (!isPlainObject(value)) {
    invalid("Claude project settings permissions must be an object.");
  }
  const allowed = new Set(["allow", "ask", "deny"]);
  assertSupportedFields({
    allowed,
    label: "Claude project settings permissions",
    value,
  });
  for (const [key, rules] of Object.entries(value)) {
    validateStringArray(rules, `Claude project settings permissions.${key}`);
  }
}

function validateEnabledPlugins(value: unknown): void {
  if (!isPlainObject(value)) {
    invalid("Claude project settings enabledPlugins must be an object.");
  }
  for (const [name, enabled] of Object.entries(value)) {
    if (!name.includes("@") || typeof enabled !== "boolean") {
      invalid(
        "Claude project settings enabledPlugins must map plugin@marketplace names to booleans."
      );
    }
  }
}

function validateMarketplaces(value: unknown): void {
  if (!isPlainObject(value)) {
    invalid(
      "Claude project settings extraKnownMarketplaces must be an object."
    );
  }
  for (const [name, marketplace] of Object.entries(value)) {
    const label = `Claude project settings extraKnownMarketplaces.${name}`;
    if (!isPlainObject(marketplace)) {
      invalid(`${label} must be an object.`);
    }
    const keys =
      marketplace.autoUpdate === undefined
        ? ["source"]
        : ["autoUpdate", "source"];
    if (!hasExactKeys(marketplace, keys)) {
      unsupported(
        `${label} supports only a GitHub source and optional autoUpdate in producer version 1.`
      );
    }
    if (
      marketplace.autoUpdate !== undefined &&
      typeof marketplace.autoUpdate !== "boolean"
    ) {
      invalid(`${label}.autoUpdate must be a boolean.`);
    }
    if (
      !(
        isPlainObject(marketplace.source) &&
        hasExactKeys(marketplace.source, ["repo", "source"])
      ) ||
      marketplace.source.source !== "github" ||
      typeof marketplace.source.repo !== "string" ||
      !GITHUB_REPOSITORY_RE.test(marketplace.source.repo)
    ) {
      unsupported(
        `${label}.source must be a GitHub owner/repository source in producer version 1.`
      );
    }
  }
}

function renderClaudeSettings(sourceTexts: string[]): string {
  const parsed = sourceTexts.map((source, index) =>
    parseJson(source, `Claude project settings source ${index + 1}`)
  );
  const settings = mergeDisjointObjects({
    label: "Claude project settings",
    values: parsed,
  });
  if ("env" in settings) {
    secret(
      "Claude project settings env embeds values; inject runtime environment outside committed settings."
    );
  }
  assertSupportedFields({
    allowed: CLAUDE_SETTINGS_FIELDS,
    label: "Claude project settings",
    value: settings,
  });
  if (settings.permissions !== undefined) {
    validateClaudePermissions(settings.permissions);
  }
  if (settings.enabledPlugins !== undefined) {
    validateEnabledPlugins(settings.enabledPlugins);
  }
  if (settings.extraKnownMarketplaces !== undefined) {
    validateMarketplaces(settings.extraKnownMarketplaces);
  }
  for (const key of ["disabledMcpjsonServers", "enabledMcpjsonServers"]) {
    if (settings[key] !== undefined) {
      validateStringArray(settings[key], `Claude project settings ${key}`);
    }
  }
  if (
    settings.agent !== undefined &&
    (typeof settings.agent !== "string" ||
      !PORTABLE_CAPABILITY_NAME_RE.test(settings.agent))
  ) {
    invalid("Claude project settings agent must be a portable agent name.");
  }
  if (
    settings.includeCoAuthoredBy !== undefined &&
    typeof settings.includeCoAuthoredBy !== "boolean"
  ) {
    invalid("Claude project settings includeCoAuthoredBy must be a boolean.");
  }
  assertNoRecognizableSecretValues(settings, "Claude project settings");
  return stableJson(settings);
}

export function renderClaudeProjectTarget(args: {
  destination: string;
  producer: ClaudeProjectRenderProducer;
  sourceTexts: string[];
  tool: string;
}): string {
  if (args.tool !== "claude") {
    invalid(`${args.producer} requires tool = "claude".`);
  }
  if (args.producer === "claude-root-claude-md") {
    if (args.destination !== "CLAUDE.md") {
      invalid("claude-root-claude-md destination must be CLAUDE.md.");
    }
    if (
      args.sourceTexts.length !== 1 ||
      args.sourceTexts[0]?.trim() !== "@AGENTS.md"
    ) {
      invalid(
        "claude-root-claude-md requires one body-less @AGENTS.md import source."
      );
    }
    return "@AGENTS.md\n";
  }
  if (args.producer === "claude-skill-md") {
    const [source] = args.sourceTexts;
    if (source === undefined || args.sourceTexts.length !== 1) {
      invalid("claude-skill-md requires exactly one source.");
    }
    validateClaudeSkill(source, args.destination);
    return source;
  }
  if (args.producer === "claude-agent-md") {
    const [source] = args.sourceTexts;
    if (source === undefined || args.sourceTexts.length !== 1) {
      invalid("claude-agent-md requires exactly one source.");
    }
    validateClaudeAgent(source, args.destination);
    return source;
  }
  if (args.producer === "claude-mcp-json") {
    if (args.destination !== ".mcp.json") {
      invalid("claude-mcp-json destination must be .mcp.json.");
    }
    return renderClaudeMcp(args.sourceTexts);
  }
  if (args.destination !== ".claude/settings.json") {
    invalid("claude-settings-json destination must be .claude/settings.json.");
  }
  return renderClaudeSettings(args.sourceTexts);
}
