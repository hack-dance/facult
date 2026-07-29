import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import {
  buildLaunchAgentPlist,
  buildLaunchAgentSpec,
  setLaunchctlRunnerForTests,
  setLaunchctlSupportedForTests,
} from "./autosync";
import { facultMachineStateDir } from "./paths";
import { bootstrapFclt } from "./setup";

const cleanupPaths: string[] = [];
const cliEntry = join(import.meta.dir, "index.ts");

afterEach(async () => {
  setLaunchctlRunnerForTests(null);
  setLaunchctlSupportedForTests(null);
  for (const pathValue of cleanupPaths.splice(0)) {
    await rm(pathValue, { recursive: true, force: true });
  }
});

it("setup surfaces active legacy recovery without touching owned runtime or live tools", async () => {
  const home = await tempHome("facult-setup-recovery-");
  const rootDir = join(home, ".ai");
  const stateDir = facultMachineStateDir(home, rootDir);
  const configPath = join(stateDir, "autosync", "services", "all.json");
  const managedPath = join(stateDir, "managed.json");
  const plistPath = join(
    home,
    "Library",
    "LaunchAgents",
    "com.fclt.autosync.plist"
  );
  const livePath = join(home, ".codex", "AGENTS.md");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        name: "all",
        rootDir,
        debounceMs: 100,
        git: {
          enabled: false,
          remote: "origin",
          branch: "main",
          intervalMinutes: 60,
          autoCommit: false,
          commitPrefix: "test",
          source: "fixture",
        },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    managedPath,
    `${JSON.stringify({ version: 1, tools: { codex: {} } }, null, 2)}\n`
  );
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(
    plistPath,
    buildLaunchAgentPlist(
      buildLaunchAgentSpec({
        homeDir: home,
        rootDir,
        serviceName: "all",
        invocation: [join(home, "bin", "fclt")],
      })
    )
  );
  await mkdir(dirname(livePath), { recursive: true });
  await writeFile(livePath, "live user content\n");
  const before = await Promise.all(
    [configPath, managedPath, plistPath, livePath].map((pathValue) =>
      readFile(pathValue, "utf8")
    )
  );
  setLaunchctlSupportedForTests(true);
  setLaunchctlRunnerForTests((args) => {
    if (args[0] === "list") {
      return Promise.resolve({
        exitCode: 0,
        stdout: "-\t0\tcom.fclt.autosync\n",
        stderr: "",
      });
    }
    if (args[0] === "print") {
      return Promise.resolve({
        exitCode: 0,
        stdout: `working directory = ${rootDir}\n`,
        stderr: "",
      });
    }
    return Promise.resolve({ exitCode: 64, stdout: "", stderr: "unexpected" });
  });

  const first = await bootstrapFclt({
    homeDir: home,
    cwd: home,
    includeProject: false,
    installCodexPlugin: false,
  });
  const second = await bootstrapFclt({
    homeDir: home,
    cwd: home,
    includeProject: false,
    installCodexPlugin: false,
  });
  expect(first.health).toBe("degraded");
  expect(first.readiness.global.legacyRecovery.state).toBe("cleanup_required");
  expect(first.repairActions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        scope: "global",
        command: expect.stringContaining("'autosync' 'cleanup'"),
      }),
    ])
  );
  expect(second.readiness.global.legacyRecovery).toEqual(
    first.readiness.global.legacyRecovery
  );
  expect(
    await Promise.all(
      [configPath, managedPath, plistPath, livePath].map((pathValue) =>
        readFile(pathValue, "utf8")
      )
    )
  ).toEqual(before);
});

async function tempHome(prefix: string): Promise<string> {
  const pathValue = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(pathValue);
  return await realpath(pathValue);
}

async function initRepo(home: string): Promise<string> {
  const repo = join(home, "repo");
  await mkdir(repo, { recursive: true });
  await runFixtureGit({
    argv: ["init", "--quiet", repo],
    repoDir: repo,
    homeDir: join(home, ".git-home"),
  });
  return repo;
}

