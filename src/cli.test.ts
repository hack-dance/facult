import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFindArgs, parseGraphArgs, parseListArgs } from "./index";

const SEMVER_RE = /^\d+\.\d+\.\d+/;

describe("parseListArgs", () => {
  it("parses list options and filters", () => {
    const opts = parseListArgs([
      "mcp",
      "--enabled-for",
      "cursor",
      "--untrusted",
      "--flagged",
      "--json",
    ]);

    expect(opts).toEqual({
      kind: "mcp",
      filters: {
        enabledFor: "cursor",
        untrusted: true,
        flagged: true,
      },
      json: true,
    });
  });

  it("defaults to skills when no type provided", () => {
    const opts = parseListArgs([]);
    expect(opts.kind).toBe("skills");
  });

  it("accepts instructions as a list type", () => {
    const opts = parseListArgs(["instructions", "--json"]);
    expect(opts.kind).toBe("instructions");
    expect(opts.json).toBe(true);
  });

  it("accepts automations as a list type", () => {
    const opts = parseListArgs(["automations", "--json"]);
    expect(opts.kind).toBe("automations");
    expect(opts.json).toBe(true);
  });
});

describe("parseFindArgs", () => {
  it("parses text query and json flag", () => {
    const opts = parseFindArgs(["feedback", "loops", "--json"]);
    expect(opts).toEqual({
      text: "feedback loops",
      json: true,
    });
  });
});

describe("parseGraphArgs", () => {
  it("defaults to show when only an asset is provided", () => {
    const opts = parseGraphArgs(["skills:alpha"]);

    expect(opts).toEqual({
      kind: "show",
      target: "skills:alpha",
      json: false,
    });
  });

  it("parses explicit graph modes", () => {
    const opts = parseGraphArgs(["deps", "skills:alpha", "--json"]);

    expect(opts).toEqual({
      kind: "deps",
      target: "skills:alpha",
      json: true,
    });
  });
});

