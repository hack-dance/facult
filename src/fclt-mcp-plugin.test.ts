import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildCompiledCliFixture,
  type CompiledCliFixture,
} from "../test/compiled-cli-fixture";
import { facultBuiltinCodexPluginRoot } from "./builtin";

const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const MCP_CONFIG_PATH = join(
  import.meta.dir,
  "..",
  "plugins",
  "fclt",
  ".mcp.json"
);
const { NODE_OPTIONS: _ambientNodeOptions, ...MCP_BASE_ENV } = process.env;
let cliFixture: CompiledCliFixture | null = null;

beforeAll(async () => {
  cliFixture = await buildCompiledCliFixture();
}, 15_000);

afterAll(async () => {
  await cliFixture?.cleanup();
  cliFixture = null;
});
const MCP_CONFIG = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")) as {
  mcpServers?: {
    fclt?: {
      args?: unknown;
      command?: unknown;
      cwd?: unknown;
      env?: unknown;
    };
  };
};
const MCP_LAUNCH = MCP_CONFIG.mcpServers?.fclt;
if (
  MCP_LAUNCH?.command !== "node" ||
  MCP_LAUNCH.cwd !== "." ||
  !Array.isArray(MCP_LAUNCH.args) ||
  MCP_LAUNCH.args.some((arg) => typeof arg !== "string") ||
  !(
    MCP_LAUNCH.env &&
    typeof MCP_LAUNCH.env === "object" &&
    !Array.isArray(MCP_LAUNCH.env) &&
    Object.values(MCP_LAUNCH.env).every((value) => typeof value === "string")
  )
) {
  throw new Error("Bundled fclt MCP launch configuration is unsupported");
}
const CONFIGURED_MCP_COMMAND = "node";
const CONFIGURED_MCP_CWD = ".";
const CONFIGURED_NODE = Bun.which(CONFIGURED_MCP_COMMAND, {
  PATH: MCP_BASE_ENV.PATH,
});
if (!CONFIGURED_NODE) {
  throw new Error("Bundled fclt MCP tests require the configured Node runtime");
}
const CONFIGURED_NODE_RUNTIME = realpathSync(CONFIGURED_NODE);
const CONFIGURED_MCP_ARGS = MCP_LAUNCH.args as string[];
const CONFIGURED_MCP_ENV = MCP_LAUNCH.env as Record<string, string>;

function spawnConfiguredMcp(options?: {
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  pluginRoot?: string;
}) {
  const pluginRoot = options?.pluginRoot ?? facultBuiltinCodexPluginRoot();
  const env = { ...MCP_BASE_ENV, ...CONFIGURED_MCP_ENV, ...options?.env };
  return spawn(
    CONFIGURED_NODE_RUNTIME,
    [...(options?.nodeArgs ?? []), ...CONFIGURED_MCP_ARGS],
    {
      cwd: resolve(pluginRoot, CONFIGURED_MCP_CWD),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}
const CLOSED_FIELD_ERROR_RE =
  /unknown argument fields|received unsupported fields/;
const ACTION_LOCATOR = `fclt-act-v1.${"a".repeat(64)}.${"b".repeat(64)}`;

function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function lineFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function compatibleStubScript(): string {
  return [
    `#!${process.execPath}`,
    "if (process.argv[2] === 'protocol') {",
    "  console.log(JSON.stringify({schemaVersion:1,packageVersion:'9.9.9',protocol:{version:1,minimumPluginVersion:1,maximumPluginVersion:1},runtime:{platform:process.platform,architecture:process.arch,executable:process.argv[1]},capabilities:['activity-action-resolve-v1','audit-read-only-v1']}));",
    "} else {",
    "  console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));",
    "}",
    "",
  ].join("\n");
}

function legacyProtocolStubScript(version: string): string {
  return [
    `#!${process.execPath}`,
    "if (process.argv[2] === 'protocol') {",
    `  console.log(JSON.stringify({schemaVersion:1,packageVersion:${JSON.stringify(version)},protocol:{version:1,minimumPluginVersion:1,maximumPluginVersion:1},runtime:{platform:process.platform,architecture:process.arch,executable:process.argv[1]},capabilities:['plugin-runtime-handshake-v1']}));`,
    "} else {",
    "  if (process.env.FCLT_LEGACY_INVOKED) require('node:fs').writeFileSync(process.env.FCLT_LEGACY_INVOKED, 'invoked');",
    "  console.log('{}');",
    "}",
    "",
  ].join("\n");
}

async function writeFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        snapshot[relative] = "directory";
        await visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        snapshot[relative] = `symlink:${await readlink(absolute)}`;
      } else {
        snapshot[relative] = `file:${createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex")}`;
      }
    }
  }
  await visit(root, "");
  return snapshot;
}

