import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectRenderPlan,
  type ProjectRenderPlanV1,
} from "./project-render";
import {
  ClaudeProjectRenderDiagnosticError,
  renderClaudeProjectTarget,
} from "./project-render-claude";

const MANIFEST = `schema_version = 1
exclusive_roots = [".claude/agents", ".claude/skills"]

[[targets]]
id = "root-agents"
tool = "shared"
destination = "AGENTS.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["AGENTS.project.md"]

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
id = "claude-project-mcp"
tool = "claude"
destination = ".mcp.json"
mode = "0644"
producer = "claude-mcp-json"
producer_version = 1
sources = ["mcp/claude-stdio.json", "mcp/claude-http.json"]

[[targets]]
id = "claude-project-settings"
tool = "claude"
destination = ".claude/settings.json"
mode = "0644"
producer = "claude-settings-json"
producer_version = 1
sources = ["tools/claude/permissions.json", "tools/claude/plugins.json"]
`;
const ROOT_AGENTS_TARGET_RE =
  /\n\[\[targets\]\]\nid = "root-agents"[\s\S]*?sources = \["AGENTS\.project\.md"\]\n/;

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

async function createClaudeFixture(): Promise<{
  canonicalRoot: string;
  projectRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "fclt-claude-render-"));
  const canonicalRoot = join(projectRoot, ".ai");
  for (const directory of [
    "agents/reviewer",
    "mcp",
    "skills/review",
    "tools/claude",
  ]) {
    await mkdir(join(canonicalRoot, directory), { recursive: true });
  }
  await Bun.write(join(canonicalRoot, "project-render.toml"), MANIFEST);
  await Bun.write(
    join(canonicalRoot, "AGENTS.project.md"),
    "# Shared project contract\r\n"
  );
  await Bun.write(
    join(canonicalRoot, "tools/claude/CLAUDE.md"),
    "@AGENTS.md\r\n"
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
    join(canonicalRoot, "agents/reviewer/claude.md"),
    `---
name: reviewer
description: Review changes against project evidence.
tools: Read, Grep, Glob
mcpServers:
  - docs
---

Return concise, evidence-backed findings.
`
  );
  await Bun.write(
    join(canonicalRoot, "mcp/claude-stdio.json"),
    JSON.stringify({
      mcpServers: {
        local: {
          args: ["server.mjs"],
          command: "node",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands this literal at runtime.
          env: { LOCAL_TOKEN: "${LOCAL_TOKEN}" },
          type: "stdio",
        },
      },
    })
  );
  await Bun.write(
    join(canonicalRoot, "mcp/claude-http.json"),
    JSON.stringify({
      mcpServers: {
        docs: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands this literal at runtime.
          headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
          type: "http",
          url: "https://example.com/mcp",
        },
      },
    })
  );
  await Bun.write(
    join(canonicalRoot, "tools/claude/permissions.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash(bun run check)"],
        deny: ["Read(./.env)"],
      },
    })
  );
  await Bun.write(
    join(canonicalRoot, "tools/claude/plugins.json"),
    JSON.stringify({
      enabledPlugins: { "review@team-tools": true },
      extraKnownMarketplaces: {
        "team-tools": {
          source: { repo: "example/claude-plugins", source: "github" },
        },
      },
    })
  );
  return { canonicalRoot, projectRoot };
}

