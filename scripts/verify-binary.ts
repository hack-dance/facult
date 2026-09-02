#!/usr/bin/env bun

import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { auditPersistenceContract } from "./verify-binary-audit-contract";

const repoRoot = resolve(import.meta.dir, "..");
const defaultBinary =
  process.platform === "win32" ? "dist/fclt.exe" : "dist/fclt";
const binaryPath = resolve(repoRoot, process.argv[2] ?? defaultBinary);
const tempHome = await mkdtemp(join(tmpdir(), "fclt-binary-verify-"));
const tempProcessTmp = join(tempHome, "tmp");
const legacyManagedMutationFlag = "--allow-legacy-managed-mutation";
await mkdir(tempProcessTmp, { recursive: true });

async function execute(args: string[]): Promise<{
  code: number;
  stderr: string;
  stdout: string;
}> {
  const env = { ...process.env };
  env.FACULT_ROOT_DIR = undefined;
  env.FACULT_ROOT_SCOPE = undefined;
  env.FCLT_ALLOW_LEGACY_MANAGED_MUTATION = undefined;
  const proc = Bun.spawn([binaryPath, ...args], {
    cwd: tempHome,
    env: {
      ...env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: join(tempHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(tempHome, "AppData", "Local"),
      TEMP: tempProcessTmp,
      TMP: tempProcessTmp,
      FACULT_CACHE_DIR: join(tempHome, ".cache", "fclt"),
      FACULT_LOCAL_STATE_DIR: join(tempHome, ".local", "state", "fclt"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

async function run(args: string[]): Promise<string> {
  const { code, stderr, stdout } = await execute(args);
  if (code !== 0) {
    throw new Error(
      `${binaryPath} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`
    );
  }
  return stdout;
}

async function runBlocked(args: string[]): Promise<string> {
  const { code, stderr, stdout } = await execute(args);
  if (code === 0) {
    throw new Error(`${binaryPath} ${args.join(" ")} unexpectedly succeeded`);
  }
  return stderr || stdout;
}

await run(["--help"]);

const version = (await run(["--version"])).trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(
    `Expected semver from --version, got ${JSON.stringify(version)}`
  );
}

const status = JSON.parse(await run(["status", "--json"])) as {
  packageVersion?: string;
  version?: number;
};
if (status.version !== 1) {
  throw new Error(
    `Expected status version 1, got ${JSON.stringify(status.version)}`
  );
}
if (status.packageVersion !== version) {
  throw new Error(
    `Expected status packageVersion ${version}, got ${JSON.stringify(status.packageVersion)}`
  );
}

async function verifyProjectRenderer(): Promise<void> {
  const expectedProjectTargets = 9;
  const projectRenderRoot = join(tempHome, "project-render-proof");
  const projectRenderCanonicalRoot = join(projectRenderRoot, ".ai");
  for (const directory of [
    ["agents", "reviewer"],
    ["mcp"],
    ["skills", "review"],
    ["tools", "claude"],
    ["tools", "codex"],
  ]) {
    await mkdir(join(projectRenderCanonicalRoot, ...directory), {
      recursive: true,
    });
  }
  await Bun.write(
    join(projectRenderCanonicalRoot, "project-render.toml"),
    `schema_version = 1
exclusive_roots = [".agents/skills", ".claude/agents", ".claude/skills", ".codex/agents"]

[[targets]]
id = "root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "codex-root-agents-md"
producer_version = 1
sources = ["AGENTS.project.md"]

[[targets]]
id = "review-skill"
tool = "codex"
destination = ".agents/skills/review/SKILL.md"
mode = "0644"
producer = "codex-skill-md"
producer_version = 1
sources = ["skills/review/SKILL.md"]

[[targets]]
id = "reviewer-agent"
tool = "codex"
destination = ".codex/agents/reviewer.toml"
mode = "0644"
producer = "codex-agent-toml"
producer_version = 1
sources = ["agents/reviewer/agent.toml"]

[[targets]]
id = "codex-config"
tool = "codex"
destination = ".codex/config.toml"
mode = "0644"
producer = "codex-config-toml"
producer_version = 1
sources = ["tools/codex/config.toml"]

[[targets]]
id = "claude-root"
tool = "claude"
destination = "CLAUDE.md"
mode = "0644"
producer = "claude-root-claude-md"
producer_version = 1
sources = ["tools/claude/CLAUDE.md"]

[[targets]]
id = "claude-review-skill"
tool = "claude"
destination = ".claude/skills/review/SKILL.md"
mode = "0644"
producer = "claude-skill-md"
producer_version = 1
sources = ["skills/review/SKILL.md"]

[[targets]]
id = "claude-reviewer-agent"
tool = "claude"
destination = ".claude/agents/reviewer.md"
mode = "0644"
producer = "claude-agent-md"
producer_version = 1
sources = ["agents/reviewer/claude.md"]

[[targets]]
id = "claude-mcp"
tool = "claude"
destination = ".mcp.json"
mode = "0644"
producer = "claude-mcp-json"
producer_version = 1
sources = ["mcp/claude.json"]

[[targets]]
id = "claude-settings"
tool = "claude"
destination = ".claude/settings.json"
mode = "0644"
producer = "claude-settings-json"
producer_version = 1
sources = ["tools/claude/settings.json"]
`
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "AGENTS.project.md"),
    "# Compiled project agents\n"
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review compiled output.\n---\n\n# Compiled review\n"
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "agents", "reviewer", "agent.toml"),
    'name = "reviewer"\ndescription = "Review compiled output."\ndeveloper_instructions = "Return evidence."\n'
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "agents", "reviewer", "claude.md"),
    "---\nname: reviewer\ndescription: Review compiled output.\ntools: Read, Grep, Glob\n---\n\nReturn evidence.\n"
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "tools", "codex", "config.toml"),
    '[mcp_servers.docs]\nurl = "https://developers.openai.com/mcp"\nbearer_token_env_var = "DOCS_TOKEN"\n'
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "tools", "claude", "CLAUDE.md"),
    "@AGENTS.md\n"
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "mcp", "claude.json"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands this literal at runtime.
    '{"mcpServers":{"docs":{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}\n'
  );
  await Bun.write(
    join(projectRenderCanonicalRoot, "tools", "claude", "settings.json"),
    '{"permissions":{"deny":["Read(./.env)"]}}\n'
  );
  const projectRenderArgs = [
    "--root",
    projectRenderCanonicalRoot,
    "--project-root",
    projectRenderRoot,
    "--json",
  ];
  const compilerPlatform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const lockResult = JSON.parse(
    await run([
      "project",
      "lock",
      ...projectRenderArgs,
      "--pack-version",
      "compiled-proof-1.0.0",
      "--pack-schema-version",
      "1",
      "--compiler-compatibility",
      `>=${version} <3.0.0`,
      "--compiler-artifact",
      `${compilerPlatform}=${binaryPath}`,
    ])
  ) as { lock?: { compiler?: { version?: string } }; path?: string };
  if (
    lockResult.path !== "project-render.lock.json" ||
    lockResult.lock?.compiler?.version !== version
  ) {
    throw new Error("Compiled project lock did not bind compiler identity");
  }
  const projectRenderPlanText = await run([
    "project",
    "render-plan",
    ...projectRenderArgs,
  ]);
  const projectRenderPlan = JSON.parse(projectRenderPlanText) as {
    compiler?: { version?: string };
    lock?: {
      compilerArtifact?: { platform?: string };
      pack?: { version?: string };
    };
    planId?: string;
    targets?: Array<{
      content?: { data?: string; encoding?: string };
      destination?: string;
      mode?: string;
    }>;
  };
  if (
    projectRenderPlan.compiler?.version !== version ||
    projectRenderPlan.lock?.compilerArtifact?.platform !== compilerPlatform ||
    projectRenderPlan.lock?.pack?.version !== "compiled-proof-1.0.0" ||
    !projectRenderPlan.planId?.startsWith("sha256:") ||
    projectRenderPlanText.includes(projectRenderRoot) ||
    projectRenderPlan.targets?.length !== expectedProjectTargets
  ) {
    throw new Error(
      "Compiled project planner did not emit hermetic version-bound output"
    );
  }
  const driftCheck = JSON.parse(
    await runBlocked(["project", "render", "--check", ...projectRenderArgs])
  ) as { clean?: boolean; summary?: { missing?: number } };
  if (
    driftCheck.clean !== false ||
    driftCheck.summary?.missing !== expectedProjectTargets
  ) {
    throw new Error("Compiled project check did not report missing outputs");
  }
  for (const target of projectRenderPlan.targets) {
    if (
      !target.destination ||
      target.content?.encoding !== "base64" ||
      !target.content.data ||
      !target.mode
    ) {
      throw new Error("Compiled project plan target is incomplete");
    }
  }
  const apply = JSON.parse(
    await run(["project", "render", ...projectRenderArgs])
  ) as { changed?: boolean; written?: number };
  if (apply.changed !== true || apply.written !== expectedProjectTargets) {
    throw new Error(
      "Compiled project render did not transactionally apply outputs"
    );
  }
  const cleanCheck = JSON.parse(
    await run(["project", "render", "--check", ...projectRenderArgs])
  ) as { clean?: boolean; summary?: { matching?: number } };
  if (
    cleanCheck.clean !== true ||
    cleanCheck.summary?.matching !== expectedProjectTargets
  ) {
    throw new Error("Compiled project check did not verify exact outputs");
  }
  const rollback = JSON.parse(
    await run(["project", "render", "--rollback", ...projectRenderArgs])
  ) as { planId?: string | null; restored?: number };
  if (
    rollback.planId !== null ||
    rollback.restored !== expectedProjectTargets
  ) {
    throw new Error(
      "Compiled project render did not roll back its first apply"
    );
  }
  const rollbackCheck = JSON.parse(
    await runBlocked(["project", "render", "--check", ...projectRenderArgs])
  ) as { clean?: boolean; summary?: { missing?: number } };
  if (
    rollbackCheck.clean !== false ||
    rollbackCheck.summary?.missing !== expectedProjectTargets
  ) {
    throw new Error(
      "Compiled project rollback did not restore the absent tree"
    );
  }
  await run(["project", "render", ...projectRenderArgs]);
}

