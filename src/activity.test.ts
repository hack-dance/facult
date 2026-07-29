import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildActivityFeed,
  latestActivitySet,
  redactPortableActivityText,
  renderActivityFeed,
  renderActivitySet,
} from "./activity";
import type { AiWritebackRecord } from "./ai";
import type { EvolutionLoopReport, LoopQueueItem } from "./evolution-loop";
import {
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionLoopStatePath,
  facultLocalStateRoot,
} from "./paths";
import type { ReconciliationReview } from "./reconciliation-types";

function queueItem(overrides?: Partial<LoopQueueItem>): LoopQueueItem {
  return {
    id: "family:SF-stable",
    kind: "signal",
    title: "Setup repeatedly loses project context",
    state: "open",
    revision: 1,
    firstSeenAt: "2026-07-13T00:00:00.000Z",
    lastSeenAt: "2026-07-13T00:00:00.000Z",
    lastChangedAt: "2026-07-13T00:00:00.000Z",
    disposition: "task",
    familyId: "SF-stable",
    linkedWork: ["TASK-1"],
    approvalRequired: false,
    sourceIds: ["git-history", "writebacks"],
    evidenceRefs: ["evidence-1", "evidence-2"],
    ...overrides,
  };
}

function report(overrides?: Partial<EvolutionLoopReport>): EvolutionLoopReport {
  return {
    version: 1,
    runId: "LR-stable",
    generatedAt: "2026-07-13T00:00:00.000Z",
    scope: "project",
    projectRoot: "/Users/example/private/repo",
    status: "complete",
    trigger: "scheduled",
    generationBefore: 1,
    generationAfter: 2,
    reviewId: "RW-stable",
    coverage: [
      {
        sourceId: "git-history",
        sourceType: "git",
        state: "checked",
        checkedAt: "2026-07-13T00:00:00.000Z",
        recordsScanned: 2,
        signalsDiscovered: 1,
        freshness: {
          state: "current",
          reason: "cursor_advanced",
          checkedAt: "2026-07-13T00:00:00.000Z",
          thresholdHours: 168,
          alert: false,
        },
      },
    ],
    coverageComplete: true,
    freshness: {
      state: "current",
      staleSourceIds: [],
      unknownSourceIds: [],
      alertSourceIds: [],
    },
    queue: [queueItem()],
    delta: {
      new: ["family:SF-stable"],
      changed: [],
      resolved: [],
      notifiable: ["family:SF-stable"],
      unchangedSuppressed: 0,
    },
    mutations: [],
    attempts: [{ attempt: 1, ok: true }],
    artifactPath: "/Users/example/.ai/evolution/LR-stable.md",
    auditPath: "/Users/example/Library/Application Support/fclt/audit.jsonl",
    ...overrides,
  };
}

function review(): ReconciliationReview {
  return {
    version: 1,
    reviewId: "RW-stable",
    generatedAt: "2026-07-13T00:00:00.000Z",
    window: {
      id: "RW-stable",
      mode: "incremental",
      since: "2026-07-12T00:00:00.000Z",
      until: "2026-07-13T00:00:00.000Z",
      scope: "project",
      rootDir: "/Users/example/private/repo/.ai",
      projectRoot: "/Users/example/private/repo",
      configDigest: "digest",
    },
    coverageComplete: true,
    degraded: false,
    freshness: report().freshness,
    coverage: report().coverage,
    decisions: [],
    evidence: [],
    signals: [
      {
        id: "SIG-1",
        familyId: "SF-stable",
        subjectKeys: ["setup"],
        title: "Setup repeatedly loses project context",
        evidenceKeys: ["evidence-1", "evidence-2"],
        sourceIds: ["git-history", "writebacks"],
        classifications: ["capability-source"],
        assetRefs: ["@project/instructions/SETUP.md"],
        issueRefs: ["TASK-1"],
        writebackRefs: ["WB-00002", "WB-00001"],
        disposition: "task",
        dispositionTarget: "TASK-1",
        rationale: "Repeated evidence points to one project setup gap.",
        unresolved: true,
      },
    ],
    resolutionProofs: [],
    resolvedSignalFamilies: [],
    resolvedEvidenceKeys: [],
    unresolvedSignals: ["SIG-1"],
    linkedWork: ["TASK-1"],
    dispositionCounts: {
      propose: 0,
      "apply-local": 0,
      task: 1,
      "resolve-watch": 0,
      defer: 0,
    },
    artifactPath: "/Users/example/.ai/evolution/RW-stable.md",
  };
}

