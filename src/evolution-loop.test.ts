import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { latestActivityFeed } from "./activity";
import { resolveActivityActionLocator } from "./activity-action";
import { queryActivityHistory } from "./activity-history";
import {
  type AiProposalRecord,
  acceptProposal,
  addWriteback,
  applyProposal,
  draftProposal,
  linkWritebackIssue,
  listProposals,
  listWritebacks,
  proposeEvolution,
  rejectProposal,
  setWritebackDisposition,
  showProposal,
  verifyProposalEffectiveness,
} from "./ai";
import {
  disableEvolutionLoop,
  enableEvolutionLoop,
  evolutionLoopStatus,
  runEvolutionLoop,
} from "./evolution-loop";
import {
  facultAiActivityHistoryManifestPath,
  facultAiEvolutionLoopAuditPath,
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopStatePath,
  facultAiProposalDir,
  facultAiReconciliationStatePath,
  facultAiWritebackQueuePath,
  withFacultRootScope,
} from "./paths";

const SIGNAL_FAMILY_ID_RE = /^SF-/;
const COMPLETED_RUN_STATUS_RE = /^(complete|degraded)$/;
const temporaryRoots: string[] = [];

async function makeProject(): Promise<{
  homeDir: string;
  projectRoot: string;
  rootDir: string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "fclt-loop-"));
  temporaryRoots.push(homeDir);
  const projectRoot = join(homeDir, "repo");
  const rootDir = join(projectRoot, ".ai");
  await mkdir(rootDir, { recursive: true });
  await Bun.write(
    join(rootDir, "reconciliation.json"),
    `${JSON.stringify({
      version: 1,
      sources: [
        {
          id: "review-notes",
          type: "markdown",
          root: "project",
          paths: ["review.md"],
        },
      ],
    })}\n`
  );
  await Bun.write(
    join(projectRoot, "review.md"),
    "## 2026-01-02 Capability review\n\nThe capability review needs a durable verification loop.\n"
  );
  return { homeDir, projectRoot, rootDir };
}

