import { describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { facultBuiltinPackRoot } from "./builtin";
import { LEGACY_MANAGED_MUTATION_FLAG } from "./legacy-mutation-policy";
import {
  inspectManagedStateRecords,
  loadManagedState,
  managedStatePath,
  managedStatePathForRoot,
  manageTool,
  type SetupCodexPluginResult,
  saveManagedState,
  setupCodexPlugin,
  syncManagedTools,
  unmanageTool,
} from "./manage";
import { facultMachineStateDir, legacyFacultStateDirForRoot } from "./paths";

const DOLLAR = "$";

function placeholder(name: string): string {
  return `${DOLLAR}{${name}}`;
}

const REFS_WRITING_RULE = placeholder("refs.review_policy");
const HOME_VAR = placeholder("HOME");

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "facult-manage-"));
}

async function writeJson(p: string, data: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeCodexPluginStub(args: {
  codexBin: string;
  enabled?: boolean;
  home: string;
  installedMutation?:
    | "aggregate-oversize"
    | "growing-file"
    | "hardlink"
    | "oversize-file"
    | "path-too-long"
    | "sparse-file"
    | "symlink"
    | "too-deep"
    | "too-many-entries"
    | "unreadable-subtree";
  listedVersion?: string;
  selectedVersion: string;
}): Promise<void> {
  await mkdir(dirname(args.codexBin), { recursive: true });
  await Bun.write(
    args.codexBin,
    [
      `#!${process.execPath}`,
      `import { spawn } from "node:child_process";`,
      `import { appendFileSync, chmodSync, closeSync, cpSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";`,
      `import { dirname, join } from "node:path";`,
      `const home = ${JSON.stringify(args.home)};`,
      `const selectedVersion = ${JSON.stringify(args.selectedVersion)};`,
      `const listedVersion = ${JSON.stringify(
        args.listedVersion ?? args.selectedVersion
      )};`,
      `const installedMutation = ${JSON.stringify(args.installedMutation ?? null)};`,
      `const installedPath = join(home, ".codex", "plugins", "cache", "local", "fclt", selectedVersion);`,
      "const argv = process.argv.slice(2);",
      `appendFileSync(join(home, "codex-args.txt"), argv.join("\\n") + "\\n--\\n");`,
      `if (argv[0] === "plugin" && argv[1] === "add") {`,
      "  rmSync(installedPath, { force: true, recursive: true });",
      "  mkdirSync(dirname(installedPath), { recursive: true });",
      `  cpSync(join(home, "plugins", "fclt"), installedPath, { recursive: true });`,
      `  if (installedMutation === "symlink") {`,
      `    symlinkSync(join(installedPath, "scripts"), join(installedPath, "unexpected-link"));`,
      `  } else if (installedMutation === "hardlink") {`,
      `    const outside = join(home, "outside-hardlink");`,
      `    writeFileSync(outside, "externally mutable executable input\\n");`,
      `    linkSync(outside, join(installedPath, "unexpected-hardlink"));`,
      `  } else if (installedMutation === "unreadable-subtree") {`,
      `    const unreadable = join(installedPath, "unexpected-private");`,
      "    mkdirSync(unreadable);",
      `    writeFileSync(join(unreadable, "hidden.txt"), "not-part-of-the-bundled-payload\\n");`,
      "    chmodSync(unreadable, 0);",
      `  } else if (installedMutation === "too-many-entries") {`,
      `    const crowded = join(installedPath, "unexpected-crowded");`,
      "    mkdirSync(crowded);",
      `    for (let index = 0; index < 260; index += 1) writeFileSync(join(crowded, String(index)), "");`,
      `  } else if (installedMutation === "oversize-file") {`,
      `    writeFileSync(join(installedPath, "unexpected-large"), Buffer.alloc(1_048_577));`,
      `  } else if (installedMutation === "aggregate-oversize") {`,
      `    for (let index = 0; index < 5; index += 1) writeFileSync(join(installedPath, "unexpected-aggregate-" + index), Buffer.alloc(900_000));`,
      `  } else if (installedMutation === "too-deep") {`,
      "    let deep = installedPath;",
      `    for (let index = 0; index < 13; index += 1) { deep = join(deep, "d" + index); mkdirSync(deep); }`,
      `  } else if (installedMutation === "path-too-long") {`,
      "    let longPath = installedPath;",
      `    for (let index = 0; index < 3; index += 1) { longPath = join(longPath, String(index).padEnd(180, "x")); mkdirSync(longPath); }`,
      `  } else if (installedMutation === "sparse-file") {`,
      `    const sparse = openSync(join(installedPath, "unexpected-sparse"), "w");`,
      "    ftruncateSync(sparse, 524_288);",
      "    closeSync(sparse);",
      `  } else if (installedMutation === "growing-file") {`,
      `    writeFileSync(join(installedPath, "unexpected-growing"), Buffer.alloc(131_072));`,
      "  }",
      `  console.log(JSON.stringify({ pluginId: "fclt@local", name: "fclt", marketplaceName: "local", version: selectedVersion, installedPath, authPolicy: "ON_INSTALL" }));`,
      `} else if (argv[0] === "plugin" && argv[1] === "list") {`,
      `  if (installedMutation === "growing-file") {`,
      `    const target = join(installedPath, "unexpected-growing");`,
      `    const ready = join(home, "growth-ready");`,
      `    const stop = join(home, "growth-stop");`,
      `    const script = 'const { appendFileSync, existsSync, writeFileSync } = require("node:fs"); const [target, ready, stop] = process.argv.slice(1); writeFileSync(ready, ""); const deadline = Date.now() + 2000; while (Date.now() < deadline && !existsSync(stop)) appendFileSync(target, Buffer.from([1]));';`,
      `    const mutator = spawn(process.execPath, ["-e", script, target, ready, stop], { detached: true, stdio: "ignore" });`,
      "    mutator.unref();",
      "    const readyDeadline = Date.now() + 1000;",
      "    while (!existsSync(ready) && Date.now() < readyDeadline) {}",
      "    if (!existsSync(ready)) process.exit(70);",
      "  }",
      `  console.log(JSON.stringify({ installed: [{ pluginId: "fclt@local", name: "fclt", marketplaceName: "local", version: listedVersion, installed: true, enabled: ${args.enabled !== false} }], available: [] }));`,
      "} else {",
      "  process.exitCode = 64;",
      "}",
      "",
    ].join("\n")
  );
  await chmod(args.codexBin, 0o755);
}

type InstalledPluginMutation = NonNullable<
  Parameters<typeof writeCodexPluginStub>[0]["installedMutation"]
>;

async function setupMutatedCodexPlugin(mutation: InstalledPluginMutation) {
  const home = await createTempDir();
  await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
    name: "local",
    interface: { displayName: "Local Plugins" },
    plugins: [],
  });
  const codexBin = join(home, "bin", "codex");
  await writeCodexPluginStub({
    codexBin,
    home,
    installedMutation: mutation,
    selectedVersion: "0.1.3",
  });
  return {
    home,
    result: await setupCodexPlugin({ homeDir: home, codexBin }),
  };
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(pathValue: string, relativePath: string): Promise<void> {
    const stat = await lstat(pathValue).catch(() => null);
    if (!stat) {
      return;
    }
    const key = relativePath || ".";
    if (stat.isSymbolicLink()) {
      snapshot[key] = `symlink:${await readlink(pathValue)}`;
      return;
    }
    if (stat.isDirectory()) {
      snapshot[key] = "directory";
      const entries = await readdir(pathValue);
      for (const entry of entries.sort()) {
        await visit(join(pathValue, entry), join(relativePath, entry));
      }
      return;
    }
    snapshot[key] = `file:${(await readFile(pathValue)).toString("base64")}`;
  }

  await visit(root, "");
  return snapshot;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", "./src/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