function writeback(
  id: string,
  sensitivity: "public" | "internal" | "private"
): AiWritebackRecord {
  return {
    id,
    ts: `2026-07-13T00:00:0${id.endsWith("1") ? "1" : "2"}.000Z`,
    scope: "project",
    kind: id.endsWith("1") ? "tool_friction" : "reusable_pattern",
    summary: id.endsWith("1")
      ? "Setup command lost project context."
      : "A scoped setup check prevented recurrence.",
    capture: {
      category: id.endsWith("1") ? "friction" : "reusable-success",
      details: "Supplemental detail",
      impact: "Agents had to repeat setup",
      desiredOutcome: "Project context remains available",
      sensitivity,
    },
    evidence: [{ type: "test", ref: id }],
    confidence: "high",
    source: "facult:manual",
    tags: [],
    status: "recorded",
  };
}

describe("activity feed", () => {
  it("aggregates Global and configured project reports without exposing project roots", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "fclt-activity-set-"));
    try {
      const globalRootDir = join(homeDir, ".ai");
      const globalReport = report({
        runId: "LR-global",
        scope: "global",
        projectRoot: undefined,
      });
      globalReport.activity = buildActivityFeed({
        report: globalReport,
        review: null,
        writebacks: [],
        proposals: [],
      });
      const globalReportPath = join(
        facultAiEvolutionLoopReportDir(homeDir, globalRootDir),
        "LR-global.json"
      );
      await mkdir(join(globalReportPath, ".."), { recursive: true });
      await Bun.write(globalReportPath, JSON.stringify(globalReport));
      const globalStatePath = facultAiEvolutionLoopStatePath(
        homeDir,
        globalRootDir
      );
      await mkdir(join(globalStatePath, ".."), { recursive: true });
      await Bun.write(
        facultAiEvolutionLoopConfigPath(homeDir, globalRootDir),
        JSON.stringify({ version: 1, scope: "global" })
      );
      await Bun.write(
        globalStatePath,
        JSON.stringify({
          version: 1,
          generation: 1,
          queue: {},
          fingerprints: {},
          lastReportPath: globalReportPath,
        })
      );

      const projectsDir = join(facultLocalStateRoot(homeDir), "projects");
      const reportingLoopDir = join(
        projectsDir,
        "example-one",
        "ai",
        "project",
        "evolution",
        "loop"
      );
      const unavailableLoopDir = join(
        projectsDir,
        "example-two",
        "ai",
        "project",
        "evolution",
        "loop"
      );
      const projectReport = report({ runId: "LR-project" });
      projectReport.activity = buildActivityFeed({
        report: projectReport,
        review: null,
        writebacks: [],
        proposals: [],
      });
      await mkdir(join(reportingLoopDir, "reports"), { recursive: true });
      await mkdir(unavailableLoopDir, { recursive: true });
      await Bun.write(
        join(reportingLoopDir, "config.json"),
        JSON.stringify({ version: 1, scope: "project" })
      );
      await Bun.write(
        join(reportingLoopDir, "reports", "LR-project.json"),
        JSON.stringify(projectReport)
      );
      await Bun.write(
        join(reportingLoopDir, "state.json"),
        JSON.stringify({
          version: 1,
          generation: 1,
          queue: {},
          fingerprints: {},
          lastReportPath: "/private/machine/path/LR-project.json",
        })
      );
      await Bun.write(
        join(unavailableLoopDir, "config.json"),
        JSON.stringify({ version: 1, scope: "project" })
      );

      const set = await latestActivitySet({ homeDir, globalRootDir });

      expect(set).toMatchObject({
        version: 2,
        kind: "activity-set",
        scope: "all",
        coverage: {
          complete: false,
          configuredScopes: 3,
          reportingScopes: 2,
          unavailableScopes: 1,
        },
      });
      expect(set.feeds.map((entry) => entry.feed.scope)).toEqual([
        "global",
        "project",
      ]);
      expect(set.feeds.map((entry) => entry.scopeId)).toEqual(
        set.scopes
          .filter((scope) => scope.state === "reporting")
          .map((scope) => scope.id)
      );
      expect(set.scopes.map((scope) => scope.state)).toEqual([
        "reporting",
        "reporting",
        "unavailable",
      ]);
      expect(JSON.stringify(set)).not.toContain("/Users/example/private");
      expect(JSON.stringify(set)).not.toContain("example-one");
      expect(JSON.stringify(set)).not.toContain("example-two");

      const originalProjectScopeId = set.feeds.find(
        (entry) => entry.feed.run.id === "LR-project"
      )?.scopeId;
      const earlierLoopDir = join(
        projectsDir,
        "aaa-earlier",
        "ai",
        "project",
        "evolution",
        "loop"
      );
      await mkdir(earlierLoopDir, { recursive: true });
      await Bun.write(
        join(earlierLoopDir, "config.json"),
        JSON.stringify({ version: 1, scope: "project" })
      );
      const malformedLoopDir = join(
        projectsDir,
        "malformed-embedded",
        "ai",
        "project",
        "evolution",
        "loop"
      );
      const malformedReport = report({
        runId: "LR-malformed",
        projectRoot: "/Users/example/private/malformed",
      });
      (malformedReport as unknown as { activity: unknown }).activity = {
        version: 1,
        scope: "project",
        title: "/Users/example/private/not-portable",
      };
      await mkdir(join(malformedLoopDir, "reports"), { recursive: true });
      await Bun.write(
        join(malformedLoopDir, "config.json"),
        JSON.stringify({ version: 1, scope: "project" })
      );
      await Bun.write(
        join(malformedLoopDir, "state.json"),
        JSON.stringify({ lastReportPath: "LR-malformed.json" })
      );
      await Bun.write(
        join(malformedLoopDir, "reports", "LR-malformed.json"),
        JSON.stringify(malformedReport)
      );
      const reordered = await latestActivitySet({ homeDir, globalRootDir });
      expect(
        reordered.feeds.find((entry) => entry.feed.run.id === "LR-project")
          ?.scopeId
      ).toBe(originalProjectScopeId);
      expect(
        reordered.feeds.find((entry) => entry.feed.run.id === "LR-malformed")
          ?.feed.snapshot
      ).toBe("legacy-derived");
      expect(JSON.stringify(reordered)).not.toContain("/Users/example/private");

      const projectActivity = projectReport.activity;
      if (!projectActivity) {
        throw new Error("Expected embedded project activity");
      }
      const firstItem = projectActivity.items[0];
      if (!firstItem) {
        throw new Error("Expected project activity item");
      }
      const firstSource = projectActivity.coverage.sources[0];
      if (!firstSource) {
        throw new Error("Expected project activity coverage");
      }
      projectActivity.items = [];
      projectActivity.counts = {
        changed: 0,
        needsAttention: 0,
        new: 0,
        resolved: 0,
        total: 0,
        unchangedSuppressed: 0,
      };
      projectActivity.coverage.checked = 30;
      projectActivity.coverage.sources = Array.from(
        { length: 30 },
        (_, index) => ({
          ...firstSource,
          id: `source-${index}`,
          state: index === 0 ? ("changed" as const) : firstSource.state,
        })
      );
      await Bun.write(
        join(reportingLoopDir, "reports", "LR-project.json"),
        JSON.stringify(projectReport)
      );
      const sourceBounded = await latestActivitySet({ homeDir, globalRootDir });
      const sourceBoundedProjectFeed = sourceBounded.feeds.find(
        (entry) => entry.feed.run.id === "LR-project"
      )?.feed;
      if (!sourceBoundedProjectFeed) {
        throw new Error("Expected the source-bounded project feed");
      }
      expect(sourceBounded.truncation.omittedSources).toBe(5);
      expect(sourceBounded.coverage.checkedSources).toBe(27);
      expect(sourceBoundedProjectFeed.coverage.complete).toBe(false);
      expect(sourceBoundedProjectFeed.coverage.checked).toBe(25);
      expect(sourceBoundedProjectFeed.coverage.sources).toHaveLength(25);
      expect(sourceBoundedProjectFeed.coverage.sources[0]?.state).toBe(
        "changed"
      );
      expect(renderActivityFeed(sourceBoundedProjectFeed)).toContain(
        "Coverage: 25/25 sources checked · incomplete"
      );
      expect(renderActivityFeed(sourceBoundedProjectFeed)).not.toContain(
        "Nothing needs attention; configured coverage was checked."
      );
      projectActivity.items = Array.from({ length: 300 }, (_, index) => ({
        ...firstItem,
        id: `item-${index}`,
        title: `${"Long portable activity ".repeat(100)}${index}`,
        technical: { ...firstItem.technical, queueId: `item-${index}` },
      }));
      projectActivity.counts.total = projectActivity.items.length;
      await Bun.write(
        join(reportingLoopDir, "reports", "LR-project.json"),
        JSON.stringify(projectReport)
      );
      const bounded = await latestActivitySet({ homeDir, globalRootDir });
      expect(bounded.truncation).toMatchObject({
        truncated: true,
        omittedItems: 52,
      });
      const boundedProjectFeed = bounded.feeds.find(
        (entry) => entry.feed.run.id === "LR-project"
      )?.feed;
      if (!boundedProjectFeed) {
        throw new Error("Expected the bounded project feed");
      }
      expect(boundedProjectFeed.coverage.complete).toBe(false);
      expect(renderActivityFeed(boundedProjectFeed)).not.toContain(
        "Nothing needs attention; configured coverage was checked."
      );
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
        1_500_000
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not invent an unavailable Global scope for a project-only setup", async () => {
    const homeDir = await mkdtemp(
      join(tmpdir(), "fclt-project-only-activity-")
    );
    try {
      const globalRootDir = join(homeDir, ".ai");
      const projectLoopDir = join(
        facultLocalStateRoot(homeDir),
        "projects",
        "project-only",
        "ai",
        "project",
        "evolution",
        "loop"
      );
      const projectReport = report({ runId: "LR-project-only" });
      projectReport.activity = buildActivityFeed({
        report: projectReport,
        review: null,
        writebacks: [],
        proposals: [],
      });
      await mkdir(join(projectLoopDir, "reports"), { recursive: true });
      await Bun.write(
        join(projectLoopDir, "config.json"),
        JSON.stringify({ version: 1, scope: "project" })
      );
      await Bun.write(
        join(projectLoopDir, "reports", "LR-project-only.json"),
        JSON.stringify(projectReport)
      );
      await Bun.write(
        join(projectLoopDir, "state.json"),
        JSON.stringify({ lastReportPath: "LR-project-only.json" })
      );

      const set = await latestActivitySet({ homeDir, globalRootDir });

      expect(set.coverage).toMatchObject({
        complete: true,
        configuredScopes: 1,
        reportingScopes: 1,
        unavailableScopes: 0,
      });
      expect(set.scopes).toHaveLength(1);
      expect(set.scopes[0]).toMatchObject({
        scope: "project",
        state: "reporting",
      });
      expect(renderActivitySet(set)).not.toContain(
        "Global activity is unavailable"
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("isolates malformed or unreadable Global activity while project scopes keep reporting", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "fclt-activity-isolation-"));
    try {
      const globalRootDir = join(homeDir, ".ai");
      const globalStatePath = facultAiEvolutionLoopStatePath(
        homeDir,
        globalRootDir
      );
      await mkdir(join(globalStatePath, ".."), { recursive: true });
      await Bun.write(
        facultAiEvolutionLoopConfigPath(homeDir, globalRootDir),
        JSON.stringify({ version: 1, scope: "global" })
      );
      await Bun.write(globalStatePath, "{not-json");

      const projectLoopDir = join(
        facultLocalStateRoot(homeDir),
        "projects",
        "generic-project",
        "ai",
        "project",
        "evolution",
        "loop"
      );
      const projectReport = report({ runId: "LR-project-isolation" });
      projectReport.activity = buildActivityFeed({
        report: projectReport,
        review: null,
        writebacks: [],
        proposals: [],
      });
      await mkdir(join(projectLoopDir, "reports"), { recursive: true });
      await Bun.write(
        join(projectLoopDir, "config.json"),
        JSON.stringify({ version: 1, scope: "project" })
      );
      await Bun.write(
        join(projectLoopDir, "state.json"),
        JSON.stringify({ lastReportPath: "LR-project-isolation.json" })
      );
      await Bun.write(
        join(projectLoopDir, "reports", "LR-project-isolation.json"),
        JSON.stringify(projectReport)
      );

      const unreadable = await latestActivitySet({ homeDir, globalRootDir });
      expect(unreadable.coverage).toMatchObject({
        configuredScopes: 2,
        reportingScopes: 1,
        unavailableScopes: 1,
        complete: false,
      });
      expect(unreadable.scopes.find((scope) => scope.id === "global")).toEqual({
        id: "global",
        scope: "global",
        state: "unavailable",
      });
      expect(unreadable.feeds.map((entry) => entry.feed.run.id)).toEqual([
        "LR-project-isolation",
      ]);

      const externalReportPath = join(homeDir, "outside-loop-reports.json");
      const externalGlobalReport = report({
        runId: "LR-global-external",
        scope: "global",
        projectRoot: undefined,
      });
      externalGlobalReport.activity = buildActivityFeed({
        report: externalGlobalReport,
        review: null,
        writebacks: [],
        proposals: [],
      });
      await Bun.write(externalReportPath, JSON.stringify(externalGlobalReport));
      await Bun.write(
        globalStatePath,
        JSON.stringify({ lastReportPath: externalReportPath })
      );
      const external = await latestActivitySet({ homeDir, globalRootDir });
      expect(external.feeds.map((entry) => entry.feed.run.id)).toEqual([
        "LR-project-isolation",
      ]);

      const malformedGlobalReport = report({
        runId: "LR-global-malformed",
        scope: "global",
        projectRoot: undefined,
      });
      (malformedGlobalReport as unknown as { activity: unknown }).activity = {
        version: 1,
        scope: "global",
      };
      const globalReportPath = join(
        facultAiEvolutionLoopReportDir(homeDir, globalRootDir),
        "LR-global-malformed.json"
      );
      await mkdir(join(globalReportPath, ".."), { recursive: true });
      await Bun.write(globalReportPath, JSON.stringify(malformedGlobalReport));
      await Bun.write(
        globalStatePath,
        JSON.stringify({
          version: 1,
          generation: 1,
          queue: {},
          fingerprints: {},
          lastReportPath: globalReportPath,
        })
      );

      const malformed = await latestActivitySet({ homeDir, globalRootDir });
      expect(malformed.coverage).toMatchObject({
        configuredScopes: 2,
        reportingScopes: 1,
        unavailableScopes: 1,
        complete: false,
      });
      expect(malformed.feeds.map((entry) => entry.feed.run.id)).toEqual([
        "LR-project-isolation",
      ]);

      await Bun.write(
        globalReportPath,
        JSON.stringify({
          ...malformedGlobalReport,
          padding: "x".repeat(2_000_001),
        })
      );
      expect((await Bun.file(globalReportPath).stat()).size).toBeGreaterThan(
        2_000_000
      );
      const oversized = await latestActivitySet({ homeDir, globalRootDir });
      expect(oversized.coverage).toMatchObject({
        configuredScopes: 2,
        reportingScopes: 1,
        unavailableScopes: 1,
        complete: false,
      });
      expect(oversized.feeds.map((entry) => entry.feed.run.id)).toEqual([
        "LR-project-isolation",
      ]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("enforces the aggregate byte budget after items are exhausted", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "fclt-activity-budget-"));
    try {
      const globalRootDir = join(homeDir, ".ai");
      const globalReport = report({
        runId: "LR-global-budget",
        scope: "global",
        projectRoot: undefined,
      });
      const activity = buildActivityFeed({
        report: globalReport,
        review: null,
        writebacks: [],
        proposals: [],
      });
      activity.items = [];
      activity.counts.total = 0;
      activity.coverage.checked = 25;
      activity.coverage.sources = Array.from({ length: 25 }, (_, index) => ({
        id: `source-${index}`,
        label: `Source ${index}`,
        state: "checked" as const,
      }));
      (activity as unknown as Record<string, unknown>).padding = Array.from(
        { length: 1800 },
        (_, index) => `${"x".repeat(900)}${index}`
      );
      globalReport.activity = activity;

      const globalReportPath = join(
        facultAiEvolutionLoopReportDir(homeDir, globalRootDir),
        "LR-global-budget.json"
      );
      await mkdir(join(globalReportPath, ".."), { recursive: true });
      await Bun.write(globalReportPath, JSON.stringify(globalReport));
      const globalStatePath = facultAiEvolutionLoopStatePath(
        homeDir,
        globalRootDir
      );
      await mkdir(join(globalStatePath, ".."), { recursive: true });
      await Bun.write(
        facultAiEvolutionLoopConfigPath(homeDir, globalRootDir),
        JSON.stringify({ version: 1, scope: "global" })
      );
      await Bun.write(
        globalStatePath,
        JSON.stringify({
          version: 1,
          generation: 1,
          queue: {},
          fingerprints: {},
          lastReportPath: globalReportPath,
        })
      );

      const set = await latestActivitySet({ homeDir, globalRootDir });

      expect(Buffer.byteLength(JSON.stringify(set))).toBeLessThanOrEqual(
        1_500_000
      );
      expect(set.coverage).toMatchObject({
        checkedSources: 0,
        configuredScopes: 1,
        degradedSources: 0,
        reportingScopes: 0,
        complete: false,
      });
      expect(set.truncation).toEqual({
        truncated: true,
        omittedScopes: 1,
        omittedItems: 0,
        omittedSources: 25,
        discoveryTruncated: false,
      });
      expect(set.scopes).toEqual([
        { id: "global", scope: "global", state: "omitted" },
      ]);
      expect(set.feeds).toEqual([]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("produces a deterministic portable snapshot with bounded privacy-aware observations", () => {
    const feed = buildActivityFeed({
      report: report(),
      review: review(),
      writebacks: [
        writeback("WB-00002", "private"),
        writeback("WB-00001", "internal"),
      ],
      proposals: [],
    });

    expect(feed).toMatchObject({
      version: 1,
      mode: "latest",
      snapshot: "embedded",
      project: { key: "repo", name: "repo" },
      counts: { new: 1, needsAttention: 1 },
    });
    expect(feed.items[0]?.categories).toEqual(["friction", "reusable-success"]);
    expect(
      feed.items[0]?.observations.map((entry) => entry.writebackId)
    ).toEqual(["WB-00001", "WB-00002"]);
    expect(feed.items[0]?.observations[1]).toMatchObject({
      sensitivity: "private",
      contextOmitted: true,
    });
    expect(feed.items[0]?.observations[1]?.details).toBeUndefined();
    expect(feed.items[0]?.context).toMatchObject({
      scope: "project",
      project: { key: "repo", name: "repo" },
      targets: [
        {
          kind: "instruction",
          scope: "project",
          selector: "@project/instructions/SETUP.md",
          label: "SETUP",
        },
      ],
    });
    expect(JSON.stringify(feed)).not.toContain("/Users/");
    expect(renderActivityFeed(feed)).toContain(
      "Target: instruction · SETUP (@project/instructions/SETUP.md)"
    );
    expect(renderActivityFeed(feed)).toContain(
      "Why: Repeated evidence points to one project setup gap."
    );
  });

  it("shows only portable capability targets and source-owned links", () => {
    const linkedReview = review();
    linkedReview.evidence = [
      {
        dedupeKey: "evidence-1",
        sourceIds: ["tracker-export"],
        sourceRecordIds: ["event-1"],
        observedAt: "2026-07-13T00:00:00.000Z",
        title: "Scoped source event",
        body: "Evidence",
        classification: "capability-source",
        assetRefs: ["skill:capability-evolution"],
        issueRefs: [],
        writebackRefs: ["WB-00001"],
        correlationKeys: ["asset:skill:capability-evolution"],
        disposition: "propose",
        isNew: true,
        provenance: [
          {
            sourceUri:
              "https://example.com/work/123?path=/Users/example/private/repo",
          },
          { sourceUri: "https://example.com/work/123" },
          {
            sourceUri:
              "https://logs.example/%2FUsers%2Fexample%2Fprivate%2Frepo",
          },
          {
            sourceUri:
              "https://logs.example/%252FUsers%252Fexample%252Fprivate%252Frepo",
          },
          {
            sourceUri: "https://logs.example/Users/example/private/repo",
          },
          {
            sourceUri: "https://logs.example/C:/Users/example/private/repo",
          },
          {
            sourceUri:
              "https://logs.example/run//Users/example/private/repo/log.txt",
          },
          {
            sourceUri:
              "https://logs.example/run/C:/Users/example/private/repo/log.txt",
          },
          { sourceUri: "https://logs.example/root/.ssh/id_rsa" },
          { sourceUri: "https://logs.example/session/etc/passwd" },
          { sourceUri: "https://logs.example/session/usr/local/bin/tool" },
          { sourceUri: "https://logs.example/session/opt/tool/config" },
          { sourceUri: "https://logs.example/session/mnt/share/report" },
          { sourceUri: "https://logs.example/Users" },
          { sourceUri: "https://logs.example/etc" },
          {
            sourceUri: "https://logs.example/artifact/path=/workspace/fclt/log",
          },
          {
            sourceUri:
              "https://logs.example/artifact/cwd=C:/workspace/fclt/log",
          },
        ],
      },
      {
        dedupeKey: "evidence-2",
        sourceIds: ["writebacks"],
        sourceRecordIds: ["WB-00002"],
        observedAt: "2026-07-13T00:00:00.000Z",
        title: "Private source event",
        body: "Private evidence",
        classification: "capability-source",
        assetRefs: [],
        issueRefs: [],
        writebackRefs: ["WB-00002"],
        correlationKeys: ["asset:skill:capability-evolution"],
        disposition: "propose",
        isNew: true,
        provenance: [{ sourceUri: "https://example.com/private/source-event" }],
      },
    ];
    linkedReview.signals[0] = {
      ...linkedReview.signals[0]!,
      assetRefs: [
        "skill:capability-evolution",
        "@project/prompts/review.md",
        "@project/instructions/SETUP.md?token=target-secret",
        "@project/%2FUsers%2Fexample%2Fprivate%2Fplan.md",
        "skill:%252FUsers%252Fexample%252Fprivate",
        "/Users/example/private/repo/.ai/skills/private/SKILL.md",
        "TASK-1",
      ],
    };
    const linkedWriteback = writeback("WB-00001", "internal");
    linkedWriteback.evidence = [
      { type: "review", ref: "https://example.com/work/123" },
      { type: "secret", ref: "https://user:pass@example.com/private" },
      { type: "token", ref: "https://example.com/private?token=secret" },
      {
        type: "signed",
        ref: "https://storage.example/object?X-Goog-Signature=credential",
      },
      { type: "local", ref: "file:///Users/example/private/repo/report.md" },
    ];
    const privateWriteback = writeback("WB-00002", "private");
    privateWriteback.evidence = [
      { type: "private", ref: "https://example.com/private/writeback" },
    ];

    const feed = buildActivityFeed({
      report: report(),
      review: linkedReview,
      writebacks: [linkedWriteback, privateWriteback],
      proposals: [],
    });

    expect(feed.items[0]?.context?.targets).toEqual([
      {
        kind: "skill",
        scope: "project",
        selector: "skill:capability-evolution",
        label: "capability evolution",
      },
      {
        kind: "prompt",
        scope: "project",
        selector: "@project/prompts/review.md",
        label: "review",
      },
    ]);
    expect(feed.items[0]?.context?.links).toEqual([
      {
        label: "example.com",
        url: "https://example.com/work/123",
        source: "evidence",
      },
    ]);
    const portable = JSON.stringify(feed);
    expect(portable).not.toContain("/Users/example/private");
    expect(portable).not.toContain("file://");
    expect(portable).not.toContain("user:pass");
    expect(portable).not.toContain("token=secret");
    expect(portable).not.toContain("target-secret");
    expect(portable).not.toContain("%2FUsers");
    expect(portable).not.toContain("%252FUsers");
    expect(portable).not.toContain("X-Goog-Signature");
    expect(portable).not.toContain("private/source-event");
    expect(portable).not.toContain("private/writeback");
    expect(portable).not.toContain("path=/workspace");
    expect(portable).not.toContain("cwd=C:/workspace");
  });

  it("never describes a failed empty run as checked and clear", () => {
    const failed = buildActivityFeed({
      report: report({
        status: "failed",
        coverage: [],
        coverageComplete: false,
        queue: [],
        delta: {
          new: [],
          changed: [],
          resolved: [],
          notifiable: [],
          unchangedSuppressed: 0,
        },
      }),
      review: null,
      writebacks: [],
      proposals: [],
    });

    expect(renderActivityFeed(failed)).toContain(
      "did not prove complete coverage"
    );
    expect(renderActivityFeed(failed)).not.toContain(
      "configured coverage was checked"
    );
  });

  it("scrubs credentials and absolute paths from every portable text source", () => {
    const unixPath = "/Users/example/private/repo";
    const windowsPath = String.raw`C:\Users\example\private\repo`;
    const uncPath = String.raw`\\server\share\private\repo`;
    const basicCredential = ["dXNlcjpw", "YXNz"].join("");
    const awsAccessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "signaturevalue",
    ].join(".");
    const signedUrl =
      "https://storage.example/object?X-Amz-Signature=signed-value&X-Amz-Expires=900";
    const encodedLocalUrl =
      "https://logs.example/%2FUsers%2Fexample%2Fprivate%2Frepo";
    const rawLocalUrl = "https://logs.example/run/Users/example/private/repo";
    const encodedPlainPath = "%252FUsers%252Fexample%252Fprivate%252Frepo";
    const encodedWindowsPath = "C%3A%5CUsers%5Cexample%5Cprivate%5Crepo";
    const bareHomePath = "home/example/.ssh/id_rsa";
    const encodedKeyValuePath = "path=%2Fworkspace%2Ffclt";
    const encodedKeyValueWindowsPath = "cwd=C%3A%5Cworkspace%5Cfclt";
    const doubleEncodedKeyValuePath = "root=%252Fopt%252Fapp";
    const unsafeReview = review();
    unsafeReview.signals[0] = {
      ...unsafeReview.signals[0]!,
      rationale: `Observed at ${unixPath}; Authorization: Basic ${basicCredential}`,
      dispositionTarget: windowsPath,
    };
    const unsafeWriteback = writeback("WB-00001", "internal");
    unsafeWriteback.summary = `Failure at ${unixPath} using ${awsAccessKey}; log ${signedUrl}; source ${encodedLocalUrl}; path ${encodedPlainPath}; kv ${encodedKeyValuePath}`;
    unsafeWriteback.capture = {
      ...unsafeWriteback.capture!,
      details: `Compared ${windowsPath} and ${uncPath}; source ${signedUrl}; raw ${rawLocalUrl}; encoded ${encodedWindowsPath}; cwd ${encodedKeyValueWindowsPath}`,
      impact: "Could not read ~/private/config",
      attemptedWorkaround: "Opened file:///Users/example/private/repo/config",
      desiredOutcome: `No path from ${unixPath}; JWT ${jwt}; home ${bareHomePath}; root ${doubleEncodedKeyValuePath}`,
    };
    const unsafeReport = report({
      coverage: [
        {
          ...report().coverage[0]!,
          sourceId: unixPath,
          state: "unavailable",
          unavailableReason: `Could not read ${windowsPath}; source ${signedUrl}`,
        },
      ],
      coverageComplete: false,
      queue: [
        queueItem({
          title: `Setup failed at ${unixPath}; source ${signedUrl}`,
          sourceIds: [unixPath],
          linkedWork: [uncPath, signedUrl],
        }),
      ],
    });

    const feed = buildActivityFeed({
      report: unsafeReport,
      review: unsafeReview,
      writebacks: [unsafeWriteback],
      proposals: [],
    });
    const portable = JSON.stringify(feed);

    for (const secret of [
      unixPath,
      windowsPath,
      uncPath,
      "~/private/config",
      "file:///Users/example/private/repo/config",
      basicCredential,
      awsAccessKey,
      jwt,
      "X-Amz-Signature",
      "signed-value",
      "%2FUsers%2Fexample",
      "logs.example/run/Users/example",
      encodedPlainPath,
      encodedWindowsPath,
      bareHomePath,
      encodedKeyValuePath,
      encodedKeyValueWindowsPath,
      doubleEncodedKeyValuePath,
    ]) {
      expect(portable).not.toContain(secret);
    }
    expect(portable).toContain("<redacted-path>");
    expect(portable).toContain("<redacted-url>");
    expect(portable).toContain("<redacted>");
    for (const unsafePath of [
      encodedPlainPath,
      encodedWindowsPath,
      bareHomePath,
      encodedKeyValuePath,
      encodedKeyValueWindowsPath,
      doubleEncodedKeyValuePath,
    ]) {
      expect(redactPortableActivityText(`scrub ${unsafePath}`)).toBe(
        "scrub <redacted-path>"
      );
    }
    expect(redactPortableActivityText(`Authorization: Bearer ${jwt}`)).toBe(
      "Authorization: <redacted>"
    );
    expect(redactPortableActivityText("Authorization: Bearer abc~def")).toBe(
      "Authorization: <redacted>"
    );
    const partialPrivateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "c2Vuc2l0aXZlLWtleS1tYXRlcmlhbA==",
    ].join("\n");
    expect(
      redactPortableActivityText(`Captured key: ${partialPrivateKey}`)
    ).toBe("Captured key: <redacted-private-key>");
    const encryptedPrivateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-256-CBC,0123456789ABCDEF",
      "",
      "c2Vuc2l0aXZlLWVuY3J5cHRlZC1rZXktbWF0ZXJpYWw=",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(
      redactPortableActivityText(`Captured key: ${encryptedPrivateKey}`)
    ).toBe("Captured key: <redacted-private-key>");
    const truncatedEncryptedPrivateKey = encryptedPrivateKey
      .replace("-----END RSA PRIVATE KEY-----", "")
      .concat("\nSafe context");
    expect(
      redactPortableActivityText(
        `Captured key: ${truncatedEncryptedPrivateKey}`
      )
    ).toBe("Captured key: <redacted-private-key>\n\nSafe context");
    const emptyHeaderPrivateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "",
      "c2Vuc2l0aXZlLWtleS1tYXRlcmlhbA==",
      "",
      "Safe context",
    ].join("\n");
    expect(
      redactPortableActivityText(`Captured key: ${emptyHeaderPrivateKey}`)
    ).toBe("Captured key: <redacted-private-key>\n\nSafe context");
    for (const path of ["/etc/passwd", "/usr/bin", "/repo/config", "/secret"]) {
      expect(redactPortableActivityText(`Failure at ${path}`)).toBe(
        "Failure at <redacted-path>"
      );
    }
    for (const fileUrl of [
      "file:///Users/example/private.log",
      "file://localhost/Users/example/private.log",
      "file://server/share/private.log",
    ]) {
      expect(redactPortableActivityText(`Failure at ${fileUrl}`)).toBe(
        "Failure at file:///<redacted-path>"
      );
    }
    for (const url of [
      "https://example.com/docs",
      "https://example.com/artifact/path=workspace/fclt/log",
    ]) {
      expect(redactPortableActivityText(`keep ${url}`)).toBe(`keep ${url}`);
    }
    expect(
      redactPortableActivityText(
        "keep https://example.com:8443/a/b?next=/guides/setup/install#fragment"
      )
    ).toBe("keep https://example.com:8443/a/b");
    for (const [unsafeUrl, expectedUrl] of [
      [
        "https://logs.example/run?file=/Users/example/repo/.env",
        "<redacted-url>",
      ],
      [
        "https://logs.example/run?file=%2FUsers%2Fexample%2Frepo%2F.env",
        "<redacted-url>",
      ],
      [
        "https://logs.example/run?note=/Users/example/repo/.env",
        "<redacted-url>",
      ],
      [
        "https://logs.example/run?note=file:///Users/example/repo/.env",
        "<redacted-url>",
      ],
      [
        "https://logs.example/run?note=C%3A%5CUsers%5Cexample%5Crepo%5C.env",
        "<redacted-url>",
      ],
      [
        "https://logs.example/run?note=%5C%5Cserver%5Cshare%5Cprivate.log",
        "<redacted-url>",
      ],
      ["https://logs.example/run?note=~%2Fprivate%2Fconfig", "<redacted-url>"],
      ["https://logs.example/run#/Users/example/repo/.env", "<redacted-url>"],
      [
        "https://logs.example/artifact/path=/workspace/fclt/log",
        "<redacted-url>",
      ],
      [
        "https://logs.example/artifact/cwd=C:/workspace/fclt/log",
        "<redacted-url>",
      ],
    ]) {
      expect(redactPortableActivityText(`scrub ${unsafeUrl}`)).toBe(
        `scrub ${expectedUrl}`
      );
    }
  });
});
