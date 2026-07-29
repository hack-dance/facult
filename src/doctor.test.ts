import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import {
  buildLaunchAgentPlist,
  buildLaunchAgentSpec,
  setLaunchctlRunnerForTests,
  setLaunchctlSupportedForTests,
} from "./autosync";
import { buildDoctorReport } from "./doctor";
import { enableEvolutionLoop } from "./evolution-loop";
import {
  LEGACY_MANAGED_MUTATION_ENV,
  LEGACY_MANAGED_MUTATION_FLAG,
} from "./legacy-mutation-policy";
import { manageTool } from "./manage";
import {
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopStatePath,
  facultAiEvolutionReviewDir,
  facultAiIndexPath,
  facultAiReconciliationStatePath,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  facultMachineStateDir,
} from "./paths";

test("doctor keeps fresh homes clear when launchd inspection is unavailable", async () => {
  const home = await mkdtemp(join(tmpdir(), "facult-doctor-fresh-launchd-"));
  const rootDir = join(home, ".ai");

  try {
    await mkdir(rootDir, { recursive: true });
    setLaunchctlSupportedForTests(true);
    setLaunchctlRunnerForTests(() =>
      Promise.resolve({ exitCode: 1, stdout: "", stderr: "unavailable" })
    );

    const report = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });

    expect(report.legacyRecovery.state).toBe("clear");
    expect(report.legacyRecovery.coverage.launchd).toBe("unavailable");
    expect(report.legacyRecovery.reasonCodes).toContain(
      "autosync_launchd_inspection_unavailable"
    );
    expect(report.legacyRecovery.recovery.actions).toEqual([]);
    expect(report.health.state).not.toBe("legacy_state_attention");
  } finally {
    setLaunchctlRunnerForTests(null);
    setLaunchctlSupportedForTests(null);
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor contains managed-only homes when launchd inspection is unavailable", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "facult-doctor-managed-only-launchd-")
  );
  const rootDir = join(home, ".ai");
  const managedPath = join(
    facultMachineStateDir(home, rootDir),
    "managed.json"
  );

  try {
    await mkdir(rootDir, { recursive: true });
    await writeJson(managedPath, {
      version: 1,
      tools: { codex: {} },
    });
    setLaunchctlSupportedForTests(true);
    setLaunchctlRunnerForTests(() =>
      Promise.resolve({ exitCode: 1, stdout: "", stderr: "unavailable" })
    );

    const report = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });

    expect(report.legacyRecovery.state).toBe("contained");
    expect(report.legacyRecovery.coverage.launchd).toBe("unavailable");
    expect(report.legacyRecovery.reasonCodes).toContain(
      "managed_state_present"
    );
    expect(report.legacyRecovery.recovery).toMatchObject({
      boundary: "none",
      actions: [],
    });
    expect(report.issues.map((issue) => issue.code)).not.toContain(
      "legacy-recovery-manual-review-required"
    );
  } finally {
    setLaunchctlRunnerForTests(null);
    setLaunchctlSupportedForTests(null);
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor blocks configured autosync when launchd inspection is unavailable", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "facult-doctor-configured-launchd-")
  );
  const rootDir = join(home, ".ai");
  const serviceName = "all";
  const configPath = join(
    facultMachineStateDir(home, rootDir),
    "autosync",
    "services",
    `${serviceName}.json`
  );

  try {
    await mkdir(rootDir, { recursive: true });
    await writeJson(configPath, {
      version: 1,
      name: serviceName,
      rootDir,
      debounceMs: 100,
      git: {
        enabled: false,
        remote: "origin",
        branch: "main",
        intervalMinutes: 60,
        autoCommit: false,
        commitPrefix: "test",
        source: "local",
      },
    });
    setLaunchctlSupportedForTests(true);
    setLaunchctlRunnerForTests(() =>
      Promise.resolve({ exitCode: 1, stdout: "", stderr: "unavailable" })
    );

    const report = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });

    expect(report.legacyRecovery.state).toBe("blocked");
    expect(report.legacyRecovery.coverage.launchd).toBe("unavailable");
    expect(report.legacyRecovery.recovery.actions).toEqual([]);
    expect(report.health.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "legacy-recovery-manual-review-required"
    );
  } finally {
    setLaunchctlRunnerForTests(null);
    setLaunchctlSupportedForTests(null);
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor blocks loaded autosync without a matching owned plist", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "facult-doctor-loaded-without-plist-")
  );
  const rootDir = join(home, ".ai");
  const configPath = join(
    facultMachineStateDir(home, rootDir),
    "autosync",
    "services",
    "all.json"
  );

  try {
    await mkdir(rootDir, { recursive: true });
    await writeJson(configPath, {
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
        source: "local",
      },
    });
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
      return Promise.resolve({
        exitCode: 64,
        stdout: "",
        stderr: "unexpected",
      });
    });

    const report = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });

    expect(report.legacyRecovery.state).toBe("blocked");
    expect(report.legacyRecovery.reasonCodes).toContain(
      "autosync_loaded_ownership_unproven"
    );
    expect(report.legacyRecovery.recovery).toMatchObject({
      boundary: "manual_review",
      actions: [],
    });
    expect(
      report.actions.some((action) => action.id.startsWith("cleanup-autosync"))
    ).toBe(false);
  } finally {
    setLaunchctlRunnerForTests(null);
    setLaunchctlSupportedForTests(null);
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor reports legacy recovery coverage without mutating owned state", async () => {
  const home = await mkdtemp(join(tmpdir(), "facult-doctor-recovery-"));
  const rootDir = join(home, ".ai");
  const serviceName = "all";
  const configPath = join(
    facultMachineStateDir(home, rootDir),
    "autosync",
    "services",
    `${serviceName}.json`
  );
  const managedPath = join(
    facultMachineStateDir(home, rootDir),
    "managed.json"
  );
  const plistPath = join(
    home,
    "Library",
    "LaunchAgents",
    "com.fclt.autosync.plist"
  );
  try {
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      join(rootDir, "mcp", "servers.json"),
      `${JSON.stringify({ servers: {} }, null, 2)}\n`
    );
    await writeJson(managedPath, {
      version: 1,
      tools: { codex: { privatePath: "/must-not-leak" } },
    });
    await writeJson(configPath, {
      version: 1,
      name: serviceName,
      rootDir,
      debounceMs: 100,
      git: {
        enabled: false,
        remote: "private-remote-must-not-leak",
        branch: "main",
        intervalMinutes: 60,
        autoCommit: false,
        commitPrefix: "test",
        source: "private-host-must-not-leak",
      },
    });

    const contained = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });
    expect(contained.legacyRecovery).toMatchObject({
      state: "contained",
      mutationPolicy: "disabled_by_default",
      coverage: {
        managed: "checked",
        autosyncConfigs: "checked",
        launchAgents: "checked",
      },
      managed: {
        records: [
          {
            path: managedPath,
            location: "machine",
            state: "valid",
            tools: ["codex"],
          },
        ],
      },
      recovery: { boundary: "none", actions: [] },
    });
    expect(JSON.stringify(contained.legacyRecovery)).not.toContain(
      "must-not-leak"
    );

    await mkdir(dirname(plistPath), { recursive: true });
    await Bun.write(plistPath, doctorAutosyncPlist(home, rootDir, serviceName));
    let loaded = true;
    setLaunchctlSupportedForTests(true);
    setLaunchctlRunnerForTests((args) => {
      if (args[0] === "list") {
        return Promise.resolve({
          exitCode: 0,
          stdout: loaded ? "-\t0\tcom.fclt.autosync\n" : "",
          stderr: "",
        });
      }
      if (args[0] === "print" && loaded) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `working directory = ${rootDir}\n`,
          stderr: "",
        });
      }
      return Promise.resolve({
        exitCode: 113,
        stdout: "",
        stderr: "Could not find service",
      });
    });
    const beforeBytes = await Promise.all(
      [managedPath, configPath, plistPath].map((pathValue) =>
        readFile(pathValue, "utf8")
      )
    );
    const first = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });
    const second = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });
    expect(first.legacyRecovery.state).toBe("cleanup_required");
    expect(first.health).toEqual({
      state: "legacy_state_attention",
      ok: false,
    });
    expect(first.legacyRecovery.recovery.actions).toHaveLength(1);
    expect(first.legacyRecovery.recovery.actions[0]?.argv).toEqual([
      "fclt",
      "autosync",
      "cleanup",
      "--service",
      serviceName,
      "--expected-plan",
      expect.any(String),
      "--global",
      "--root",
      rootDir,
      LEGACY_MANAGED_MUTATION_FLAG,
      "--json",
    ]);
    expect(second.legacyRecovery).toEqual(first.legacyRecovery);
    expect(
      await Promise.all(
        [managedPath, configPath, plistPath].map((pathValue) =>
          readFile(pathValue, "utf8")
        )
      )
    ).toEqual(beforeBytes);
    loaded = false;
  } finally {
    setLaunchctlRunnerForTests(null);
    setLaunchctlSupportedForTests(null);
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor blocks orphaned autosync runtime without emitting cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "facult-doctor-recovery-orphan-"));
  const rootDir = join(home, ".ai");
  const plistPath = join(
    home,
    "Library",
    "LaunchAgents",
    "com.fclt.autosync.plist"
  );
  try {
    await mkdir(rootDir, { recursive: true });
    await mkdir(dirname(plistPath), { recursive: true });
    await Bun.write(plistPath, doctorAutosyncPlist(home, rootDir, "all"));
    const before = await readFile(plistPath, "utf8");
    const report = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });
    expect(report.legacyRecovery.state).toBe("blocked");
    expect(report.legacyRecovery.reasonCodes).toContain(
      "autosync_orphaned_runtime"
    );
    expect(report.legacyRecovery.recovery).toMatchObject({
      boundary: "manual_review",
      actions: [],
    });
    expect(
      report.actions.some((action) => action.id.includes("autosync"))
    ).toBe(false);
    expect(await readFile(plistPath, "utf8")).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor blocks malformed or comment-spoofed orphan launch artifacts", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "facult-doctor-recovery-malformed-")
  );
  const rootDir = join(home, ".ai");
  const plistPath = join(
    home,
    "Library",
    "LaunchAgents",
    "com.fclt.autosync.plist"
  );
  try {
    await mkdir(rootDir, { recursive: true });
    await mkdir(dirname(plistPath), { recursive: true });
    const spoof = doctorAutosyncPlist(home, rootDir, "all");
    await Bun.write(
      plistPath,
      `<!-- ${spoof.replaceAll("--", "-")} -->\n<plist><dict><key>Label</key><string>com.fclt.autosync</string></dict></plist>\n`
    );
    const before = await readFile(plistPath, "utf8");
    const report = await buildDoctorReport({
      homeDir: home,
      rootArg: rootDir,
      scope: "global",
    });
    expect(report.legacyRecovery.state).toBe("blocked");
    expect(report.legacyRecovery.coverage.launchAgents).toBe("unavailable");
    expect(report.legacyRecovery.reasonCodes).toContain(
      "autosync_launch_agent_inspection_unavailable"
    );
    expect(report.legacyRecovery.recovery.actions).toEqual([]);
    expect(await readFile(plistPath, "utf8")).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function doctorAutosyncPlist(
  homeDir: string,
  rootDir: string,
  serviceName: string
): string {
  return buildLaunchAgentPlist(
    buildLaunchAgentSpec({
      homeDir,
      rootDir,
      serviceName,
      invocation: [join(homeDir, "bin", "fclt")],
    })
  );
}

function doctorLegacyAutosyncPlist(
  homeDir: string,
  rootDir: string,
  serviceName: string
): string {
  const currentLabel =
    serviceName === "all"
      ? "com.fclt.autosync"
      : `com.fclt.autosync.${serviceName}`;
  const legacyLabel =
    serviceName === "all"
      ? "com.facult.autosync"
      : `com.facult.autosync.${serviceName}`;
  return doctorAutosyncPlist(homeDir, rootDir, serviceName).replace(
    `<string>${currentLabel}</string>`,
    `<string>${legacyLabel}</string>`
  );
}

async function installIsolatedLaunchctl(
  homeDir: string,
  rootDir: string
): Promise<{
  binDir: string;
  logPath: string;
  rootDir: string;
}> {
  const binDir = join(homeDir, "isolated-launchctl-bin");
  const logPath = join(homeDir, "isolated-launchctl.log");
  const executable = join(binDir, "launchctl");
  await mkdir(binDir, { recursive: true });
  await Bun.write(
    executable,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FCLT_TEST_LAUNCHCTL_LOG"',
      'if [ "$1" = "list" ]; then',
      '  if [ -n "$FCLT_TEST_LAUNCHCTL_LABEL" ]; then printf -- "-\\t0\\t%s\\n" "$FCLT_TEST_LAUNCHCTL_LABEL"; fi',
      "  exit 0",
      "fi",
      'if [ "$1" = "print" ]; then',
      '  case "$2" in',
      '    *com.facult.autosync*) printf "working directory = %s\\n" "$FCLT_TEST_LAUNCHCTL_ROOT"; exit 0 ;;',
      '    *) echo "Could not find service" >&2; exit 113 ;;',
      "  esac",
      "fi",
      'if [ "$1" = "bootout" ]; then exit 0; fi',
      "exit 64",
      "",
    ].join("\n")
  );
  await chmod(executable, 0o755);
  return { binDir, logPath, rootDir };
}