describe("CLI output contracts", () => {
  it("--version prints the package version", async () => {
    const proc = Bun.spawn(["bun", "run", "./src/index.ts", "--version"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out.trim()).toMatch(SEMVER_RE);
  });

  it("uses the baked version even under a parent package's npm environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-version-"));

    try {
      const compiledVersion = "7.8.9";
      const binaryBasePath = join(dir, "fclt-version-test");
      const build = Bun.spawn(
        [
          "bun",
          "build",
          "./src/index.ts",
          "--compile",
          "--define",
          `FCLT_COMPILED_VERSION=${JSON.stringify(compiledVersion)}`,
          "--outfile",
          binaryBasePath,
        ],
        {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [buildCode, buildError] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      expect(buildCode, buildError).toBe(0);

      const binaryPath =
        process.platform === "win32" ? `${binaryBasePath}.exe` : binaryBasePath;
      const proc = Bun.spawn([binaryPath, "--version"], {
        env: {
          ...process.env,
          FACULT_NPM_PACKAGE_VERSION: "6.7.8",
          npm_package_version: "0.1.83",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out.trim()).toBe(compiledVersion);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses only the explicitly namespaced package version in source fallback", async () => {
    const proc = Bun.spawn(
      ["bun", join(process.cwd(), "src/index.ts"), "--version"],
      {
        env: {
          ...process.env,
          FACULT_NPM_PACKAGE_VERSION: "6.7.8",
          npm_package_version: "0.1.83",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out.trim()).toBe("6.7.8");
  });

  it("status --json emits valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-status-"));

    try {
      const proc = Bun.spawn(
        ["bun", "run", join(process.cwd(), "src/index.ts"), "status", "--json"],
        {
          cwd: dir,
          env: { ...process.env, HOME: dir },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(code).toBe(0);
      expect(err).toBe("");
      const parsed = JSON.parse(out) as {
        version: number;
        packageVersion: string;
        contextRoot: string;
      };
      expect(parsed.version).toBe(1);
      expect(parsed.packageVersion).toMatch(SEMVER_RE);
      expect(parsed.contextRoot).toBe(join(dir, ".ai"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("paths --json emits canonical and review paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-paths-"));

    try {
      const proc = Bun.spawn(
        ["bun", "run", join(process.cwd(), "src/index.ts"), "paths", "--json"],
        {
          cwd: dir,
          env: { ...process.env, HOME: dir },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(code).toBe(0);
      expect(err).toBe("");
      const parsed = JSON.parse(out) as {
        version: number;
        contextRoot: string;
        canonical: { globalRoot: string };
        runtime: { evolutionLoopDecisionJournalPath: string };
        review: { writebackDir: string; evolutionDir: string };
      };
      expect(parsed.version).toBe(1);
      expect(parsed.contextRoot).toBe(join(dir, ".ai"));
      expect(parsed.canonical.globalRoot).toBe(join(dir, ".ai"));
      expect(parsed.runtime.evolutionLoopDecisionJournalPath).toContain(
        join("evolution", "loop", "decisions.jsonl")
      );
      expect(parsed.review.writebackDir).toBe(
        join(dir, ".ai", "writebacks", "global")
      );
      expect(parsed.review.evolutionDir).toBe(
        join(dir, ".ai", "evolution", "global")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("status and paths preserve an explicit custom global scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-cli-custom-global-"));
    const rootDir = join(home, "shared", ".ai");
    const stateRoot = join(home, "state");
    await mkdir(join(rootDir, "skills", "custom-global"), { recursive: true });
    await Bun.write(
      join(rootDir, "skills", "custom-global", "SKILL.md"),
      "# Custom Global\n"
    );
    await mkdir(join(home, ".ai", "skills", "default-global"), {
      recursive: true,
    });
    await Bun.write(
      join(home, ".ai", "skills", "default-global", "SKILL.md"),
      "# Default Global\n"
    );
    const env = {
      ...process.env,
      HOME: home,
      FACULT_LOCAL_STATE_DIR: stateRoot,
    };

    try {
      for (const command of ["status", "paths"]) {
        const proc = Bun.spawn(
          [
            "bun",
            "run",
            join(process.cwd(), "src/index.ts"),
            command,
            "--json",
            "--global",
            "--root",
            rootDir,
          ],
          { cwd: home, env, stdout: "pipe", stderr: "pipe" }
        );
        const [code, out, err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(err).toBe("");
        const parsed = JSON.parse(out) as {
          contextRoot: string;
          machineStateDir?: string;
          projectRoot: string | null;
          generated?: { stateDir: string };
          runtime?: { machineStateDir: string };
        };
        expect(parsed.contextRoot).toBe(rootDir);
        expect(parsed.projectRoot).toBeNull();
        expect(parsed.machineStateDir ?? parsed.runtime?.machineStateDir).toBe(
          join(stateRoot, "global")
        );
        if (parsed.generated) {
          expect(parsed.generated.stateDir).toBe(join(rootDir, ".facult"));
        }
      }
      const indexProc = Bun.spawn(
        [
          "bun",
          "run",
          join(process.cwd(), "src/index.ts"),
          "index",
          "--global",
          "--root",
          rootDir,
        ],
        { cwd: home, env, stdout: "pipe", stderr: "pipe" }
      );
      const [indexCode, indexError] = await Promise.all([
        indexProc.exited,
        new Response(indexProc.stderr).text(),
      ]);
      expect(indexCode).toBe(0);
      expect(indexError).toBe("");
      const index = JSON.parse(
        await Bun.file(join(rootDir, ".facult", "ai", "index.json")).text()
      ) as {
        skills: Record<string, { sourceKind?: string }>;
      };
      expect(index.skills["custom-global"]?.sourceKind).toBe("global");
      expect(index.skills["default-global"]).toBeUndefined();
      expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);

      for (const argv of [
        ["list", "skills", "--json"],
        ["show", "skills:custom-global"],
        ["find", "custom-global", "--json"],
        ["graph", "show", "skills:custom-global", "--json"],
      ]) {
        const proc = Bun.spawn(
          [
            "bun",
            "run",
            join(process.cwd(), "src/index.ts"),
            ...argv,
            "--global",
            "--root",
            rootDir,
          ],
          { cwd: home, env, stdout: "pipe", stderr: "pipe" }
        );
        const [code, out, err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(err).toBe("");
        expect(out).toContain("custom-global");
      }
      expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps custom-global operating-model generated state out of project scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-cli-template-global-"));
    const rootDir = join(home, "shared", ".ai");
    const stateRoot = join(home, "state");
    const env = {
      ...process.env,
      HOME: home,
      FACULT_LOCAL_STATE_DIR: stateRoot,
    };
    try {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          join(process.cwd(), "src/index.ts"),
          "templates",
          "init",
          "operating-model",
          "--global",
          "--root",
          rootDir,
          "--json",
        ],
        { cwd: home, env, stdout: "pipe", stderr: "pipe" }
      );
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain(rootDir);
      const indexPath = join(rootDir, ".facult", "ai", "index.json");
      const graphPath = join(rootDir, ".facult", "ai", "graph.json");
      expect(await Bun.file(indexPath).exists()).toBe(true);
      expect(await Bun.file(graphPath).exists()).toBe(true);
      const index = JSON.parse(await Bun.file(indexPath).text()) as {
        skills: Record<string, { sourceKind?: string }>;
      };
      expect(index.skills["fclt-writeback"]?.sourceKind).toBe("global");
      expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("global scope does not reclassify an env-selected project root", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-cli-env-project-"));
    const projectRoot = join(home, "work", "repo");
    const projectAiRoot = join(projectRoot, ".ai");
    const globalRoot = join(home, ".ai");
    await mkdir(join(projectAiRoot, "skills", "project-only"), {
      recursive: true,
    });
    await Bun.write(
      join(projectAiRoot, "skills", "project-only", "SKILL.md"),
      "# Project Only\n"
    );
    for (const skill of [
      "global-only",
      "fclt-writeback",
      "capability-evolution",
    ]) {
      await mkdir(join(globalRoot, "skills", skill), { recursive: true });
      await Bun.write(
        join(globalRoot, "skills", skill, "SKILL.md"),
        `# ${skill}\n`
      );
    }
    const env = {
      ...process.env,
      HOME: home,
      FACULT_ROOT_DIR: projectAiRoot,
      FACULT_ROOT_SCOPE: "project",
      FACULT_LOCAL_STATE_DIR: join(home, "state"),
    };
    const runContextCommand = async (args: string[]) => {
      const proc = Bun.spawn(
        ["bun", "run", join(process.cwd(), "src/index.ts"), ...args],
        { cwd: projectRoot, env, stdout: "pipe", stderr: "pipe" }
      );
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, out, err };
    };

    try {
      for (const command of ["status", "paths"]) {
        const { code, out, err } = await runContextCommand([
          command,
          "--json",
          "--global",
        ]);
        expect(code).toBe(0);
        expect(err).toBe("");
        const parsed = JSON.parse(out) as {
          globalRoot: string;
          contextRoot: string;
          projectRoot: string | null;
        };
        expect(parsed.globalRoot).toBe(globalRoot);
        expect(parsed.contextRoot).toBe(globalRoot);
        expect(parsed.projectRoot).toBeNull();
      }

      const globalDoctor = await runContextCommand([
        "doctor",
        "--global",
        "--json",
      ]);
      expect(globalDoctor.code).toBe(0);
      expect(globalDoctor.err).toBe("");
      expect(
        JSON.parse(globalDoctor.out) as {
          rootDir: string;
          projectRoot: string | null;
        }
      ).toMatchObject({ rootDir: globalRoot, projectRoot: null });

      const projectIndex = await runContextCommand(["index", "--project"]);
      expect(projectIndex.code).toBe(0);
      expect(projectIndex.err).toBe("");
      const projectPaths = await runContextCommand([
        "paths",
        "--project",
        "--json",
      ]);
      const indexPath = (
        JSON.parse(projectPaths.out) as { generated: { indexPath: string } }
      ).generated.indexPath;
      const index = JSON.parse(await Bun.file(indexPath).text()) as {
        skills: Record<string, { sourceKind?: string }>;
      };
      expect(index.skills["global-only"]?.sourceKind).toBe("global");
      expect(index.skills["project-only"]?.sourceKind).toBe("project");

      const projectDoctor = await runContextCommand([
        "doctor",
        "--project",
        "--json",
      ]);
      expect(projectDoctor.code).toBe(0);
      expect(projectDoctor.err).toBe("");
      const projectReport = JSON.parse(projectDoctor.out) as {
        loop: {
          capabilities: {
            writebackSkill: boolean;
            evolutionSkill: boolean;
          };
        };
      };
      expect(projectReport.loop.capabilities.writebackSkill).toBe(true);
      expect(projectReport.loop.capabilities.evolutionSkill).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ai writeback subcommand help exits cleanly", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "ai", "writeback", "add", "--help"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("fclt ai writeback");
  });

  it("unmanage accepts flags before the tool positional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-unmanage-"));

    try {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          join(process.cwd(), "src/index.ts"),
          "unmanage",
          "--dry-run",
          "codex",
        ],
        {
          cwd: dir,
          env: { ...process.env, HOME: dir },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, err] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);

      expect(code).toBe(1);
      expect(err).toContain("codex is not managed");
      expect(err).not.toContain("--dry-run is not managed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adapters --json emits valid JSON", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "adapters", "--json"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    const parsed = JSON.parse(out) as { id: string }[];
    expect(parsed.some((entry) => entry.id === "codex")).toBe(true);
  });

  it("inventory --json emits valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-inventory-"));
    const rootDir = join(dir, ".ai");
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      join(rootDir, "mcp", "servers.json"),
      JSON.stringify({ servers: { github: { command: "gh" } } }, null, 2)
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "inventory",
        "--json",
        "--no-config-from",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: dir },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    const parsed = JSON.parse(out) as {
      version: number;
      mcpServers: { name: string }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.mcpServers.some((entry) => entry.name === "github")).toBe(
      true
    );
  });

  it("show accepts explicit skill selectors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-show-"));
    const rootDir = join(dir, ".ai");

    try {
      await mkdir(join(rootDir, "skills", "alpha"), { recursive: true });
      await Bun.write(
        join(rootDir, "skills", "alpha", "SKILL.md"),
        "---\ndescription: Alpha skill\n---\n\n# Alpha\n"
      );

      const env = { ...process.env, HOME: dir };
      const indexProc = Bun.spawn(
        ["bun", "run", "./src/index.ts", "index", "--root", rootDir],
        {
          cwd: process.cwd(),
          env,
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(await indexProc.exited).toBe(0);

      const showProc = Bun.spawn(
        [
          "bun",
          "run",
          "./src/index.ts",
          "show",
          "skill:alpha",
          "--root",
          rootDir,
        ],
        {
          cwd: process.cwd(),
          env,
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, out, err] = await Promise.all([
        showProc.exited,
        new Response(showProc.stdout).text(),
        new Response(showProc.stderr).text(),
      ]);

      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain("fclt show skills:alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