describe("managed state", () => {
  it("loads default state when missing", async () => {
    const home = await createTempDir();
    const state = await loadManagedState(home);
    expect(state.version).toBe(1);
    expect(state.tools).toEqual({});
  });

  it("omits absent managed-state candidates from read-only inspection", async () => {
    const homeDir = await createTempDir();
    const rootDir = join(homeDir, ".ai");

    expect(await inspectManagedStateRecords({ homeDir, rootDir })).toEqual([]);
  });

  it("reports invalid current and valid legacy records without fallback masking", async () => {
    const homeDir = await createTempDir();
    const rootDir = join(homeDir, ".ai");
    const currentPath = managedStatePathForRoot(homeDir, rootDir);
    const legacyPath = join(
      legacyFacultStateDirForRoot(rootDir, homeDir),
      "managed.json"
    );
    await mkdir(dirname(currentPath), { recursive: true });
    await Bun.write(currentPath, "{invalid\n");
    await writeJson(legacyPath, {
      version: 1,
      tools: {
        zeta: { tool: "zeta", privateValue: "must-not-be-reported" },
        alpha: { tool: "alpha", managedAt: "2026-07-12T00:00:00.000Z" },
      },
    });

    const inspections = await inspectManagedStateRecords({ homeDir, rootDir });

    expect(inspections).toEqual([
      {
        path: currentPath,
        location: "machine",
        state: "invalid",
        tools: [],
      },
      {
        path: legacyPath,
        location: "legacy",
        state: "valid",
        tools: ["alpha", "zeta"],
      },
    ]);
    expect(JSON.stringify(inspections)).not.toContain("must-not-be-reported");
  });

  it("rejects symlink and non-file managed-state candidates without reading them", async () => {
    const homeDir = await createTempDir();
    const rootDir = join(homeDir, ".ai");
    const currentPath = managedStatePathForRoot(homeDir, rootDir);
    const legacyPath = join(
      legacyFacultStateDirForRoot(rootDir, homeDir),
      "managed.json"
    );
    const symlinkTarget = join(homeDir, "outside-managed.json");
    await writeJson(symlinkTarget, {
      version: 1,
      tools: { "must-not-be-read": { tool: "must-not-be-read" } },
    });
    await mkdir(dirname(currentPath), { recursive: true });
    await symlink(symlinkTarget, currentPath);
    await mkdir(legacyPath, { recursive: true });

    const inspections = await inspectManagedStateRecords({ homeDir, rootDir });

    expect(inspections).toEqual([
      {
        path: currentPath,
        location: "machine",
        state: "unavailable",
        tools: [],
      },
      {
        path: legacyPath,
        location: "legacy",
        state: "unavailable",
        tools: [],
      },
    ]);
    expect(JSON.stringify(inspections)).not.toContain("must-not-be-read");
  });

  it("writes managed.json after managing", async () => {
    const home = await createTempDir();
    const rootDir = join(home, "agents", ".facult");
    const skillsRoot = join(rootDir, "skills", "alpha");
    await mkdir(skillsRoot, { recursive: true });
    await Bun.write(join(skillsRoot, "SKILL.md"), "# Alpha\n");

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: { test: { command: "node", args: ["server.js"] } },
    });

    await manageTool("cursor", {
      homeDir: home,
      rootDir,
      toolPaths: {
        cursor: {
          tool: "cursor",
          skillsDir: join(home, "tool", "skills"),
          mcpConfig: join(home, "tool", "mcp.json"),
        },
      },
    });

    const managedPath = managedStatePath(home);
    const raw = await readFile(managedPath, "utf8");
    const parsed = JSON.parse(raw) as { tools: Record<string, unknown> };
    expect(parsed.tools.cursor).toBeTruthy();
  });

  it("keeps an explicit custom global root out of project tool and state paths", async () => {
    const home = await createTempDir();
    const rootDir = join(home, "shared", ".ai");
    const stateRoot = join(home, "state");
    const env = {
      HOME: home,
      FACULT_LOCAL_STATE_DIR: stateRoot,
    };
    await mkdir(join(rootDir, "skills", "alpha"), { recursive: true });
    await Bun.write(join(rootDir, "skills", "alpha", "SKILL.md"), "# Alpha\n");
    await writeJson(join(rootDir, "mcp", "servers.json"), {
      servers: { first: { command: "first-server" } },
    });

    const managed = await runCli(
      [
        "manage",
        "cursor",
        "--global",
        "--root",
        rootDir,
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      env
    );
    expect(managed).toMatchObject({ code: 0, stderr: "" });
    expect(await readlink(join(home, ".cursor", "skills", "alpha"))).toBe(
      join(rootDir, "skills", "alpha")
    );
    expect(await Bun.file(join(home, ".cursor", "mcp.json")).exists()).toBe(
      true
    );
    expect(
      await Bun.file(join(home, "shared", ".cursor", "mcp.json")).exists()
    ).toBe(false);
    expect(
      await Bun.file(join(stateRoot, "global", "managed.json")).exists()
    ).toBe(true);
    expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);

    const listed = await runCli(
      ["managed", "--global", "--root", rootDir],
      env
    );
    expect(listed).toMatchObject({ code: 0, stderr: "" });
    expect(listed.stdout).toContain("cursor");

    await writeJson(join(rootDir, "mcp", "servers.json"), {
      servers: { second: { command: "second-server" } },
    });
    const synced = await runCli(
      [
        "sync",
        "cursor",
        "--global",
        "--root",
        rootDir,
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      env
    );
    expect(synced).toMatchObject({ code: 0, stderr: "" });
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toContain(
      "second-server"
    );
    const ledger = (
      await readFile(join(stateRoot, "global", "ledger", "sync.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { scope: string });
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((event) => event.scope === "global")).toBe(true);

    const unmanaged = await runCli(
      [
        "unmanage",
        "cursor",
        "--global",
        "--root",
        rootDir,
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      env
    );
    expect(unmanaged).toMatchObject({ code: 0, stderr: "" });
    const finalState = JSON.parse(
      await readFile(join(stateRoot, "global", "managed.json"), "utf8")
    ) as { tools: Record<string, unknown> };
    expect(finalState.tools.cursor).toBeUndefined();
    expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);
  });

  it("renders codex agents into the default managed output dir", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "agents", "argument-editor"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "agents", "argument-editor", "agent.toml"),
      `name = "argument-editor"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.review_policy}.\nTarget tool: \${TARGET_TOOL}.\n"""\n`
    );

    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "REVIEW.md"), "Review rules.\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/rules/REVIEW.md"\n'
    );

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const managedPath = managedStatePath(home);
    const raw = await readFile(managedPath, "utf8");
    const parsed = JSON.parse(raw) as {
      tools: Record<string, { agentsDir?: string }>;
    };
    expect(parsed.tools.codex?.agentsDir).toBe(join(home, ".codex", "agents"));

    const rendered = await readFile(
      join(home, ".codex", "agents", "argument-editor.toml"),
      "utf8"
    );
    expect(rendered).toContain(join(rootDir, "rules", "REVIEW.md"));
    expect(rendered).toContain("Target tool: codex.");
    expect(rendered).not.toContain(REFS_WRITING_RULE);
  });

  it("renders factory droids into markdown files", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "agents", "argument-editor"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "agents", "argument-editor", "agent.toml"),
      [
        'name = "argument-editor"',
        'description = "Editorial reviewer."',
        "",
        'developer_instructions = """',
        `Before reviewing, read ${"${"}refs.review_policy}.`,
        `Target tool: ${"${"}TARGET_TOOL}.`,
        '"""',
        "",
      ].join("\n")
    );

    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "REVIEW.md"), "Review rules.\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/rules/REVIEW.md"\n'
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("factory", {
      homeDir: home,
      rootDir,
    });

    const rendered = await readFile(
      join(home, ".factory", "droids", "argument-editor.md"),
      "utf8"
    );
    expect(rendered).toContain('name: "argument-editor"');
    expect(rendered).toContain('description: "Editorial reviewer."');
    expect(rendered).toContain('model: "inherit"');
    expect(rendered).toContain(join(rootDir, "rules", "REVIEW.md"));
    expect(rendered).toContain("Target tool: factory.");
    expect(rendered).not.toContain(REFS_WRITING_RULE);
  });

  it("renders codex automations into the shared Codex automation dir", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(rootDir, "automations", "project-check"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "automations", "project-check", "automation.toml"),
      [
        "version = 1",
        'id = "project-check"',
        'name = "Project check"',
        'prompt = "Inspect the repo"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "automations", "project-check", "memory.md"),
      "# Memory\n"
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[project_sync.codex]\nautomations = ["project-check"]\n'
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const renderedToml = await readFile(
      join(home, ".codex", "automations", "project-check", "automation.toml"),
      "utf8"
    );
    const renderedMemory = await readFile(
      join(home, ".codex", "automations", "project-check", "memory.md"),
      "utf8"
    );
    expect(renderedToml).toContain('id = "project-check"');
    expect(renderedMemory).toBe("# Memory\n");

    const managedPath = managedStatePathForRoot(home, rootDir);
    const raw = await readFile(managedPath, "utf8");
    const parsed = JSON.parse(raw) as {
      tools: Record<string, { automationDir?: string }>;
    };
    expect(parsed.tools.codex?.automationDir).toBe(
      join(home, ".codex", "automations")
    );
  });

  it("does not render project codex automations without explicit project sync opt-in", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(rootDir, "automations", "project-check"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "automations", "project-check", "automation.toml"),
      [
        "version = 1",
        'id = "project-check"',
        'name = "Project check"',
        'prompt = "Inspect the repo"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    expect(
      await Bun.file(
        join(home, ".codex", "automations", "project-check", "automation.toml")
      ).exists()
    ).toBe(false);
  });

  it("ignores default-denied project automations during managed-mode adoption preflight", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const automationName = "project-check";

    await mkdir(join(rootDir, "automations", automationName), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "automations", automationName, "automation.toml"),
      [
        "version = 1",
        `id = "${automationName}"`,
        'name = "Project check"',
        'prompt = "Canonical prompt"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await mkdir(join(home, ".codex", "automations", automationName), {
      recursive: true,
    });
    await Bun.write(
      join(home, ".codex", "automations", automationName, "automation.toml"),
      [
        "version = 1",
        `id = "${automationName}"`,
        'name = "Project check"',
        'prompt = "Live prompt"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const canonicalToml = await readFile(
      join(rootDir, "automations", automationName, "automation.toml"),
      "utf8"
    );
    expect(canonicalToml).toContain('prompt = "Canonical prompt"');
  });

  it("renders codex plugins into plugins/ and writes the .agents marketplace", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        ".codex-plugin"
      ),
      {
        recursive: true,
      }
    );
    await Bun.write(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        ".codex-plugin",
        "plugin.json"
      ),
      JSON.stringify(
        {
          name: "autoresearch",
          version: "0.1.0",
          interface: { displayName: "Autoresearch" },
        },
        null,
        2
      )
    );
    await mkdir(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        "skills",
        "autoresearch"
      ),
      { recursive: true }
    );
    await Bun.write(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        "skills",
        "autoresearch",
        "SKILL.md"
      ),
      "# Autoresearch\n"
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "plugins", "marketplace.json"),
      JSON.stringify(
        {
          name: "local",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "autoresearch",
              source: { source: "local", path: "./plugins/autoresearch" },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ],
        },
        null,
        2
      )
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    const managed = await loadManagedState(home);
    expect(managed.tools.codex?.pluginsDir).toBe(join(home, "plugins"));
    expect(managed.tools.codex?.pluginMarketplacePath).toBe(
      join(home, ".agents", "plugins", "marketplace.json")
    );

    const marketplace = await readFile(
      join(home, ".agents", "plugins", "marketplace.json"),
      "utf8"
    );
    expect(marketplace).toContain('"path": "./plugins/autoresearch"');

    const livePluginManifest = await readFile(
      join(home, "plugins", "autoresearch", ".codex-plugin", "plugin.json"),
      "utf8"
    );
    expect(livePluginManifest).toContain('"name": "autoresearch"');
  });

  it("syncs builtin operating-model skills, agents, and global docs by default", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const skillLink = join(home, ".agents", "skills", "capability-evolution");
    const skillStat = await lstat(skillLink);
    expect(skillStat.isSymbolicLink()).toBe(true);
    expect(await readlink(skillLink)).toContain(
      join(
        "assets",
        "packs",
        "facult-operating-model",
        "skills",
        "capability-evolution"
      )
    );

    const agentText = await readFile(
      join(home, ".codex", "agents", "writeback-curator.toml"),
      "utf8"
    );
    expect(agentText).toContain('name = "writeback-curator"');

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(
      join(facultBuiltinPackRoot(), "instructions", "EVOLUTION.md")
    );
  });

  it("syncs the builtin fclt codex plugin and marketplace by default", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const marketplace = await readFile(
      join(home, ".agents", "plugins", "marketplace.json"),
      "utf8"
    );
    expect(marketplace).toContain('"name": "fclt"');
    expect(marketplace).toContain('"path": "./plugins/fclt"');

    const pluginManifest = await readFile(
      join(home, "plugins", "fclt", ".codex-plugin", "plugin.json"),
      "utf8"
    );
    expect(pluginManifest).toContain('"name": "fclt"');

    const mcpConfig = JSON.parse(
      await readFile(join(home, "plugins", "fclt", ".mcp.json"), "utf8")
    ) as {
      mcpServers: {
        fclt: {
          command: string;
          args: string[];
          env: { FCLT_BIN?: string; PATH: string };
          cwd: string;
        };
      };
    };
    const fcltServer = mcpConfig.mcpServers.fclt;
    expect(fcltServer.args).toContain("./scripts/fclt-mcp.cjs");
    expect(fcltServer.cwd).toBe(".");
    expect(isAbsolute(fcltServer.command)).toBe(true);
    expect(fcltServer.env.PATH).toContain(dirname(fcltServer.command));

    const proc = Bun.spawn(
      [fcltServer.command, ...fcltServer.args, "--self-test"],
      {
        cwd: join(home, "plugins", "fclt"),
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: fcltServer.env.PATH,
          ...(fcltServer.env.FCLT_BIN
            ? { FCLT_BIN: fcltServer.env.FCLT_BIN }
            : {}),
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("fclt_evolve");
  });

  it("can disable builtin default sync via config", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      "version = 1\n\n[builtin]\nsync_defaults = false\n"
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    expect(
      await Bun.file(
        join(home, ".agents", "skills", "capability-evolution", "SKILL.md")
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(home, ".codex", "agents", "writeback-curator.toml")
      ).exists()
    ).toBe(false);
    expect(await Bun.file(join(home, ".codex", "AGENTS.md")).exists()).toBe(
      false
    );
    expect(await Bun.file(join(home, "plugins", "fclt")).exists()).toBe(false);
    expect(
      await Bun.file(
        join(home, ".agents", "plugins", "marketplace.json")
      ).exists()
    ).toBe(false);
  });

  it("does not create codex plugin output dirs when no canonical plugin content exists", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      "version = 1\n\n[builtin]\nsync_defaults = false\n"
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    expect(await Bun.file(join(home, "plugins")).exists()).toBe(false);
    expect(
      await Bun.file(
        join(home, ".agents", "plugins", "marketplace.json")
      ).exists()
    ).toBe(false);
  });

  it("preserves local edits on builtin-backed global docs unless overwrite is requested", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const targetPath = join(home, ".codex", "AGENTS.md");
    const original = await readFile(targetPath, "utf8");
    await Bun.write(targetPath, `${original}\nLocal note.\n`);

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
    });
    const preserved = await readFile(targetPath, "utf8");
    expect(preserved).toContain("Local note.");

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      builtinConflictMode: "overwrite",
    });
    const overwritten = await readFile(targetPath, "utf8");
    expect(overwritten).not.toContain("Local note.");
    expect(overwritten).toContain(
      join(facultBuiltinPackRoot(), "instructions", "EVOLUTION.md")
    );
  });

  it("preserves local edits on canonical-backed global docs even when builtin overwrite is requested", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(join(rootDir, "AGENTS.global.md"), "Canonical doc.\n");

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const targetPath = join(home, ".codex", "AGENTS.md");
    await Bun.write(targetPath, "User-edited live doc.\n");
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      "Updated canonical doc.\n"
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      builtinConflictMode: "overwrite",
    });

    const preserved = await readFile(targetPath, "utf8");
    expect(preserved).toBe("User-edited live doc.\n");
  });

  it("renders and reconciles Claude global docs via the default CLAUDE.md surface", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/instructions/REVIEW.md"\n'
    );
    await Bun.write(
      join(rootDir, "instructions", "REVIEW.md"),
      "Write directly.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Read ${REFS_WRITING_RULE}.\nTarget tool: ${placeholder("TARGET_TOOL")}.\n`
    );
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      "Unused Claude override.\n"
    );

    await manageTool("claude", {
      homeDir: home,
      rootDir,
    });

    const globalClaude = await readFile(
      join(home, ".claude", "CLAUDE.md"),
      "utf8"
    );
    expect(globalClaude).toContain(join(rootDir, "instructions", "REVIEW.md"));
    expect(globalClaude).toContain("Target tool: claude.");
    expect(
      await Bun.file(join(home, ".claude", "CLAUDE.override.md")).exists()
    ).toBe(false);

    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Updated for ${placeholder("TARGET_TOOL")}.\nRead ${REFS_WRITING_RULE} again.\n`
    );
    await syncManagedTools({ homeDir: home, rootDir, tool: "claude" });

    const updatedClaude = await readFile(
      join(home, ".claude", "CLAUDE.md"),
      "utf8"
    );
    expect(updatedClaude).toContain("Updated for claude.");
  });

  it("renders and reconciles Cursor global docs by default and config/rules when explicitly configured", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/instructions/REVIEW.md"\n'
    );
    await Bun.write(
      join(rootDir, "instructions", "REVIEW.md"),
      "Write directly.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Read ${REFS_WRITING_RULE}.\nTarget tool: ${placeholder("TARGET_TOOL")}.\n`
    );
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      `Override for ${placeholder("TARGET_TOOL")}.\n`
    );
    await mkdir(join(rootDir, "tools", "cursor", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "cursor", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await Bun.write(
      join(rootDir, "tools", "cursor", "config.toml"),
      'approval_policy = "never"\n'
    );

    await manageTool("cursor", {
      homeDir: home,
      rootDir,
      toolPaths: {
        cursor: {
          tool: "cursor",
          rulesDir: join(home, ".cursor", "rules"),
          toolConfig: join(home, ".cursor", "config.toml"),
        },
      },
    });

    const globalAgents = await readFile(
      join(home, ".cursor", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(join(rootDir, "instructions", "REVIEW.md"));
    expect(globalAgents).toContain("Target tool: cursor.");

    const globalOverride = await readFile(
      join(home, ".cursor", "AGENTS.override.md"),
      "utf8"
    );
    expect(globalOverride).toContain("Override for cursor.");

    const toolConfig = await readFile(
      join(home, ".cursor", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "never"');

    const rule = await readFile(
      join(home, ".cursor", "rules", "default.rules"),
      "utf8"
    );
    expect(rule).toContain('pattern = ["gh"]');

    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Updated for ${placeholder("TARGET_TOOL")}.\nRead ${REFS_WRITING_RULE} again.\n`
    );
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      `Updated override for ${placeholder("TARGET_TOOL")}.\n`
    );
    await Bun.write(
      join(rootDir, "tools", "cursor", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh", "git"], decision = "prompt")\n'
    );
    await Bun.write(
      join(rootDir, "tools", "cursor", "config.toml"),
      'approval_policy = "trusted-only"\n'
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "cursor" });

    const updatedGlobalAgents = await readFile(
      join(home, ".cursor", "AGENTS.md"),
      "utf8"
    );
    expect(updatedGlobalAgents).toContain("Updated for cursor.");

    const updatedOverride = await readFile(
      join(home, ".cursor", "AGENTS.override.md"),
      "utf8"
    );
    expect(updatedOverride).toContain("Updated override for cursor.");

    const updatedConfig = await readFile(
      join(home, ".cursor", "config.toml"),
      "utf8"
    );
    expect(updatedConfig).toContain('approval_policy = "trusted-only"');

    const updatedRule = await readFile(
      join(home, ".cursor", "rules", "default.rules"),
      "utf8"
    );
    expect(updatedRule).toContain('"git"');
  });
});

describe("manage/unmanage", () => {
  it("adopts existing tool-native skills into the canonical store when requested during managed-mode entry", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const toolSkills = join(home, ".agents", "skills");
    await mkdir(join(toolSkills, "legacy-skill"), { recursive: true });
    await Bun.write(
      join(toolSkills, "legacy-skill", "SKILL.md"),
      [
        "---",
        "description: Legacy skill carried over from the live Codex install.",
        "tags: [legacy]",
        "---",
        "",
        "# Legacy Skill",
      ].join("\n")
    );
    await mkdir(join(toolSkills, ".system"), { recursive: true });
    await Bun.write(
      join(toolSkills, ".system", ".codex-system-skills.marker"),
      ""
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
    });

    const adoptedSkillPath = join(
      rootDir,
      "skills",
      "legacy-skill",
      "SKILL.md"
    );
    const adoptedSkill = await readFile(adoptedSkillPath, "utf8");
    expect(adoptedSkill).toContain("Legacy skill carried over");

    const liveLinkPath = join(toolSkills, "legacy-skill");
    const liveLinkStat = await lstat(liveLinkPath);
    expect(liveLinkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(liveLinkPath)).toBe(
      join(rootDir, "skills", "legacy-skill")
    );

    const indexRaw = await readFile(
      join(home, ".ai", ".facult", "ai", "index.json"),
      "utf8"
    );
    const index = JSON.parse(indexRaw) as {
      skills: Record<string, { path: string }>;
    };
    expect(index.skills["legacy-skill"]?.path).toBe(
      join(rootDir, "skills", "legacy-skill")
    );

    const preservedSystemMarker = await readFile(
      join(toolSkills, ".system", ".codex-system-skills.marker"),
      "utf8"
    );
    expect(preservedSystemMarker).toBe("");
  });

  it("requires preflight adoption review before managing when live skills already exist", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const toolSkills = join(home, ".codex", "skills");
    await mkdir(join(toolSkills, "legacy-skill"), { recursive: true });
    await Bun.write(
      join(toolSkills, "legacy-skill", "SKILL.md"),
      "# Legacy Skill\n"
    );

    await expect(
      manageTool("codex", {
        homeDir: home,
        rootDir,
      })
    ).rejects.toThrow("must be reviewed before entering managed mode");

    const managed = await loadManagedState(home, rootDir);
    expect(managed.tools.codex).toBeUndefined();
  });

  it("requires explicit conflict policy when adopting existing conflicting skills", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "skills", "shared-skill"), { recursive: true });
    await Bun.write(
      join(rootDir, "skills", "shared-skill", "SKILL.md"),
      "# Canonical Skill\n"
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const toolSkills = join(home, ".codex", "skills");
    await mkdir(join(toolSkills, "shared-skill"), { recursive: true });
    await Bun.write(
      join(toolSkills, "shared-skill", "SKILL.md"),
      "# Live Skill\n"
    );

    await expect(
      manageTool("codex", {
        homeDir: home,
        rootDir,
        adoptExisting: true,
      })
    ).rejects.toThrow(
      'Rerun with "--existing-conflicts keep-canonical" or "--existing-conflicts keep-existing"'
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
      existingConflictMode: "keep-existing",
    });

    const canonical = await readFile(
      join(rootDir, "skills", "shared-skill", "SKILL.md"),
      "utf8"
    );
    expect(canonical).toBe("# Live Skill\n");
  });

  it("adopts existing managed content across skills, agents, overlapping automations, docs, rules, config, and mcp", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(join(home, ".codex"), { recursive: true });

    await mkdir(join(home, ".codex", "skills", "legacy-skill"), {
      recursive: true,
    });
    await Bun.write(
      join(home, ".codex", "skills", "legacy-skill", "SKILL.md"),
      "# Legacy Skill\n"
    );

    await mkdir(join(home, ".codex", "agents"), { recursive: true });
    await Bun.write(
      join(home, ".codex", "agents", "legacy-agent.toml"),
      'name = "legacy-agent"\n'
    );
    await mkdir(join(rootDir, "automations", "legacy-review"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "automations", "legacy-review", "automation.toml"),
      [
        "version = 1",
        'id = "legacy-review"',
        'name = "Canonical review"',
        'prompt = "Canonical prompt"',
        'status = "PAUSED"',
        'rrule = "FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await mkdir(join(home, ".codex", "automations", "legacy-review"), {
      recursive: true,
    });
    await Bun.write(
      join(home, ".codex", "automations", "legacy-review", "automation.toml"),
      [
        "version = 1",
        'id = "legacy-review"',
        'name = "Legacy review"',
        'prompt = "Review changes"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await Bun.write(
      join(home, ".codex", "automations", "legacy-review", "memory.md"),
      "# Legacy automation memory\n"
    );

    await Bun.write(join(home, ".codex", "AGENTS.md"), "# Legacy Global\n");
    await mkdir(join(home, ".codex", "rules"), { recursive: true });
    await Bun.write(
      join(home, ".codex", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await Bun.write(
      join(home, ".codex", "config.toml"),
      'approval_policy = "never"\n'
    );
    await writeJson(join(home, ".codex", "mcp.json"), {
      mcpServers: {
        github: { command: "node", args: ["server.js"] },
      },
    });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
      existingConflictMode: "keep-existing",
    });

    expect(
      await readFile(
        join(rootDir, "skills", "legacy-skill", "SKILL.md"),
        "utf8"
      )
    ).toBe("# Legacy Skill\n");
    expect(
      await readFile(
        join(rootDir, "agents", "legacy-agent", "agent.toml"),
        "utf8"
      )
    ).toContain('name = "legacy-agent"');
    expect(
      await readFile(
        join(rootDir, "automations", "legacy-review", "automation.toml"),
        "utf8"
      )
    ).toContain('id = "legacy-review"');
    expect(
      await readFile(
        join(rootDir, "automations", "legacy-review", "automation.toml"),
        "utf8"
      )
    ).toContain('name = "Legacy review"');
    expect(
      await readFile(
        join(rootDir, "automations", "legacy-review", "memory.md"),
        "utf8"
      )
    ).toBe("# Legacy automation memory\n");
    expect(await readFile(join(rootDir, "AGENTS.global.md"), "utf8")).toBe(
      "# Legacy Global\n"
    );
    expect(
      await readFile(
        join(rootDir, "tools", "codex", "rules", "default.rules"),
        "utf8"
      )
    ).toContain('pattern = ["gh"]');
    expect(
      await readFile(join(rootDir, "tools", "codex", "config.toml"), "utf8")
    ).toContain('approval_policy = "never"');

    const canonicalMcp = JSON.parse(
      await readFile(join(rootDir, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { command: string }>;
    };
    expect(canonicalMcp.servers.github?.command).toBe("node");
  });

  it("requires preflight review for existing non-skill managed content", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(join(home, ".codex"), { recursive: true });

    await Bun.write(join(home, ".codex", "AGENTS.md"), "# Legacy Global\n");

    await expect(
      manageTool("codex", {
        homeDir: home,
        rootDir,
      })
    ).rejects.toThrow("must be reviewed before entering managed mode");
  });

  it("backs up, renders, and restores", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    const skill = join(rootDir, "skills", "alpha");
    await mkdir(skill, { recursive: true });
    await Bun.write(join(skill, "SKILL.md"), "# Alpha\n");

    const agent = join(rootDir, "agents", "alpha");
    await mkdir(agent, { recursive: true });
    await Bun.write(
      join(agent, "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.review_policy}.\nTarget file: \${TARGET_PATH}\n"""\n`
    );

    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "REVIEW.md"), "Review rules.\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/rules/REVIEW.md"\n'
    );

    const indexPath = join(home, ".ai", ".facult", "ai", "index.json");

    await writeJson(indexPath, {
      skills: {
        alpha: {
          name: "alpha",
          path: skill,
          enabledFor: ["codex"],
        },
      },
    });

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: {
        alpha: { command: "node", args: ["server.js"], enabledFor: ["cursor"] },
        beta: { command: "node", args: ["skip.js"], enabledFor: ["codex"] },
      },
    });

    const toolRoot = join(home, "tool");
    const toolSkills = join(toolRoot, "skills");
    const toolMcp = join(toolRoot, "mcp.json");
    const toolAgents = join(toolRoot, "agents");
    await mkdir(toolSkills, { recursive: true });
    await Bun.write(join(toolSkills, "legacy.txt"), "old");
    await writeJson(toolMcp, { servers: { legacy: { command: "old" } } });
    await mkdir(toolAgents, { recursive: true });
    await Bun.write(join(toolAgents, "legacy.toml"), "old");

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
      toolPaths: {
        codex: {
          tool: "codex",
          skillsDir: toolSkills,
          mcpConfig: toolMcp,
          agentsDir: toolAgents,
        },
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const linkPath = join(toolSkills, "alpha");
    const st = await lstat(linkPath);
    expect(st.isSymbolicLink()).toBe(true);
    const target = await readlink(linkPath);
    expect(target).toBe(skill);

    const renderedAgent = await readFile(
      join(toolAgents, "alpha.toml"),
      "utf8"
    );
    expect(renderedAgent).toContain(join(rootDir, "rules", "REVIEW.md"));
    expect(renderedAgent).toContain(join(toolAgents, "alpha.toml"));

    const newMcp = JSON.parse(await readFile(toolMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(newMcp.mcpServers).length).toBeGreaterThan(0);

    await unmanageTool("codex", {
      homeDir: home,
      toolPaths: {
        codex: {
          tool: "codex",
          skillsDir: toolSkills,
          mcpConfig: toolMcp,
          agentsDir: toolAgents,
        },
      },
    });

    const restored = await readFile(join(toolSkills, "legacy.txt"), "utf8");
    expect(restored).toBe("old");
    const restoredMcp = JSON.parse(await readFile(toolMcp, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(restoredMcp.servers)).toEqual(["legacy"]);

    const restoredAgent = await readFile(
      join(toolAgents, "legacy.toml"),
      "utf8"
    );
    expect(restoredAgent).toBe("old");
  });

  it("manages global codex AGENTS.md and rules with backups", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/instructions/REVIEW.md"\n'
    );
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "instructions", "REVIEW.md"),
      "Write directly.\n"
    );
    await mkdir(join(rootDir, "snippets", "global", "codex"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "snippets", "global", "codex", "base.md"),
      "Always show the active instruction sources before editing.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      [
        "# Global Instructions",
        "",
        "<!-- fclty:global/codex/base -->",
        "OLD",
        "<!-- /fclty:global/codex/base -->",
        "",
        `Read ${REFS_WRITING_RULE}.`,
      ].join("\n")
    );
    await mkdir(join(rootDir, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      [
        'project_doc_fallback_filenames = ["TEAM_GUIDE.md", "team_guide.md", ".agents.md"]',
        "project_doc_max_bytes = 65536",
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "rules", "default.rules"),
      [
        "prefix_rule(",
        `    pattern = ["python3", "${HOME_VAR}/.codex/skills/.system/skill-creator/scripts/init_skill.py"],`,
        '    decision = "prompt",',
        ")",
      ].join("\n")
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await mkdir(join(home, ".codex", "rules"), { recursive: true });
    await Bun.write(join(home, ".codex", "AGENTS.md"), "legacy global\n");
    await Bun.write(
      join(home, ".codex", "config.toml"),
      `${[
        'approval_policy = "never"',
        "",
        '[projects."/workspace/facult"]',
        'trust_level = "trusted"',
      ].join("\n")}\n`
    );
    await Bun.write(join(home, ".codex", "rules", "legacy.rules"), "legacy\n");

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
      existingConflictMode: "keep-canonical",
    });

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(
      "Always show the active instruction sources before editing."
    );
    expect(globalAgents).toContain(join(rootDir, "instructions", "REVIEW.md"));
    expect(globalAgents).not.toContain(REFS_WRITING_RULE);

    const defaultRule = await readFile(
      join(home, ".codex", "rules", "default.rules"),
      "utf8"
    );
    expect(defaultRule).toContain(
      `pattern = ["python3", "${join(home, ".codex", "skills", ".system", "skill-creator", "scripts", "init_skill.py")}"]`
    );
    expect(defaultRule).not.toContain(HOME_VAR);

    const toolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "never"');
    expect(toolConfig).toContain("TEAM_GUIDE.md");
    expect(toolConfig).toContain("team_guide.md");
    expect(toolConfig).toContain("project_doc_max_bytes = 65536");
    expect(toolConfig).toContain('[projects."/workspace/facult"]');
    expect(toolConfig).toContain('trust_level = "trusted"');

    const legacyRuleExists = await Bun.file(
      join(home, ".codex", "rules", "legacy.rules")
    ).exists();
    expect(legacyRuleExists).toBe(true);

    await unmanageTool("codex", { homeDir: home });

    const restoredGlobalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(restoredGlobalAgents).toBe("legacy global\n");
    const restoredToolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(restoredToolConfig).toBe(
      [
        'approval_policy = "never"',
        "",
        '[projects."/workspace/facult"]',
        'trust_level = "trusted"',
        "",
      ].join("\n")
    );
    const restoredLegacyRule = await readFile(
      join(home, ".codex", "rules", "legacy.rules"),
      "utf8"
    );
    expect(restoredLegacyRule).toBe("legacy\n");
  });
});

