import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ActivityFeed,
  buildActivityFeed,
  latestActivitySet,
} from "./activity";
import {
  decideActivityAction,
  renderActivityActionResolution,
  renderActivityDecisionResult,
  resolveActivityActionLocator,
} from "./activity-action";
import { activityActionRootIdentity } from "./activity-action-contract";
import type { AiProposalRecord } from "./ai";
import { aiCommand } from "./ai";
import type { EvolutionLoopReport, LoopQueueItem } from "./evolution-loop";
import {
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopDecisionJournalPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionLoopStatePath,
  facultAiProposalDir,
  facultLocalStateRoot,
  machineStateProjectKey,
  preferredGlobalAiRoot,
} from "./paths";

const STAMP = "2026-07-15T12:00:00.000Z";

function proposal(overrides?: Partial<AiProposalRecord>): AiProposalRecord {
  return {
    id: "EV-00001",
    ts: STAMP,
    status: "drafted",
    scope: "project",
    kind: "update_asset",
    targets: ["@project/instructions/SETUP.md"],
    sourceWritebacks: [],
    summary: "Improve scoped setup guidance",
    rationale: "Repeated evidence supports one narrow change.",
    confidence: "high",
    reviewRequired: true,
    policyClass: "project_review",
    draftRefs: [],
    review: { history: [] },
    ...overrides,
  };
}

function queueItem(overrides?: Partial<LoopQueueItem>): LoopQueueItem {
  return {
    id: "proposal:EV-00001",
    kind: "proposal",
    title: "Improve scoped setup guidance",
    state: "approval_needed",
    revision: 3,
    firstSeenAt: STAMP,
    lastSeenAt: STAMP,
    lastChangedAt: STAMP,
    proposalStatus: "drafted",
    proposalId: "EV-00001",
    linkedWork: [],
    approvalRequired: true,
    sourceIds: [],
    evidenceRefs: [],
    ...overrides,
  };
}

function signalQueueItem(overrides?: Partial<LoopQueueItem>): LoopQueueItem {
  return queueItem({
    id: "family:SF-approved",
    kind: "signal",
    title: "Preserve a bounded implementation handoff",
    state: "open",
    proposalStatus: undefined,
    proposalId: undefined,
    familyId: "SF-approved",
    linkedWork: ["WORK-123"],
    approvalRequired: true,
    sourceIds: ["evidence"],
    evidenceRefs: ["commit:abc123"],
    ...overrides,
  });
}

function report(args: {
  scope: "global" | "project";
  projectRoot?: string;
  item?: LoopQueueItem;
  runId: string;
}): EvolutionLoopReport {
  const item = args.item ?? queueItem();
  return {
    version: 1,
    runId: args.runId,
    generatedAt: STAMP,
    scope: args.scope,
    projectRoot: args.projectRoot,
    status: "complete",
    trigger: "scheduled",
    generationBefore: 2,
    generationAfter: 3,
    coverage: [],
    coverageComplete: true,
    freshness: {
      state: "current",
      staleSourceIds: [],
      unknownSourceIds: [],
      alertSourceIds: [],
    },
    queue: [item],
    delta: {
      new: [item.id],
      changed: [],
      resolved: [],
      notifiable: [item.id],
      unchangedSuppressed: 0,
    },
    mutations: [],
    attempts: [{ attempt: 1, ok: true }],
    artifactPath: "<machine-local>",
    auditPath: "<machine-local>",
  };
}