if (process.platform !== "win32") {
  await verifyProjectRenderer();
}

const auditSource = join(tempHome, "audit-source");
const auditSkill = join(auditSource, "skills", "compiled-audit", "SKILL.md");
const auditReportRoot = await mkdtemp(
  join(tmpdir(), "fclt-binary-audit-reports-")
);
await mkdir(dirname(auditSkill), { recursive: true });
await Bun.write(auditSkill, "# Compiled Audit\n\nReview safely.\n");
const auditSourceBefore = await Bun.file(auditSkill).text();
const readOnlyAudit = JSON.parse(
  await run([
    "audit",
    "--non-interactive",
    "--no-config-from",
    "--from",
    auditSource,
    "--json",
  ])
) as { mode?: string };
if (
  readOnlyAudit.mode !== "static" ||
  (await Bun.file(auditSkill).text()) !== auditSourceBefore ||
  (await readdir(auditReportRoot)).length !== 0
) {
  throw new Error(
    "Compiled default audit did not preserve its read-only boundary"
  );
}
const persistenceArgs = [
  "audit",
  "--non-interactive",
  "--no-config-from",
  "--from",
  auditSource,
  "--report-root",
  auditReportRoot,
  "--json",
];
if (auditPersistenceContract(process.platform) === "fail-closed") {
  const blockedPersistence = await runBlocked(persistenceArgs);
  if (
    !blockedPersistence.includes(
      "Audit report persistence is unavailable on win32"
    ) ||
    (await readdir(auditReportRoot)).length !== 0 ||
    (await Bun.file(auditSkill).text()) !== auditSourceBefore
  ) {
    throw new Error(
      "Compiled Windows audit persistence did not fail closed without source mutation"
    );
  }
} else {
  const persistedAuditText = await run(persistenceArgs);
  const reportNames = (await readdir(auditReportRoot)).sort();
  const reportName = reportNames.find((name) => name.startsWith("static-"));
  const envelope = reportName
    ? ((await Bun.file(join(auditReportRoot, reportName)).json()) as {
        receipt?: { reportRevision?: number; schemaVersion?: number };
        report?: unknown;
        schemaVersion?: number;
      })
    : null;
  if (
    !reportName ||
    reportNames.length !== 1 ||
    envelope?.schemaVersion !== 1 ||
    envelope.receipt?.schemaVersion !== 6 ||
    envelope.receipt.reportRevision !== 11 ||
    JSON.stringify(envelope.report) !==
      JSON.stringify(JSON.parse(persistedAuditText)) ||
    (await Bun.file(auditSkill).text()) !== auditSourceBefore
  ) {
    throw new Error(
      "Compiled explicit audit persistence did not produce one isolated authorization envelope"
    );
  }
}