async function runCli(args: {
  home: string;
  cwd: string;
  argv: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliEntry, ...args.argv], {
    cwd: args.cwd,
    env: {
      ...process.env,
      ...args.env,
      HOME: args.home,
      FACULT_LOCAL_STATE_DIR: join(args.home, ".local-state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function snapshotFiles(root: string): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for await (const pathValue of new Bun.Glob("**/*").scan({
    cwd: root,
    dot: true,
    onlyFiles: true,
  })) {
    entries.push([
      pathValue,
      Buffer.from(await Bun.file(join(root, pathValue)).arrayBuffer()).toString(
        "base64"
      ),
    ]);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

describe("zero-config setup", () => {
  it("dry-runs a fresh isolated home without writing or failing", async () => {
    const home = await tempHome("fclt-setup-dry-");
    const repo = await initRepo(home);
    const result = await runCli({
      home,
      cwd: repo,
      argv: ["setup", "--dry-run", "--json", "--no-codex-plugin"],
    });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { dryRun: boolean }).dryRun).toBe(
      true
    );
    expect(await Bun.file(join(home, ".ai")).exists()).toBe(false);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });

  it("keeps global-only setup out of an env-selected project root", async () => {
    const home = await tempHome("fclt-setup-project-env-");
    const repo = await initRepo(home);
    const projectAiRoot = join(repo, ".ai");
    await mkdir(projectAiRoot, { recursive: true });

    const result = await runCli({
      home,
      cwd: repo,
      argv: [
        "setup",
        "--dry-run",
        "--global-only",
        "--no-codex-plugin",
        "--json",
      ],
      env: {
        FACULT_ROOT_DIR: projectAiRoot,
        FACULT_ROOT_SCOPE: "project",
      },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      globalRoot: string;
      projectRoot: string | null;
      changedPaths: string[];
    };
    expect(parsed.globalRoot).toBe(join(home, ".ai"));
    expect(parsed.projectRoot).toBeNull();
    expect(
      parsed.changedPaths.every(
        (pathValue) => !pathValue.startsWith(`${projectAiRoot}/`)
      )
    ).toBe(true);
    expect(await readdir(projectAiRoot)).toEqual([]);
    expect(await Bun.file(join(home, ".ai")).exists()).toBe(false);
  });

  it("keeps every project mutation path zero-write under common --dry-run", async () => {
    const home = await tempHome("fclt-project-dry-run-");
    const repo = await initRepo(home);
    const preview = await runCli({
      home,
      cwd: repo,
      argv: ["project", "init", "--project-root", repo, "--json"],
    });
    expect(preview.code).toBe(0);
    const plan = JSON.parse(preview.stdout) as { planSha256: string };

    const initDryRun = await runCli({
      home,
      cwd: repo,
      argv: [
        "project",
        "init",
        "--project-root",
        repo,
        "--apply",
        "--plan-sha",
        plan.planSha256,
        "--dry-run",
        "--json",
      ],
    });
    expect(initDryRun.code).toBe(0);
    expect(
      (JSON.parse(initDryRun.stdout) as { planSha256: string }).planSha256
    ).toBe(plan.planSha256);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
    expect(await Bun.file(join(home, ".local-state")).exists()).toBe(false);

    const applied = await runCli({
      home,
      cwd: repo,
      argv: [
        "project",
        "init",
        "--project-root",
        repo,
        "--apply",
        "--plan-sha",
        plan.planSha256,
        "--json",
      ],
    });
    expect(applied.code).toBe(0);
    const receiptId = (JSON.parse(applied.stdout) as { receiptId: string })
      .receiptId;
    const before = await snapshotFiles(home);

    const rollback = await runCli({
      home,
      cwd: repo,
      argv: [
        "project",
        "rollback",
        "--receipt",
        receiptId,
        "--apply",
        "--dry-run",
        "--json",
      ],
    });
    expect(rollback.code).toBe(0);
    expect((JSON.parse(rollback.stdout) as { applied: boolean }).applied).toBe(
      false
    );
    const decisions = {
      disable: "disabled",
      ignore: "ignored",
      inactive: "inactive",
      remove: "removed",
    } as const;
    for (const [command, decision] of Object.entries(decisions)) {
      const result = await runCli({
        home,
        cwd: repo,
        argv: [
          "project",
          command,
          "--project-root",
          repo,
          "--dry-run",
          "--json",
        ],
      });
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as { decision: string }).decision).toBe(
        decision
      );
    }
    expect(await snapshotFiles(home)).toEqual(before);
  }, 20_000);

  it("shell-quotes project repair paths as executable argv", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = await tempHome("fclt-setup-quote-");
    const repo = join(home, "repo' ; touch INJECTED ; #");
    await mkdir(repo, { recursive: true });
    await runFixtureGit({
      argv: ["init", "--quiet", repo],
      repoDir: repo,
      homeDir: join(home, ".git-home"),
    });
    const result = await bootstrapFclt({
      homeDir: home,
      cwd: repo,
      includeProject: true,
      installCodexPlugin: false,
      dryRun: true,
    });
    const action = result.repairActions.find(
      (candidate) =>
        candidate.scope === "project" &&
        candidate.command.includes("--plan-sha")
    );
    expect(action).toBeDefined();
    const planSha256 = result.projectEnrollmentPlan?.planSha256;
    expect(planSha256).toBeDefined();

    const binDir = join(home, "bin");
    const fakeFclt = join(binDir, "fclt");
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeFclt, '#!/bin/sh\nprintf "%s\\n" "$@"\n', "utf8");
    await chmod(fakeFclt, 0o755);
    const proc = Bun.spawn(["/bin/sh", "-c", action?.command ?? ""], {
      cwd: home,
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([
      "project",
      "init",
      "--project-root",
      repo,
      "--apply",
      "--plan-sha",
      planSha256 ?? "",
    ]);
    expect(await Bun.file(join(home, "INJECTED")).exists()).toBe(false);
  });

  it("preserves an invalid reconciliation config and reports repair", async () => {
    const home = await tempHome("fclt-setup-invalid-reconciliation-");
    const root = join(home, ".ai");
    const configPath = join(root, "reconciliation.json");
    await mkdir(root, { recursive: true });
    await Bun.write(configPath, "{invalid\n");

    const result = await runCli({
      home,
      cwd: home,
      argv: ["setup", "--global-only", "--json", "--no-codex-plugin"],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      health: string;
      skippedPaths: string[];
      repairActions: Array<{ command: string }>;
      readiness: { global: { loop: { blockers: string[] } } };
    };
    expect(parsed.health).toBe("blocked");
    expect(parsed.skippedPaths).toContain(configPath);
    expect(parsed.readiness.global.loop.blockers).toContain(
      "reconciliation_config_invalid"
    );
    expect(parsed.repairActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "fclt ai review init --force" }),
      ])
    );
    expect(await Bun.file(configPath).text()).toBe("{invalid\n");
  });

  it("keeps setup global and returns a no-write project plan only when requested", async () => {
    const home = await tempHome("fclt-setup-cli-");
    const repo = await initRepo(home);

    const first = await runCli({
      home,
      cwd: repo,
      argv: ["setup", "--json", "--no-codex-plugin"],
    });
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const result = JSON.parse(first.stdout) as {
      health: string;
      projectRoot: string | null;
      projectEnrollmentPlan: null;
      readiness: {
        global: {
          loop: { state: string; capabilities: Record<string, boolean> };
        };
        project: null;
      };
    };
    expect(result.health).toBe("ready");
    expect(result.projectRoot).toBeNull();
    expect(result.projectEnrollmentPlan).toBeNull();
    expect(result.readiness.global.loop.state).toBe("ready");
    expect(result.readiness.project).toBeNull();
    expect(result.readiness.global.loop.capabilities.writebackSkill).toBe(true);
    expect(result.readiness.global.loop.capabilities.evolutionSkill).toBe(true);
    expect(
      result.readiness.global.loop.capabilities.reconciliation
    ).toMatchObject({ configured: true, sourceCount: 1 });
    expect(
      JSON.parse(
        await Bun.file(join(home, ".ai", "reconciliation.json")).text()
      ).sources
    ).toHaveLength(1);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);

    const preview = await runCli({
      home,
      cwd: repo,
      argv: ["setup", "--include-project", "--json", "--no-codex-plugin"],
    });
    expect(preview.code).toBe(0);
    const planned = JSON.parse(preview.stdout) as {
      projectRoot: string;
      projectEnrollmentPlan: {
        projectRoot: string;
        planSha256: string;
        protections: { automaticGuidanceCopy: boolean };
      };
      repairActions: Array<{ command: string }>;
    };
    expect(planned.projectRoot).toBe(join(repo, ".ai"));
    expect(planned.projectEnrollmentPlan.projectRoot).toBe(repo);
    expect(
      planned.projectEnrollmentPlan.protections.automaticGuidanceCopy
    ).toBe(false);
    expect(planned.repairActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining(
            `--plan-sha ${planned.projectEnrollmentPlan.planSha256}`
          ),
        }),
      ])
    );
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);

    const textPreview = await runCli({
      home,
      cwd: repo,
      argv: ["setup", "--include-project", "--dry-run", "--no-codex-plugin"],
    });
    expect(textPreview.code).toBe(0);
    const serializedPlan = JSON.stringify(
      planned.projectEnrollmentPlan,
      null,
      2
    );
    const planOffset = textPreview.stdout.indexOf(serializedPlan);
    const applyOffset = textPreview.stdout.indexOf(
      "fclt project init --project-root"
    );
    expect(planOffset).toBeGreaterThanOrEqual(0);
    expect(applyOffset).toBeGreaterThan(planOffset);

    const apply = await runCli({
      home,
      cwd: repo,
      argv: [
        "project",
        "init",
        "--project-root",
        repo,
        "--apply",
        "--plan-sha",
        planned.projectEnrollmentPlan.planSha256,
        "--json",
      ],
    });
    expect(apply.code).toBe(0);
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      true
    );
    expect(await Bun.file(join(repo, ".ai", "AGENTS.global.md")).exists()).toBe(
      false
    );
  }, 20_000);

  it("does not bootstrap a nested project inside a git-backed global root", async () => {
    const home = await tempHome("fclt-setup-global-root-");
    const globalRoot = join(home, ".ai");
    await mkdir(globalRoot, { recursive: true });
    await runFixtureGit({
      argv: ["init", "--quiet", globalRoot],
      repoDir: globalRoot,
      homeDir: join(home, ".git-home"),
    });

    const result = await bootstrapFclt({
      homeDir: home,
      cwd: globalRoot,
      installCodexPlugin: false,
    });

    expect(result.projectRoot).toBeNull();
    expect(await Bun.file(join(globalRoot, ".ai")).exists()).toBe(false);
    expect(result.readiness.project).toBeNull();
  }, 20_000);

  it("records and assesses project writeback after explicit enrollment", async () => {
    const home = await tempHome("fclt-setup-loop-");
    const repo = await initRepo(home);
    expect(
      (
        await runCli({
          home,
          cwd: repo,
          argv: ["setup", "--json", "--no-codex-plugin"],
        })
      ).code
    ).toBe(0);
    const preview = await runCli({
      home,
      cwd: repo,
      argv: ["project", "init", "--project-root", repo, "--json"],
    });
    expect(preview.code).toBe(0);
    const planSha256 = (JSON.parse(preview.stdout) as { planSha256: string })
      .planSha256;
    expect(
      (
        await runCli({
          home,
          cwd: repo,
          argv: [
            "project",
            "init",
            "--project-root",
            repo,
            "--apply",
            "--plan-sha",
            planSha256,
            "--json",
          ],
        })
      ).code
    ).toBe(0);

    const add = await runCli({
      home,
      cwd: repo,
      argv: [
        "ai",
        "writeback",
        "add",
        "--kind",
        "weak_verification",
        "--summary",
        "Bootstrap smoke found a reusable verification gap.",
        "--asset",
        "skill:capability-evolution",
        "--evidence",
        "test:isolated-home",
        "--project",
      ],
    });
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("WB-00001");

    const assess = await runCli({
      home,
      cwd: repo,
      argv: [
        "ai",
        "evolve",
        "assess",
        "--asset",
        "skill:capability-evolution",
        "--project",
        "--json",
      ],
    });
    expect(assess.code).toBe(0);
    expect(
      (JSON.parse(assess.stdout) as { recommendation: string }).recommendation
    ).toBe("record_more_writeback");

    const reviewRoot = join(home, ".ai", "writebacks", "projects");
    const projectDirs = await readdir(reviewRoot);
    expect(projectDirs).toHaveLength(1);
    expect(
      await Bun.file(
        join(reviewRoot, projectDirs[0] ?? "", "WB-00001.md")
      ).exists()
    ).toBe(true);
  }, 20_000);

  it("uses the isolated HOME for Codex registration and reports fresh-session proof honestly", async () => {
    const home = await tempHome("fclt-setup-codex-");
    const repo = await initRepo(home);
    const codexBin = join(home, "bin", "codex");
    await mkdir(dirname(codexBin), { recursive: true });
    await Bun.write(
      codexBin,
      [
        `#!${process.execPath}`,
        'import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        "const argv = process.argv.slice(2);",
        'const pluginId = "fclt@hack-local";',
        'const version = "0.1.3";',
        'const installedPath = join(process.env.HOME, ".codex", "plugins", "cache", "hack-local", "fclt", version);',
        'mkdirSync(join(process.env.HOME, ".codex"), { recursive: true });',
        'writeFileSync(join(process.env.HOME, ".codex", "config.toml"), `[plugins."` + pluginId + `"]\nenabled = true\n`);',
        'if (argv[0] === "plugin" && argv[1] === "add") {',
        "  rmSync(installedPath, { recursive: true, force: true });",
        "  mkdirSync(dirname(installedPath), { recursive: true });",
        '  cpSync(join(process.env.HOME, "plugins", "fclt"), installedPath, { recursive: true });',
        "  console.log(JSON.stringify({ pluginId, name: 'fclt', marketplaceName: 'hack-local', version, installedPath }));",
        '} else if (argv[0] === "plugin" && argv[1] === "list") {',
        "  console.log(JSON.stringify({ installed: [{ pluginId, name: 'fclt', marketplaceName: 'hack-local', version, installed: true, enabled: true }] }));",
        "} else {",
        "  process.exitCode = 64;",
        "}",
        "",
      ].join("\n")
    );
    await chmod(codexBin, 0o755);

    const result = await bootstrapFclt({
      homeDir: home,
      cwd: repo,
      codexBin,
    });
    expect(result.health).toBe("degraded");
    expect(result.codexPlugin?.codexInstall.status).toBe("succeeded");
    expect(result.readiness.global.loop.integrations.codex.state).toBe(
      "registered_unverified"
    );
    expect(
      result.readiness.global.loop.integrations.codex.freshSessionDiscovery
    ).toBe("requires_fresh_session");
    expect(await Bun.file(join(home, ".codex", "config.toml")).exists()).toBe(
      true
    );
  }, 20_000);

  it("prepares the Codex plugin without a Codex binary when installation is disabled", async () => {
    const home = await tempHome("fclt-setup-codex-payload-");
    const repo = await initRepo(home);

    const result = await bootstrapFclt({
      homeDir: home,
      cwd: repo,
      codexBin: null,
      installInCodex: false,
    });

    expect(result.codexPlugin?.codexInstall).toEqual({
      status: "skipped",
      reason: "codex plugin install disabled by --no-codex-install",
    });
    expect(
      await Bun.file(
        join(
          result.codexPlugin?.pluginDir ?? "",
          ".codex-plugin",
          "plugin.json"
        )
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(result.codexPlugin?.marketplacePath ?? "").exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(repo, ".agents", "plugins", "marketplace.json")
      ).exists()
    ).toBe(false);
  }, 20_000);
});
