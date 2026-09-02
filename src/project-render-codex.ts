import { parse as parseYaml } from "yaml";

const CODEX_AGENT_DESTINATION_RE =
  /^\.codex\/agents\/([a-z0-9][a-z0-9_-]*?)\.toml$/;
const CODEX_SKILL_DESTINATION_RE =
  /^\.agents\/skills\/([a-z0-9][a-z0-9_-]*?)\/SKILL\.md$/;
const ENVIRONMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORTABLE_CAPABILITY_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SECRET_VALUE_RE =
  /(?:\bsk-[A-Za-z0-9_-]{10,}|\bghp_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,})/;

export type CodexProjectRenderProducer =
  | "codex-agent-toml"
  | "codex-config-toml"
  | "codex-root-agents-md"
  | "codex-skill-md";

export type ProjectRenderDiagnosticCode =
  | "FCLT_PR_CODEX_INVALID_TARGET"
  | "FCLT_PR_CODEX_SECRET_VALUE"
  | "FCLT_PR_CODEX_UNSUPPORTED_CAPABILITY";

export class ProjectRenderDiagnosticError extends Error {
  readonly code: ProjectRenderDiagnosticCode;

  constructor(code: ProjectRenderDiagnosticCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProjectRenderDiagnosticError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ProjectRenderDiagnosticError(
    "FCLT_PR_CODEX_INVALID_TARGET",
    message
  );
}

function unsupported(message: string): never {
  throw new ProjectRenderDiagnosticError(
    "FCLT_PR_CODEX_UNSUPPORTED_CAPABILITY",
    message
  );
}

function secret(message: string): never {
  throw new ProjectRenderDiagnosticError("FCLT_PR_CODEX_SECRET_VALUE", message);
}

function parseToml(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    invalid(`${label} must be valid TOML.`);
  }
  if (!isPlainObject(parsed)) {
    invalid(`${label} must contain a TOML table.`);
  }
  return parsed;
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

function assertEnvironmentName(value: unknown, label: string): void {
  if (typeof value !== "string" || !ENVIRONMENT_NAME_RE.test(value)) {
    invalid(`${label} must be an environment variable name.`);
  }
}

function validateEnvironmentReferences(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    invalid(`${label} must be an array.`);
  }
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (typeof entry === "string") {
      assertEnvironmentName(entry, entryLabel);
      return;
    }
    if (!isPlainObject(entry)) {
      invalid(`${entryLabel} must be a name or a runtime source reference.`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "source") {
      invalid(`${entryLabel} must contain exactly name and source.`);
    }
    assertEnvironmentName(entry.name, `${entryLabel}.name`);
    if (entry.source !== "local" && entry.source !== "remote") {
      invalid(`${entryLabel}.source must be local or remote.`);
    }
  });
}

function validateEnvironmentHeaderReferences(
  value: unknown,
  label: string
): void {
  if (!isPlainObject(value)) {
    invalid(`${label} must be a table of header names to environment names.`);
  }
  for (const [header, environmentName] of Object.entries(value)) {
    if (!header.trim()) {
      invalid(`${label} contains an empty header name.`);
    }
    assertEnvironmentName(environmentName, `${label}.${header}`);
  }
}

function validateMcpServers(value: unknown, label: string): void {
  if (!isPlainObject(value)) {
    invalid(`${label} must be a table.`);
  }
  for (const [name, server] of Object.entries(value)) {
    const serverLabel = `${label}.${name}`;
    if (!name.trim()) {
      invalid(`${label} contains an empty server name.`);
    }
    if (!isPlainObject(server)) {
      invalid(`${serverLabel} must be a table.`);
    }
    if ("env" in server) {
      secret(
        `${serverLabel}.env embeds values; use env_vars runtime references instead.`
      );
    }
    if ("http_headers" in server) {
      secret(
        `${serverLabel}.http_headers embeds values; use env_http_headers runtime references instead.`
      );
    }
    const hasCommand =
      typeof server.command === "string" && Boolean(server.command.trim());
    const hasUrl = typeof server.url === "string" && Boolean(server.url.trim());
    if (hasCommand === hasUrl) {
      invalid(`${serverLabel} must define exactly one of command or url.`);
    }
    if (server.env_vars !== undefined) {
      const envVars = server.env_vars;
      validateEnvironmentReferences(envVars, `${serverLabel}.env_vars`);
      if (
        Array.isArray(envVars) &&
        envVars.some(
          (entry) => isPlainObject(entry) && entry.source === "remote"
        ) &&
        server.experimental_environment !== "remote"
      ) {
        invalid(
          `${serverLabel} remote env_vars require experimental_environment = "remote".`
        );
      }
    }
    if (
      server.args !== undefined &&
      (!Array.isArray(server.args) ||
        server.args.some((argument) => typeof argument !== "string"))
    ) {
      invalid(`${serverLabel}.args must be an array of strings.`);
    }
    if (server.bearer_token_env_var !== undefined) {
      assertEnvironmentName(
        server.bearer_token_env_var,
        `${serverLabel}.bearer_token_env_var`
      );
    }
    if (server.env_http_headers !== undefined) {
      validateEnvironmentHeaderReferences(
        server.env_http_headers,
        `${serverLabel}.env_http_headers`
      );
    }
  }
}