const setup = JSON.parse(
  await run(["setup", "--global-only", "--no-codex-plugin", "--json"])
) as {
  health?: string;
  readiness?: { global?: { loop?: { state?: string } } };
};
if (
  setup.health !== "ready" ||
  setup.readiness?.global?.loop?.state !== "ready"
) {
  throw new Error(
    `Expected compiled setup readiness, got ${JSON.stringify(setup)}`
  );
}

const customGlobalRoot = join(tempHome, "shared", ".ai");
await mkdir(join(customGlobalRoot, "skills", "compiled-preview"), {
  recursive: true,
});
await Bun.write(
  join(customGlobalRoot, "skills", "compiled-preview", "SKILL.md"),
  "# Compiled Preview\n"
);
await mkdir(join(tempHome, ".ai", "skills", "default-only"), {
  recursive: true,
});
await Bun.write(
  join(tempHome, ".ai", "skills", "default-only", "SKILL.md"),
  "# Default Only\n"
);
await mkdir(join(customGlobalRoot, "mcp"), { recursive: true });
await Bun.write(
  join(customGlobalRoot, "mcp", "servers.json"),
  `${JSON.stringify({ servers: {} }, null, 2)}\n`
);
const customStatus = JSON.parse(
  await run(["status", "--json", "--global", "--root", customGlobalRoot])
) as { machineStateDir?: string; projectRoot?: string | null };
if (
  customStatus.projectRoot !== null ||
  customStatus.machineStateDir !==
    join(tempHome, ".local", "state", "fclt", "global")
) {
  throw new Error(
    `Expected custom root to remain global, got ${JSON.stringify(customStatus)}`
  );
}
await run([
  "manage",
  "cursor",
  "--dry-run",
  "--global",
  "--root",
  customGlobalRoot,
]);
const forbiddenPreviewWrites = [
  join(tempHome, ".cursor"),
  join(tempHome, "shared", ".cursor"),
  join(customGlobalRoot, ".facult", "ai", "index.json"),
  join(customGlobalRoot, ".facult", "ai", "graph.json"),
];
for (const pathValue of forbiddenPreviewWrites) {
  if (await Bun.file(pathValue).exists()) {
    throw new Error(`Managed dry-run unexpectedly wrote ${pathValue}`);
  }
}
await run(["index", "--global", "--root", customGlobalRoot]);
const customIndex = JSON.parse(
  await Bun.file(join(customGlobalRoot, ".facult", "ai", "index.json")).text()
) as { skills?: Record<string, { sourceKind?: string }> };
if (
  customIndex.skills?.["compiled-preview"]?.sourceKind !== "global" ||
  customIndex.skills?.["default-only"]
) {
  throw new Error(
    `Expected isolated custom-global index, got ${JSON.stringify(customIndex.skills)}`
  );
}