describe("syncManagedTools", () => {
  it("keeps canonical, generated, runtime, and live trees unchanged during dry-run", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    const skillsDir = join(home, "tool", "skills");
    const agentsDir = join(home, "tool", "agents");

    await mkdir(join(rootDir, "skills", "alpha"), { recursive: true });
    await Bun.write(join(rootDir, "skills", "alpha", "SKILL.md"), "# Alpha\n");
    await mkdir(join(rootDir, "agents", "reviewer"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "reviewer", "agent.toml"),
      'name = "reviewer"\n\ndeveloper_instructions = "Review carefully."\n'
    );
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });
    await mkdir(skillsDir, { recursive: true });
    await Bun.write(join(skillsDir, "owned.txt"), "tool-owned skill state\n");
    await mkdir(agentsDir, { recursive: true });
    await Bun.write(join(agentsDir, "owned.txt"), "tool-owned agent state\n");
    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-07-11T00:00:00.000Z",
            skillsDir,
            agentsDir,
          },
        },
      },
      home,
      rootDir
    );
    const before = await snapshotTree(home);

    await syncManagedTools({
      homeDir: home,
      rootDir,
      scope: "global",
      tool: "codex",
      dryRun: true,
      allowLegacyManagedMutation: false,
    });

    expect(await snapshotTree(home)).toEqual(before);
    expect(
      await Bun.file(join(rootDir, ".facult", "ai", "index.json")).exists()
    ).toBe(false);
    expect(
      await Bun.file(join(rootDir, ".facult", "ai", "graph.json")).exists()
    ).toBe(false);
  });

  it("preserves hidden tool-owned skill entries during sync planning", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "skills", "alpha"), { recursive: true });
    await Bun.write(join(rootDir, "skills", "alpha", "SKILL.md"), "# Alpha\n");
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const codexSkillsDir = join(home, ".codex", "skills");
    await mkdir(join(codexSkillsDir, ".system"), { recursive: true });
    await Bun.write(
      join(codexSkillsDir, ".system", ".codex-system-skills.marker"),
      ""
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-03-19T00:13:23.457Z",
            skillsDir: codexSkillsDir,
          },
        },
      },
      home,
      rootDir
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      await syncManagedTools({
        homeDir: home,
        rootDir,
        tool: "codex",
        dryRun: true,
      });
    } finally {
      console.log = originalLog;
    }

    expect(
      logs.some((line) => line.includes("would remove skill .system"))
    ).toBe(false);
  });

  it("does not overwrite disabled canonical skills when live unmanaged copies differ", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const codexSkillsDir = join(home, ".codex", "skills");

    await mkdir(join(rootDir, "skills", "disabled-skill"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "skills", "disabled-skill", "SKILL.md"),
      "# Canonical Disabled Skill\n"
    );
    await Bun.write(
      join(rootDir, "config.toml"),
      "version = 1\n\n[project_sync.codex]\nskills = []\n"
    );
    await mkdir(join(codexSkillsDir, "disabled-skill"), { recursive: true });
    await Bun.write(
      join(codexSkillsDir, "disabled-skill", "SKILL.md"),
      "# Live Unmanaged Skill\n"
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-03-19T00:13:23.457Z",
            skillsDir: codexSkillsDir,
          },
        },
      },
      home,
      rootDir
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    expect(
      await readFile(
        join(rootDir, "skills", "disabled-skill", "SKILL.md"),
        "utf8"
      )
    ).toBe("# Canonical Disabled Skill\n");
    expect(
      await readFile(join(codexSkillsDir, "disabled-skill", "SKILL.md"), "utf8")
    ).toBe("# Live Unmanaged Skill\n");
  });

  it("skips manually edited live skill directories by default", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "skills", "shared-skill"), { recursive: true });
    await Bun.write(
      join(rootDir, "skills", "shared-skill", "SKILL.md"),
      "# Canonical Skill\n"
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const codexSkillsDir = join(home, ".agents", "skills");
    await mkdir(join(codexSkillsDir, "shared-skill"), { recursive: true });
    await Bun.write(
      join(codexSkillsDir, "shared-skill", "SKILL.md"),
      "# User Edited Skill\n"
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-03-19T00:13:23.457Z",
            skillsDir: codexSkillsDir,
          },
        },
      },
      home,
      rootDir
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
    });

    expect(
      await readFile(
        join(rootDir, "skills", "shared-skill", "SKILL.md"),
        "utf8"
      )
    ).toBe("# Canonical Skill\n");
    expect(
      await readFile(join(codexSkillsDir, "shared-skill", "SKILL.md"), "utf8")
    ).toBe("# User Edited Skill\n");
  });

  it("adopts manually edited live skill directories with explicit opt-in", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "skills", "shared-skill"), { recursive: true });
    await Bun.write(
      join(rootDir, "skills", "shared-skill", "SKILL.md"),
      "# Canonical Skill\n"
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const codexSkillsDir = join(home, ".agents", "skills");
    await mkdir(join(codexSkillsDir, "shared-skill"), { recursive: true });
    await Bun.write(
      join(codexSkillsDir, "shared-skill", "SKILL.md"),
      "# User Edited Skill\n"
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-03-19T00:13:23.457Z",
            skillsDir: codexSkillsDir,
          },
        },
      },
      home,
      rootDir
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    const liveSkillPath = join(codexSkillsDir, "shared-skill");
    const liveSkillStat = await lstat(liveSkillPath);
    expect(liveSkillStat.isSymbolicLink()).toBe(true);
    expect(
      await readFile(
        join(rootDir, "skills", "shared-skill", "SKILL.md"),
        "utf8"
      )
    ).toBe("# User Edited Skill\n");

    const ledger = (
      await readFile(
        join(facultMachineStateDir(home, rootDir), "ledger", "sync.jsonl"),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; reason: string });
    expect(
      ledger.some(
        (event) => event.action === "adopt" && event.reason === "skill_modified"
      )
    ).toBe(true);
  });

  it("adopts unmanaged live skill directories with explicit opt-in", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const codexSkillsDir = join(home, ".agents", "skills");
    await mkdir(join(codexSkillsDir, "new-skill"), { recursive: true });
    await Bun.write(
      join(codexSkillsDir, "new-skill", "SKILL.md"),
      "# New Skill\n"
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-03-19T00:13:23.457Z",
            skillsDir: codexSkillsDir,
          },
        },
      },
      home,
      rootDir
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    const liveSkillPath = join(codexSkillsDir, "new-skill");
    const liveSkillStat = await lstat(liveSkillPath);
    expect(liveSkillStat.isSymbolicLink()).toBe(true);
    expect(
      await readFile(join(rootDir, "skills", "new-skill", "SKILL.md"), "utf8")
    ).toBe("# New Skill\n");
  });

  it("skips local edits to canonical-backed rendered docs without writing rendered text back to source", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/instructions/REVIEW.md"\n'
    );
    await Bun.write(
      join(rootDir, "instructions", "REVIEW.md"),
      "Write directly.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Read ${REFS_WRITING_RULE}.\n`
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const targetPath = join(home, ".codex", "AGENTS.md");
    await Bun.write(targetPath, "# Live Edited Global\n");

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    expect(await readFile(join(rootDir, "AGENTS.global.md"), "utf8")).toBe(
      `Read ${REFS_WRITING_RULE}.\n`
    );
    expect(await readFile(targetPath, "utf8")).toBe("# Live Edited Global\n");
  });

  it("skips local edits to managed mcp config instead of overwriting them", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), {
      servers: { canonical: { command: "node", args: ["canonical.js"] } },
    });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const targetPath = join(home, ".codex", "mcp.json");
    const liveEdited = {
      mcpServers: { live: { command: "node", args: ["live.js"] } },
    };
    await writeJson(targetPath, liveEdited);
    await writeJson(join(rootDir, "mcp", "servers.json"), {
      servers: { canonical: { command: "node", args: ["updated.js"] } },
    });

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual(liveEdited);
  });

  it("skips project sync entirely when the project .ai root is generated-only", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const targetPath = join(projectRoot, ".codex", "AGENTS.md");

    await mkdir(join(rootDir, ".facult", "ai"), { recursive: true });
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, "# Rendered project docs\n");
    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-05-24T00:00:00.000Z",
            toolHome: join(projectRoot, ".codex"),
            globalAgentsPath: targetPath,
            renderedTargets: {
              [targetPath]: {
                hash: "existing-hash",
                sourcePath: join(rootDir, "AGENTS.global.md"),
                sourceKind: "canonical",
              },
            },
          },
        },
      },
      home,
      rootDir
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
    });

    expect(await readFile(targetPath, "utf8")).toBe(
      "# Rendered project docs\n"
    );
    const ledger = await readFile(
      join(facultMachineStateDir(home, rootDir), "ledger", "sync.jsonl"),
      "utf8"
    );
    expect(ledger).toContain("generated_only_project_root");
  });

  it("does not treat project roots with rules as generated-only", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const targetPath = join(projectRoot, ".codex", "AGENTS.md");

    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "POLICY.md"), "Project policy.\n");
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, "# Rendered project docs\n");
    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-05-24T00:00:00.000Z",
            toolHome: join(projectRoot, ".codex"),
            globalAgentsPath: targetPath,
            renderedTargets: {
              [targetPath]: {
                hash: "existing-hash",
                sourcePath: join(rootDir, "AGENTS.global.md"),
                sourceKind: "canonical",
              },
            },
          },
        },
      },
      home,
      rootDir
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
    });

    const ledger = await readFile(
      join(facultMachineStateDir(home, rootDir), "ledger", "sync.jsonl"),
      "utf8"
    );
    expect(ledger).not.toContain("generated_only_project_root");
  });

  it("skips rendered target removal when the previous canonical source is missing", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(rootDir, "agents", "alpha"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "alpha", "agent.toml"),
      'name = "alpha"\n'
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[project_sync.codex]\nagents = ["alpha"]\n'
    );

    await manageTool("codex", { homeDir: home, rootDir });
    const targetPath = join(projectRoot, ".codex", "agents", "alpha.toml");

    await rm(join(rootDir, "agents", "alpha"), {
      recursive: true,
      force: true,
    });
    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    expect(await Bun.file(targetPath).exists()).toBe(true);
  });

  it("manages project-local codex artifacts from a repo-local .ai root", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      [
        "version = 1",
        "",
        "[refs]",
        'review_policy = "@project/instructions/REVIEW.md"',
        "",
        "[project_sync.codex]",
        'agents = ["alpha"]',
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "instructions", "REVIEW.md"),
      "Project-specific writing guidance.\n"
    );
    await mkdir(join(rootDir, "agents", "alpha"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "alpha", "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nRead \${refs.review_policy}.\nTarget tool: \${TARGET_TOOL}.\n"""\n`
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    const rendered = await readFile(
      join(projectRoot, ".codex", "agents", "alpha.toml"),
      "utf8"
    );
    expect(rendered).toContain(join(rootDir, "instructions", "REVIEW.md"));
    expect(rendered).toContain("Target tool: codex.");

    const managedRaw = await readFile(
      managedStatePathForRoot(home, rootDir),
      "utf8"
    );
    const managed = JSON.parse(managedRaw).tools.codex;
    expect(managed.agentsDir).toBe(join(projectRoot, ".codex", "agents"));
    expect(managed.pluginsDir).toBeUndefined();
    expect(managed.pluginMarketplacePath).toBeUndefined();
    expect(
      await Bun.file(
        join(
          projectRoot,
          ".agents",
          "skills",
          "capability-evolution",
          "SKILL.md"
        )
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(projectRoot, ".codex", "agents", "writeback-curator.toml")
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(join(projectRoot, ".codex", "AGENTS.md")).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(projectRoot, ".agents", "plugins", "marketplace.json")
      ).exists()
    ).toBe(false);
    expect(await Bun.file(join(projectRoot, "plugins")).exists()).toBe(false);
  });

  it("ignores repo-local codex plugin payloads when managing a project root", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });
    await mkdir(
      join(projectRoot, ".codex", "plugins", "legacy-plugin", ".codex-plugin"),
      {
        recursive: true,
      }
    );
    await Bun.write(
      join(
        projectRoot,
        ".codex",
        "plugins",
        "legacy-plugin",
        ".codex-plugin",
        "plugin.json"
      ),
      JSON.stringify({ name: "legacy-plugin", version: "0.1.0" }, null, 2)
    );

    await manageTool("codex", { homeDir: home, rootDir });

    expect(
      await Bun.file(
        join(
          rootDir,
          "tools",
          "codex",
          "plugins",
          "legacy-plugin",
          ".codex-plugin",
          "plugin.json"
        )
      ).exists()
    ).toBe(false);
    expect(await Bun.file(join(projectRoot, "plugins")).exists()).toBe(false);
  });

  it("does not sync global skills into project-managed codex without explicit opt-in", async () => {
    const home = await createTempDir();
    const globalRoot = join(home, ".ai");
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(globalRoot, "skills", "global-alpha"), {
      recursive: true,
    });
    await Bun.write(
      join(globalRoot, "skills", "global-alpha", "SKILL.md"),
      "---\ndescription: Global alpha\n---\n\n# Global alpha\n"
    );

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    expect(
      await Bun.file(
        join(projectRoot, ".agents", "skills", "global-alpha", "SKILL.md")
      ).exists()
    ).toBe(false);
  });

  it("can explicitly sync allowlisted skills into project-managed codex", async () => {
    const home = await createTempDir();
    const globalRoot = join(home, ".ai");
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(globalRoot, "skills", "global-alpha"), {
      recursive: true,
    });
    await Bun.write(
      join(globalRoot, "skills", "global-alpha", "SKILL.md"),
      "---\ndescription: Global alpha\n---\n\n# Global alpha\n"
    );

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[project_sync.codex]\nskills = ["global-alpha"]\n'
    );

    await manageTool("codex", { homeDir: home, rootDir });

    const skillLink = join(projectRoot, ".agents", "skills", "global-alpha");
    const skillStat = await lstat(skillLink);
    expect(skillStat.isSymbolicLink()).toBe(true);
    expect(await readlink(skillLink)).toBe(
      join(globalRoot, "skills", "global-alpha")
    );
  });

  it("reconciles rendered codex agents on sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "agents", "alpha"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "alpha", "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.review_policy}.\n"""\n`
    );
    await mkdir(join(rootDir, "agents", "beta"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "beta", "agent.toml"),
      `name = "beta"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.review_policy}.\n"""\n`
    );
    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "REVIEW.md"), "Review rules.\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/rules/REVIEW.md"\n'
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    await rm(join(rootDir, "agents", "beta"), { recursive: true, force: true });
    await Bun.write(
      join(rootDir, "agents", "alpha", "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.review_policy} and check \${refs.review_policy} again.\n"""\n`
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    const alpha = await readFile(
      join(home, ".codex", "agents", "alpha.toml"),
      "utf8"
    );
    expect(alpha).toContain(join(rootDir, "rules", "REVIEW.md"));
    expect(alpha).toContain("check");

    const betaExists = await Bun.file(
      join(home, ".codex", "agents", "beta.toml")
    ).exists();
    expect(betaExists).toBe(false);

    const ledger = (
      await readFile(
        join(facultMachineStateDir(home, rootDir), "ledger", "sync.jsonl"),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; reason: string });
    expect(
      ledger.some(
        (event) => event.action === "write" && event.reason === "agent_render"
      )
    ).toBe(true);
    expect(
      ledger.some(
        (event) => event.action === "remove" && event.reason === "agent_render"
      )
    ).toBe(true);
  });

  it("reconciles managed codex automations without removing unrelated live automations", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "automations", "alpha"), { recursive: true });
    await Bun.write(
      join(rootDir, "automations", "alpha", "automation.toml"),
      [
        "version = 1",
        'id = "alpha"',
        'name = "Alpha"',
        'prompt = "Run alpha"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "automations", "alpha", "memory.md"),
      "# Alpha memory\n"
    );
    await mkdir(join(rootDir, "automations", "beta"), { recursive: true });
    await Bun.write(
      join(rootDir, "automations", "beta", "automation.toml"),
      [
        "version = 1",
        'id = "beta"',
        'name = "Beta"',
        'prompt = "Run beta"',
        'status = "PAUSED"',
        'rrule = "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    await mkdir(join(home, ".codex", "automations", "local-only"), {
      recursive: true,
    });
    await Bun.write(
      join(home, ".codex", "automations", "local-only", "automation.toml"),
      [
        "version = 1",
        'id = "local-only"',
        'name = "Local only"',
        'prompt = "Stay local"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );

    await rm(join(rootDir, "automations", "beta"), {
      recursive: true,
      force: true,
    });
    await Bun.write(
      join(rootDir, "automations", "alpha", "memory.md"),
      "# Alpha canonical memory updated\n"
    );
    await Bun.write(
      join(rootDir, "automations", "alpha", "automation.toml"),
      [
        "version = 1",
        'id = "alpha"',
        'name = "Alpha"',
        'prompt = "Run alpha with new scope"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await Bun.write(
      join(home, ".codex", "automations", "alpha", "memory.md"),
      "# Alpha live memory\n"
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    expect(
      await readFile(
        join(home, ".codex", "automations", "alpha", "automation.toml"),
        "utf8"
      )
    ).toContain('prompt = "Run alpha with new scope"');
    expect(
      await readFile(
        join(home, ".codex", "automations", "alpha", "memory.md"),
        "utf8"
      )
    ).toBe("# Alpha live memory\n");
    expect(
      await Bun.file(
        join(home, ".codex", "automations", "beta", "automation.toml")
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(home, ".codex", "automations", "local-only", "automation.toml")
      ).exists()
    ).toBe(true);
  });

  it("treats automation memory as seed-only runtime state during sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "automations", "alpha"), { recursive: true });
    await Bun.write(
      join(rootDir, "automations", "alpha", "automation.toml"),
      [
        "version = 1",
        'id = "alpha"',
        'name = "Alpha"',
        'prompt = "Run alpha"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "automations", "alpha", "memory.md"),
      "# Alpha seed memory\n"
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    await Bun.write(
      join(home, ".codex", "automations", "alpha", "memory.md"),
      "# Alpha runtime memory\n"
    );
    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    expect(
      await readFile(
        join(home, ".codex", "automations", "alpha", "memory.md"),
        "utf8"
      )
    ).toBe("# Alpha runtime memory\n");

    const managed = JSON.parse(
      await readFile(managedStatePathForRoot(home, rootDir), "utf8")
    ) as {
      tools: Record<
        string,
        {
          renderedTargets?: Record<string, unknown>;
        }
      >;
    };
    const renderedTargets = Object.keys(
      managed.tools.codex?.renderedTargets ?? {}
    );
    expect(
      renderedTargets.some((target) => target.endsWith("/memory.md"))
    ).toBe(false);
  });

  it("reconciles global codex docs and rules on sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/instructions/REVIEW.md"\n'
    );
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "instructions", "REVIEW.md"),
      "Write directly.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Read ${REFS_WRITING_RULE}.\n`
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      'project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]\n'
    );
    await mkdir(join(rootDir, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await mkdir(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        ".codex-plugin"
      ),
      { recursive: true }
    );
    await Bun.write(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        ".codex-plugin",
        "plugin.json"
      ),
      JSON.stringify(
        {
          name: "autoresearch",
          version: "0.1.0",
          interface: { displayName: "Autoresearch" },
        },
        null,
        2
      )
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "plugins", "marketplace.json"),
      JSON.stringify(
        {
          name: "local",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "autoresearch",
              source: { source: "local", path: "./plugins/autoresearch" },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ],
        },
        null,
        2
      )
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    await rm(join(rootDir, "AGENTS.global.md"), { force: true });
    const liveConfigPath = join(home, ".codex", "config.toml");
    const existingLiveConfig = await readFile(liveConfigPath, "utf8");
    await Bun.write(
      liveConfigPath,
      `${existingLiveConfig}\napproval_policy = "trusted-only"\n`
    );
    await rm(join(rootDir, "tools", "codex", "config.toml"), { force: true });
    await rm(join(rootDir, "tools", "codex", "rules", "default.rules"), {
      force: true,
    });

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(
      join(facultBuiltinPackRoot(), "instructions", "EVOLUTION.md")
    );

    const ruleExists = await Bun.file(
      join(home, ".codex", "rules", "default.rules")
    ).exists();
    expect(ruleExists).toBe(false);

    const toolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "trusted-only"');
  });

  it("merges tool-local codex config overrides during sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "tools", "codex"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      [
        'approval_policy = "on-failure"',
        "",
        "[shell_environment_policy]",
        'inherit = "all"',
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "config.local.toml"),
      [
        "[shell_environment_policy]",
        'inherit = "core"',
        `set = { PATH = "\${HOME}/.local/bin:/usr/bin:/bin" }`,
      ].join("\n")
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    const toolConfig = Bun.TOML.parse(
      await readFile(join(home, ".codex", "config.toml"), "utf8")
    ) as {
      approval_policy: string;
      shell_environment_policy?: {
        inherit?: string;
        set?: {
          PATH?: string;
        };
      };
    };

    expect(toolConfig.approval_policy).toBe("on-failure");
    expect(toolConfig.shell_environment_policy?.inherit).toBe("core");
    expect(toolConfig.shell_environment_policy?.set?.PATH).toBe(
      `${home}/.local/bin:/usr/bin:/bin`
    );
  });

  it("repairs legacy managed codex state and adopts new global surfaces on sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nreview_policy = "@ai/instructions/REVIEW.md"\n'
    );
    await Bun.write(
      join(rootDir, "instructions", "REVIEW.md"),
      "Write directly.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Read ${REFS_WRITING_RULE}.\n`
    );
    await mkdir(join(rootDir, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n'
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await mkdir(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        ".codex-plugin"
      ),
      { recursive: true }
    );
    await Bun.write(
      join(
        rootDir,
        "tools",
        "codex",
        "plugins",
        "autoresearch",
        ".codex-plugin",
        "plugin.json"
      ),
      JSON.stringify(
        {
          name: "autoresearch",
          version: "0.1.0",
          interface: { displayName: "Autoresearch" },
        },
        null,
        2
      )
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "plugins", "marketplace.json"),
      JSON.stringify(
        {
          name: "local",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "autoresearch",
              source: { source: "local", path: "./plugins/autoresearch" },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ],
        },
        null,
        2
      )
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await mkdir(join(home, ".codex", "rules"), { recursive: true });
    await Bun.write(join(home, ".codex", "AGENTS.md"), "legacy global\n");
    await Bun.write(
      join(home, ".codex", "config.toml"),
      'approval_policy = "never"\n'
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-02-21T18:27:27.874Z",
            skillsDir: join(home, ".codex", "skills"),
            mcpConfig: join(home, ".codex", "mcp.json"),
            skillsBackup: join(home, ".codex", "skills.bak"),
            mcpBackup: null,
          },
        },
      },
      home
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });

    const repairedState = await loadManagedState(home);
    expect(repairedState.tools.codex?.globalAgentsPath).toBe(
      join(home, ".codex", "AGENTS.md")
    );
    expect(repairedState.tools.codex?.toolConfig).toBe(
      join(home, ".codex", "config.toml")
    );
    expect(repairedState.tools.codex?.rulesDir).toBe(
      join(home, ".codex", "rules")
    );
    expect(repairedState.tools.codex?.pluginsDir).toBe(join(home, "plugins"));
    expect(repairedState.tools.codex?.pluginMarketplacePath).toBe(
      join(home, ".agents", "plugins", "marketplace.json")
    );
    expect(repairedState.tools.codex?.skillsBackup).toBe(
      join(home, ".codex", "skills.bak")
    );

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(join(rootDir, "instructions", "REVIEW.md"));

    const toolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "never"');
    expect(toolConfig).toContain("TEAM_GUIDE.md");

    const rulesFile = await readFile(
      join(home, ".codex", "rules", "default.rules"),
      "utf8"
    );
    expect(rulesFile).toContain('pattern = ["gh"]');

    const pluginMarketplace = await readFile(
      join(home, ".agents", "plugins", "marketplace.json"),
      "utf8"
    );
    expect(pluginMarketplace).toContain('"path": "./plugins/autoresearch"');

    expect(
      await Bun.file(
        join(home, "plugins", "autoresearch", ".codex-plugin", "plugin.json")
      ).exists()
    ).toBe(true);
  });

  it("does not adopt live codex plugins during repair from builtin defaults alone", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    await mkdir(join(home, "plugins", "custom", ".codex-plugin"), {
      recursive: true,
    });
    await Bun.write(
      join(home, "plugins", "custom", ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "custom", version: "0.1.0" }, null, 2)
    );
    await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
      name: "local",
      interface: { displayName: "Local Plugins" },
      plugins: [
        {
          name: "custom",
          source: { source: "local", path: "./plugins/custom" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    });

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-02-21T18:27:27.874Z",
          },
        },
      },
      home
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });

    const repairedState = await loadManagedState(home);
    expect(repairedState.tools.codex?.pluginsDir).toBeUndefined();
    expect(repairedState.tools.codex?.pluginMarketplacePath).toBeUndefined();
    expect(repairedState.tools.codex?.pluginsBackup).toBeUndefined();
    expect(repairedState.tools.codex?.pluginMarketplaceBackup).toBeUndefined();

    expect(
      await Bun.file(
        join(home, "plugins", "custom", ".codex-plugin", "plugin.json")
      ).exists()
    ).toBe(true);
    const marketplace = await readFile(
      join(home, ".agents", "plugins", "marketplace.json"),
      "utf8"
    );
    expect(marketplace).toContain('"name": "custom"');
    expect(marketplace).not.toContain('"name": "fclt"');
  });

  it("sets up the bundled codex plugin without entering managed mode", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(home, "plugins", "custom", ".codex-plugin"), {
      recursive: true,
    });
    await Bun.write(
      join(home, "plugins", "custom", ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "custom", version: "0.1.0" }, null, 2)
    );
    await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
      name: "hack-local",
      interface: { displayName: "Hack Local Plugins" },
      plugins: [
        {
          name: "custom",
          source: { source: "local", path: "./plugins/custom" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    });

    const result = await setupCodexPlugin({
      homeDir: home,
      installInCodex: false,
    });

    expect(result.codexInstall.status).toBe("skipped");
    expect(result.changedPaths).toContain(join(home, "plugins", "fclt"));
    expect(result.changedPaths).toContain(
      join(home, ".agents", "plugins", "marketplace.json")
    );
    expect(
      await Bun.file(
        join(home, "plugins", "fclt", ".codex-plugin", "plugin.json")
      ).exists()
    ).toBe(true);
    expect(
      await readFile(
        join(home, "plugins", "fclt", "scripts", "fclt-mcp.cjs"),
        "utf8"
      )
    ).toContain('name: "fclt_setup"');
    expect(
      await readFile(
        join(home, "plugins", "fclt", "scripts", "fclt-mcp.cjs"),
        "utf8"
      )
    ).toContain(
      'enum: ["assess", "list", "propose", "draft", "review", "show"]'
    );

    const fcltMcp = JSON.parse(
      await readFile(join(home, "plugins", "fclt", ".mcp.json"), "utf8")
    ) as {
      mcpServers: {
        fclt?: {
          command?: string;
          cwd?: string;
          env?: { FCLT_BIN?: string; PATH?: string };
        };
      };
    };
    expect(fcltMcp.mcpServers.fclt?.cwd).toBe(".");
    expect(isAbsolute(fcltMcp.mcpServers.fclt?.command ?? "")).toBe(true);
    if (fcltMcp.mcpServers.fclt?.env?.FCLT_BIN) {
      expect(isAbsolute(fcltMcp.mcpServers.fclt.env.FCLT_BIN)).toBe(true);
    }
    expect(fcltMcp.mcpServers.fclt?.env?.PATH).toContain(
      dirname(fcltMcp.mcpServers.fclt?.command ?? "")
    );
    expect(
      await Bun.file(
        join(home, "plugins", "custom", ".codex-plugin", "plugin.json")
      ).exists()
    ).toBe(true);

    const marketplace = JSON.parse(
      await readFile(
        join(home, ".agents", "plugins", "marketplace.json"),
        "utf8"
      )
    ) as {
      plugins: {
        name: string;
        source: { path: string };
        policy?: { authentication?: string };
      }[];
    };
    expect(marketplace.plugins.map((plugin) => plugin.name).sort()).toEqual([
      "custom",
      "fclt",
    ]);
    expect(
      marketplace.plugins.find((plugin) => plugin.name === "fclt")?.source.path
    ).toBe("./plugins/fclt");
    expect(
      marketplace.plugins.find((plugin) => plugin.name === "fclt")?.policy
        ?.authentication
    ).toBe("ON_INSTALL");
    expect((await loadManagedState(home)).tools.codex).toBeUndefined();

    const repeated = await setupCodexPlugin({
      homeDir: home,
      installInCodex: false,
    });
    expect(repeated.changedPaths).toEqual([]);
  });

  it("installs from the preserved Codex marketplace name", async () => {
    const home = await createTempDir();
    const codexBin = join(home, "bin", "codex");
    await writeCodexPluginStub({
      codexBin,
      home,
      selectedVersion: "0.1.3",
    });
    await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
      name: "local",
      interface: { displayName: "Local Plugins" },
      plugins: [],
    });

    const result = await setupCodexPlugin({
      homeDir: home,
      codexBin,
    });

    expect(result.marketplaceName).toBe("local");
    expect(result.codexInstall.status).toBe("succeeded");
    expect(result.codexInstall.command).toEqual([
      codexBin,
      "plugin",
      "add",
      "fclt@local",
      "--json",
    ]);
    expect(result.codexInstall.verificationCommand).toEqual([
      codexBin,
      "plugin",
      "list",
      "--marketplace",
      "local",
      "--json",
    ]);
    expect(await readFile(join(home, "codex-args.txt"), "utf8")).toBe(
      "plugin\nadd\nfclt@local\n--json\n--\nplugin\nlist\n--marketplace\nlocal\n--json\n--\n"
    );
  });

  it("fails closed when Codex retains the pre-fix cached wrapper", async () => {
    const home = await createTempDir();
    const oldCache = join(
      home,
      ".codex",
      "plugins",
      "cache",
      "local",
      "fclt",
      "0.1.2"
    );
    await mkdir(oldCache, { recursive: true });
    await Bun.write(join(oldCache, "selected.txt"), "legacy-wrapper\n");
    await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
      name: "local",
      interface: { displayName: "Local Plugins" },
      plugins: [],
    });
    const codexBin = join(home, "bin", "codex");
    await writeCodexPluginStub({
      codexBin,
      home,
      listedVersion: "0.1.2",
      selectedVersion: "0.1.3",
    });

    const result = await setupCodexPlugin({ homeDir: home, codexBin });

    expect(result.codexInstall.status).toBe("failed");
    expect(result.codexInstall.stderr).toContain(
      "expected fclt@local version 0.1.3 to be installed and enabled"
    );
    expect(result.codexInstall.verificationCommand).toEqual([
      codexBin,
      "plugin",
      "list",
      "--marketplace",
      "local",
      "--json",
    ]);
    expect(await Bun.file(join(oldCache, "selected.txt")).text()).toBe(
      "legacy-wrapper\n"
    );
    expect(
      await Bun.file(
        join(
          home,
          ".codex",
          "plugins",
          "cache",
          "local",
          "fclt",
          "0.1.3",
          "selected.txt"
        )
      ).exists()
    ).toBe(false);
  });

  it("upgrades to plugin 0.1.3 while preserving a cached 0.1.2 payload", async () => {
    const home = await createTempDir();
    const oldCache = join(
      home,
      ".codex",
      "plugins",
      "cache",
      "local",
      "fclt",
      "0.1.2"
    );
    await mkdir(oldCache, { recursive: true });
    await Bun.write(join(oldCache, "selected.txt"), "legacy-wrapper\n");
    await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
      name: "local",
      interface: { displayName: "Local Plugins" },
      plugins: [],
    });
    const codexBin = join(home, "bin", "codex");
    await writeCodexPluginStub({
      codexBin,
      home,
      selectedVersion: "0.1.3",
    });

    const result = await setupCodexPlugin({ homeDir: home, codexBin });
    const installedPath = join(
      home,
      ".codex",
      "plugins",
      "cache",
      "local",
      "fclt",
      "0.1.3"
    );

    expect(result.codexInstall.status).toBe("succeeded");
    expect(
      (await Bun.file(
        join(installedPath, ".codex-plugin", "plugin.json")
      ).json()) as { version: string }
    ).toMatchObject({ version: "0.1.3" });
    expect(
      await Bun.file(join(installedPath, "scripts", "fclt-mcp.cjs")).text()
    ).toContain("audit-read-only-v1");
    expect(await Bun.file(join(oldCache, "selected.txt")).text()).toBe(
      "legacy-wrapper\n"
    );
  });

  it("rejects an installed plugin tree containing an extra symlink", async () => {
    const home = await createTempDir();
    await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
      name: "local",
      interface: { displayName: "Local Plugins" },
      plugins: [],
    });
    const codexBin = join(home, "bin", "codex");
    await writeCodexPluginStub({
      codexBin,
      home,
      installedMutation: "symlink",
      selectedVersion: "0.1.3",
    });

    const result = await setupCodexPlugin({ homeDir: home, codexBin });

    expect(result.codexInstall.status).toBe("failed");
    expect(result.codexInstall.stderr).toContain(
      "plugin payload contains a symbolic link at unexpected-link"
    );
    expect(await readFile(join(home, "codex-args.txt"), "utf8")).toContain(
      "plugin\nlist\n--marketplace\nlocal\n--json"
    );
  });

  it("rejects an installed plugin tree containing a hard-linked file", async () => {
    const { home, result } = await setupMutatedCodexPlugin("hardlink");

    expect(result.codexInstall.status).toBe("failed");
    expect(result.codexInstall.stderr).toContain(
      "plugin payload contains a hard-linked file at unexpected-hardlink"
    );
    expect(await readFile(join(home, "codex-args.txt"), "utf8")).toContain(
      "plugin\nlist\n--marketplace\nlocal\n--json"
    );
  });

  it("rejects an installed plugin tree containing an unreadable subtree", async () => {
    const home = await createTempDir();
    await writeJson(join(home, ".agents", "plugins", "marketplace.json"), {
      name: "local",
      interface: { displayName: "Local Plugins" },
      plugins: [],
    });
    const codexBin = join(home, "bin", "codex");
    await writeCodexPluginStub({
      codexBin,
      home,
      installedMutation: "unreadable-subtree",
      selectedVersion: "0.1.3",
    });

    const result = await setupCodexPlugin({ homeDir: home, codexBin });

    expect(result.codexInstall.status).toBe("failed");
    expect(result.codexInstall.stderr).toContain(
      "Codex installed payload for fclt@local does not match"
    );
    expect(result.codexInstall.stderr).toContain("EACCES");
    expect(await readFile(join(home, "codex-args.txt"), "utf8")).toContain(
      "plugin\nlist\n--marketplace\nlocal\n--json"
    );
    await chmod(
      join(
        home,
        ".codex",
        "plugins",
        "cache",
        "local",
        "fclt",
        "0.1.3",
        "unexpected-private"
      ),
      0o700
    );
  });

  it("enforces every installed plugin tree resource limit", async () => {
    const cases: [InstalledPluginMutation, string][] = [
      ["too-many-entries", "exceeds 256 entries"],
      ["oversize-file", "file exceeds 1048576 bytes"],
      ["aggregate-oversize", "exceeds 4194304 aggregate bytes"],
      ["too-deep", "exceeds depth 12"],
      ["path-too-long", "relative path exceeds 512 bytes"],
    ];

    for (const [mutation, expectedError] of cases) {
      const { result } = await setupMutatedCodexPlugin(mutation);
      expect(result.codexInstall.status).toBe("failed");
      expect(result.codexInstall.stderr).toContain(expectedError);
    }
  });

  it("rejects a sparse installed plugin file before allocating its logical size", async () => {
    const { result } = await setupMutatedCodexPlugin("sparse-file");

    expect(result.codexInstall.status).toBe("failed");
    expect(result.codexInstall.stderr).toContain(
      "plugin payload contains a sparse file at unexpected-sparse"
    );
  });

  it("rejects an installed plugin file that grows around bounded reads", async () => {
    const { home, result } = await setupMutatedCodexPlugin("growing-file");
    await Bun.write(join(home, "growth-stop"), "stop\n");

    expect(result.codexInstall.status).toBe("failed");
    expect(result.codexInstall.stderr).toContain("unexpected-growing");
    expect(result.codexInstall.stderr).toContain("file changed");
  });

  it("dry-runs bundled codex plugin setup without writing files", async () => {
    const home = await createTempDir();
    const result = await setupCodexPlugin({
      homeDir: home,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.changedPaths).toEqual([
      join(home, ".agents", "plugins", "marketplace.json"),
      join(home, "plugins", "fclt"),
    ]);
    expect(
      await Bun.file(
        join(home, "plugins", "fclt", ".codex-plugin", "plugin.json")
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(home, ".agents", "plugins", "marketplace.json")
      ).exists()
    ).toBe(false);
    expect(result.codexInstall.status).toBe("skipped");
  });

  it("returns a failing exit code for JSON codex plugin install failures", async () => {
    const home = await createTempDir();
    const binDir = join(home, "bin");
    const codexBin = join(binDir, "codex");
    await mkdir(binDir, { recursive: true });
    await Bun.write(
      codexBin,
      `#!/bin/sh
echo "install failed" >&2
exit 7
`
    );
    await chmod(codexBin, 0o755);

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/index.ts"),
        "setup",
        "codex-plugin",
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(1);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as SetupCodexPluginResult;
    expect(result.codexInstall.status).toBe("failed");
    expect(result.codexInstall.code).toBe(7);
    expect(result.codexInstall.stderr).toContain("install failed");
  });

  it("adopts backed-up managed skills back into the canonical store during sync repair", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const backupSkillsDir = join(home, ".codex", "skills.bak");
    await mkdir(join(backupSkillsDir, "legacy-skill"), { recursive: true });
    await Bun.write(
      join(backupSkillsDir, "legacy-skill", "SKILL.md"),
      [
        "---",
        "description: Skill rescued from managed backup.",
        "tags: [legacy]",
        "---",
        "",
        "# Legacy Skill",
      ].join("\n")
    );

    await mkdir(join(home, ".codex", "skills"), { recursive: true });

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-02-21T18:27:27.874Z",
            skillsDir: join(home, ".codex", "skills"),
            skillsBackup: backupSkillsDir,
          },
        },
      },
      home
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    const adoptedSkill = await readFile(
      join(rootDir, "skills", "legacy-skill", "SKILL.md"),
      "utf8"
    );
    expect(adoptedSkill).toContain("managed backup");

    const liveLinkPath = join(home, ".codex", "skills", "legacy-skill");
    const liveLinkStat = await lstat(liveLinkPath);
    expect(liveLinkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(liveLinkPath)).toBe(
      join(rootDir, "skills", "legacy-skill")
    );
  });

  it("adopts backed-up managed agents, docs, rules, config, and mcp during sync repair", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    const backupAgentsDir = join(home, ".codex", "agents.bak");
    await mkdir(backupAgentsDir, { recursive: true });
    await Bun.write(
      join(backupAgentsDir, "legacy-agent.toml"),
      'name = "legacy-agent"\n'
    );

    const backupGlobalAgents = join(home, ".codex", "AGENTS.md.bak");
    await mkdir(join(home, ".codex"), { recursive: true });
    await Bun.write(backupGlobalAgents, "# Legacy Global\n");

    const backupRulesDir = join(home, ".codex", "rules.bak");
    await mkdir(backupRulesDir, { recursive: true });
    await Bun.write(
      join(backupRulesDir, "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );

    const backupToolConfig = join(home, ".codex", "config.toml.bak");
    await Bun.write(backupToolConfig, 'approval_policy = "never"\n');

    const backupMcp = join(home, ".codex", "mcp.json.bak");
    await writeJson(backupMcp, {
      mcpServers: {
        github: { command: "node", args: ["server.js"] },
      },
    });

    await mkdir(join(home, ".codex", "agents"), { recursive: true });
    await mkdir(join(home, ".codex", "rules"), { recursive: true });

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-02-21T18:27:27.874Z",
            agentsDir: join(home, ".codex", "agents"),
            agentsBackup: backupAgentsDir,
            toolHome: join(home, ".codex"),
            globalAgentsPath: join(home, ".codex", "AGENTS.md"),
            globalAgentsBackup: backupGlobalAgents,
            rulesDir: join(home, ".codex", "rules"),
            rulesBackup: backupRulesDir,
            toolConfig: join(home, ".codex", "config.toml"),
            toolConfigBackup: backupToolConfig,
            mcpConfig: join(home, ".codex", "mcp.json"),
            mcpBackup: backupMcp,
          },
        },
      },
      home
    );

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      adoptLive: true,
    });

    expect(
      await readFile(
        join(rootDir, "agents", "legacy-agent", "agent.toml"),
        "utf8"
      )
    ).toContain('name = "legacy-agent"');
    expect(await readFile(join(rootDir, "AGENTS.global.md"), "utf8")).toBe(
      "# Legacy Global\n"
    );
    expect(
      await readFile(
        join(rootDir, "tools", "codex", "rules", "default.rules"),
        "utf8"
      )
    ).toContain('pattern = ["gh"]');
    expect(
      await readFile(join(rootDir, "tools", "codex", "config.toml"), "utf8")
    ).toContain('approval_policy = "never"');

    const canonicalMcp = JSON.parse(
      await readFile(join(rootDir, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { command: string }>;
    };
    expect(canonicalMcp.servers.github?.command).toBe("node");

    expect(
      await readFile(
        join(home, ".codex", "agents", "legacy-agent.toml"),
        "utf8"
      )
    ).toContain('name = "legacy-agent"');
    expect(await readFile(join(home, ".codex", "AGENTS.md"), "utf8")).toBe(
      "# Legacy Global\n"
    );
  });
});
