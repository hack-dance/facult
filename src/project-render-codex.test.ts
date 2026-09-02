import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectRenderPlan,
  type ProjectRenderPlanV1,
} from "./project-render";
import {
  ProjectRenderDiagnosticError,
  renderCodexProjectTarget,
} from "./project-render-codex";

const MANIFEST = `schema_version = 1
exclusive_roots = [".agents/skills", ".codex/agents"]

[[targets]]
id = "codex-root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "codex-root-agents-md"
producer_version = 1
sources = ["instructions/header.md", "instructions/work.md"]

[[targets]]
id = "codex-review-skill"
tool = "codex"
destination = ".agents/skills/review/SKILL.md"
mode = "0644"
producer = "codex-skill-md"
producer_version = 1
sources = ["skills/review/SKILL.md"]

[[targets]]
id = "codex-reviewer-agent"
tool = "codex"
destination = ".codex/agents/reviewer.toml"
mode = "0644"
producer = "codex-agent-toml"
producer_version = 1
sources = ["agents/reviewer/agent.toml"]

[[targets]]
id = "codex-project-config"
tool = "codex"
destination = ".codex/config.toml"
mode = "0644"
producer = "codex-config-toml"
producer_version = 1
sources = ["tools/codex/base.toml", "mcp/codex.toml"]
`;

function decodedTarget(
  plan: Readonly<ProjectRenderPlanV1>,
  destination: string
): string {
  const target = plan.targets.find(
    (candidate) => candidate.destination === destination
  );
  if (!target) {
    throw new Error(`Missing target: ${destination}`);
  }
  return Buffer.from(target.content.data, "base64").toString("utf8");
}

async function createCodexFixture(): Promise<{
  canonicalRoot: string;
  projectRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "fclt-codex-render-"));
  const canonicalRoot = join(projectRoot, ".ai");
  for (const directory of [
    "agents/reviewer",
    "instructions",
    "mcp",
    "skills/review",
    "tools/codex",
  ]) {
    await mkdir(join(canonicalRoot, directory), { recursive: true });
  }
  await Bun.write(join(canonicalRoot, "project-render.toml"), MANIFEST);
  await Bun.write(
    join(canonicalRoot, "instructions/header.md"),
    "# Project instructions\r\n"
  );
  await Bun.write(
    join(canonicalRoot, "instructions/work.md"),
    "Keep evidence explicit.\r\n"
  );
  await Bun.write(
    join(canonicalRoot, "skills/review/SKILL.md"),
    `---
name: review
description: Review a change with project evidence.
---

# Review
`
  );
  await Bun.write(
    join(canonicalRoot, "agents/reviewer/agent.toml"),
    `name = "reviewer"
description = "Review changes against project evidence."
developer_instructions = "Return concise, evidence-backed findings."
sandbox_mode = "read-only"
`
  );
  await Bun.write(
    join(canonicalRoot, "tools/codex/base.toml"),
    `[agents]
max_concurrent_threads_per_session = 4
`
  );
  await Bun.write(
    join(canonicalRoot, "mcp/codex.toml"),
    `[mcp_servers.docs]
url = "https://developers.openai.com/mcp"
bearer_token_env_var = "DOCS_TOKEN"

[mcp_servers.local]
command = "node"
args = ["server.mjs"]
experimental_environment = "remote"
env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]
`
  );
  return { canonicalRoot, projectRoot };
}

describe("Codex project render producers", () => {
  it("renders the current Codex project surfaces with deterministic semantics", async () => {
    const fixture = await createCodexFixture();
    try {
      const plan = await buildProjectRenderPlan(fixture);

      expect(plan.targets.map((target) => target.destination)).toEqual([
        ".agents/skills/review/SKILL.md",
        ".codex/agents/reviewer.toml",
        ".codex/config.toml",
        "AGENTS.md",
      ]);
      expect(decodedTarget(plan, "AGENTS.md")).toBe(
        "# Project instructions\n\nKeep evidence explicit.\n"
      );
      expect(decodedTarget(plan, ".agents/skills/review/SKILL.md")).toContain(
        "name: review"
      );
      expect(decodedTarget(plan, ".codex/agents/reviewer.toml")).toContain(
        'developer_instructions = "Return concise, evidence-backed findings."'
      );
      expect(decodedTarget(plan, ".codex/config.toml")).toBe(
        `[agents]
max_concurrent_threads_per_session = 4

[mcp_servers.docs]
url = "https://developers.openai.com/mcp"
bearer_token_env_var = "DOCS_TOKEN"

[mcp_servers.local]
command = "node"
args = ["server.mjs"]
experimental_environment = "remote"
env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]
`
      );
      expect(decodedTarget(plan, ".codex/config.toml")).not.toContain(
        "secret-value"
      );
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects mismatched tools and destinations with typed diagnostics", () => {
    expect(() =>
      renderCodexProjectTarget({
        destination: "AGENTS.md",
        producer: "codex-root-agents-md",
        sourceTexts: ["# Instructions\n"],
        tool: "claude",
      })
    ).toThrow(ProjectRenderDiagnosticError);
    try {
      renderCodexProjectTarget({
        destination: ".codex/skills/review/SKILL.md",
        producer: "codex-skill-md",
        sourceTexts: [
          "---\nname: review\ndescription: Review changes.\n---\n# Review\n",
        ],
        tool: "codex",
      });
      throw new Error("Expected the target to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectRenderDiagnosticError);
      expect((error as ProjectRenderDiagnosticError).code).toBe(
        "FCLT_PR_CODEX_INVALID_TARGET"
      );
    }
  });

  it("rejects secret-valued MCP environment and static headers", () => {
    for (const source of [
      `[mcp_servers.local]
command = "node"

[mcp_servers.local.env]
API_TOKEN = "secret-value"
`,
      `[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { Authorization = "Bearer secret-value" }
`,
    ]) {
      try {
        renderCodexProjectTarget({
          destination: ".codex/config.toml",
          producer: "codex-config-toml",
          sourceTexts: [source],
          tool: "codex",
        });
        throw new Error("Expected secret-valued MCP config to be rejected.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectRenderDiagnosticError);
        expect((error as ProjectRenderDiagnosticError).code).toBe(
          "FCLT_PR_CODEX_SECRET_VALUE"
        );
      }
    }
  });

  it("rejects user-owned plugin and provider configuration explicitly", () => {
    for (const source of [
      '[plugins."sample@test"]\nenabled = true\n',
      'model_provider = "custom"\n',
    ]) {
      try {
        renderCodexProjectTarget({
          destination: ".codex/config.toml",
          producer: "codex-config-toml",
          sourceTexts: [source],
          tool: "codex",
        });
        throw new Error("Expected unsupported project config to be rejected.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectRenderDiagnosticError);
        expect((error as ProjectRenderDiagnosticError).code).toBe(
          "FCLT_PR_CODEX_UNSUPPORTED_CAPABILITY"
        );
      }
    }
  });

  it("rejects invalid skill and agent semantic inventories", () => {
    expect(() =>
      renderCodexProjectTarget({
        destination: ".agents/skills/review/SKILL.md",
        producer: "codex-skill-md",
        sourceTexts: [
          "---\nname: other\ndescription: Review changes.\n---\n# Review\n",
        ],
        tool: "codex",
      })
    ).toThrow("frontmatter name must match");
    expect(() =>
      renderCodexProjectTarget({
        destination: ".codex/agents/reviewer.toml",
        producer: "codex-agent-toml",
        sourceTexts: ['name = "reviewer"\ndescription = "Review changes."\n'],
        tool: "codex",
      })
    ).toThrow("developer_instructions must be a non-empty string");
  });
});