async function persistScope(args: {
  homeDir: string;
  scope: "global" | "project";
  proposal?: AiProposalRecord;
  item?: LoopQueueItem;
  projectName?: string;
  runId: string;
}): Promise<{
  locator: string;
  report: EvolutionLoopReport;
  reportPath: string;
  rootDir: string;
}> {
  const projectRoot =
    args.scope === "project"
      ? join(args.homeDir, "workspaces", args.projectName ?? "example-project")
      : undefined;
  const rootDir =
    args.scope === "global"
      ? preferredGlobalAiRoot(args.homeDir)
      : join(projectRoot!, ".ai");
  await mkdir(rootDir, { recursive: true });
  if (args.scope === "project") {
    await Bun.write(join(rootDir, "config.toml"), "version = 1\n");
  }
  const currentReport = report({
    scope: args.scope,
    projectRoot,
    runId: args.runId,
    item: args.item,
  });
  const runtimeId = "00000000-0000-4000-8000-000000000001";
  const rootIdentity = activityActionRootIdentity(rootDir);
  if (!rootIdentity) {
    throw new Error("Expected a verified activity root identity");
  }
  currentReport.activity = buildActivityFeed({
    report: currentReport,
    review: null,
    writebacks: [],
    proposals: args.proposal ? [args.proposal] : [],
    locatorContext: { homeDir: args.homeDir, rootDir, runtimeId },
  });
  const locator = currentReport.activity.items[0]?.actionLocator;
  if (!locator) {
    throw new Error("Expected an activity action locator");
  }
  if (args.proposal) {
    const proposalDir = facultAiProposalDir(args.homeDir, rootDir);
    await mkdir(proposalDir, { recursive: true });
    await Bun.write(
      join(proposalDir, `${args.proposal.id}.json`),
      `${JSON.stringify(args.proposal, null, 2)}\n`
    );
  }
  const reportDir = facultAiEvolutionLoopReportDir(args.homeDir, rootDir);
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${args.runId}.json`);
  await Bun.write(reportPath, `${JSON.stringify(currentReport, null, 2)}\n`);
  await Bun.write(
    facultAiEvolutionLoopConfigPath(args.homeDir, rootDir),
    JSON.stringify({
      version: 1,
      scope: args.scope,
      actionLocator: { version: 1, runtimeId, rootIdentity },
    })
  );
  await Bun.write(
    facultAiEvolutionLoopStatePath(args.homeDir, rootDir),
    JSON.stringify({ version: 1, lastReportPath: reportPath })
  );
  return { locator, report: currentReport, reportPath, rootDir };
}

async function directorySnapshot(
  root: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(pathValue: string, prefix: string): Promise<void> {
    for (const entry of await readdir(pathValue, { withFileTypes: true })) {
      const child = join(pathValue, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(child, key);
      } else if (entry.isFile()) {
        result[key] = await readFile(child, "utf8");
      }
    }
  }
  await visit(root, "");
  return result;
}

function captureConsole(
  operation: () => Promise<void>
): Promise<{ errors: string[]; logs: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  return operation().then(
    () => {
      console.log = originalLog;
      console.error = originalError;
      return { errors, logs };
    },
    (error) => {
      console.log = originalLog;
      console.error = originalError;
      throw error;
    }
  );
}

describe("activity action locators", () => {
  let homeDir = "";
  let originalHome: string | undefined;
  let originalCwd = "";

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fclt-action-locator-"));
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = homeDir;
    process.chdir(homeDir);
    process.exitCode = 0;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    process.exitCode = 0;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("resolves identical internal proposal ids to exact global and project targets", async () => {
    const global = await persistScope({
      homeDir,
      scope: "global",
      proposal: proposal({
        scope: "global",
        targets: ["@ai/instructions/SETUP.md"],
      }),
      runId: "LR-global",
    });
    const project = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal(),
      runId: "LR-project",
    });

    expect(global.locator).not.toBe(project.locator);
    const aggregate = await latestActivitySet({
      homeDir,
      globalRootDir: preferredGlobalAiRoot(homeDir),
    });
    expect(
      aggregate.feeds.flatMap((entry) =>
        entry.feed.items.map((item) => item.actionLocator)
      )
    ).toEqual(expect.arrayContaining([global.locator, project.locator]));
    const globalResolution = await resolveActivityActionLocator({
      homeDir,
      locator: global.locator,
      now: () => new Date(STAMP),
    });
    const projectResolution = await resolveActivityActionLocator({
      homeDir,
      locator: project.locator,
      now: () => new Date(STAMP),
    });
    expect(globalResolution).toMatchObject({
      status: "resolved",
      target: {
        scopeId: "global",
        scope: "global",
        resource: { kind: "proposal", id: "EV-00001" },
        activity: { runId: "LR-global", revision: 3 },
        allowedActionClass: "decide",
      },
      plan: {
        mutation: {
          performed: false,
          separateCommandRequired: true,
          approvalRequired: true,
          staleRevisionCheckRequired: true,
        },
      },
    });
    expect(projectResolution).toMatchObject({
      status: "resolved",
      target: {
        scope: "project",
        resource: { kind: "proposal", id: "EV-00001" },
      },
    });
    expect(JSON.stringify(projectResolution)).not.toContain(project.rootDir);
  });

  it("resolves locators for path-safe legacy proposal ids", async () => {
    const legacyId = "EV-LEGACY";
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal({ id: legacyId }),
      item: queueItem({
        id: `proposal:${legacyId}`,
        proposalId: legacyId,
      }),
      runId: "LR-legacy-id",
    });

    expect(
      await resolveActivityActionLocator({ homeDir, locator: fixture.locator })
    ).toMatchObject({
      status: "resolved",
      target: {
        resource: { kind: "proposal", id: legacyId },
      },
    });
  });

  it("preserves global resolution when project discovery exceeds its cap", async () => {
    const global = await persistScope({
      homeDir,
      scope: "global",
      proposal: proposal({ scope: "global" }),
      runId: "LR-global-cap",
    });
    const project = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal(),
      runId: "LR-project-cap",
    });
    const projectsDir = join(facultLocalStateRoot(homeDir), "projects");
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        mkdir(join(projectsDir, `overflow-${index}`), { recursive: true })
      )
    );

    expect(
      await resolveActivityActionLocator({ homeDir, locator: global.locator })
    ).toMatchObject({
      status: "resolved",
      target: { scopeId: "global", scope: "global" },
    });
    expect(
      await resolveActivityActionLocator({ homeDir, locator: project.locator })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });
  });

  it("is read-only and emits no raw root, argv, endpoint, token, or credential fields", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal(),
      runId: "LR-no-write",
    });
    const before = await directorySnapshot(homeDir);
    const resolution = await resolveActivityActionLocator({
      homeDir,
      locator: fixture.locator,
      now: () => new Date(STAMP),
    });
    const after = await directorySnapshot(homeDir);
    expect(after).toEqual(before);
    const serialized = JSON.stringify(resolution);
    expect(serialized).not.toContain(homeDir);
    for (const rawField of [
      '"argv"',
      '"cwd"',
      '"root"',
      '"rootDir"',
      '"path"',
      '"endpoint"',
      '"token"',
      '"tokenEnv"',
      '"credential"',
    ]) {
      expect(serialized).not.toContain(rawField);
    }
  });

  it("fails closed for stale lifecycle and activity revisions", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal(),
      runId: "LR-stale",
    });
    await Bun.write(
      join(facultAiProposalDir(homeDir, fixture.rootDir), "EV-00001.json"),
      `${JSON.stringify(proposal({ status: "accepted" }), null, 2)}\n`
    );
    expect(
      await resolveActivityActionLocator({ homeDir, locator: fixture.locator })
    ).toMatchObject({
      status: "rejected",
      error: { code: "stale_revision" },
    });

    await Bun.write(
      join(facultAiProposalDir(homeDir, fixture.rootDir), "EV-00001.json"),
      `${JSON.stringify(proposal(), null, 2)}\n`
    );
    const nextReport = {
      ...fixture.report,
      queue: [{ ...fixture.report.queue[0]!, revision: 4 }],
    };
    await Bun.write(
      fixture.reportPath,
      `${JSON.stringify(nextReport, null, 2)}\n`
    );
    expect(
      await resolveActivityActionLocator({ homeDir, locator: fixture.locator })
    ).toMatchObject({
      status: "rejected",
      error: { code: "stale_revision" },
    });

    const nextRun = {
      ...fixture.report,
      runId: "LR-new-run",
      activity: {
        ...fixture.report.activity!,
        run: { ...fixture.report.activity!.run, id: "LR-new-run" },
      },
    };
    await Bun.write(
      fixture.reportPath,
      `${JSON.stringify(nextRun, null, 2)}\n`
    );
    expect(
      await resolveActivityActionLocator({ homeDir, locator: fixture.locator })
    ).toMatchObject({
      status: "rejected",
      error: { code: "stale_revision" },
    });
  });

  it("resolves persisted signal and coverage locators after JSON round trips", async () => {
    for (const kind of ["signal", "coverage"] as const) {
      const item = queueItem({
        id: `${kind}:portable-item`,
        kind,
        title: `Portable ${kind}`,
        state: "open",
        proposalId: undefined,
        proposalStatus: undefined,
        familyId: kind === "signal" ? "portable-family" : undefined,
        approvalRequired: false,
      });
      const fixture = await persistScope({
        homeDir,
        scope: "project",
        projectName: `persisted-${kind}`,
        item,
        runId: `LR-persisted-${kind}`,
      });
      expect(
        await resolveActivityActionLocator({
          homeDir,
          locator: fixture.locator,
        })
      ).toMatchObject({
        status: "resolved",
        target: {
          resource: {
            kind,
            id: kind === "signal" ? "portable-family" : item.id,
          },
          allowedActionClass: "handoff",
        },
      });
    }
  });

  it("atomically records each signal-family decision with a revision-bound receipt", async () => {
    for (const decision of ["accept", "redirect", "reject", "defer"] as const) {
      const fixture = await persistScope({
        homeDir,
        scope: "project",
        projectName: `decision-${decision}`,
        item: signalQueueItem({
          familyId: `SF-${decision}`,
          id: `family:SF-${decision}`,
        }),
        runId: `LR-decision-${decision}`,
      });
      const reportBefore = await readFile(fixture.reportPath, "utf8");
      const canonicalBefore = await directorySnapshot(fixture.rootDir);
      const result = await decideActivityAction({
        homeDir,
        locator: fixture.locator,
        decision,
        expectedRevision: 3,
        actor: "operator-1",
        ...(decision === "defer"
          ? { note: "Approved hold pending a newer signal revision." }
          : { approvalReference: "linear-comment:approval-1" }),
        redirectTarget:
          decision === "redirect" ? "instruction:WORK_UNITS.md" : undefined,
        approve: true,
        now: () => new Date(STAMP),
      });

      expect(result).toMatchObject({
        version: 1,
        kind: "activity-decision-receipt",
        status: "recorded",
        receipt: {
          scope: "project",
          resource: { kind: "signal", id: `SF-${decision}` },
          decision,
          actor: "operator-1",
          approval:
            decision === "defer"
              ? { note: "Approved hold pending a newer signal revision." }
              : { reference: "linear-comment:approval-1" },
          previousLifecycleRevision: 0,
          newLifecycleRevision: 1,
          activity: { runId: `LR-decision-${decision}`, queueRevision: 3 },
          decidedAt: STAMP,
        },
      });
      expect(JSON.stringify(result)).not.toContain(homeDir);
      if (result.status === "recorded") {
        expect(result.receipt.approval).toEqual(
          decision === "defer"
            ? { note: "Approved hold pending a newer signal revision." }
            : { reference: "linear-comment:approval-1" }
        );
        expect(result.receipt.redirectTarget).toBe(
          decision === "redirect" ? "instruction:WORK_UNITS.md" : undefined
        );
      }
      expect(await readFile(fixture.reportPath, "utf8")).toBe(reportBefore);
      expect(await directorySnapshot(fixture.rootDir)).toEqual(canonicalBefore);
      const history = await readFile(
        facultAiEvolutionLoopDecisionJournalPath(homeDir, fixture.rootDir),
        "utf8"
      );
      expect(history.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(history)).toMatchObject(
        result.status === "recorded" ? result.receipt : {}
      );
    }
  });

  it("preserves bounded accepted-signal context for work-unit construction", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      projectName: "accepted-context",
      item: signalQueueItem(),
      runId: "LR-accepted-context",
    });
    const issued = fixture.report.activity?.items[0];
    if (!issued) {
      throw new Error("Expected issued signal activity");
    }
    issued.context = {
      scope: "project",
      targets: [
        {
          kind: "instruction",
          scope: "project",
          selector: "instruction:WORK_UNITS.md",
          label: "Work units",
        },
      ],
      links: [],
    };
    issued.evidence = {
      count: 2,
      types: ["commit", "issue"],
      writebackIds: ["WB-00001"],
    };
    issued.observations = [
      {
        writebackId: "WB-00001",
        category: "opportunity",
        sensitivity: "internal",
        summary: "The implementation is ready for a bounded handoff.",
        contextOmitted: false,
        desiredOutcome: "Dispatch one isolated implementation work unit.",
      },
    ];
    issued.verification = { state: "pending", attempts: 0 };
    issued.nextAction = "Create the bounded implementation work unit.";
    await Bun.write(
      fixture.reportPath,
      `${JSON.stringify(fixture.report, null, 2)}\n`
    );

    const result = await decideActivityAction({
      homeDir,
      locator: fixture.locator,
      decision: "accept",
      expectedRevision: 3,
      actor: "operator-1",
      approvalReference: "linear-comment:approval-1",
      approve: true,
      now: () => new Date(STAMP),
    });

    expect(result).toMatchObject({
      status: "recorded",
      workUnit: {
        targets: [{ selector: "instruction:WORK_UNITS.md" }],
        evidence: {
          count: 2,
          types: ["commit", "issue"],
          writebackIds: ["WB-00001"],
        },
        linkedWork: ["WORK-123"],
        expectedOutcome: "Dispatch one isolated implementation work unit.",
        verification: { state: "pending", attempts: 0 },
        nextAction: "Create the bounded implementation work unit.",
      },
    });
  });

  it("advances lifecycle revisions only for a newer current signal revision", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      projectName: "decision-lifecycle",
      item: signalQueueItem(),
      runId: "LR-decision-lifecycle-1",
    });
    const first = await decideActivityAction({
      homeDir,
      locator: fixture.locator,
      decision: "defer",
      expectedRevision: 3,
      actor: "operator-1",
      note: "Hold until the source produces a changed signal.",
      approve: true,
      now: () => new Date(STAMP),
    });
    expect(first).toMatchObject({
      status: "recorded",
      receipt: { previousLifecycleRevision: 0, newLifecycleRevision: 1 },
    });

    const nextReport: EvolutionLoopReport = {
      ...fixture.report,
      runId: "LR-decision-lifecycle-2",
      queue: [{ ...fixture.report.queue[0]!, revision: 4 }],
    };
    nextReport.activity = buildActivityFeed({
      report: nextReport,
      review: null,
      writebacks: [],
      proposals: [],
      locatorContext: {
        homeDir,
        rootDir: fixture.rootDir,
        runtimeId: "00000000-0000-4000-8000-000000000001",
      },
    });
    const nextLocator = nextReport.activity.items[0]?.actionLocator;
    if (!nextLocator) {
      throw new Error("Expected a locator for the newer signal revision");
    }
    await Bun.write(
      fixture.reportPath,
      `${JSON.stringify(nextReport, null, 2)}\n`
    );

    expect(
      await decideActivityAction({
        homeDir,
        locator: nextLocator,
        decision: "accept",
        expectedRevision: 4,
        actor: "operator-2",
        approvalReference: "linear-comment:approval-2",
        approve: true,
        now: () => new Date("2026-07-16T12:00:00.000Z"),
      })
    ).toMatchObject({
      status: "recorded",
      receipt: {
        previousLifecycleRevision: 1,
        newLifecycleRevision: 2,
        activity: { queueRevision: 4 },
      },
    });
  });

  it("rejects stale, replayed, malformed, incompatible, and unsafe decision inputs", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      projectName: "decision-adversarial",
      item: signalQueueItem(),
      runId: "LR-decision-adversarial",
    });
    const base = {
      homeDir,
      locator: fixture.locator,
      decision: "accept" as const,
      expectedRevision: 3,
      actor: "operator-1",
      approvalReference: "linear-comment:approval-1",
      approve: true,
    };

    expect(
      await decideActivityAction({ ...base, expectedRevision: 2 })
    ).toMatchObject({ status: "rejected", error: { code: "stale_revision" } });
    expect(
      await decideActivityAction({ ...base, approve: false })
    ).toMatchObject({
      status: "rejected",
      error: { code: "approval_required" },
    });
    expect(
      await decideActivityAction({
        ...base,
        approvalReference: "token=secret-value",
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "invalid_decision_input" },
    });
    expect(
      await decideActivityAction({ ...base, locator: "not-a-locator" })
    ).toMatchObject({ status: "rejected", error: { code: "invalid_locator" } });
    expect(
      await decideActivityAction({
        ...base,
        locator: fixture.locator.replace("fclt-act-v1", "fclt-act-v2"),
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "incompatible_locator" },
    });
    expect(
      await decideActivityAction({
        ...base,
        decision: "redirect",
        redirectTarget: undefined,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "invalid_decision_input" },
    });

    expect(await decideActivityAction(base)).toMatchObject({
      status: "recorded",
    });
    expect(await decideActivityAction(base)).toMatchObject({
      status: "rejected",
      error: { code: "replayed_decision" },
    });
  });

  it("fails closed for malformed history and concurrent decision attempts", async () => {
    const malformed = await persistScope({
      homeDir,
      scope: "project",
      projectName: "decision-malformed-history",
      item: signalQueueItem(),
      runId: "LR-decision-malformed-history",
    });
    const malformedJournal = facultAiEvolutionLoopDecisionJournalPath(
      homeDir,
      malformed.rootDir
    );
    await mkdir(dirname(malformedJournal), { recursive: true });
    await Bun.write(malformedJournal, "{not-json}\n");
    expect(
      await decideActivityAction({
        homeDir,
        locator: malformed.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-1",
        approvalReference: "linear-comment:approval-1",
        approve: true,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "malformed_history" },
    });

    const sourceScope = await persistScope({
      homeDir,
      scope: "project",
      projectName: "decision-source-scope",
      item: signalQueueItem(),
      runId: "LR-decision-source-scope",
    });
    expect(
      await decideActivityAction({
        homeDir,
        locator: sourceScope.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-1",
        approvalReference: "linear-comment:approval-1",
        approve: true,
      })
    ).toMatchObject({ status: "recorded" });
    const copiedHistory = await readFile(
      facultAiEvolutionLoopDecisionJournalPath(homeDir, sourceScope.rootDir),
      "utf8"
    );
    const targetScope = await persistScope({
      homeDir,
      scope: "project",
      projectName: "decision-target-scope",
      item: signalQueueItem(),
      runId: "LR-decision-target-scope",
    });
    const targetJournal = facultAiEvolutionLoopDecisionJournalPath(
      homeDir,
      targetScope.rootDir
    );
    await mkdir(dirname(targetJournal), { recursive: true });
    await Bun.write(targetJournal, copiedHistory);
    expect(
      await decideActivityAction({
        homeDir,
        locator: targetScope.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-2",
        approvalReference: "linear-comment:approval-2",
        approve: true,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "malformed_history" },
    });

    const concurrent = await persistScope({
      homeDir,
      scope: "project",
      projectName: "decision-concurrent",
      item: signalQueueItem(),
      runId: "LR-decision-concurrent",
    });
    const attempts = await Promise.all([
      decideActivityAction({
        homeDir,
        locator: concurrent.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-1",
        approvalReference: "linear-comment:approval-1",
        approve: true,
      }),
      decideActivityAction({
        homeDir,
        locator: concurrent.locator,
        decision: "reject",
        expectedRevision: 3,
        actor: "operator-2",
        approvalReference: "linear-comment:approval-2",
        approve: true,
      }),
    ]);
    expect(
      attempts.filter((result) => result.status === "recorded")
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    const concurrentHistory = await readFile(
      facultAiEvolutionLoopDecisionJournalPath(homeDir, concurrent.rootDir),
      "utf8"
    );
    expect(concurrentHistory.trim().split("\n")).toHaveLength(1);
  });

  it("rejects non-signal resources and moved-root decision replay", async () => {
    const proposalFixture = await persistScope({
      homeDir,
      scope: "project",
      projectName: "proposal-decision",
      proposal: proposal(),
      runId: "LR-proposal-decision",
    });
    expect(
      await decideActivityAction({
        homeDir,
        locator: proposalFixture.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-1",
        approvalReference: "linear-comment:approval-1",
        approve: true,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "not_signal_family" },
    });

    const duplicate = await persistScope({
      homeDir,
      scope: "project",
      projectName: "duplicate-decision",
      item: signalQueueItem(),
      runId: "LR-duplicate-decision",
    });
    await Bun.write(
      duplicate.reportPath,
      `${JSON.stringify(
        {
          ...duplicate.report,
          queue: [duplicate.report.queue[0], duplicate.report.queue[0]],
        },
        null,
        2
      )}\n`
    );
    expect(
      await decideActivityAction({
        homeDir,
        locator: duplicate.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-1",
        approvalReference: "linear-comment:approval-1",
        approve: true,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "duplicate_identity" },
    });

    const unsafeIdentity = await persistScope({
      homeDir,
      scope: "project",
      projectName: "unsafe-identity-decision",
      item: signalQueueItem({
        familyId: join(homeDir, "private-signal"),
        id: "family:unsafe-identity",
      }),
      runId: "LR-unsafe-identity-decision",
    });
    expect(
      await decideActivityAction({
        homeDir,
        locator: unsafeIdentity.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-1",
        approvalReference: "linear-comment:approval-1",
        approve: true,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "invalid_decision_input" },
    });

    const moved = await persistScope({
      homeDir,
      scope: "project",
      projectName: "moved-decision",
      item: signalQueueItem(),
      runId: "LR-moved-decision",
    });
    await rename(
      join(moved.rootDir, ".."),
      join(homeDir, "workspaces", "moved-decision-renamed")
    );
    expect(
      await decideActivityAction({
        homeDir,
        locator: moved.locator,
        decision: "accept",
        expectedRevision: 3,
        actor: "operator-1",
        approvalReference: "linear-comment:approval-1",
        approve: true,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });
  });

  it("exposes a closed CLI decision command and readable receipt", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      projectName: "decision-cli",
      item: signalQueueItem(),
      runId: "LR-decision-cli",
    });
    const output = await captureConsole(() =>
      aiCommand([
        "loop",
        "decide",
        fixture.locator,
        "--decision",
        "accept",
        "--expected-revision",
        "3",
        "--actor",
        "operator-1",
        "--approval-ref",
        "linear-comment:approval-1",
        "--approve",
        "--json",
      ])
    );
    expect(JSON.parse(output.logs[0] ?? "{}")).toMatchObject({
      status: "recorded",
      receipt: { decision: "accept", newLifecycleRevision: 1 },
    });
    expect(
      renderActivityDecisionResult(
        JSON.parse(output.logs[0] ?? "{}") as Awaited<
          ReturnType<typeof decideActivityAction>
        >
      )
    ).toContain("Recorded accept decision");
    await expect(
      aiCommand([
        "loop",
        "decide",
        fixture.locator,
        "--decision",
        "accept",
        "--expected-revision",
        "3",
        "--actor",
        "operator-1",
        "--approval-ref",
        "linear-comment:approval-1",
        "--approve",
        "--root",
        fixture.rootDir,
      ])
    ).rejects.toThrow(
      "does not accept caller-supplied root or scope authority"
    );
  });

  it("fails closed for moved roots, missing state, and incompatible locators", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal(),
      runId: "LR-missing",
    });
    await rename(
      join(fixture.rootDir, ".."),
      join(homeDir, "workspaces", "renamed-project")
    );
    expect(
      await resolveActivityActionLocator({ homeDir, locator: fixture.locator })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });

    const missingState = await persistScope({
      homeDir,
      scope: "project",
      projectName: "missing-state",
      proposal: proposal(),
      runId: "LR-no-state",
    });
    await rm(facultAiEvolutionLoopStatePath(homeDir, missingState.rootDir));
    expect(
      await resolveActivityActionLocator({
        homeDir,
        locator: missingState.locator,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });

    expect(
      await resolveActivityActionLocator({
        homeDir,
        locator: fixture.locator.replace("fclt-act-v1", "fclt-act-v2"),
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "incompatible_locator" },
    });
    expect(
      await resolveActivityActionLocator({ homeDir, locator: "not-a-locator" })
    ).toMatchObject({
      status: "rejected",
      error: { code: "invalid_locator" },
    });
  });

  it("leaves legacy, custom-global, and missing-proposal items handoff-only", () => {
    const globalReport = report({ scope: "global", runId: "LR-custom" });
    const customGlobal = buildActivityFeed({
      report: globalReport,
      review: null,
      writebacks: [],
      proposals: [proposal({ scope: "global" })],
      locatorContext: {
        homeDir,
        rootDir: join(homeDir, "custom-global-root"),
      },
    });
    const missingProposal = buildActivityFeed({
      report: report({ scope: "project", runId: "LR-missing-proposal" }),
      review: null,
      writebacks: [],
      proposals: [],
      locatorContext: {
        homeDir,
        rootDir: join(homeDir, "workspaces", "missing", ".ai"),
      },
    });
    const legacy = buildActivityFeed({
      report: globalReport,
      review: null,
      writebacks: [],
      proposals: [proposal({ scope: "global" })],
    });
    expect(customGlobal.items[0]?.actionLocator).toBeUndefined();
    expect(missingProposal.items[0]?.actionLocator).toBeUndefined();
    expect(legacy.items[0]?.actionLocator).toBeUndefined();
  });

  it("rejects malformed current proposal state without throwing", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal(),
      runId: "LR-malformed",
    });
    await Bun.write(
      join(facultAiProposalDir(homeDir, fixture.rootDir), "EV-00001.json"),
      "{not-json"
    );
    expect(
      await resolveActivityActionLocator({ homeDir, locator: fixture.locator })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });
  });

  it("rejects incompatible state schema and locators absent from the current snapshot", async () => {
    const incompatible = await persistScope({
      homeDir,
      scope: "project",
      projectName: "incompatible-state",
      proposal: proposal(),
      runId: "LR-incompatible-state",
    });
    await Bun.write(
      facultAiEvolutionLoopStatePath(homeDir, incompatible.rootDir),
      JSON.stringify({
        version: 2,
        lastReportPath: incompatible.reportPath,
      })
    );
    expect(
      await resolveActivityActionLocator({
        homeDir,
        locator: incompatible.locator,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });

    const notIssued = await persistScope({
      homeDir,
      scope: "project",
      projectName: "not-issued",
      proposal: proposal(),
      runId: "LR-not-issued",
    });
    notIssued.report.activity!.items[0]!.actionLocator = undefined;
    await Bun.write(
      notIssued.reportPath,
      `${JSON.stringify(notIssued.report, null, 2)}\n`
    );
    expect(
      await resolveActivityActionLocator({
        homeDir,
        locator: notIssued.locator,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_issued" },
    });
  });

  it("does not trust persisted project or title fields for plan output", async () => {
    const fixture = await persistScope({
      homeDir,
      scope: "project",
      proposal: proposal(),
      runId: "LR-tampered-display",
    });
    const activity = fixture.report.activity!;
    activity.project = {
      key: "unsafe",
      name: `${homeDir}/private-project`,
      rootDir: homeDir,
      token: "secret-value",
    } as ActivityFeed["project"];
    activity.items[0]!.title = `${homeDir}/private-title secret-value`;
    await Bun.write(
      fixture.reportPath,
      `${JSON.stringify(fixture.report, null, 2)}\n`
    );
    const serialized = JSON.stringify(
      await resolveActivityActionLocator({
        homeDir,
        locator: fixture.locator,
      })
    );
    expect(serialized).not.toContain(homeDir);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("rootDir");
  });

  it("rejects same-path replacement and ancestor-symlink replay", async () => {
    const replaced = await persistScope({
      homeDir,
      scope: "project",
      projectName: "replace-me",
      proposal: proposal(),
      runId: "LR-replaced",
    });
    const replacedProject = join(replaced.rootDir, "..");
    await rename(replacedProject, `${replacedProject}-old`);
    await mkdir(replaced.rootDir, { recursive: true });
    expect(
      await resolveActivityActionLocator({
        homeDir,
        locator: replaced.locator,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });

    const linked = await persistScope({
      homeDir,
      scope: "project",
      projectName: "link-me",
      proposal: proposal(),
      runId: "LR-linked",
    });
    const linkedProject = join(linked.rootDir, "..");
    const movedProject = `${linkedProject}-moved`;
    await rename(linkedProject, movedProject);
    await symlink(movedProject, linkedProject, "dir");
    expect(
      await resolveActivityActionLocator({
        homeDir,
        locator: linked.locator,
      })
    ).toMatchObject({
      status: "rejected",
      error: { code: "locator_not_found" },
    });
  });

  it("keeps duplicate worktrees distinct and refuses caller authority or approval fields", async () => {
    const first = await persistScope({
      homeDir,
      scope: "project",
      projectName: "clone-one",
      proposal: proposal(),
      runId: "LR-clone-one",
    });
    const second = await persistScope({
      homeDir,
      scope: "project",
      projectName: "clone-two",
      proposal: proposal(),
      runId: "LR-clone-two",
    });
    expect(machineStateProjectKey(first.rootDir, homeDir)).not.toBe(
      machineStateProjectKey(second.rootDir, homeDir)
    );
    expect(first.locator).not.toBe(second.locator);

    const resolved = await captureConsole(async () => {
      await aiCommand(["loop", "resolve", first.locator, "--json"]);
    });
    expect(resolved.errors).toEqual([]);
    expect(JSON.parse(resolved.logs.join("\n"))).toMatchObject({
      status: "resolved",
      target: { activity: { runId: "LR-clone-one" } },
    });
    expect(
      renderActivityActionResolution(
        await resolveActivityActionLocator({ homeDir, locator: first.locator })
      )
    ).toContain("No mutation was performed");

    await expect(
      aiCommand([
        "loop",
        "resolve",
        first.locator,
        "--root",
        first.rootDir,
        "--json",
      ])
    ).rejects.toThrow(
      "does not accept caller-supplied root or scope authority"
    );
    await expect(
      aiCommand(["loop", "resolve", first.locator, "--approve", "--json"])
    ).rejects.toThrow(
      "loop resolve accepts exactly one opaque locator and optional --json"
    );
  });
});