async function runProjectGit(args: {
  projectRoot: string;
  argv: string[];
  date?: string;
}): Promise<void> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) {
      env[name] = value;
    }
  }
  if (args.date) {
    env.GIT_AUTHOR_DATE = args.date;
    env.GIT_COMMITTER_DATE = args.date;
  }
  const proc = Bun.spawn({
    cmd: [Bun.which("git") ?? "/usr/bin/git", ...args.argv],
    cwd: args.projectRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("evolution loop", () => {
  it("keeps embedded activity immutable when writebacks change after the run", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });
    const report = await runEvolutionLoop({
      ...project,
      since: "2026-07-12T00:00:00.000Z",
      until: "2026-07-13T00:00:00.000Z",
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });
    const before = await latestActivityFeed({ ...project, scope: "project" });
    const later = await addWriteback({
      ...project,
      kind: "tool_friction",
      summary:
        "A later writeback must not rewrite an earlier activity snapshot.",
      evidence: [{ type: "test", ref: "post-report-mutation" }],
    });
    await setWritebackDisposition(later.id, "defer", {
      ...project,
      nextTrigger: "A second setup failure",
      expectedOutcome: "Project context remains available",
    });
    const after = await latestActivityFeed({ ...project, scope: "project" });

    expect(report.activity?.snapshot).toBe("embedded");
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("enables, observes, and safely pauses its owned Codex automation", async () => {
    const project = await makeProject();
    const enabled = await enableEvolutionLoop({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });

    expect(enabled.config.enabled).toBe(true);
    expect(enabled.config.scope).toBe("project");
    expect(enabled.config.autoApply.mode).toBe("plan-only");
    expect(
      JSON.parse(
        await readFile(
          facultAiEvolutionLoopConfigPath(project.homeDir, project.rootDir),
          "utf8"
        )
      ).enabled
    ).toBe(true);

    const beforeRun = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(beforeRun.health).toBe("degraded");
    expect(beforeRun.scheduler.registered).toBe(true);
    expect(beforeRun.scheduler.status).toBe("ACTIVE");
    expect(beforeRun.schedulerObservation.state).toBe("never_observed");

    await enableEvolutionLoop({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      rrule: "RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=19;BYMINUTE=0",
      now: () => new Date("2026-01-03T00:30:00.000Z"),
    });
    expect(
      await readFile(join(enabled.automationPath, "automation.toml"), "utf8")
    ).toContain("RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=19;BYMINUTE=0");

    await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      trigger: "manual",
      now: () => new Date("2026-01-03T00:45:00.000Z"),
    });
    const afterManualRun = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-03T00:45:00.000Z"),
    });
    expect(afterManualRun.schedulerObservation.state).toBe("never_observed");

    await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      trigger: "scheduled",
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    const afterRun = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-06T00:00:00.000Z"),
    });
    expect(afterRun.health).toBe("ready");
    expect(afterRun.schedulerObservation.state).toBe("healthy");
    expect(afterRun.schedulerObservation.staleAfterHours).toBe(336);
    expect(afterRun.config?.sourceIds).toEqual([]);

    const disabled = await disableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    expect(disabled.changed).toBe(true);
    expect(disabled.config?.enabled).toBe(false);
    const status = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    expect(status.health).toBe("disabled");
    expect(status.scheduler.status).toBe("PAUSED");
  });

  it("preserves configured source selection when cadence alone is updated", async () => {
    const project = await makeProject();
    const initial = await enableEvolutionLoop({
      ...project,
      sourceIds: ["review-notes"],
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const updated = await enableEvolutionLoop({
      ...project,
      rrule: "RRULE:FREQ=WEEKLY;BYDAY=FR",
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    const status = await evolutionLoopStatus(project);
    expect(status.config?.sourceIds).toEqual(["review-notes"]);
    expect(updated.config.actionLocator).toEqual(initial.config.actionLocator);
  });

  it("rotates locator identity when configured sources change", async () => {
    const project = await makeProject();
    const initial = await enableEvolutionLoop({
      ...project,
      sourceIds: ["review-notes"],
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const updated = await enableEvolutionLoop({
      ...project,
      sourceIds: ["verification-notes"],
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });

    expect(updated.config.sourceIds).toEqual(["verification-notes"]);
    expect(updated.config.actionLocator?.runtimeId).not.toBe(
      initial.config.actionLocator?.runtimeId
    );
    expect(updated.config.actionLocator?.rootIdentity).toBe(
      initial.config.actionLocator?.rootIdentity
    );
  });

  it("requires a scheduled run from the current config generation", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      trigger: "scheduled",
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    expect(
      (
        await evolutionLoopStatus({
          ...project,
          now: () => new Date("2026-01-03T02:00:00.000Z"),
        })
      ).health
    ).toBe("ready");

    const updated = await enableEvolutionLoop({
      ...project,
      sourceIds: ["review-notes"],
      now: () => new Date("2026-01-03T03:00:00.000Z"),
    });
    const staleConfigStatus = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-03T04:00:00.000Z"),
    });
    expect(updated.config.generation).toBe(2);
    expect(staleConfigStatus.schedulerObservation.state).toBe("healthy");
    expect(staleConfigStatus.health).toBe("degraded");
    expect(
      staleConfigStatus.state.lastSuccessfulScheduledConfigGeneration
    ).toBe(1);

    await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      trigger: "scheduled",
      now: () => new Date("2026-01-03T05:00:00.000Z"),
    });
    const refreshed = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-03T06:00:00.000Z"),
    });
    expect(refreshed.health).toBe("ready");
    expect(refreshed.state.lastSuccessfulScheduledConfigGeneration).toBe(2);
  });

  it("rejects unsupported or out-of-range scheduler recurrence rules", async () => {
    const project = await makeProject();
    await expect(
      enableEvolutionLoop({ ...project, rrule: "RRULE:FREQ=HOURLY" })
    ).rejects.toThrow("FREQ must be DAILY or WEEKLY");
    await expect(
      enableEvolutionLoop({
        ...project,
        rrule: "RRULE:FREQ=DAILY;BYHOUR=25",
      })
    ).rejects.toThrow("BYHOUR must be between 0 and 23");
    await expect(
      enableEvolutionLoop({
        ...project,
        rrule: "RRULE:FREQ=WEEKLY;BYDAY=XX",
      })
    ).rejects.toThrow("BYDAY must contain weekday abbreviations");
  });

  it("renders a global scheduler with the global loop scope", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "fclt-loop-global-"));
    temporaryRoots.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    await mkdir(rootDir, { recursive: true });
    const enabled = await enableEvolutionLoop({ homeDir, rootDir });
    const automation = await readFile(
      join(enabled.automationPath, "automation.toml"),
      "utf8"
    );
    expect(automation).toContain("fclt ai loop run --global --root");
    expect(automation).toContain("--scheduled --json");
    expect(automation).not.toContain(
      "fclt ai loop run --project --scheduled --json"
    );
  });

  it("preserves explicit global scope for a custom canonical root", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "fclt-loop-custom-global-"));
    temporaryRoots.push(homeDir);
    const rootDir = join(homeDir, "shared $() `tick` 'quote", ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "global-review-a",
            type: "markdown",
            root: "home",
            paths: ["global-review.md"],
          },
          {
            id: "global-review-b",
            type: "markdown",
            root: "home",
            paths: ["global-review.md"],
          },
        ],
      })}\n`
    );
    await Bun.write(
      join(homeDir, "global-review.md"),
      "## 2026-01-02 Missing global capability\n\nCreate @ai/instructions/GLOBAL_REVIEW.md for durable review verification.\n"
    );
    const enabled = await enableEvolutionLoop({
      homeDir,
      rootDir,
      scope: "global",
    });
    expect(enabled.config.scope).toBe("global");
    expect(enabled.config.automationName).toBe("fclt-evolution-global");
    const automation = await readFile(
      join(enabled.automationPath, "automation.toml"),
      "utf8"
    );
    const parsedAutomation = Bun.TOML.parse(automation) as { prompt: string };
    const shellQuotedRoot = `'${rootDir.replaceAll("'", `'"'"'`)}'`;
    expect(parsedAutomation.prompt).toContain(
      `fclt ai loop run --global --root ${shellQuotedRoot} --scheduled --json`
    );
    expect(automation).not.toContain("fclt ai loop run --project");
    const report = await runEvolutionLoop({
      homeDir,
      rootDir,
      scope: "global",
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    expect(report.scope).toBe("global");
    expect(report.projectRoot).toBeUndefined();
    expect(report.artifactPath).toContain("/evolution/global/");
    const records = await withFacultRootScope(
      { rootDir, scope: "global" },
      async () => ({
        proposals: await listProposals({ homeDir, rootDir }),
        writebacks: await listWritebacks({ homeDir, rootDir }),
      })
    );
    expect(records.writebacks[0]).toMatchObject({
      scope: "global",
      suggestedDestination: "@ai/instructions/GLOBAL_REVIEW.md",
    });
    expect("projectRoot" in records.writebacks[0]!).toBe(false);
    expect(records.proposals[0]).toMatchObject({
      scope: "global",
      policyClass: "high-risk",
      reviewRequired: true,
      targets: ["@ai/instructions/GLOBAL_REVIEW.md"],
    });
    expect("projectRoot" in records.proposals[0]!).toBe(false);
  });

  it("keeps the full queue while suppressing unchanged incremental carry-forward", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const first = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const family = first.queue.find((item) => item.kind === "signal");
    expect(family?.familyId).toMatch(SIGNAL_FAMILY_ID_RE);

    const second = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    expect(second.queue.some((item) => item.id === family?.id)).toBe(true);
    expect(second.delta.notifiable).toHaveLength(0);
    expect(second.delta.unchangedSuppressed).toBeGreaterThan(0);
    expect(
      JSON.parse(
        await readFile(
          facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir),
          "utf8"
        )
      ).queue[family!.id].state
    ).not.toBe("resolved");
  });

  it("resolves disappeared signals only with terminal source evidence", async () => {
    const project = await makeProject();
    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })}\n`
    );
    const queuePath = facultAiWritebackQueuePath(
      project.homeDir,
      project.rootDir
    );
    await mkdir(dirname(queuePath), { recursive: true });
    const source = {
      id: "WB-00001",
      ts: "2026-01-02T00:00:00.000Z",
      scope: "project",
      projectRoot: project.projectRoot,
      kind: "capability_gap",
      summary: "A review capability is missing.",
      evidence: [{ type: "session", ref: "terminal-signal" }],
      confidence: "high",
      source: "facult:manual",
      suggestedDestination: "@project/instructions/REVIEW.md",
      tags: [],
      status: "recorded",
      issueLinks: ["TICKET-1"],
      disposition: "task",
      dispositionTarget: "TICKET-1",
    };
    await Bun.write(queuePath, `${JSON.stringify(source)}\n`);
    await enableEvolutionLoop({ ...project });

    const discovered = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const signal = discovered.queue.find((item) => item.kind === "signal");
    expect(signal?.state).toBe("open");

    const absentWithoutProof = await runEvolutionLoop({
      ...project,
      until: "2026-01-03T12:00:00.000Z",
      now: () => new Date("2026-01-03T12:00:00.000Z"),
    });
    expect(
      absentWithoutProof.queue.find((item) => item.id === signal?.id)?.state
    ).toBe("open");
    expect(absentWithoutProof.delta.notifiable).toHaveLength(0);

    await Bun.write(
      queuePath,
      `${JSON.stringify(source)}\n${JSON.stringify({
        ...source,
        updatedAt: "2026-01-04T00:00:00.000Z",
        status: "resolved",
      })}\n`
    );
    const resolved = await runEvolutionLoop({
      ...project,
      until: "2026-01-05",
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });
    expect(resolved.queue.find((item) => item.id === signal?.id)?.state).toBe(
      "resolved"
    );
    expect(resolved.delta.resolved).toContain(signal!.id);
    expect(resolved.delta.notifiable).toContain(signal!.id);

    const quiet = await runEvolutionLoop({
      ...project,
      until: "2026-01-06",
      now: () => new Date("2026-01-06T00:00:00.000Z"),
    });
    expect(quiet.queue.find((item) => item.id === signal?.id)?.state).toBe(
      "resolved"
    );
    expect(quiet.delta.notifiable).toHaveLength(0);
  });

  it("alerts once for a stale cursor while keeping complete coverage", async () => {
    const project = await makeProject();
    for (const argv of [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
    ]) {
      await runProjectGit({ projectRoot: project.projectRoot, argv });
    }
    await mkdir(join(project.projectRoot, "docs"), { recursive: true });
    await Bun.write(
      join(project.projectRoot, "docs", "review.md"),
      "Capability review cursor baseline.\n"
    );
    await runProjectGit({
      projectRoot: project.projectRoot,
      argv: ["add", "docs"],
    });
    await runProjectGit({
      projectRoot: project.projectRoot,
      argv: ["commit", "--quiet", "-m", "docs: cursor baseline"],
      date: "2026-07-23T18:12:45-04:00",
    });
    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "git",
            type: "git",
            paths: ["docs"],
            defaultBranch: "main",
            freshnessThresholdHours: 168,
          },
        ],
      })}\n`
    );
    await enableEvolutionLoop({ ...project });
    await runEvolutionLoop({
      ...project,
      since: "2026-07-23T00:00:00-04:00",
      until: "2026-07-23T18:15:00-04:00",
      now: () => new Date("2026-07-23T18:15:00-04:00"),
    });

    await Bun.write(join(project.projectRoot, "outside.txt"), "new activity\n");
    await runProjectGit({
      projectRoot: project.projectRoot,
      argv: ["add", "outside.txt"],
    });
    await runProjectGit({
      projectRoot: project.projectRoot,
      argv: ["commit", "--quiet", "-m", "fix: newer activity"],
      date: "2026-07-23T18:28:50-04:00",
    });
    const stale = await runEvolutionLoop({
      ...project,
      until: "2026-07-27T23:04:10Z",
      now: () => new Date("2026-07-27T23:04:10Z"),
    });
    const freshnessItem = stale.queue.find(
      (item) => item.id === "freshness:git"
    );
    expect(stale.coverageComplete).toBe(true);
    expect(stale.status).toBe("complete");
    expect(stale.freshness.state).toBe("stale");
    expect(freshnessItem).toMatchObject({
      kind: "coverage",
      state: "blocked",
      sourceIds: ["git"],
    });
    expect(stale.delta.notifiable).toContain("freshness:git");

    const quiet = await runEvolutionLoop({
      ...project,
      until: "2026-07-28T00:04:10Z",
      now: () => new Date("2026-07-28T00:04:10Z"),
    });
    expect(quiet.coverageComplete).toBe(true);
    expect(quiet.freshness.state).toBe("stale");
    expect(quiet.delta.notifiable).not.toContain("freshness:git");
    expect(quiet.delta.unchangedSuppressed).toBeGreaterThan(0);
    const artifact = await readFile(quiet.artifactPath, "utf8");
    expect(artifact).toContain("Freshness: stale");
    expect(artifact).toContain("newer_repository_activity");
  });

  it("does not report an existing signal-family writeback as a new mutation", async () => {
    const project = await makeProject();
    await mkdir(join(project.rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(project.rootDir, "instructions", "REVIEW.md"),
      "# Review\n"
    );
    await Bun.write(
      join(project.projectRoot, "review.md"),
      "## 2026-01-02 Capability review\n\nThe rule in @project/instructions/REVIEW.md needs a durable verification loop.\n"
    );
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const first = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(
      first.mutations.some(
        (entry) => entry.type === "record-writeback" && entry.applied
      )
    ).toBe(true);
    expect(
      first.mutations.some(
        (entry) => entry.type === "create-proposal" && entry.applied
      )
    ).toBe(true);
    expect(
      first.mutations.some(
        (entry) => entry.type === "draft-proposal" && entry.applied
      )
    ).toBe(true);

    const second = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    expect(second.mutations.some((entry) => entry.applied)).toBe(false);
  });

  it("creates a review proposal for a missing canonical target without applying it", async () => {
    const project = await makeProject();
    await Bun.write(
      join(project.projectRoot, "review.md"),
      "## 2026-01-02 Missing capability\n\nCreate @project/instructions/NEW_REVIEW.md so capability reviews have a durable verification loop.\n"
    );
    await enableEvolutionLoop({ ...project });
    const report = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    const proposals = await listProposals(project);
    expect(report.status).toBe("complete");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe("create_instruction");
    expect(proposals[0]?.status).toBe("drafted");
    expect(proposals[0]?.targets).toEqual([
      "@project/instructions/NEW_REVIEW.md",
    ]);
    expect(
      await Bun.file(
        join(project.rootDir, "instructions", "NEW_REVIEW.md")
      ).exists()
    ).toBe(false);
  });

  it("does not advance successful coverage or report ready after a degraded run", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "review-notes",
            type: "markdown",
            root: "project",
            paths: ["review.md"],
          },
          {
            id: "missing-notes",
            type: "markdown",
            root: "project",
            paths: ["missing.md"],
          },
        ],
      })}\n`
    );
    const degraded = await runEvolutionLoop({
      ...project,
      until: "2026-01-04",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    expect(degraded.status).toBe("degraded");
    const state = JSON.parse(
      await readFile(
        facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir),
        "utf8"
      )
    );
    expect(state.lastSuccessfulCoverageUntil).toBe("2026-01-03T23:59:59.999Z");
    expect(state.lastCoverageComplete).toBe(false);
    const status = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    expect(status.health).toBe("degraded");
  });

  it("does not combine a degraded scheduled run with later manual coverage", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({ ...project });
    const firstScheduled = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-02",
      trigger: "scheduled",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(firstScheduled.status).toBe("complete");
    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "missing-notes",
            type: "markdown",
            root: "project",
            paths: ["missing.md"],
          },
        ],
      })}\n`
    );
    const degraded = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      trigger: "scheduled",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    expect(degraded.status).toBe("degraded");

    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "review-notes",
            type: "markdown",
            root: "project",
            paths: ["review.md"],
          },
        ],
      })}\n`
    );
    const manual = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-04",
      trigger: "manual",
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });
    expect(manual.status).toBe("complete");
    const status = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });
    expect(status.schedulerObservation.state).toBe("healthy");
    expect(status.schedulerObservation.lastObservedRunAt).toBe(
      "2026-01-04T00:00:00.000Z"
    );
    expect(status.schedulerObservation.lastSuccessfulRunAt).toBe(
      "2026-01-03T00:00:00.000Z"
    );
    expect(status.health).toBe("degraded");
  });

  it("previews without changing state, audit history, or lock files", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const first = await runEvolutionLoop({
      ...project,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-03T00:00:00.000Z",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    await Bun.write(
      join(project.projectRoot, "review.md"),
      [
        "## 2026-01-02 Capability review",
        "",
        "The capability review needs a durable verification loop.",
        "",
        "## Newly observed setup friction",
        "",
        "The setup instructions need a reusable recovery step.",
        "",
      ].join("\n")
    );
    const changedAt = new Date("2026-01-03T00:30:00.000Z");
    await utimes(join(project.projectRoot, "review.md"), changedAt, changedAt);
    const statePath = facultAiEvolutionLoopStatePath(
      project.homeDir,
      project.rootDir
    );
    const auditPath = facultAiEvolutionLoopAuditPath(
      project.homeDir,
      project.rootDir
    );
    const reconciliationStatePath = facultAiReconciliationStatePath(
      project.homeDir,
      project.rootDir
    );
    const stateBefore = await readFile(statePath, "utf8");
    const auditBefore = await readFile(auditPath, "utf8");
    const reconciliationStateBefore = await readFile(
      reconciliationStatePath,
      "utf8"
    );
    const reconciliationEntriesBefore = (
      await readdir(dirname(reconciliationStatePath), { recursive: true })
    ).sort();

    const preview = await runEvolutionLoop({
      ...project,
      dryRun: true,
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });

    expect(preview.status).toBe("preview");
    expect(preview.reviewId).not.toBe(first.reviewId);
    expect(preview.attempts).toEqual([{ attempt: 1, ok: true }]);
    expect(preview.coverage[0]).toMatchObject({
      sourceId: "review-notes",
      state: "changed",
      recordsScanned: 1,
      watermarkAfter: changedAt.toISOString(),
    });
    expect(preview.coverage[0]?.signalsDiscovered).toBeGreaterThan(0);
    expect(preview.generationAfter).toBe(preview.generationBefore);
    expect(
      preview.activity?.items.every((item) => item.actionLocator === undefined)
    ).toBe(true);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    expect(await readFile(auditPath, "utf8")).toBe(auditBefore);
    expect(await readFile(reconciliationStatePath, "utf8")).toBe(
      reconciliationStateBefore
    );
    expect(
      (
        await readdir(dirname(reconciliationStatePath), { recursive: true })
      ).sort()
    ).toEqual(reconciliationEntriesBefore);
    expect(await Bun.file(`${reconciliationStatePath}.lock`).exists()).toBe(
      false
    );
    expect(await Bun.file(`${statePath}.lock`).exists()).toBe(false);
    expect(await Bun.file(preview.artifactPath).exists()).toBe(false);
  });

  it("previews current signal families before the first persisted review", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({ ...project });
    const preview = await runEvolutionLoop({
      ...project,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-03T00:00:00.000Z",
      dryRun: true,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(preview.queue.some((item) => item.id.includes("undefined"))).toBe(
      false
    );
    expect(
      preview.queue.find((item) => item.kind === "signal")?.familyId
    ).toMatch(SIGNAL_FAMILY_ID_RE);
    expect(
      await Bun.file(
        facultAiReconciliationStatePath(project.homeDir, project.rootDir)
      ).exists()
    ).toBe(false);
  });

  it("refuses to update a scheduler after its ownership marker is removed", async () => {
    const project = await makeProject();
    const enabled = await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const automationPath = join(enabled.automationPath, "automation.toml");
    const current = await readFile(automationPath, "utf8");
    await Bun.write(
      automationPath,
      current.replace('managed_by = "fclt-evolution-loop"\n', "")
    );

    await expect(
      enableEvolutionLoop({
        ...project,
        rrule: "RRULE:FREQ=WEEKLY;BYDAY=FR",
      })
    ).rejects.toThrow("not owned by the fclt evolution loop");
    expect(await readFile(automationPath, "utf8")).not.toContain(
      "RRULE:FREQ=WEEKLY"
    );
    const disabled = await disableEvolutionLoop(project);
    expect(disabled.config?.enabled).toBe(false);
    expect(disabled.scheduler?.paused).toBe(false);
    expect(disabled.scheduler?.error).toContain("not owned");
    expect((await evolutionLoopStatus(project)).health).toBe("disabled");
  });

  it("refuses to replace a partial scheduler directory", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "fclt-loop-partial-"));
    temporaryRoots.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const automationDir = join(
      homeDir,
      ".codex",
      "automations",
      "fclt-evolution-global"
    );
    const memoryPath = join(automationDir, "memory.md");
    await mkdir(rootDir, { recursive: true });
    await mkdir(automationDir, { recursive: true });
    await Bun.write(memoryPath, "stale unowned memory\n");

    await expect(
      enableEvolutionLoop({ homeDir, rootDir, scope: "global" })
    ).rejects.toThrow("automation directory is incomplete");
    expect(
      await Bun.file(join(automationDir, "automation.toml")).exists()
    ).toBe(false);
    expect(await readFile(memoryPath, "utf8")).toBe("stale unowned memory\n");
  });

  it("does not trust a scheduler reached through a symlinked directory", async () => {
    const project = await makeProject();
    const enabled = await enableEvolutionLoop({ ...project });
    await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      trigger: "scheduled",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    const outside = join(project.homeDir, "outside-loop-automation");
    await rename(enabled.automationPath, outside);
    await symlink(outside, enabled.automationPath);

    const status = await evolutionLoopStatus({
      ...project,
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    expect(status.scheduler.registered).toBe(false);
    expect(status.scheduler.error).toContain(
      "unsafe Codex automation directory"
    );
    expect(status.health).toBe("degraded");
  });

  it("reports malformed scheduler configuration as degraded health", async () => {
    const project = await makeProject();
    const enabled = await enableEvolutionLoop({ ...project });
    await Bun.write(
      join(enabled.automationPath, "automation.toml"),
      'managed_by = "fclt-evolution-loop"\nstatus = [\n'
    );

    const status = await evolutionLoopStatus(project);
    expect(status.scheduler).toMatchObject({
      exists: true,
      registered: false,
    });
    expect(status.scheduler.error).toContain(
      "Unable to inspect Codex automation"
    );
    expect(status.health).toBe("degraded");
  });

  it("transitions applied proposals from due to overdue without marking success", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const proposalDir = facultAiProposalDir(project.homeDir, project.rootDir);
    await mkdir(proposalDir, { recursive: true });
    const proposal: AiProposalRecord = {
      id: "EV-00001",
      ts: "2026-01-01T00:00:00.000Z",
      status: "applied",
      scope: "project",
      projectRoot: project.projectRoot,
      projectSlug: "repo",
      kind: "create_instruction",
      targets: ["@project/instructions/REVIEW.md"],
      sourceWritebacks: [],
      summary: "Add a project review instruction",
      rationale: "Repeated review gaps need a local instruction.",
      confidence: "high",
      reviewRequired: false,
      policyClass: "low-risk",
      draftRefs: [],
      applyResult: {
        status: "applied",
        appliedAt: "2026-01-01T00:00:00.000Z",
        appliedBy: "test",
        changedFiles: [join(project.rootDir, "instructions", "REVIEW.md")],
        draftRefs: [],
      },
      verification: {
        scheduledAt: "2026-01-01T00:00:00.000Z",
        opensAt: "2026-01-01T00:00:00.000Z",
        dueAt: "2026-01-02T00:00:00.000Z",
        overdueAt: "2026-01-03T00:00:00.000Z",
        delayHours: 24,
        graceHours: 24,
        status: "pending",
        baseline: [],
        criteria: ["Review failures stop recurring"],
        attempts: [],
      },
    };
    await Bun.write(
      join(proposalDir, `${proposal.id}.json`),
      `${JSON.stringify(proposal, null, 2)}\n`
    );

    const due = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-02T12:00:00.000Z"),
    });
    expect(
      due.queue.find((item) => item.proposalId === proposal.id)?.state
    ).toBe("verification_due");

    const overdue = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-04",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    const item = overdue.queue.find(
      (candidate) => candidate.proposalId === proposal.id
    );
    expect(item?.state).toBe("verification_overdue");
    expect(item?.verification?.state).toBe("overdue");
    expect(item?.approvalRequired).toBe(false);
    expect(overdue.delta.notifiable).toContain(`proposal:${proposal.id}`);
  });

  it("treats legacy applied proposals without schedules as unverified work", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({ ...project });
    const proposalDir = facultAiProposalDir(project.homeDir, project.rootDir);
    await mkdir(proposalDir, { recursive: true });
    const legacy: AiProposalRecord = {
      id: "EV-LEGACY",
      ts: "2025-01-01T00:00:00.000Z",
      status: "applied",
      scope: "project",
      projectRoot: project.projectRoot,
      projectSlug: "repo",
      kind: "create_instruction",
      targets: ["@project/instructions/LEGACY.md"],
      sourceWritebacks: [],
      summary: "Legacy applied proposal",
      rationale: "Published before verification scheduling.",
      confidence: "medium",
      reviewRequired: false,
      policyClass: "low-risk",
      draftRefs: [],
      applyResult: {
        status: "applied",
        appliedAt: "2025-01-01T00:00:00.000Z",
        appliedBy: "legacy",
        changedFiles: [],
        draftRefs: [],
      },
    };
    await Bun.write(
      join(proposalDir, `${legacy.id}.json`),
      `${JSON.stringify(legacy, null, 2)}\n`
    );
    const report = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const item = report.queue.find((entry) => entry.proposalId === legacy.id);
    expect(item?.state).toBe("verification_pending");
    expect(item?.verification?.state).toBe("unscheduled");
    expect(item?.approvalRequired).toBe(false);
  });

  it("records retry failure state and audit history without hiding the error", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      sourceIds: ["missing-source"],
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });

    const failed = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toHaveLength(3);
    expect(await Bun.file(failed.artifactPath).exists()).toBe(true);
    const state = JSON.parse(
      await readFile(
        facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir),
        "utf8"
      )
    );
    expect(state.lastFailure.attempts).toBe(3);
    const audit = await readFile(
      facultAiEvolutionLoopAuditPath(project.homeDir, project.rootDir),
      "utf8"
    );
    expect(audit).toContain('"status":"failed"');
    expect(audit).toContain('"attempt":3');
  });

  it("keeps proposal action locators in failed-run activity snapshots", async () => {
    const project = await makeProject();
    await mkdir(join(project.rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(project.rootDir, "instructions", "REVIEW.md"),
      "# Review\n"
    );
    await Bun.write(
      join(project.projectRoot, "review.md"),
      "## 2026-01-02 Capability review\n\nThe rule in @project/instructions/REVIEW.md needs a durable verification loop.\n"
    );
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const complete = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const proposalId = complete.queue.find(
      (item) => item.kind === "proposal"
    )?.proposalId;
    expect(proposalId).toBeDefined();

    await enableEvolutionLoop({
      ...project,
      sourceIds: ["missing-source"],
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    const failed = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T01:00:00.000Z"),
    });
    const proposalActivity = failed.activity?.items.find(
      (item) =>
        item.kind === "proposal" && item.technical.proposalId === proposalId
    );
    expect(failed.status).toBe("failed");
    expect(proposalActivity?.actionLocator).toBeDefined();
    expect(
      await resolveActivityActionLocator({
        homeDir: project.homeDir,
        locator: proposalActivity!.actionLocator!,
      })
    ).toMatchObject({
      status: "resolved",
      target: { resource: { kind: "proposal", id: proposalId } },
    });
  });

  it("preserves a failed run when activity history is malformed", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      sourceIds: ["missing-source"],
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const manifestPath = facultAiActivityHistoryManifestPath(
      project.homeDir,
      project.rootDir
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await Bun.write(manifestPath, "{malformed\n");

    const failed = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });

    expect(failed.status).toBe("failed");
    expect(failed.attempts).toHaveLength(3);
    expect(failed.attempts[0]?.error).toContain("missing-source");
    const history = await queryActivityHistory({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      scope: "project",
    });
    expect(history.coverage.scopes[0]).toMatchObject({
      state: "degraded",
      detail: "history-manifest-invalid",
    });
  });

  it("records committed mutations when a later materialization step fails", async () => {
    const project = await makeProject();
    await mkdir(join(project.rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(project.rootDir, "instructions", "REVIEW.md"),
      "# Review\n"
    );
    await Bun.write(
      join(project.projectRoot, "review.md"),
      "## 2026-01-02 Capability review\n\nThe rule in @project/instructions/REVIEW.md needs a durable verification loop.\n"
    );
    await enableEvolutionLoop({ ...project });
    const failed = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
      onMutationCommitted: (mutation) => {
        if (mutation.type === "record-writeback") {
          throw new Error("injected post-commit failure");
        }
      },
    });
    expect(failed.status).toBe("failed");
    expect(failed.reviewId).toBeDefined();
    expect(failed.coverage).toHaveLength(1);
    expect(failed.mutations).toEqual([
      expect.objectContaining({
        type: "record-writeback",
        applied: true,
      }),
    ]);
    expect(await listWritebacks(project)).toHaveLength(1);
    const artifact = await readFile(failed.artifactPath, "utf8");
    expect(artifact).toContain("| record-writeback |");
    const audit = await readFile(
      facultAiEvolutionLoopAuditPath(project.homeDir, project.rootDir),
      "utf8"
    );
    expect(audit).toContain('"type":"record-writeback"');
  });

  it("preserves committed queue state when the success audit append fails", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({ ...project });
    const failed = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
      onBeforeAuditCommit: () => {
        throw new Error("injected audit failure");
      },
    });
    expect(failed.status).toBe("failed");
    expect(failed.generationAfter).toBe(1);
    expect(failed.queue.length).toBeGreaterThan(0);
    expect(failed.attempts.at(-1)?.error).toContain("post-commit audit");
    const state = JSON.parse(
      await readFile(
        facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir),
        "utf8"
      )
    );
    expect(state.generation).toBe(1);
    expect(Object.keys(state.queue)).toHaveLength(failed.queue.length);
    expect(state.lastRunStatus).toBe("failed");
    expect(state.lastFailure.message).toBe("injected audit failure");
    const history = await queryActivityHistory({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      scope: "project",
    });
    expect(history.runs).toEqual([
      expect.objectContaining({
        id: failed.runId,
        status: "failed",
      }),
    ]);
    expect(history.events).toContainEqual(
      expect.objectContaining({
        runId: failed.runId,
        action: "run-recorded",
      })
    );
  });

  it("records a terminal failed audit when committed history persistence fails", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({ ...project });
    const manifestPath = facultAiActivityHistoryManifestPath(
      project.homeDir,
      project.rootDir
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await Bun.write(manifestPath, "{malformed\n");

    const failed = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });

    expect(failed.status).toBe("failed");
    expect(failed.attempts.at(-1)?.error).toContain("post-commit history");
    const audit = (
      await readFile(
        facultAiEvolutionLoopAuditPath(project.homeDir, project.rootDir),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.runId === failed.runId);
    expect(audit.at(-1)).toMatchObject({
      runId: failed.runId,
      status: "failed",
    });
    expect(audit.at(-2)?.status).toMatch(COMPLETED_RUN_STATUS_RE);
    const state = JSON.parse(
      await readFile(
        facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir),
        "utf8"
      )
    );
    expect(state.lastRunStatus).toBe("failed");
    expect(state.lastSuccessfulCoverageUntil).toBeUndefined();
  });

  it("never takes over a live lease and recovers an abandoned lease", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const statePath = facultAiEvolutionLoopStatePath(
      project.homeDir,
      project.rootDir
    );
    const lockPath = `${statePath}.lock`;
    await Bun.write(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: "2026-01-03T00:00:00.000Z" })}\n`
    );
    await expect(
      runEvolutionLoop({
        ...project,
        now: () => new Date("2026-01-03T00:01:00.000Z"),
      })
    ).rejects.toThrow("Another evolution loop run holds");

    await Bun.write(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" })}\n`
    );
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);
    await expect(
      runEvolutionLoop({
        ...project,
        since: "2026-01-01",
        until: "2026-01-03",
        now: () => new Date("2026-01-03T00:00:00.000Z"),
      })
    ).rejects.toThrow("A live evolution loop owner still holds");

    await Bun.write(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        processStartedAt: "original-process",
      })}\n`
    );
    await utimes(lockPath, old, old);
    const recovered = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
      resolveProcessStartIdentity: () => "reused-pid-process",
    });
    expect(recovered.status).toBe("complete");
    expect(await Bun.file(lockPath).exists()).toBe(false);
    expect(
      (await readdir(dirname(lockPath))).some((name) =>
        name.startsWith(
          `${basename(lockPath)}.stale-${new Date("2026-01-03T00:00:00.000Z").getTime()}-`
        )
      )
    ).toBe(true);
  });

  it("serializes two contenders recovering the same stale loop lock", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const lockPath = `${facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir)}.lock`;
    await Bun.write(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, startedAt: "2026-01-01T00:00:00.000Z" })}\n`
    );
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);

    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => {
      markEntered = resolveEntered;
    });
    let releaseFirst: (() => void) | undefined;
    const holdFirst = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });
    const first = runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
      onLockAcquired: async () => {
        markEntered?.();
        await holdFirst;
      },
    });
    await entered;
    await expect(
      runEvolutionLoop({
        ...project,
        since: "2026-01-01",
        until: "2026-01-03",
        now: () => new Date("2026-01-03T00:00:00.000Z"),
      })
    ).rejects.toThrow("Another evolution loop run holds");
    releaseFirst?.();
    expect((await first).status).toBe("complete");
  });

  it("creates locator runtime identity only after acquiring the loop lock", async () => {
    const project = await makeProject();
    const writeback = await addWriteback({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      kind: "missing_context",
      summary: "A scoped review instruction needs a durable target.",
      suggestedDestination: "@project/instructions/REVIEW.md",
      evidence: [{ type: "test", ref: "locator-lock-order" }],
    });
    const [proposal] = await proposeEvolution({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      writebackIds: [writeback.id],
    });
    await draftProposal(proposal!.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
    });
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const configPath = facultAiEvolutionLoopConfigPath(
      project.homeDir,
      project.rootDir
    );
    const configured = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const { actionLocator: _removed, ...legacyConfig } = configured;
    await Bun.write(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);

    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => {
      markEntered = resolveEntered;
    });
    let releaseFirst: (() => void) | undefined;
    const holdFirst = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });
    const first = runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
      onLockAcquired: async () => {
        markEntered?.();
        await holdFirst;
      },
    });
    await entered;
    await expect(
      runEvolutionLoop({
        ...project,
        since: "2026-01-01",
        until: "2026-01-03",
        now: () => new Date("2026-01-03T00:00:00.000Z"),
      })
    ).rejects.toThrow("Another evolution loop run holds");
    expect(
      (
        JSON.parse(await readFile(configPath, "utf8")) as Record<
          string,
          unknown
        >
      ).actionLocator
    ).toBeUndefined();

    releaseFirst?.();
    const report = await first;
    const locator = report.activity?.items.find(
      (item) => item.actionLocator
    )?.actionLocator;
    expect(locator).toBeDefined();
    expect(
      await resolveActivityActionLocator({
        homeDir: project.homeDir,
        locator: locator!,
      })
    ).toMatchObject({ status: "resolved" });
  });

  it("reports an exact manual recovery boundary for an orphaned takeover claim", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const lockPath = `${facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir)}.lock`;
    const takeoverPath = `${lockPath}.takeover`;
    const staleOwner = `${JSON.stringify({
      pid: 2_147_483_647,
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    await Bun.write(lockPath, staleOwner);
    await Bun.write(
      takeoverPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "orphaned-takeover",
        startedAt: "2026-01-01T00:00:00.000Z",
        processStartedAt: "missing-process",
      })}\n`
    );
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);
    await utimes(takeoverPath, old, old);

    await expect(
      runEvolutionLoop({
        ...project,
        now: () => new Date("2026-01-03T00:00:00.000Z"),
      })
    ).rejects.toThrow(`remove exactly ${takeoverPath} and retry`);
    expect(await readFile(lockPath, "utf8")).toBe(staleOwner);
  });

  it("does not reinterpret a non-file lock-path error as stale recovery", async () => {
    const project = await makeProject();
    await enableEvolutionLoop({ ...project });
    const lockPath = `${facultAiEvolutionLoopStatePath(project.homeDir, project.rootDir)}.lock`;

    await expect(
      runEvolutionLoop({
        ...project,
        openLockFile: () =>
          Promise.reject(
            Object.assign(new Error("injected lock permission failure"), {
              code: "EACCES",
            })
          ),
      })
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(await Bun.file(lockPath).exists()).toBe(false);
    expect(await Bun.file(`${lockPath}.takeover`).exists()).toBe(false);
  });

  it("keeps one signal family when later evidence expands the correlation set", async () => {
    const project = await makeProject();
    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "work-export",
            type: "evidence-export",
            path: "evidence.json",
          },
        ],
      })}\n`
    );
    const evidencePath = join(project.projectRoot, "evidence.json");
    const writeEvidence = async (events: unknown[], until: string) => {
      await Bun.write(
        evidencePath,
        `${JSON.stringify({
          version: 1,
          producer: "fixture",
          generatedAt: "2026-01-06T00:00:00.000Z",
          coverage: {
            since: "2026-01-01T00:00:00.000Z",
            until,
            complete: true,
          },
          events,
        })}\n`
      );
    };
    const firstEvent = {
      id: "opened",
      kind: "work-item",
      observedAt: "2026-01-02T00:00:00.000Z",
      title: "Capability review task opened",
      refs: ["EXAMPLE-1"],
      terminal: false,
    };
    await writeEvidence([firstEvent], "2026-01-03T23:59:59.999Z");
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    const first = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    const familyId = first.queue.find(
      (item) => item.kind === "signal"
    )?.familyId;
    expect(familyId).toMatch(SIGNAL_FAMILY_ID_RE);

    await writeEvidence(
      [
        firstEvent,
        {
          id: "commented",
          kind: "comment",
          observedAt: "2026-01-04T00:00:00.000Z",
          title: "Capability review implementation updated",
          body: "Resolved with outcome proof.",
          refs: ["EXAMPLE-1"],
          terminal: true,
        },
      ],
      "2026-01-05T23:59:59.999Z"
    );
    const second = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-05",
      now: () => new Date("2026-01-06T00:00:00.000Z"),
    });
    const signalItems = second.queue.filter((item) => item.kind === "signal");
    expect(
      signalItems.filter((item) => item.familyId === familyId)
    ).toHaveLength(1);
    expect(signalItems.find((item) => item.familyId === familyId)?.state).toBe(
      "resolved"
    );
  });

  it("merges two prior families when a later signal bridges their subjects", async () => {
    const project = await makeProject();
    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "work-export",
            type: "evidence-export",
            path: "evidence.json",
          },
        ],
      })}\n`
    );
    const evidencePath = join(project.projectRoot, "evidence.json");
    const writeWindow = async (args: {
      since: string;
      until: string;
      generatedAt: string;
      events: unknown[];
    }) => {
      await Bun.write(
        evidencePath,
        `${JSON.stringify({
          version: 1,
          producer: "bridge-fixture",
          generatedAt: args.generatedAt,
          coverage: {
            since: args.since,
            until: args.until,
            complete: true,
          },
          events: args.events,
        })}\n`
      );
    };
    const event = (id: string, observedAt: string, refs: string[]) => ({
      id,
      kind: "work-item",
      observedAt,
      title: "Capability review implementation",
      refs,
      terminal: false,
    });
    await enableEvolutionLoop({ ...project });

    await writeWindow({
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T23:59:59.999Z",
      generatedAt: "2026-01-03T00:00:00.000Z",
      events: [event("subject-a", "2026-01-02T00:00:00.000Z", ["EXAMPLE-1"])],
    });
    const first = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-02",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const familyA = first.queue.find(
      (item) => item.kind === "signal"
    )?.familyId;

    await writeWindow({
      since: "2026-01-03T00:00:00.000Z",
      until: "2026-01-04T23:59:59.999Z",
      generatedAt: "2026-01-05T00:00:00.000Z",
      events: [event("subject-b", "2026-01-04T00:00:00.000Z", ["EXAMPLE-2"])],
    });
    const second = await runEvolutionLoop({
      ...project,
      since: "2026-01-03",
      until: "2026-01-04",
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });
    const familyB = second.queue.find(
      (item) => item.kind === "signal" && item.familyId !== familyA
    )?.familyId;
    expect(familyA).toMatch(SIGNAL_FAMILY_ID_RE);
    expect(familyB).toMatch(SIGNAL_FAMILY_ID_RE);
    const aliasWriteback = await addWriteback({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      kind: "missing_context",
      summary: "Bridge family needs durable review guidance.",
      suggestedDestination: "@project/instructions/BRIDGE_REVIEW.md",
      evidence: [{ type: "reconciliation", ref: `signal-family:${familyB}` }],
    });
    const [aliasProposal] = await proposeEvolution({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      writebackIds: [aliasWriteback.id],
    });
    await draftProposal(aliasProposal!.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
    });

    await writeWindow({
      since: "2026-01-05T00:00:00.000Z",
      until: "2026-01-06T23:59:59.999Z",
      generatedAt: "2026-01-07T00:00:00.000Z",
      events: [
        event("bridge", "2026-01-06T00:00:00.000Z", ["EXAMPLE-1", "EXAMPLE-2"]),
      ],
    });
    const third = await runEvolutionLoop({
      ...project,
      since: "2026-01-05",
      until: "2026-01-06",
      now: () => new Date("2026-01-07T00:00:00.000Z"),
    });
    const canonicalSignal = third.queue.find(
      (item) => item.kind === "signal" && item.familyId === familyA
    );
    expect(canonicalSignal?.state).toBe("resolved");
    expect(canonicalSignal?.proposalId).toBe(aliasProposal!.id);
    expect(canonicalSignal?.familyAliases).toContain(familyB!);
    expect(
      third.queue.find((item) => item.familyId === familyB)?.linkedWork
    ).toContain(`merged:family:${familyA}`);

    await writeWindow({
      since: "2026-01-07T00:00:00.000Z",
      until: "2026-01-08T23:59:59.999Z",
      generatedAt: "2026-01-09T00:00:00.000Z",
      events: [event("post-merge", "2026-01-08T00:00:00.000Z", ["EXAMPLE-1"])],
    });
    const fourth = await runEvolutionLoop({
      ...project,
      since: "2026-01-07",
      until: "2026-01-08",
      now: () => new Date("2026-01-09T00:00:00.000Z"),
    });
    const postMergeSignal = fourth.queue.find(
      (item) => item.kind === "signal" && item.familyId === familyA
    );
    expect(postMergeSignal?.state).toBe("resolved");
    expect(postMergeSignal?.proposalId).toBe(aliasProposal!.id);
    expect(postMergeSignal?.familyAliases).toContain(familyB!);
    expect(await listWritebacks(project)).toHaveLength(1);

    const reconciliationState = JSON.parse(
      await readFile(
        facultAiReconciliationStatePath(project.homeDir, project.rootDir),
        "utf8"
      )
    );
    expect(Object.keys(reconciliationState.families)).toEqual([familyA!]);
  });

  it("escapes source details in readable Markdown review artifacts", async () => {
    const project = await makeProject();
    await Bun.write(
      join(project.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "external-export",
            type: "evidence-export",
            path: "evidence.json",
          },
        ],
      })}\n`
    );
    await Bun.write(
      join(project.projectRoot, "evidence.json"),
      `${JSON.stringify({
        version: 1,
        producer: "escaping-fixture",
        generatedAt: "2026-01-04T00:00:00.000Z",
        coverage: {
          since: "2026-01-01T00:00:00.000Z",
          until: "2026-01-03T23:59:59.999Z",
          complete: false,
          partialReasons: ["upstream | unavailable\nretry later"],
        },
        events: [],
      })}\n`
    );
    await enableEvolutionLoop({ ...project });
    const report = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    const artifact = await readFile(report.artifactPath, "utf8");
    expect(report.status).toBe("degraded");
    expect(artifact).toContain("upstream \\| unavailable retry later");
    expect(artifact).not.toContain("upstream | unavailable");
  });

  it("appends verification attempts and moves regression lineage to completed only after improvement", async () => {
    const project = await makeProject();
    const proposalDir = facultAiProposalDir(project.homeDir, project.rootDir);
    await mkdir(proposalDir, { recursive: true });
    const proposal: AiProposalRecord = {
      id: "EV-00002",
      ts: "2026-01-01T00:00:00.000Z",
      status: "applied",
      scope: "project",
      projectRoot: project.projectRoot,
      projectSlug: "repo",
      kind: "create_instruction",
      targets: ["@project/instructions/REVIEW.md"],
      sourceWritebacks: [],
      summary: "Add review guidance",
      rationale: "Repeated evidence supports it.",
      confidence: "high",
      reviewRequired: false,
      policyClass: "low-risk",
      draftRefs: [],
      verification: {
        scheduledAt: "2026-01-01T00:00:00.000Z",
        opensAt: "2026-01-01T00:00:00.000Z",
        dueAt: "2026-01-02T00:00:00.000Z",
        overdueAt: "2026-01-03T00:00:00.000Z",
        delayHours: 24,
        graceHours: 24,
        status: "pending",
        baseline: ["Review failures recur"],
        criteria: ["Review failures stop recurring"],
        attempts: [],
      },
    };
    await Bun.write(
      join(proposalDir, `${proposal.id}.json`),
      `${JSON.stringify(proposal, null, 2)}\n`
    );

    const regressed = await verifyProposalEffectiveness(proposal.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      effectiveness: "regressed",
      evidence: [{ type: "test", ref: "regression" }],
    });
    expect(regressed.verification?.status).toBe("reopened");
    expect(regressed.effectivenessHistory).toHaveLength(1);
    expect(regressed.verification?.attempts).toHaveLength(1);
    const duplicate = await verifyProposalEffectiveness(proposal.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      effectiveness: "regressed",
      evidence: [{ type: "test", ref: "regression" }],
    });
    expect(duplicate.effectivenessHistory).toHaveLength(1);
    expect(duplicate.verification?.attempts).toHaveLength(1);

    const improved = await verifyProposalEffectiveness(proposal.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      effectiveness: "improved",
      evidence: [{ type: "test", ref: "post-fix" }],
    });
    expect(improved.verification?.status).toBe("completed");
    expect(improved.effectivenessHistory).toHaveLength(2);
    expect(improved.verification?.attempts).toHaveLength(2);
    expect(
      (
        await showProposal(proposal.id, {
          homeDir: project.homeDir,
          rootDir: project.rootDir,
        })
      )?.effectiveness?.effectiveness
    ).toBe("improved");
  });

  it("shares one proposal across same-target families and preserves external-work provenance", async () => {
    const project = await makeProject();
    await mkdir(join(project.rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(project.rootDir, "instructions", "REVIEW.md"),
      "# Review\n"
    );
    await Bun.write(
      join(project.projectRoot, "review.md"),
      [
        "## 2026-01-02 First verification gap",
        "",
        "Update @project/instructions/REVIEW.md for EXAMPLE-101 and EXAMPLE-102 with stronger capability verification.",
        "",
        "## 2026-01-03 Second review gap",
        "",
        "Update @project/instructions/REVIEW.md for EXAMPLE-201 and EXAMPLE-202 with a different review safeguard.",
        "",
      ].join("\n")
    );
    await enableEvolutionLoop({ ...project });
    const first = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    const proposals = await listProposals(project);
    const writebacks = (await listWritebacks(project)).filter(
      (entry) => entry.source === "fclt:evolution-loop"
    );
    expect(writebacks).toHaveLength(2);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.sourceWritebacks).toHaveLength(2);
    expect(proposals[0]?.status).toBe("drafted");
    expect(
      first.queue.filter(
        (item) => item.kind === "signal" && item.state !== "resolved"
      )
    ).toHaveLength(0);
    expect(
      writebacks.flatMap((entry) => entry.issueLinks ?? []).sort()
    ).toEqual(["EXAMPLE-101", "EXAMPLE-102", "EXAMPLE-201", "EXAMPLE-202"]);

    await acceptProposal(proposals[0]!.id, project);
    await applyProposal(proposals[0]!.id, {
      ...project,
      verificationDelayHours: 1,
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    await verifyProposalEffectiveness(proposals[0]!.id, {
      ...project,
      effectiveness: "regressed",
      evidence: [{ type: "test", ref: "same-target-regression" }],
      now: () => new Date("2026-01-04T02:00:00.000Z"),
    });
    const regressed = await runEvolutionLoop({
      ...project,
      until: "2026-01-05",
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });
    const proposalItem = regressed.queue.find(
      (item) => item.kind === "proposal" && item.proposalId === proposals[0]!.id
    );
    expect(proposalItem?.state).toBe("regressed");
    expect(proposalItem?.requestedExternalAction).toBe("reopen");
    expect(proposalItem?.linkedWork).toEqual([
      "EXAMPLE-101",
      "EXAMPLE-102",
      "EXAMPLE-201",
      "EXAMPLE-202",
    ]);

    await rejectProposal(proposals[0]!.id, {
      ...project,
      reason: "Closed after operator review.",
    });
    const closed = await runEvolutionLoop({
      ...project,
      until: "2026-01-06",
      now: () => new Date("2026-01-06T00:00:00.000Z"),
    });
    const closedItem = closed.queue.find(
      (item) => item.kind === "proposal" && item.proposalId === proposals[0]!.id
    );
    expect(closedItem?.state).toBe("resolved");
    expect(closedItem?.requestedExternalAction).toBeUndefined();
  });

  it("rejects an obsolete duplicate proposal without applying its target edit", async () => {
    const project = await makeProject();
    const targetPath = join(project.rootDir, "instructions", "REVIEW.md");
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(
      targetPath,
      "# Review\n\nThe requested bounded review rule already exists.\n"
    );
    const writeback = await addWriteback({
      ...project,
      kind: "bad_default",
      summary: "Add the bounded review rule that already exists.",
      suggestedDestination: "@project/instructions/REVIEW.md",
      evidence: [{ type: "test", ref: "duplicate-existing-rule" }],
    });
    const [proposal] = await proposeEvolution({
      ...project,
      writebackIds: [writeback.id],
    });
    await draftProposal(proposal!.id, project);
    const targetBefore = await readFile(targetPath, "utf8");

    const rejected = await rejectProposal(proposal!.id, {
      ...project,
      reason:
        "Rejected as duplicate/obsolete after exact proposal and target readback.",
    });
    await enableEvolutionLoop({ ...project });
    const report = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });

    expect(rejected.status).toBe("rejected");
    expect(await readFile(targetPath, "utf8")).toBe(targetBefore);
    expect(
      report.queue.find((item) => item.proposalId === proposal!.id)
    ).toMatchObject({
      state: "resolved",
      approvalRequired: false,
    });
    expect(report.mutations.every((mutation) => !mutation.applied)).toBe(true);
  });

  it("covers signal, proposal, explicit apply, regression reopen, and verified improvement end to end", async () => {
    const project = await makeProject();
    const writeback = await addWriteback({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      kind: "missing_context",
      summary: "A project review instruction is missing.",
      suggestedDestination: "@project/instructions/GOLDEN_REVIEW.md",
      evidence: [{ type: "session", ref: "golden-signal" }],
    });
    await linkWritebackIssue(writeback.id, "EXAMPLE-42", {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
    });
    const [proposal] = await proposeEvolution({
      homeDir: project.homeDir,
      rootDir: project.rootDir,
    });
    expect(proposal?.kind).toBe("create_instruction");
    await draftProposal(proposal!.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
    });
    await enableEvolutionLoop({
      ...project,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });

    const proposed = await runEvolutionLoop({
      ...project,
      since: "2026-01-01",
      until: "2026-01-03",
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(
      proposed.queue.find((item) => item.proposalId === proposal!.id)?.state
    ).toBe("open");

    await applyProposal(proposal!.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      verificationDelayHours: 24,
      verificationGraceHours: 24,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const due = await runEvolutionLoop({
      ...project,
      until: "2026-01-04T12:00:00.000Z",
      now: () => new Date("2026-01-04T12:00:00.000Z"),
    });
    expect(
      due.queue.find((item) => item.proposalId === proposal!.id)?.state
    ).toBe("verification_due");

    await verifyProposalEffectiveness(proposal!.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      effectiveness: "regressed",
      evidence: [{ type: "test", ref: "golden-regression" }],
    });
    const regressed = await runEvolutionLoop({
      ...project,
      until: "2026-01-05T00:00:00.000Z",
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });
    const regressedItem = regressed.queue.find(
      (item) => item.proposalId === proposal!.id
    );
    expect(regressedItem?.state).toBe("regressed");
    expect(regressedItem?.requestedExternalAction).toBe("reopen");
    expect(regressedItem?.linkedWork).toContain("EXAMPLE-42");

    await verifyProposalEffectiveness(proposal!.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      effectiveness: "improved",
      evidence: [{ type: "test", ref: "golden-improvement" }],
    });
    const improved = await runEvolutionLoop({
      ...project,
      until: "2026-01-06T00:00:00.000Z",
      now: () => new Date("2026-01-06T00:00:00.000Z"),
    });
    expect(
      improved.queue.find((item) => item.proposalId === proposal!.id)?.state
    ).toBe("resolved");
    const artifact = await readFile(improved.artifactPath, "utf8");
    expect(artifact).toContain(`| proposal:${proposal!.id} |`);
    expect(artifact).toContain("| resolved |");

    await verifyProposalEffectiveness(proposal!.id, {
      homeDir: project.homeDir,
      rootDir: project.rootDir,
      effectiveness: "regressed",
      evidence: [{ type: "test", ref: "golden-regression" }],
    });
    const renewedRegression = await runEvolutionLoop({
      ...project,
      until: "2026-01-07T00:00:00.000Z",
      now: () => new Date("2026-01-07T00:00:00.000Z"),
    });
    const renewedRegressionItem = renewedRegression.queue.find(
      (item) => item.proposalId === proposal!.id
    );
    expect(renewedRegressionItem?.state).toBe("regressed");
    expect(renewedRegressionItem?.requestedExternalAction).toBe("reopen");
  });
});