test("doctor preserves explicit custom-global scope and reports unsafe scheduler ownership", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "facult-doctor-custom-global-"));
  const rootDir = join(homeDir, "shared", ".ai");
  try {
    await mkdir(rootDir, { recursive: true });
    const enabled = await enableEvolutionLoop({
      homeDir,
      rootDir,
      scope: "global",
    });
    const ready = await buildDoctorReport({
      homeDir,
      rootArg: rootDir,
      scope: "global",
    });
    expect(ready.rootDir).toBe(rootDir);
    expect(ready.projectRoot).toBeNull();
    expect(ready.checks.evolutionLoopConfigured).toBe(true);
    expect(ready.loop.capabilities.scheduling.configurationState).toBe("ready");

    const outside = join(homeDir, "outside-loop-automation");
    await rename(enabled.automationPath, outside);
    await symlink(outside, enabled.automationPath);
    const degraded = await buildDoctorReport({
      homeDir,
      rootArg: rootDir,
      scope: "global",
    });
    expect(degraded.loop.capabilities.scheduling.schedulerError).toContain(
      "unsafe Codex automation directory"
    );
    expect(degraded.issues.map((issue) => issue.code)).toContain(
      "evolution-loop-scheduler-invalid"
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("doctor reports scheduled loop configuration and invalid state safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-loop-config-"));
  const aiRoot = join(dir, ".ai");
  const env = { ...process.env, HOME: dir };
  try {
    const setup = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "setup",
        "--global-only",
        "--no-codex-plugin",
        "--json",
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await setup.exited).toBe(0);

    const initial = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const initialReport = JSON.parse(
      await new Response(initial.stdout).text()
    ) as {
      checks: { evolutionLoopConfigured: boolean };
      loop: {
        capabilities: {
          scheduling: { configurationState: string; enabled: boolean };
        };
      };
    };
    expect(await initial.exited).toBe(0);
    expect(initialReport.checks.evolutionLoopConfigured).toBe(false);
    expect(initialReport.loop.capabilities.scheduling.configurationState).toBe(
      "not_configured"
    );
    expect(initialReport.loop.capabilities.scheduling.enabled).toBe(false);

    const enable = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "ai",
        "loop",
        "enable",
        "--global",
        "--json",
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await enable.exited).toBe(0);
    await Bun.write(
      facultAiEvolutionLoopStatePath(dir, aiRoot),
      "{invalid-loop-state"
    );
    const invalidState = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const stateReport = JSON.parse(
      await new Response(invalidState.stdout).text()
    ) as { health: { state: string }; issues: Array<{ code: string }> };
    expect(await invalidState.exited).toBe(0);
    expect(stateReport.health.state).toBe("scheduled_loop_attention");
    expect(stateReport.issues.map((issue) => issue.code)).toContain(
      "evolution-loop-state-invalid"
    );

    await rm(facultAiEvolutionLoopStatePath(dir, aiRoot), { force: true });
    await Bun.write(
      join(
        dir,
        ".codex",
        "automations",
        "fclt-evolution-global",
        "automation.toml"
      ),
      "{invalid-automation"
    );
    const invalidScheduler = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const schedulerReport = JSON.parse(
      await new Response(invalidScheduler.stdout).text()
    ) as { issues: Array<{ code: string }> };
    expect(await invalidScheduler.exited).toBe(0);
    expect(schedulerReport.issues.map((issue) => issue.code)).toContain(
      "evolution-loop-scheduler-invalid"
    );

    await Bun.write(
      facultAiEvolutionLoopConfigPath(dir, aiRoot),
      "{invalid-loop-config"
    );
    const invalid = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const invalidReport = JSON.parse(
      await new Response(invalid.stdout).text()
    ) as {
      issues: Array<{ code: string }>;
      loop: {
        capabilities: { scheduling: { configurationState: string } };
      };
    };
    expect(await invalid.exited).toBe(0);
    expect(invalidReport.issues.map((issue) => issue.code)).toContain(
      "evolution-loop-config-invalid"
    );
    expect(invalidReport.loop.capabilities.scheduling.configurationState).toBe(
      "invalid"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("doctor distinguishes invalid reconciliation config and state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-reconciliation-"));
  const aiRoot = join(dir, ".ai");
  const env = { ...process.env, HOME: dir };
  try {
    const setup = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "setup",
        "--global-only",
        "--no-codex-plugin",
        "--json",
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await setup.exited).toBe(0);

    await Bun.write(join(aiRoot, "reconciliation.json"), "{invalid-config");
    const invalidConfig = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const configReport = JSON.parse(
      await new Response(invalidConfig.stdout).text()
    ) as {
      issues: Array<{ code: string }>;
      actions: Array<{ command: string }>;
    };
    await invalidConfig.exited;
    expect(configReport.issues.map((issue) => issue.code)).toContain(
      "reconciliation-config-invalid"
    );
    expect(configReport.actions.map((action) => action.command)).toContain(
      "fclt ai review init --force"
    );

    await Bun.write(
      join(aiRoot, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    await Bun.write(
      facultAiReconciliationStatePath(dir, aiRoot),
      "{invalid-state"
    );
    const invalidState = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const stateReport = JSON.parse(
      await new Response(invalidState.stdout).text()
    ) as { issues: Array<{ code: string }>; loop: { blockers: string[] } };
    await invalidState.exited;
    expect(stateReport.issues.map((issue) => issue.code)).toContain(
      "reconciliation-state-invalid"
    );
    expect(stateReport.loop.blockers).toContain("reconciliation_state_invalid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

const BROKEN_CUSTOM_REF = ["$", "{refs.private_custom}"].join("");
const BROKEN_LEARNING_REF = ["$", "{refs.learning_writeback}"].join("");
const BROKEN_VERIFICATION_REF = ["$", "{refs.verification}"].join("");
const AGENTS_GLOBAL_BACKUP_RE = /^AGENTS\.global\./;
const FEEDBACK_LOOPS_BACKUP_RE = /^instructions__FEEDBACK_LOOPS\.md\./;

async function writeJson(p: string, data: unknown) {
  await mkdir(join(p, ".."), { recursive: true }).catch(() => null);
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

test("doctor --repair migrates a legacy root index into generated ai state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-"));
  const rootDir = join(dir, "root");
  const legacyIndex = join(rootDir, "index.json");
  const generatedIndex = facultAiIndexPath(dir, rootDir);

  try {
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      legacyIndex,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          skills: {},
          mcp: { servers: {} },
          agents: {},
          snippets: {},
          instructions: {},
        },
        null,
        2
      )}\n`
    );

    const env = { ...process.env, HOME: dir, FACULT_ROOT_DIR: rootDir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
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
    expect(out).toContain("Repaired generated AI index");

    const repaired = JSON.parse(await readFile(generatedIndex, "utf8")) as {
      version: number;
    };
    expect(repaired.version).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair updates legacy root config to ~/.ai when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-config-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "agents"), { recursive: true });
    await writeJson(join(dir, ".facult", "config.json"), {
      rootDir: join(dir, "agents", ".facult"),
    });

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
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
    expect(out).toContain(`Updated fclt root config to ${aiRoot}`);

    const config = JSON.parse(
      await readFile(join(dir, ".ai", ".facult", "config.json"), "utf8")
    ) as { rootDir: string };
    expect(config.rootDir).toBe(aiRoot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor preflights legacy autosync before any repair writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-autosync-guard-"));
  const aiRoot = join(dir, ".ai");
  const repairedConfig = join(aiRoot, ".facult", "config.json");
  const serviceName = "doctor-guard-test";
  const serviceConfig = join(
    aiRoot,
    ".facult",
    "autosync",
    "services",
    `${serviceName}.json`
  );
  const legacyPlist = join(
    dir,
    "Library",
    "LaunchAgents",
    `com.facult.autosync.${serviceName}.plist`
  );

  try {
    await mkdir(aiRoot, { recursive: true });
    await writeJson(join(dir, ".facult", "config.json"), {
      rootDir: join(dir, "agents", ".facult"),
    });
    await writeJson(serviceConfig, {
      version: 1,
      name: serviceName,
      tool: serviceName,
      rootDir: aiRoot,
      debounceMs: 10,
      git: {
        enabled: false,
        remote: "origin",
        branch: "main",
        intervalMinutes: 60,
        autoCommit: false,
        commitPrefix: "test",
        source: "test",
      },
    });
    await mkdir(dirname(legacyPlist), { recursive: true });
    await Bun.write(
      legacyPlist,
      doctorLegacyAutosyncPlist(dir, aiRoot, serviceName)
    );
    const isolatedLaunchctl = await installIsolatedLaunchctl(dir, aiRoot);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir,
      PATH: `${isolatedLaunchctl.binDir}${delimiter}${process.env.PATH ?? ""}`,
      FCLT_TEST_LAUNCHCTL_LOG: isolatedLaunchctl.logPath,
      FCLT_TEST_LAUNCHCTL_ROOT: isolatedLaunchctl.rootDir,
    };
    env[LEGACY_MANAGED_MUTATION_ENV] = undefined;
    const rejectedPreview = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair", "--dry-run"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [previewCode, previewError] = await Promise.all([
      rejectedPreview.exited,
      new Response(rejectedPreview.stderr).text(),
    ]);
    expect(previewCode).toBe(1);
    expect(previewError).toContain("Unknown option: --dry-run");
    expect(await Bun.file(repairedConfig).exists()).toBe(false);
    expect(await Bun.file(legacyPlist).exists()).toBe(true);

    const blocked = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [blockedCode, blockedError] = await Promise.all([
      blocked.exited,
      new Response(blocked.stderr).text(),
    ]);

    expect(blockedCode).toBe(1);
    expect(blockedError).toContain(
      "fclt doctor --repair autosync is a deprecated"
    );
    expect(await Bun.file(repairedConfig).exists()).toBe(false);
    expect(
      await readFile(isolatedLaunchctl.logPath, "utf8").catch(() => "")
    ).not.toContain("bootout");

    const approved = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "doctor",
        "--repair",
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [approvedCode, approvedOut, approvedError] = await Promise.all([
      approved.exited,
      new Response(approved.stdout).text(),
      new Response(approved.stderr).text(),
    ]);
    expect(approvedCode).toBe(0);
    expect(approvedError).toBe("");
    expect(approvedOut).toContain(
      "Removed contained background autosync launch agents"
    );
    expect(await Bun.file(repairedConfig).exists()).toBe(true);
    expect(await Bun.file(serviceConfig).exists()).toBe(false);
    expect(await Bun.file(legacyPlist).exists()).toBe(false);
    const approvedLaunchctlLog = await readFile(
      isolatedLaunchctl.logPath,
      "utf8"
    );
    if (process.platform === "darwin") {
      expect(approvedLaunchctlLog).toContain("bootout");
    } else {
      expect(approvedLaunchctlLog).not.toContain("bootout");
    }
    expect(
      await Bun.file(
        join(
          facultMachineStateDir(dir, aiRoot),
          "autosync",
          "services",
          `${serviceName}.json`
        )
      ).exists()
    ).toBe(true);

    const status = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "autosync",
        "status",
        serviceName,
        "--global",
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [statusCode, statusOut, statusError] = await Promise.all([
      status.exited,
      new Response(status.stdout).text(),
      new Response(status.stderr).text(),
    ]);
    expect(statusCode).toBe(0);
    expect(statusError).toBe("");
    expect(statusOut).toContain("Installed: no");
    expect(statusOut).toContain("Loaded: no");
    expect(statusOut).toContain(`Root: ${aiRoot}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair preserves an explicit custom global root and state scope", async () => {
  const home = await mkdtemp(join(tmpdir(), "facult-doctor-custom-global-"));
  const rootDir = join(home, "shared", ".ai");
  const stateRoot = join(home, "state");
  const serviceName = "custom-global-test";
  const configPath = join(
    stateRoot,
    "global",
    "autosync",
    "services",
    `${serviceName}.json`
  );
  const legacyPlist = join(
    home,
    "Library",
    "LaunchAgents",
    `com.facult.autosync.${serviceName}.plist`
  );

  try {
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      join(rootDir, "mcp", "servers.json"),
      JSON.stringify({ servers: {} }, null, 2)
    );
    await mkdir(dirname(configPath), { recursive: true });
    await Bun.write(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          name: serviceName,
          rootDir,
          debounceMs: 100,
          git: {
            enabled: false,
            remote: "origin",
            branch: "main",
            intervalMinutes: 60,
            autoCommit: false,
            commitPrefix: "test",
            source: "test",
          },
        },
        null,
        2
      )}\n`
    );
    await mkdir(dirname(legacyPlist), { recursive: true });
    await Bun.write(
      legacyPlist,
      doctorLegacyAutosyncPlist(home, rootDir, serviceName)
    );
    const isolatedLaunchctl = await installIsolatedLaunchctl(home, rootDir);
    const env = {
      ...process.env,
      HOME: home,
      FACULT_LOCAL_STATE_DIR: stateRoot,
      PATH: `${isolatedLaunchctl.binDir}${delimiter}${process.env.PATH ?? ""}`,
      FCLT_TEST_LAUNCHCTL_LOG: isolatedLaunchctl.logPath,
      FCLT_TEST_LAUNCHCTL_ROOT: isolatedLaunchctl.rootDir,
    };
    const repair = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "doctor",
        "--repair",
        "--global",
        "--root",
        rootDir,
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [code, stdout, stderr] = await Promise.all([
      repair.exited,
      new Response(repair.stdout).text(),
      new Response(repair.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`Canonical root: ${rootDir}`);
    expect(stdout).toContain(
      "Removed contained background autosync launch agents"
    );
    const preserved = JSON.parse(await readFile(configPath, "utf8")) as {
      rootDir: string;
    };
    expect(preserved.rootDir).toBe(rootDir);
    expect(await Bun.file(legacyPlist).exists()).toBe(false);
    const launchctlLog = await readFile(isolatedLaunchctl.logPath, "utf8");
    if (process.platform === "darwin") {
      expect(launchctlLog).toContain("bootout");
    } else {
      expect(launchctlLog).not.toContain("bootout");
    }
    expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);
    expect(
      await Bun.file(join(rootDir, ".facult", "ai", "index.json")).exists()
    ).toBe(true);
    expect(
      await Bun.file(join(rootDir, ".facult", "ai", "graph.json")).exists()
    ).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

test("doctor stops before all repair writes for an orphaned autosync plist", async () => {
  const home = await mkdtemp(join(tmpdir(), "facult-doctor-orphan-"));
  const rootDir = join(home, ".ai");
  const serviceName = "doctor-orphan-test";
  const plistPath = join(
    home,
    "Library",
    "LaunchAgents",
    `com.facult.autosync.${serviceName}.plist`
  );
  const repairedRootConfig = join(rootDir, ".facult", "config.json");

  try {
    await mkdir(rootDir, { recursive: true });
    await writeJson(join(home, ".facult", "config.json"), {
      rootDir: join(home, "agents", ".facult"),
    });
    await mkdir(dirname(plistPath), { recursive: true });
    await Bun.write(
      plistPath,
      doctorLegacyAutosyncPlist(home, rootDir, serviceName)
    );
    const before = await readFile(plistPath, "utf8");
    const isolatedLaunchctl = await installIsolatedLaunchctl(home, rootDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${isolatedLaunchctl.binDir}${delimiter}${process.env.PATH ?? ""}`,
      FCLT_TEST_LAUNCHCTL_LOG: isolatedLaunchctl.logPath,
      FCLT_TEST_LAUNCHCTL_ROOT: isolatedLaunchctl.rootDir,
    };
    const repair = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "doctor",
        "--repair",
        "--global",
        "--root",
        rootDir,
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [code, stderr] = await Promise.all([
      repair.exited,
      new Response(repair.stderr).text(),
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("root-owned orphaned autosync LaunchAgent");
    expect(await readFile(plistPath, "utf8")).toBe(before);
    expect(await Bun.file(repairedRootConfig).exists()).toBe(false);
    expect(
      await Bun.file(join(rootDir, ".facult", "ai", "index.json")).exists()
    ).toBe(false);
    expect(
      await readFile(isolatedLaunchctl.logPath, "utf8").catch(() => "")
    ).toBe("");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== "darwin")(
  "doctor stops before other repair writes when autosync unload fails",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-doctor-unload-fail-"));
    const rootDir = join(home, ".ai");
    const serviceName = "doctor-unload-fail-test";
    const serviceConfig = join(
      rootDir,
      ".facult",
      "autosync",
      "services",
      `${serviceName}.json`
    );
    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      `com.fclt.autosync.${serviceName}.plist`
    );
    const legacyRootConfig = join(home, ".facult", "config.json");
    const repairedRootConfig = join(rootDir, ".facult", "config.json");
    const fakeBin = join(home, "bin");
    const fakeLaunchctl = join(fakeBin, "launchctl");

    try {
      await writeJson(legacyRootConfig, {
        rootDir: join(home, "agents", ".facult"),
      });
      await writeJson(serviceConfig, {
        version: 1,
        name: serviceName,
        rootDir,
        debounceMs: 100,
        git: {
          enabled: false,
          remote: "origin",
          branch: "main",
          intervalMinutes: 60,
          autoCommit: false,
          commitPrefix: "test",
          source: "test",
        },
      });
      await mkdir(dirname(plistPath), { recursive: true });
      await Bun.write(
        plistPath,
        doctorAutosyncPlist(home, rootDir, serviceName)
      );
      await mkdir(fakeBin, { recursive: true });
      await Bun.write(
        fakeLaunchctl,
        [
          "#!/bin/sh",
          'if [ "$1" = "print" ]; then printf "working directory = %s\\n" "$FCLT_TEST_LAUNCHCTL_ROOT"; exit 0; fi',
          'if [ "$1" = "bootout" ]; then echo "still loaded" >&2; exit 9; fi',
          "exit 0",
          "",
        ].join("\n")
      );
      await chmod(fakeLaunchctl, 0o755);
      const configBefore = await readFile(serviceConfig, "utf8");
      const plistBefore = await readFile(plistPath, "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        FCLT_TEST_LAUNCHCTL_ROOT: rootDir,
      };
      env[LEGACY_MANAGED_MUTATION_ENV] = undefined;
      const repair = Bun.spawn(
        [
          "bun",
          "run",
          "./src/index.ts",
          "doctor",
          "--repair",
          "--global",
          "--root",
          rootDir,
          LEGACY_MANAGED_MUTATION_FLAG,
        ],
        { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
      );
      const [code, stderr] = await Promise.all([
        repair.exited,
        new Response(repair.stderr).text(),
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("Unable to unload autosync service");
      expect(await readFile(serviceConfig, "utf8")).toBe(configBefore);
      expect(await readFile(plistPath, "utf8")).toBe(plistBefore);
      expect(await Bun.file(repairedRootConfig).exists()).toBe(false);
      expect(
        await Bun.file(join(rootDir, ".facult", "ai", "index.json")).exists()
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000
);

test("doctor --repair migrates legacy codex skill and plugin layouts into .agents and plugins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-codex-layout-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "mcp"), { recursive: true });
    await Bun.write(
      join(aiRoot, "mcp", "servers.json"),
      JSON.stringify({ servers: {} }, null, 2)
    );

    await mkdir(join(dir, ".codex", "skills", "legacy-skill"), {
      recursive: true,
    });
    await Bun.write(
      join(dir, ".codex", "skills", "legacy-skill", "SKILL.md"),
      "# Legacy Skill\n"
    );
    await symlink(
      join(dir, "missing-imagegen-source"),
      join(dir, ".codex", "skills", "imagegen")
    );
    await mkdir(join(dir, ".agents", "skills"), { recursive: true });
    await symlink(
      join(dir, "missing-imagegen-destination"),
      join(dir, ".agents", "skills", "imagegen")
    );

    await mkdir(
      join(dir, ".codex", "plugins", "autoresearch", ".codex-plugin"),
      {
        recursive: true,
      }
    );
    await Bun.write(
      join(
        dir,
        ".codex",
        "plugins",
        "autoresearch",
        ".codex-plugin",
        "plugin.json"
      ),
      JSON.stringify({ name: "autoresearch", version: "0.1.0" }, null, 2)
    );

    await mkdir(join(dir, ".agents", "plugins"), { recursive: true });
    await Bun.write(
      join(dir, ".agents", "plugins", "marketplace.json"),
      JSON.stringify(
        {
          name: "local",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "autoresearch",
              source: {
                source: "local",
                path: "./.codex/plugins/autoresearch",
              },
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

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
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
    expect(out).toContain("Migrated legacy Codex authoring paths");

    expect(
      await Bun.file(
        join(dir, ".agents", "skills", "legacy-skill", "SKILL.md")
      ).exists()
    ).toBe(true);
    expect(
      (await lstat(join(dir, ".codex", "skills", "imagegen"))).isSymbolicLink()
    ).toBe(true);
    expect(
      await Bun.file(
        join(dir, "plugins", "autoresearch", ".codex-plugin", "plugin.json")
      ).exists()
    ).toBe(true);

    const marketplace = await readFile(
      join(dir, ".agents", "plugins", "marketplace.json"),
      "utf8"
    );
    expect(marketplace).toContain('"path": "./plugins/autoresearch"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair materializes explicit project sync config for managed project roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-project-sync-"));
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, "skills", "project-skill"), { recursive: true });
    await Bun.write(
      join(aiRoot, "skills", "project-skill", "SKILL.md"),
      "---\ndescription: Project skill\n---\n\n# Project skill\n"
    );

    await mkdir(join(aiRoot, "agents", "reviewer"), { recursive: true });
    await Bun.write(
      join(aiRoot, "agents", "reviewer", "agent.toml"),
      'name = "reviewer"\n'
    );
    await mkdir(join(aiRoot, "automations", "project-check"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "automations", "project-check", "automation.toml"),
      [
        "version = 1",
        'id = "project-check"',
        'name = "Project check"',
        'prompt = "Inspect the repo"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
    );

    await mkdir(join(aiRoot, "mcp"), { recursive: true });
    await Bun.write(
      join(aiRoot, "mcp", "servers.json"),
      JSON.stringify(
        {
          servers: {
            "project-server": {
              command: "node",
              args: ["server.js"],
            },
          },
        },
        null,
        2
      )
    );

    await Bun.write(join(aiRoot, "AGENTS.global.md"), "# Project docs\n");
    await mkdir(join(aiRoot, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(aiRoot, "tools", "codex", "rules", "project.rules"),
      "Project rules.\n"
    );
    await Bun.write(
      join(aiRoot, "tools", "codex", "config.toml"),
      'approval_policy = "never"\n'
    );

    await manageTool("codex", { homeDir: dir, rootDir: aiRoot });

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair", "--root", aiRoot],
      {
        cwd: process.cwd(),
        env,
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
    expect(out).toContain("Materialized explicit project sync policy");

    const config = Bun.TOML.parse(
      await readFile(join(aiRoot, "config.local.toml"), "utf8")
    ) as {
      project_sync?: {
        codex?: {
          skills?: string[];
          agents?: string[];
          automations?: string[];
          mcp_servers?: string[];
          global_docs?: boolean;
          tool_rules?: boolean;
          tool_config?: boolean;
        };
      };
    };

    expect(config.project_sync?.codex?.skills).toEqual(["project-skill"]);
    expect(config.project_sync?.codex?.agents).toEqual(["reviewer"]);
    expect(config.project_sync?.codex?.automations).toEqual(["project-check"]);
    expect(config.project_sync?.codex?.mcp_servers).toEqual(["project-server"]);
    expect(config.project_sync?.codex?.global_docs).toBe(true);
    expect(config.project_sync?.codex?.tool_rules).toBe(true);
    expect(config.project_sync?.codex?.tool_config).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json reports read-only setup health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-json-"));

  try {
    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      {
        cwd: process.cwd(),
        env,
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
    const report = JSON.parse(out) as {
      version: number;
      health: { state: string; ok: boolean };
      rootDir: string;
      checks: { generatedIndexSource: string };
      issues: Array<{ code: string }>;
      actions: Array<{ id: string; risk: string }>;
    };
    expect(report.version).toBe(2);
    expect(report.rootDir).toBe(join(dir, ".ai"));
    expect(report.health.state).toBe("uninitialized");
    expect(report.health.ok).toBe(false);
    expect(report.checks.generatedIndexSource).toBe("missing");
    expect(report.issues.map((issue) => issue.code)).toContain("missing-root");
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "init-global-operating-model",
        risk: "canonical_write",
      })
    );
    expect(await Bun.file(join(dir, ".ai")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor health is non-OK when loop readiness is blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-loop-blocked-"));

  try {
    const env = { ...process.env, HOME: dir };
    const setup = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "setup",
        "--global-only",
        "--no-codex-plugin",
        "--json",
      ],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [setupCode, setupErr] = await Promise.all([
      setup.exited,
      new Response(setup.stderr).text(),
      new Response(setup.stdout).text(),
    ]);
    expect(setupCode).toBe(0);
    expect(setupErr).toBe("");

    await rm(join(dir, ".ai", "skills", "capability-evolution"), {
      recursive: true,
      force: true,
    });

    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      {
        cwd: process.cwd(),
        env,
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      loop: { state: string; blockers: string[] };
    };
    expect(report.health).toEqual({ state: "loop_blocked", ok: false });
    expect(report.loop.state).toBe("blocked");
    expect(report.loop.blockers).toContain("evolution_skill_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("project doctor accepts loop skills inherited from the global root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-inherited-loop-"));
  const repo = join(dir, "work", "repo");
  const cliEntry = join(import.meta.dir, "index.ts");

  try {
    await mkdir(repo, { recursive: true });
    await runFixtureGit({
      argv: ["init", repo],
      repoDir: repo,
      homeDir: join(dir, ".git-home"),
    });

    const env = { ...process.env, HOME: dir };
    const setup = Bun.spawn(
      ["bun", "run", cliEntry, "setup", "--no-codex-plugin", "--json"],
      {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [setupCode, setupOut, setupErr] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ]);
    expect(setupErr).toBe("");
    expect(setupCode).toBe(0);
    expect(setupOut).not.toBe("");
    const projectSetup = Bun.spawn(
      [
        "bun",
        "run",
        cliEntry,
        "templates",
        "init",
        "operating-model",
        "--project",
      ],
      {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(await projectSetup.exited).toBe(0);
    const projectReviewSetup = Bun.spawn(
      ["bun", "run", cliEntry, "ai", "review", "init", "--project"],
      {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(await projectReviewSetup.exited).toBe(0);

    await Promise.all([
      rm(join(repo, ".ai", "skills", "fclt-writeback"), {
        recursive: true,
        force: true,
      }),
      rm(join(repo, ".ai", "skills", "capability-evolution"), {
        recursive: true,
        force: true,
      }),
    ]);

    const proc = Bun.spawn(
      ["bun", "run", cliEntry, "doctor", "--project", "--json"],
      {
        cwd: repo,
        env,
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
    const report = JSON.parse(out) as {
      health: { ok: boolean };
      loop: {
        state: string;
        blockers: string[];
        capabilities: { writebackSkill: boolean; evolutionSkill: boolean };
      };
    };
    expect(report.health.ok).toBe(true);
    expect(report.loop.state).toBe("degraded");
    expect(report.loop.blockers).not.toContain("writeback_skill_missing");
    expect(report.loop.blockers).not.toContain("evolution_skill_missing");
    expect(report.loop.capabilities.writebackSkill).toBe(true);
    expect(report.loop.capabilities.evolutionSkill).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor blocks loop readiness when reconciliation has no enabled sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-no-sources-"));
  const repo = join(dir, "work", "repo");
  const cliEntry = join(import.meta.dir, "index.ts");

  try {
    await mkdir(repo, { recursive: true });
    await runFixtureGit({
      argv: ["init", repo],
      repoDir: repo,
      homeDir: join(dir, ".git-home"),
    });
    const env = { ...process.env, HOME: dir };
    const setup = Bun.spawn(
      ["bun", "run", cliEntry, "setup", "--no-codex-plugin", "--json"],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await setup.exited).toBe(0);
    const projectSetup = Bun.spawn(
      [
        "bun",
        "run",
        cliEntry,
        "templates",
        "init",
        "operating-model",
        "--project",
      ],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await projectSetup.exited).toBe(0);
    await Bun.write(
      join(repo, ".ai", "reconciliation.json"),
      JSON.stringify({ version: 1, sources: [] })
    );
    const proc = Bun.spawn(
      ["bun", "run", cliEntry, "doctor", "--project", "--json"],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" }
    );
    const [code, out] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      loop: { state: string; blockers: string[] };
    };
    expect(report.loop.state).toBe("blocked");
    expect(report.loop.blockers).toContain("reconciliation_sources_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json flags invalid canonical global guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-global-docs-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/work-units -->",
        "<!-- /fclty:global/core/work-units -->",
        "",
        `- For verification, read ${BROKEN_VERIFICATION_REF}.`,
      ].join("\n")
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      {
        cwd: process.cwd(),
        env,
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      checks: {
        canonicalGlobalDocsValid: boolean;
        canonicalGlobalDocsIssueCodes: string[];
        canonicalTemplateRefsValid: boolean;
        canonicalTemplateRefsIssueCodes: string[];
        canonicalTemplateRefsIssuePaths: string[];
      };
      issues: Array<{ code: string }>;
      actions: Array<{ id: string; command: string }>;
    };
    expect(report.health.state).toBe("canonical_source_attention");
    expect(report.health.ok).toBe(false);
    expect(report.checks.canonicalGlobalDocsValid).toBe(false);
    expect(report.checks.canonicalGlobalDocsIssueCodes).toEqual([
      "canonical-global-docs-empty-managed-sections",
    ]);
    expect(report.checks.canonicalTemplateRefsValid).toBe(true);
    expect(report.checks.canonicalTemplateRefsIssueCodes).toEqual([]);
    expect(report.checks.canonicalTemplateRefsIssuePaths).toEqual([]);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "canonical-global-docs-empty-managed-sections"
    );
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "refresh-global-operating-model",
        command: "fclt templates init operating-model --global --force",
      })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json accepts renderable templated canonical global guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-global-template-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "snippets", "global", "core"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/work-units -->",
        "<!-- /fclty:global/core/work-units -->",
        "",
        `- For learning, read ${BROKEN_LEARNING_REF}.`,
      ].join("\n")
    );
    await Bun.write(
      join(aiRoot, "snippets", "global", "core", "work-units.md"),
      `- For deeper guidance, read ${BROKEN_LEARNING_REF}.\n`
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      {
        cwd: process.cwd(),
        env,
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      checks: {
        canonicalGlobalDocsValid: boolean;
        canonicalGlobalDocsIssueCodes: string[];
      };
    };
    expect(report.health.state).not.toBe("canonical_source_attention");
    expect(report.checks.canonicalGlobalDocsValid).toBe(true);
    expect(report.checks.canonicalGlobalDocsIssueCodes).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor exits nonzero for invalid canonical global guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-global-docs-text-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/writeback -->",
        "<!-- /fclty:global/core/writeback -->",
      ].join("\n")
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(["bun", "run", "./src/index.ts", "doctor"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toContain("empty fclty managed sections");
    expect(out).toContain("templates init operating-model --global --force");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json flags unresolved refs in canonical markdown sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-source-refs-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "instructions"), { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      "# Global Agent Instructions\n\n- Source is otherwise valid.\n"
    );
    await Bun.write(
      join(aiRoot, "instructions", "FEEDBACK_LOOPS.md"),
      `# Feedback Loops\n\nRead ${BROKEN_CUSTOM_REF}.\n`
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      {
        cwd: process.cwd(),
        env,
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      checks: {
        canonicalGlobalDocsValid: boolean;
        canonicalTemplateRefsValid: boolean;
        canonicalTemplateRefsIssueCodes: string[];
        canonicalTemplateRefsIssuePaths: string[];
      };
      issues: Array<{ code: string; message: string }>;
      actions: Array<{ id: string; command: string }>;
    };
    expect(report.health.state).toBe("canonical_source_attention");
    expect(report.health.ok).toBe(false);
    expect(report.checks.canonicalGlobalDocsValid).toBe(true);
    expect(report.checks.canonicalTemplateRefsValid).toBe(false);
    expect(report.checks.canonicalTemplateRefsIssueCodes).toEqual([
      "canonical-source-unresolved-template-ref",
    ]);
    expect(report.checks.canonicalTemplateRefsIssuePaths).toEqual([
      "instructions/FEEDBACK_LOOPS.md",
    ]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "canonical-source-unresolved-template-ref",
        message: expect.stringContaining("instructions/FEEDBACK_LOOPS.md"),
      })
    );
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "repair-canonical-template-refs",
        command: "fclt doctor --repair",
      })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair refreshes invalid canonical global guidance and review artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-self-heal-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/writeback -->",
        "<!-- /fclty:global/core/writeback -->",
        "",
        `- Read ${BROKEN_LEARNING_REF}.`,
      ].join("\n")
    );
    await mkdir(join(aiRoot, "instructions"), { recursive: true });
    await Bun.write(
      join(aiRoot, "instructions", "FEEDBACK_LOOPS.md"),
      [
        "# Feedback Loops",
        "",
        `For verification, read ${BROKEN_VERIFICATION_REF}.`,
        `For learning, read ${BROKEN_LEARNING_REF}.`,
      ].join("\n")
    );
    await mkdir(join(aiRoot, "snippets", "global", "core"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "snippets", "global", "core", "feedback-loops.md"),
      `- For deeper guidance, read ${BROKEN_LEARNING_REF}.\n`
    );
    await mkdir(join(aiRoot, "snippets", "global", "core"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "snippets", "global", "core", "writeback.md"),
      "\n"
    );

    const queuePath = facultAiWritebackQueuePath(dir, aiRoot);
    await mkdir(dirname(queuePath), { recursive: true });
    await Bun.write(
      queuePath,
      `${JSON.stringify({
        id: "WB-00001",
        ts: "2026-06-19T00:00:00.000Z",
        scope: "global",
        kind: "capability_gap",
        summary: "Self-heal test writeback",
        evidence: [{ type: "test", ref: "doctor" }],
        confidence: "medium",
        source: "facult:test",
        tags: [],
        status: "recorded",
      })}\n`
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
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
    expect(out).toContain("Repaired canonical AGENTS.global.md");
    expect(out).toContain("Resolved canonical template refs in:");
    expect(out).toContain("instructions/FEEDBACK_LOOPS.md");
    expect(out).toContain("Refreshed AI review artifacts: 1 writebacks");

    const repaired = await readFile(join(aiRoot, "AGENTS.global.md"), "utf8");
    expect(repaired).toContain("# Global Agent Instructions");
    expect(repaired).toContain(BROKEN_LEARNING_REF);
    expect(repaired).toContain("<!-- fclty:global/core/writeback -->");
    expect(
      await Bun.file(
        join(aiRoot, "snippets", "global", "core", "writeback.md")
      ).exists()
    ).toBe(true);
    const repairedWritebackSnippet = await readFile(
      join(aiRoot, "snippets", "global", "core", "writeback.md"),
      "utf8"
    );
    expect(repairedWritebackSnippet).toContain(
      "Do not end at output if something important was learned."
    );
    const repairedInstruction = await readFile(
      join(aiRoot, "instructions", "FEEDBACK_LOOPS.md"),
      "utf8"
    );
    expect(repairedInstruction).toContain(
      join(aiRoot, "instructions", "VERIFICATION.md")
    );
    expect(repairedInstruction).toContain(
      join(aiRoot, "instructions", "LEARNING_AND_WRITEBACK.md")
    );
    expect(repairedInstruction).not.toContain("${refs.");

    const backupEntries = await readdir(
      join(aiRoot, ".facult", "backups", "doctor")
    );
    expect(backupEntries).toContainEqual(
      expect.stringMatching(AGENTS_GLOBAL_BACKUP_RE)
    );
    expect(backupEntries).toContainEqual(
      expect.stringMatching(FEEDBACK_LOOPS_BACKUP_RE)
    );

    const review = await readFile(
      join(facultAiWritebackReviewDir(dir, aiRoot), "WB-00001.md"),
      "utf8"
    );
    expect(review).toContain("Self-heal test writeback");
    expect(await readdir(facultAiEvolutionReviewDir(dir, aiRoot))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair does not replace project AGENTS.global.md with global defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-project-docs-"));
  const repoDir = join(dir, "repo");
  const aiRoot = join(repoDir, ".ai");
  const agentsPath = join(aiRoot, "AGENTS.global.md");
  const projectGuidance = [
    "# Project Agent Instructions",
    "",
    "Keep this project-specific guidance.",
    "",
    "<!-- fclty:global/core/writeback -->",
    "<!-- /fclty:global/core/writeback -->",
  ].join("\n");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(agentsPath, projectGuidance);

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair", "--root", aiRoot],
      {
        cwd: process.cwd(),
        env,
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
    expect(out).toContain("project AGENTS.global.md");
    expect(out).toContain(
      `fclt templates init operating-model --root '${aiRoot}' --force`
    );
    expect(out).not.toContain("Repaired canonical AGENTS.global.md");
    expect(await readFile(agentsPath, "utf8")).toBe(projectGuidance);
    expect(
      await Bun.file(join(aiRoot, ".facult", "backups", "doctor")).exists()
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor flags generated-only project ai roots as unsafe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-generated-only-"));
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(aiRoot, ".facult", "ai", "index.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          skills: {},
          mcp: { servers: {} },
          agents: {},
          snippets: {},
          instructions: {},
        },
        null,
        2
      )
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--root", aiRoot],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toContain("generated state only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json flags generated-only project ai roots without exiting nonzero", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "facult-doctor-json-generated-only-")
  );
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(aiRoot, ".facult", "ai", "index.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          skills: {},
          mcp: { servers: {} },
          agents: {},
          snippets: {},
          instructions: {},
        },
        null,
        2
      )
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json", "--root", aiRoot],
      {
        cwd: process.cwd(),
        env,
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      projectRoot: string | null;
      checks: { generatedOnlyProjectRoot: boolean };
      issues: Array<{ code: string }>;
      actions: Array<{ id: string; command: string }>;
    };
    expect(report.health.state).toBe("project_generated_only");
    expect(report.health.ok).toBe(false);
    expect(report.projectRoot).toBe(projectRoot);
    expect(report.checks.generatedOnlyProjectRoot).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "project-generated-only"
    );
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "init-project-ai",
        command: `fclt project init --project-root '${projectRoot}'`,
      })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor does not flag project ai roots with rules as generated-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-rules-source-"));
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(aiRoot, ".facult", "ai", "index.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          skills: {},
          mcp: { servers: {} },
          agents: {},
          snippets: {},
          instructions: {},
        },
        null,
        2
      )
    );
    await mkdir(join(aiRoot, "rules"), { recursive: true });
    await Bun.write(join(aiRoot, "rules", "POLICY.md"), "Project policy.\n");

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--root", aiRoot],
      {
        cwd: process.cwd(),
        env,
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
    expect(out).not.toContain("generated state only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