describe("Claude project render producers", () => {
  it("renders deterministic native Claude project surfaces", async () => {
    const fixture = await createClaudeFixture();
    try {
      const plan = await buildProjectRenderPlan(fixture);

      expect(plan.targets.map((target) => target.destination)).toEqual([
        ".claude/agents/reviewer.md",
        ".claude/settings.json",
        ".claude/skills/review/SKILL.md",
        ".mcp.json",
        "AGENTS.md",
        "CLAUDE.md",
      ]);
      expect(decodedTarget(plan, "CLAUDE.md")).toBe("@AGENTS.md\n");
      expect(decodedTarget(plan, "AGENTS.md")).toBe(
        "# Shared project contract\n"
      );
      expect(decodedTarget(plan, ".claude/agents/reviewer.md")).toContain(
        "name: reviewer"
      );
      expect(decodedTarget(plan, ".claude/skills/review/SKILL.md")).toContain(
        "name: review"
      );
      expect(decodedTarget(plan, ".mcp.json")).toBe(`{
  "mcpServers": {
    "docs": {
      "headers": {
        "Authorization": "Bearer \${DOCS_TOKEN}"
      },
      "type": "http",
      "url": "https://example.com/mcp"
    },
    "local": {
      "args": [
        "server.mjs"
      ],
      "command": "node",
      "env": {
        "LOCAL_TOKEN": "\${LOCAL_TOKEN}"
      },
      "type": "stdio"
    }
  }
}
`);
      expect(decodedTarget(plan, ".claude/settings.json")).toContain(
        '"review@team-tools": true'
      );
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("requires the body-less CLAUDE.md shim to have a declared AGENTS.md target", async () => {
    const fixture = await createClaudeFixture();
    try {
      await Bun.write(
        join(fixture.canonicalRoot, "project-render.toml"),
        MANIFEST.replace(ROOT_AGENTS_TARGET_RE, "")
      );
      await expect(buildProjectRenderPlan(fixture)).rejects.toThrow(
        "requires a declared AGENTS.md target"
      );
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects mismatched tools, destinations, and semantic names", () => {
    expect(() =>
      renderClaudeProjectTarget({
        destination: "CLAUDE.md",
        producer: "claude-root-claude-md",
        sourceTexts: ["@AGENTS.md\n"],
        tool: "codex",
      })
    ).toThrow(ClaudeProjectRenderDiagnosticError);
    expect(() =>
      renderClaudeProjectTarget({
        destination: ".claude/agents/other.md",
        producer: "claude-agent-md",
        sourceTexts: [
          "---\nname: reviewer\ndescription: Review changes.\n---\nReview.\n",
        ],
        tool: "claude",
      })
    ).toThrow("name must match");
  });

  it("rejects literal MCP environment and header values", () => {
    for (const source of [
      JSON.stringify({
        mcpServers: {
          local: { command: "node", env: { TOKEN: "secret-value" } },
        },
      }),
      JSON.stringify({
        mcpServers: {
          remote: {
            headers: { Authorization: "Bearer secret-value" },
            type: "http",
            url: "https://example.com/mcp",
          },
        },
      }),
    ]) {
      try {
        renderClaudeProjectTarget({
          destination: ".mcp.json",
          producer: "claude-mcp-json",
          sourceTexts: [source],
          tool: "claude",
        });
        throw new Error("Expected secret-valued MCP config to be rejected.");
      } catch (error) {
        expect(error).toBeInstanceOf(ClaudeProjectRenderDiagnosticError);
        expect((error as ClaudeProjectRenderDiagnosticError).code).toBe(
          "FCLT_PR_CLAUDE_SECRET_VALUE"
        );
      }
    }
  });

  it("rejects unsupported settings and inline agent MCP definitions", () => {
    for (const args of [
      {
        destination: ".claude/settings.json",
        producer: "claude-settings-json" as const,
        sourceTexts: [JSON.stringify({ hooks: {} })],
      },
      {
        destination: ".claude/agents/reviewer.md",
        producer: "claude-agent-md" as const,
        sourceTexts: [
          `---
name: reviewer
description: Review changes.
mcpServers:
  - local:
      command: node
---
Review.
`,
        ],
      },
    ]) {
      try {
        renderClaudeProjectTarget({ ...args, tool: "claude" });
        throw new Error("Expected unsupported capability to be rejected.");
      } catch (error) {
        expect(error).toBeInstanceOf(ClaudeProjectRenderDiagnosticError);
        expect((error as ClaudeProjectRenderDiagnosticError).code).toBe(
          "FCLT_PR_CLAUDE_UNSUPPORTED_CAPABILITY"
        );
      }
    }
  });

  it("validates every supported Claude agent frontmatter value", () => {
    for (const field of [
      "tools: {}",
      "disallowedTools: false",
      "model: unknown",
      "permissionMode: unrestricted",
      "maxTurns: many",
      "skills: {}",
      "memory: shared",
      "background: []",
      "effort: extreme",
      "isolation: checkout",
      "color: ultraviolet",
      "initialPrompt: []",
      "experimental: []",
    ]) {
      expect(() =>
        renderClaudeProjectTarget({
          destination: ".claude/agents/reviewer.md",
          producer: "claude-agent-md",
          sourceTexts: [
            `---
name: reviewer
description: Review changes.
${field}
---
Review.
`,
          ],
          tool: "claude",
        })
      ).toThrow(ClaudeProjectRenderDiagnosticError);
    }
  });

  it("rejects duplicate JSON fragment ownership", () => {
    expect(() =>
      renderClaudeProjectTarget({
        destination: ".claude/settings.json",
        producer: "claude-settings-json",
        sourceTexts: [
          JSON.stringify({ enabledPlugins: { "one@team": true } }),
          JSON.stringify({ enabledPlugins: { "two@team": true } }),
        ],
        tool: "claude",
      })
    ).toThrow("multiple source owners");
  });
});