function readFrame(stream: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = CONTENT_LENGTH_RE.exec(header);
      if (!match) {
        cleanup();
        reject(new Error("Missing Content-Length header"));
        return;
      }
      const bodyLength = Number(match[1]);
      const frameEnd = headerEnd + 4 + bodyLength;
      if (buffer.length < frameEnd) {
        return;
      }
      const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
      cleanup();
      resolve(JSON.parse(body));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function readLine(stream: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      cleanup();
      try {
        resolve(JSON.parse(buffer.slice(0, lineEnd)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function toolPayload(response: unknown): {
  operation: { preview: boolean; risk: string };
  recovery: {
    canonicalCapabilityChanged?: boolean;
    changedPaths?: string[];
    rollbackAvailable?: boolean;
    verification?: string;
  } | null;
  result: {
    exitCode: number;
    stdout: { argv: string[]; cwd: string } | string;
    stderr: string;
  };
} {
  const typed = response as {
    result?: { content?: { text?: string }[] };
  };
  const text = typed.result?.content?.[0]?.text;
  if (!text) {
    throw new Error("MCP response did not include a text payload");
  }
  return JSON.parse(text) as {
    operation: { preview: boolean; risk: string };
    recovery: {
      canonicalCapabilityChanged?: boolean;
      changedPaths?: string[];
      rollbackAvailable?: boolean;
      verification?: string;
    } | null;
    result: {
      exitCode: number;
      stdout: { argv: string[]; cwd: string } | string;
      stderr: string;
    };
  };
}

describe("bundled fclt MCP plugin", () => {
  it("runs the shipped MCP launch contract under the exact configured Node runtime", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "facult-mcp-node-proof-"));
    const marker = join(fixtureRoot, "runtime.json");
    const preload = join(fixtureRoot, "assert-node.cjs");
    await writeFile(
      preload,
      [
        'const { realpathSync, writeFileSync } = require("node:fs");',
        'if (process.release.name !== "node" || process.versions.bun) throw new Error("MCP runtime is not Node");',
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ execPath: realpathSync(process.execPath), release: process.release.name, bun: Boolean(process.versions.bun) }), { flag: "wx", mode: 0o600 });`,
        "",
      ].join("\n")
    );
    const child = spawnConfiguredMcp({ nodeArgs: ["--require", preload] });
    try {
      child.stdin.write(
        frame({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { tools?: unknown[] };
      };
      expect(Array.isArray(response.result?.tools)).toBe(true);
      const runtime = JSON.parse(await readFile(marker, "utf8")) as {
        bun: boolean;
        execPath: string;
        release: string;
      };
      expect(runtime).toEqual({
        bun: false,
        execPath: CONFIGURED_NODE_RUNTIME,
        release: "node",
      });
      expect(CONFIGURED_MCP_COMMAND).toBe("node");
      expect(CONFIGURED_MCP_ARGS).toEqual(["./scripts/fclt-mcp.cjs"]);
      expect(CONFIGURED_MCP_ENV).toEqual({ FCLT_BIN: "fclt" });
    } finally {
      child.kill();
    }
  });

  it("negotiates newline-delimited stdio framing used by Codex", async () => {
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({ pluginRoot });

    try {
      child.stdin.write(
        lineFrame({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "codex-test", version: "1" },
          },
        })
      );
      const initialized = (await readLine(child.stdout)) as {
        result?: { serverInfo?: { name?: string } };
      };
      expect(initialized.result?.serverInfo?.name).toBe("fclt");

      child.stdin.write(
        lineFrame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        })
      );
      const listed = (await readLine(child.stdout)) as {
        result?: { tools?: { name?: string }[] };
      };
      expect(listed.result?.tools?.map((tool) => tool.name)).toContain(
        "fclt_runtime"
      );
    } finally {
      child.kill();
    }
  });

  it("wraps the released setup contract with preview, scope, and approval gates", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: stub, HOME: home, PWD: workspace },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: { scope: "global" },
          },
        })
      );
      const defaultResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(defaultResponse.result?.isError).toBe(false);
      expect(toolPayload(defaultResponse).result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: ["setup", "--json", "--dry-run"],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: {
              scope: "global_and_project",
              cwd: workspace,
              dryRun: false,
              installCodexPlugin: false,
              approve: true,
            },
          },
        })
      );
      const disabledResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(disabledResponse.result?.isError).toBe(false);
      expect(toolPayload(disabledResponse).result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: ["setup", "--json", "--include-project", "--no-codex-plugin"],
      });
      expect(toolPayload(disabledResponse).operation).toMatchObject({
        preview: false,
        risk: "reversible_mutation",
      });
      expect(toolPayload(disabledResponse).recovery).toMatchObject({
        rollbackAvailable: false,
        changedPaths: [],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: { scope: "global", dryRun: false },
          },
        })
      );
      const unapproved = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unapproved.error?.message).toContain("requires approve=true");

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: {
              action: "install_preview",
              scope: "project",
              item: "skill:test",
            },
          },
        })
      );
      const unsupportedProjectPreview = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unsupportedProjectPreview.error?.message).toContain(
        "only supports global scope"
      );

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 31,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: {
              action: "reconcile_status",
              scope: "project",
            },
          },
        })
      );
      const statusResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(statusResponse)).toMatchObject({
        operation: { preview: false, risk: "read_only" },
        result: {
          stdout: {
            cwd: await realpath(workspace),
            argv: ["ai", "review", "--project", "status", "--json"],
          },
        },
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 311,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: {
              action: "activity_resolve",
              locator: ACTION_LOCATOR,
            },
          },
        })
      );
      const resolveResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(resolveResponse)).toMatchObject({
        operation: { preview: false, risk: "read_only" },
        result: {
          stdout: {
            argv: ["ai", "loop", "resolve", ACTION_LOCATOR, "--json"],
          },
        },
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 32,
          method: "tools/call",
          params: {
            name: "fclt_automation",
            arguments: {
              action: "loop_status",
              scope: "project",
            },
          },
        })
      );
      const loopStatusResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(loopStatusResponse)).toMatchObject({
        operation: { preview: false, risk: "read_only" },
        result: {
          stdout: {
            cwd: await realpath(workspace),
            argv: ["ai", "loop", "--project", "status", "--json"],
          },
        },
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 33,
          method: "tools/call",
          params: {
            name: "fclt_automation",
            arguments: {
              action: "loop_activity",
              scope: "project",
            },
          },
        })
      );
      const activityResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(activityResponse)).toMatchObject({
        operation: { preview: false, risk: "read_only" },
        result: {
          stdout: {
            cwd: await realpath(workspace),
            argv: ["ai", "loop", "--project", "activity", "--json"],
          },
        },
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 331,
          method: "tools/call",
          params: {
            name: "fclt_automation",
            arguments: {
              action: "loop_activity",
            },
          },
        })
      );
      const allActivityResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(allActivityResponse)).toMatchObject({
        operation: { preview: false, risk: "read_only", scope: "all" },
        result: {
          stdout: {
            argv: ["ai", "loop", "activity", "--all", "--json"],
          },
        },
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 332,
          method: "tools/call",
          params: {
            name: "fclt_automation",
            arguments: { action: "loop_status" },
          },
        })
      );
      const unscopedStatusResponse = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unscopedStatusResponse.error?.message).toContain(
        "loop_status requires global or project scope"
      );

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 34,
          method: "tools/call",
          params: {
            name: "fclt_automation",
            arguments: {
              action: "loop_preview",
              scope: "project",
            },
          },
        })
      );
      const loopPreviewResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(loopPreviewResponse)).toMatchObject({
        operation: { preview: true, risk: "read_only" },
        result: {
          stdout: {
            cwd: await realpath(workspace),
            argv: ["ai", "loop", "--project", "run", "--dry-run", "--json"],
          },
        },
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 32,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: {
              action: "reconcile",
              scope: "project",
              since: "2026-07-03",
              until: "2026-07-10",
              sourceIds: ["writebacks", "cos-git"],
              incremental: true,
            },
          },
        })
      );
      const reconcileResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(reconcileResponse)).toMatchObject({
        operation: { preview: false, risk: "review_producing" },
        recovery: { canonicalCapabilityChanged: false },
        result: {
          stdout: {
            cwd: await realpath(workspace),
            argv: [
              "ai",
              "review",
              "--project",
              "reconcile",
              "--since",
              "2026-07-03",
              "--until",
              "2026-07-10",
              "--source",
              "writebacks",
              "--source",
              "cos-git",
              "--incremental",
              "--json",
            ],
          },
        },
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 33,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: {
              action: "reconcile",
              scope: "global",
              since: "2026-07-03",
              config: "/tmp/unsafe.json",
            },
          },
        })
      );
      const unsafeConfig = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unsafeConfig.error?.message).toContain("unknown argument fields");

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 34,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: {
              action: "reconcile",
              scope: "global",
              since: "2026-07-03",
              query: "ignored passthrough",
            },
          },
        })
      );
      const actionSpecificField = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(actionSpecificField.error?.message).toContain(
        "received unsupported fields"
      );

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fclt_init_operating_model",
            arguments: {
              scope: "project",
              dryRun: false,
              approve: true,
            },
          },
        })
      );
      const applyResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const apply = toolPayload(applyResponse);
      expect(apply.operation).toMatchObject({
        preview: false,
        risk: "high_risk_destructive",
      });
      expect(apply.recovery).toMatchObject({
        rollbackAvailable: false,
        changedPaths: [],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: { scope: "global_and_project" },
          },
        })
      );
      const missingTarget = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(missingTarget.error?.message).toContain("explicit cwd");
    } finally {
      child.kill();
    }
  });

  it("publishes typed full-service routers with closed argument schemas", async () => {
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({ pluginRoot });

    try {
      child.stdin.write(
        frame({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: {
          tools?: {
            inputSchema?: {
              additionalProperties?: boolean;
              oneOf?: Array<{ additionalProperties?: boolean }>;
            };
            name?: string;
          }[];
        };
      };
      const published = response.result?.tools ?? [];
      const names = published.map((tool) => tool.name);

      expect(names).toContain("fclt_runtime");
      expect(names).toContain("fclt_capability");
      expect(names).toContain("fclt_workflow");
      expect(names).toContain("fclt_sync");
      expect(names).toContain("fclt_registry");
      expect(names).toContain("fclt_audit");
      expect(names).toContain("fclt_automation");
      expect(
        published.every(
          (tool) =>
            tool.inputSchema?.additionalProperties === false ||
            tool.inputSchema?.oneOf?.every(
              (branch: { additionalProperties?: boolean }) =>
                branch.additionalProperties === false
            )
        )
      ).toBe(true);
      const workflow = published.find(
        (tool) => tool.name === "fclt_workflow"
      ) as
        | {
            inputSchema?: {
              properties?: { action?: { enum?: string[] } };
            };
          }
        | undefined;
      expect(workflow?.inputSchema?.properties?.action?.enum).not.toContain(
        "evolve_apply"
      );
      expect(workflow?.inputSchema?.properties?.action?.enum).not.toContain(
        "evolve_accept"
      );
      const registry = published.find(
        (tool) => tool.name === "fclt_registry"
      ) as
        | {
            inputSchema?: {
              oneOf?: Array<{
                additionalProperties?: boolean;
                properties?: {
                  action?: { const?: string; enum?: string[] };
                  locator?: { pattern?: string };
                  sourceIds?: { items?: { pattern?: string } };
                };
                required?: string[];
              }>;
            };
          }
        | undefined;
      const resolverSchema = registry?.inputSchema?.oneOf?.find(
        (branch) => branch.properties?.action?.const === "activity_resolve"
      );
      const registrySchema = registry?.inputSchema?.oneOf?.find((branch) =>
        branch.properties?.action?.enum?.includes("reconcile")
      );
      expect(registrySchema?.properties?.action?.enum).toEqual(
        expect.arrayContaining(["reconcile_status", "reconcile"])
      );
      expect(resolverSchema).toMatchObject({
        additionalProperties: false,
        required: ["action", "locator"],
        properties: { action: { const: "activity_resolve" } },
      });
      expect(resolverSchema?.properties?.locator?.pattern).toBeDefined();
      expect(Object.keys(resolverSchema?.properties ?? {}).sort()).toEqual([
        "action",
        "locator",
      ]);
      expect(
        registrySchema?.properties?.sourceIds?.items?.pattern
      ).toBeDefined();
      const automation = published.find(
        (tool) => tool.name === "fclt_automation"
      ) as
        | {
            inputSchema?: {
              properties?: {
                action?: { enum?: string[] };
                scope?: { enum?: string[] };
              };
              oneOf?: Array<{
                properties?: { scope?: { default?: string } };
              }>;
            };
          }
        | undefined;
      expect(automation?.inputSchema?.properties?.action?.enum).toEqual(
        expect.arrayContaining(["loop_status", "loop_activity", "loop_preview"])
      );
      expect(automation?.inputSchema?.properties?.scope).toMatchObject({
        enum: ["all", "global", "project"],
      });
      expect(
        automation?.inputSchema?.oneOf?.[0]?.properties?.scope
      ).toMatchObject({ default: "all" });
    } finally {
      child.kill();
    }
  });

  it("keeps the typed audit entry byte-for-byte read-only", async () => {
    const base = await mkdtemp(join(tmpdir(), "facult-mcp-audit-"));
    const home = join(base, "home");
    await writeFile(
      join(home, ".ai", "skills", "review", "SKILL.md"),
      "Review safely.\n"
    );
    await writeFile(
      join(home, ".ai", ".facult", "audit", "static-latest.json"),
      "protected report bytes\n"
    );
    await writeFile(
      join(home, ".ai", ".facult", "ai", "index.json"),
      `${JSON.stringify({ version: 1, updatedAt: "protected", skills: {} })}\n`
    );
    const before = await snapshotTree(home);
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: {
        APPDATA: join(base, "appdata"),
        BUN_INSTALL: join(base, "bun-install"),
        BUN_INSTALL_CACHE_DIR: join(base, "bun-cache"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(base, "bun-runtime-cache"),
        CLAUDE_CONFIG_DIR: join(base, "claude-config"),
        CODEX_HOME: join(base, "codex-home"),
        FACULT_CACHE_DIR: join(base, "facult-cache"),
        FACULT_LOCAL_STATE_DIR: join(base, "facult-state"),
        FACULT_ROOT_DIR: join(home, ".ai"),
        FACULT_ROOT_SCOPE: "global",
        FCLT_BIN: cliFixture!.entryPath,
        FCLT_PLUGIN_RUNTIME_DIR: join(base, "plugin-runtime"),
        FCLT_SYSTEM_PATHS: "",
        HOME: home,
        LOCALAPPDATA: join(base, "local-appdata"),
        PWD: home,
        XDG_CACHE_HOME: join(base, "xdg-cache"),
        XDG_CONFIG_HOME: join(base, "xdg-config"),
        XDG_STATE_HOME: join(base, "xdg-state"),
      },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_audit",
            arguments: { action: "scan", cwd: home, severity: "high" },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(response.result?.isError).toBe(false);
      const payload = toolPayload(response);
      expect(payload.result.exitCode).toBe(0);
      expect(payload.result.stdout).toMatchObject({ mode: "static" });
      expect(await snapshotTree(home)).toEqual(before);
    } finally {
      child.kill();
    }
    // This is the Bun aggregate timeout only. The shipped MCP command timeout
    // and the byte-for-byte zero-write assertions above remain unchanged.
  }, 15_000);

  it("fails typed audit closed for protocol-v1 runtimes without the read-only capability", async () => {
    for (const version of ["2.24.1", "2.24.0"]) {
      const base = await mkdtemp(join(tmpdir(), "facult-mcp-legacy-audit-"));
      const stub = join(base, "fclt-legacy.cjs");
      const invoked = join(base, "invoked.txt");
      await Bun.write(stub, legacyProtocolStubScript(version));
      await chmod(stub, 0o755);
      const pluginRoot = facultBuiltinCodexPluginRoot();
      const child = spawnConfiguredMcp({
        env: {
          FCLT_BIN: stub,
          FCLT_LEGACY_INVOKED: invoked,
          HOME: base,
          PWD: base,
        },
        pluginRoot,
      });
      try {
        child.stdin.write(
          frame({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "fclt_audit",
              arguments: { action: "scan", cwd: base },
            },
          })
        );
        const response = (await readFrame(child.stdout)) as {
          result?: { content?: { text?: string }[]; isError?: boolean };
        };
        expect(response.result?.isError).toBe(true);
        const payload = toolPayload(response) as unknown as { error: string };
        expect(payload.error).toBe("missing_runtime_capability");
        expect(await Bun.file(invoked).exists()).toBe(false);
      } finally {
        child.kill();
      }
    }
  });

  it("fails typed activity resolution closed for runtimes without the resolver capability", async () => {
    const base = await mkdtemp(join(tmpdir(), "facult-mcp-legacy-resolver-"));
    const stub = join(base, "fclt-legacy.cjs");
    const invoked = join(base, "invoked.txt");
    await Bun.write(stub, legacyProtocolStubScript("2.25.4"));
    await chmod(stub, 0o755);
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: {
        FCLT_BIN: stub,
        FCLT_LEGACY_INVOKED: invoked,
        HOME: base,
        PWD: base,
      },
      pluginRoot,
    });
    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: {
              action: "activity_resolve",
              locator: ACTION_LOCATOR,
            },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(response.result?.isError).toBe(true);
      const payload = toolPayload(response) as unknown as { error: string };
      expect(payload.error).toBe("missing_runtime_capability");
      expect(await Bun.file(invoked).exists()).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("routes typed capability and workflow operations without shell passthrough", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: stub, HOME: home, PWD: workspace },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_capability",
            arguments: {
              action: "graph",
              graphMode: "deps",
              selector: "skill:review",
            },
          },
        })
      );
      const capabilityResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const capability = toolPayload(capabilityResponse);
      expect(capability.result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: ["graph", "deps", "skill:review", "--json"],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_workflow",
            arguments: {
              action: "writeback_add",
              approve: true,
              scope: "project",
              kind: "capability_gap",
              category: "opportunity",
              summary: "Missing review context",
              details: "The project instructions were not discoverable.",
              impact: "The review had to reconstruct setup context.",
              attemptedWorkaround: "Inspected the repository manually.",
              desiredOutcome: "Project guidance is available at task start.",
              sensitivity: "internal",
              evidence: ["session:runtime-router"],
            },
          },
        })
      );
      const workflowResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const workflow = toolPayload(workflowResponse);
      expect(workflow.result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: [
          "ai",
          "writeback",
          "--project",
          "add",
          "--kind",
          "capability_gap",
          "--summary",
          "Missing review context",
          "--category",
          "opportunity",
          "--details",
          "The project instructions were not discoverable.",
          "--impact",
          "The review had to reconstruct setup context.",
          "--attempted-workaround",
          "Inspected the repository manually.",
          "--desired-outcome",
          "Project guidance is available at task start.",
          "--sensitivity",
          "internal",
          "--evidence",
          "session:runtime-router",
          "--json",
        ],
      });
      expect(workflow.operation.risk).toBe("review_producing");

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fclt_writeback_add",
            arguments: {
              approve: true,
              scope: "project",
              kind: "capability_gap",
              category: "opportunity",
              summary: "Legacy review context",
              details: "Legacy callers can provide structured context.",
              desiredOutcome: "Both typed writeback surfaces agree.",
              sensitivity: "internal",
              evidence: "session:legacy-router",
            },
          },
        })
      );
      const legacyWritebackResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(legacyWritebackResponse).operation.risk).toBe(
        "review_producing"
      );
      expect(toolPayload(legacyWritebackResponse).result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: [
          "ai",
          "writeback",
          "--project",
          "add",
          "--kind",
          "capability_gap",
          "--summary",
          "Legacy review context",
          "--category",
          "opportunity",
          "--details",
          "Legacy callers can provide structured context.",
          "--desired-outcome",
          "Both typed writeback surfaces agree.",
          "--sensitivity",
          "internal",
          "--evidence",
          "session:legacy-router",
          "--json",
        ],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "fclt_evolve",
            arguments: {
              action: "propose",
              approve: true,
              scope: "project",
              asset: "AGENTS.md",
            },
          },
        })
      );
      const legacyEvolveResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(toolPayload(legacyEvolveResponse).operation.risk).toBe(
        "review_producing"
      );
    } finally {
      child.kill();
    }
  });

  it("rejects unknown fields and unapproved workflow mutation before spawning fclt", async () => {
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({ pluginRoot });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_capability",
            arguments: { action: "inventory", shell: "rm -rf /" },
          },
        })
      );
      const unknown = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unknown.error?.message).toContain("unknown argument fields");

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_workflow",
            arguments: {
              action: "writeback_add",
              scope: "project",
              kind: "capability_gap",
              summary: "Missing review context",
              evidence: ["session:unapproved"],
            },
          },
        })
      );
      const unapproved = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unapproved.error?.message).toContain("requires approve=true");

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fclt_workflow",
            arguments: {
              action: "writeback_add",
              approve: true,
              scope: "project",
              kind: "capability_gap",
              summary: "Do not confuse lifecycle and capture outcomes",
              expectedOutcome: "This field belongs to disposition",
              evidence: ["session:wrong-field"],
            },
          },
        })
      );
      const irrelevant = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(irrelevant.error?.message).toContain(
        "writeback_add received unsupported fields: expectedOutcome"
      );

      for (const rawField of [
        { cwd: "/tmp/unsafe" },
        { root: "/tmp/unsafe" },
        { argv: ["ai", "evolve", "apply"] },
        { endpoint: "https://example.invalid" },
        { token: "secret" },
        { tokenEnv: "SECRET_TOKEN" },
        { credential: "secret" },
        { approve: true },
      ]) {
        child.stdin.write(
          frame({
            jsonrpc: "2.0",
            id: 40,
            method: "tools/call",
            params: {
              name: "fclt_registry",
              arguments: {
                action: "activity_resolve",
                locator: ACTION_LOCATOR,
                ...rawField,
              },
            },
          })
        );
        const rejected = (await readFrame(child.stdout)) as {
          error?: { message?: string };
        };
        expect(rejected.error?.message).toMatch(CLOSED_FIELD_ERROR_RE);
      }

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 41,
          method: "tools/call",
          params: {
            name: "fclt_registry",
            arguments: { action: "activity_resolve" },
          },
        })
      );
      const missingLocator = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(missingLocator.error?.message).toContain(
        "fclt_registry requires locator"
      );
    } finally {
      child.kill();
    }
  });

  it("keeps legacy mutating tools preview-first and approval-gated", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: stub, HOME: home, PWD: workspace },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_init_operating_model",
            arguments: { scope: "project" },
          },
        })
      );
      const previewResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const preview = toolPayload(previewResponse);
      expect(preview.result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: [
          "templates",
          "init",
          "operating-model",
          "--project",
          "--dry-run",
          "--json",
        ],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_init_operating_model",
            arguments: { scope: "project", dryRun: false },
          },
        })
      );
      const unapproved = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unapproved.error?.message).toContain("requires approve=true");
    } finally {
      child.kill();
    }
  });

  it("uses the caller workspace cwd instead of the plugin cwd when omitted", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);
    await mkdir(join(home, ".ai"), { recursive: true });

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: stub, HOME: home, PWD: workspace },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: {},
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const expectedWorkspace = await realpath(workspace);
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(false);
      expect(payload.result.stdout).toEqual({
        cwd: expectedWorkspace,
        argv: ["status", "--json"],
      });
    } finally {
      child.kill();
    }
  });

  it("uses the inferred workspace cwd for project-scoped calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);
    await mkdir(join(home, ".ai"), { recursive: true });

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: stub, HOME: home, PWD: workspace },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: { scope: "project" },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const expectedWorkspace = await realpath(workspace);
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(false);
      expect(payload.result.stdout).toEqual({
        cwd: expectedWorkspace,
        argv: ["status", "--project", "--json"],
      });
    } finally {
      child.kill();
    }
  });

  it("skips invalid inferred cwd values before choosing a workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: {
        FCLT_BIN: stub,
        FCLT_MCP_WORKSPACE_CWD: join(home, "deleted-workspace"),
        HOME: home,
        PWD: workspace,
      },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: {},
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const expectedWorkspace = await realpath(workspace);
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(false);
      expect(payload.result.stdout).toEqual({
        cwd: expectedWorkspace,
        argv: ["status", "--json"],
      });
    } finally {
      child.kill();
    }
  });

  it("rejects project-scoped calls without a usable workspace cwd", async () => {
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: "fclt", PWD: pluginRoot },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: { scope: "project" },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };

      expect(response.error?.message).toContain("requires a cwd");
    } finally {
      child.kill();
    }
  });

  it("rejects home as an inferred project workspace cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: "fclt", HOME: home, PWD: home },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: { scope: "project" },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };

      expect(response.error?.message).toContain("requires a cwd");
    } finally {
      child.kill();
    }
  });

  it("returns an MCP tool error when an explicit cwd cannot be spawned", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawnConfiguredMcp({
      env: { FCLT_BIN: stub, HOME: home, PWD: pluginRoot },
      pluginRoot,
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: { cwd: join(home, "missing-workspace") },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(true);
      expect(payload.result.stderr).toContain("ENOENT");
    } finally {
      child.kill();
    }
  });
});

describe("Codex plugin capability matrix", () => {
  it("tracks the released setup contract and exposes the closed reconciliation router", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const packageJson = (await Bun.file(
      join(repoRoot, "package.json")
    ).json()) as {
      version: string;
      scripts: { version?: string };
    };
    const pluginJson = (await Bun.file(
      join(repoRoot, "plugins", "fclt", ".codex-plugin", "plugin.json")
    ).json()) as {
      version: string;
    };
    const matrix = (await Bun.file(
      join(repoRoot, "docs", "codex-plugin-capability-matrix.json")
    ).json()) as {
      generatedFrom: { packageVersion: string; pluginVersion: string };
      capabilities: {
        id: string;
        mcp: {
          disposition: string;
          actions?: string[];
          plannedRouter?: string;
          tool?: string;
        };
        risk: string;
      }[];
    };
    const releaseConfig = (await Bun.file(
      join(repoRoot, ".releaserc.json")
    ).json()) as {
      plugins: Array<
        string | [string, { assets?: string[]; [key: string]: unknown }]
      >;
    };
    const ids = matrix.capabilities.map((capability) => capability.id);
    const setup = matrix.capabilities.find(
      (capability) => capability.id === "setup.readiness"
    );
    const reconciliation = matrix.capabilities.find(
      (capability) => capability.id === "reconciliation.review"
    );
    const evolutionLoop = matrix.capabilities.find(
      (capability) => capability.id === "evolution_loop.review"
    );
    const activityResolution = matrix.capabilities.find(
      (capability) =>
        capability.id === "evolution_loop.activity_action_resolution"
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(matrix.generatedFrom.packageVersion).toBe(packageJson.version);
    expect(matrix.generatedFrom.pluginVersion).toBe(pluginJson.version);
    expect(packageJson.scripts.version).toBe(
      "bun run scripts/sync-release-metadata.mjs"
    );
    const npmPluginIndex = releaseConfig.plugins.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/npm"
    );
    const metadataPluginIndex = releaseConfig.plugins.indexOf(
      "./scripts/sync-release-metadata.mjs"
    );
    const gitPluginIndex = releaseConfig.plugins.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git"
    );
    expect(metadataPluginIndex).toBeGreaterThan(npmPluginIndex);
    expect(metadataPluginIndex).toBeLessThan(gitPluginIndex);
    expect(
      releaseConfig.plugins.find(
        (plugin): plugin is [string, { assets?: string[] }] =>
          Array.isArray(plugin) && plugin[0] === "@semantic-release/git"
      )?.[1].assets
    ).toContain("docs/codex-plugin-capability-matrix.json");
    expect(setup?.mcp).toMatchObject({
      disposition: "exposed",
      tool: "fclt_setup",
    });
    expect(reconciliation?.risk).toBe("review_producing");
    expect(reconciliation?.mcp).toMatchObject({
      disposition: "exposed",
      tool: "fclt_registry",
      actions: ["reconcile_status", "reconcile"],
    });
    expect(evolutionLoop?.mcp).toMatchObject({
      disposition: "exposed",
      tool: "fclt_automation",
      actions: ["loop_status", "loop_activity", "loop_preview"],
    });
    expect(activityResolution).toMatchObject({
      risk: "read_only",
      mcp: {
        disposition: "exposed",
        tool: "fclt_registry",
        action: "activity_resolve",
      },
    });
  });
});