const blockedManage = await runBlocked(["manage", "codex", "--global"]);
if (!blockedManage.includes("deprecated broad managed-mode mutation")) {
  throw new Error(`Expected managed-mode containment, got ${blockedManage}`);
}
const codexAgentsPath = join(tempHome, ".codex", "AGENTS.md");
if (await Bun.file(codexAgentsPath).exists()) {
  throw new Error(`Blocked manage unexpectedly wrote ${codexAgentsPath}`);
}

await run(["manage", "codex", "--global", legacyManagedMutationFlag]);
await run(["sync", "codex", "--global", legacyManagedMutationFlag]);

const capabilityEvolutionSkillPath = join(
  tempHome,
  ".agents",
  "skills",
  "capability-evolution",
  "SKILL.md"
);
const codexAgents = await Bun.file(codexAgentsPath).text();
const normalizedCodexAgents = codexAgents.replaceAll("\\", "/");
const missingCodexGuidance = [
  "Global Agent Instructions",
  "Treat every task as a work unit",
  "For any task, identify the highest-signal feedback loops available",
  "When a high-signal learning clearly points at a canonical asset",
].filter((text) => !normalizedCodexAgents.includes(text));
const hasUnresolvedRefs = /\$\{refs\.[^}]+}/.test(codexAgents);
const hasEmptyFcltyBlock =
  /<!--\s*fclty:([^>]+?)\s*-->\s*<!--\s*\/fclty:\1\s*-->/.test(
    normalizedCodexAgents
  );
if (
  missingCodexGuidance.length > 0 ||
  hasUnresolvedRefs ||
  hasEmptyFcltyBlock
) {
  const details = [
    `Expected builtin AGENTS guidance in ${codexAgentsPath}`,
    missingCodexGuidance.length > 0
      ? `Missing: ${missingCodexGuidance.join(", ")}`
      : "",
    hasUnresolvedRefs
      ? "Rendered guidance still contains unresolved refs."
      : "",
    hasEmptyFcltyBlock
      ? "Rendered guidance still contains empty fclty blocks."
      : "",
    `Preview:\n${normalizedCodexAgents.slice(0, 1200)}`,
  ].filter(Boolean);
  throw new Error(details.join("\n"));
}
const capabilityEvolutionSkill = await Bun.file(
  capabilityEvolutionSkillPath
).text();
if (!capabilityEvolutionSkill.includes("tool-call-audit")) {
  throw new Error(
    `Expected builtin capability-evolution skill in ${capabilityEvolutionSkillPath}`
  );
}

console.log(`Verified ${binaryPath} (${version})`);