function validateCodexConfig(
  parsed: Record<string, unknown>,
  label: string
): void {
  const unsupportedProjectKeys = [
    "apps_mcp_product_sku",
    "chatgpt_base_url",
    "experimental_realtime_ws_base_url",
    "model_provider",
    "model_providers",
    "notify",
    "openai_base_url",
    "otel",
    "profile",
    "profiles",
  ].filter((key) => key in parsed);
  if (unsupportedProjectKeys.length > 0) {
    unsupported(
      `${label} contains user-level-only keys: ${unsupportedProjectKeys.join(", ")}.`
    );
  }
  if ("plugins" in parsed) {
    unsupported(
      `${label} contains plugin state; Codex plugin installation and enablement are user-owned, not a project render target.`
    );
  }
  if (parsed.mcp_servers !== undefined) {
    validateMcpServers(parsed.mcp_servers, `${label}.mcp_servers`);
  }
  assertNoRecognizableSecretValues(parsed, label);
}

function parseSkillFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n")) {
    invalid("Codex skill SKILL.md must start with YAML frontmatter.");
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    invalid("Codex skill SKILL.md has unterminated YAML frontmatter.");
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text.slice(4, end));
  } catch {
    invalid("Codex skill SKILL.md frontmatter must be valid YAML.");
  }
  if (!isPlainObject(parsed)) {
    invalid("Codex skill SKILL.md frontmatter must be a mapping.");
  }
  return parsed;
}

function validateCodexSkill(text: string, destination: string): void {
  const match = CODEX_SKILL_DESTINATION_RE.exec(destination);
  if (!match) {
    invalid(
      "codex-skill-md destination must be .agents/skills/<name>/SKILL.md."
    );
  }
  const directoryName = match[1];
  const frontmatter = parseSkillFrontmatter(text);
  if (
    typeof frontmatter.name !== "string" ||
    !PORTABLE_CAPABILITY_NAME_RE.test(frontmatter.name)
  ) {
    invalid("Codex skill frontmatter name must be a portable skill name.");
  }
  if (frontmatter.name !== directoryName) {
    invalid(
      "Codex skill frontmatter name must match its destination directory."
    );
  }
  if (
    typeof frontmatter.description !== "string" ||
    !frontmatter.description.trim()
  ) {
    invalid("Codex skill frontmatter description must be a non-empty string.");
  }
}

function validateCodexAgent(text: string, destination: string): void {
  const match = CODEX_AGENT_DESTINATION_RE.exec(destination);
  if (!match) {
    invalid("codex-agent-toml destination must be .codex/agents/<name>.toml.");
  }
  const parsed = parseToml(text, "Codex agent");
  for (const key of ["name", "description", "developer_instructions"]) {
    if (typeof parsed[key] !== "string" || !parsed[key].trim()) {
      invalid(`Codex agent ${key} must be a non-empty string.`);
    }
  }
  if (!PORTABLE_CAPABILITY_NAME_RE.test(String(parsed.name))) {
    invalid("Codex agent name must be a portable agent name.");
  }
  if (parsed.name !== match[1]) {
    invalid("Codex agent name must match its destination filename.");
  }
  if (parsed.mcp_servers !== undefined) {
    validateMcpServers(parsed.mcp_servers, "Codex agent.mcp_servers");
  }
  assertNoRecognizableSecretValues(parsed, "Codex agent");
}

export function renderCodexProjectTarget(args: {
  destination: string;
  producer: CodexProjectRenderProducer;
  sourceTexts: string[];
  tool: string;
}): string {
  if (args.tool !== "codex") {
    invalid(`${args.producer} requires tool = "codex".`);
  }
  if (args.producer === "codex-root-agents-md") {
    if (args.destination !== "AGENTS.md") {
      invalid("codex-root-agents-md destination must be AGENTS.md.");
    }
    const output = args.sourceTexts.join("\n");
    if (!output.trim()) {
      invalid("Codex root AGENTS.md must not be empty.");
    }
    return output;
  }
  if (args.producer === "codex-skill-md") {
    const [source] = args.sourceTexts;
    if (source === undefined || args.sourceTexts.length !== 1) {
      invalid("codex-skill-md requires exactly one source.");
    }
    validateCodexSkill(source, args.destination);
    return source;
  }
  if (args.producer === "codex-agent-toml") {
    const [source] = args.sourceTexts;
    if (source === undefined || args.sourceTexts.length !== 1) {
      invalid("codex-agent-toml requires exactly one source.");
    }
    validateCodexAgent(source, args.destination);
    return source;
  }
  if (args.destination !== ".codex/config.toml") {
    invalid("codex-config-toml destination must be .codex/config.toml.");
  }
  const output = args.sourceTexts.join("\n");
  validateCodexConfig(
    parseToml(output, "Codex project config"),
    "Codex project config"
  );
  return output;
}
