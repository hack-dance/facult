import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ActivityFeed, ActivityItem } from "./activity";
import {
  type ActivityHistoryEventType,
  appendActivityHistory,
  queryActivityHistory,
} from "./activity-history";
import type { EvolutionLoopReport } from "./evolution-loop";
import {
  facultAiActivityHistoryManifestPath,
  facultAiActivityHistorySegmentDir,
  facultAiEvolutionLoopConfigPath,
} from "./paths";
import type { ReconciliationReview } from "./reconciliation-types";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    })
  );
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fclt-activity-history-"));
  temporaryRoots.push(home);
  return home;
}

function signalItem(args?: {
  state?: ActivityItem["state"];
  disposition?: ActivityItem["decision"]["disposition"];
  evidenceCount?: number;
  sourceLabels?: string[];
  title?: string;
  linkedWork?: string[];
  rationale?: string;
  familyId?: string;
}): ActivityItem {
  const evidenceCount = args?.evidenceCount ?? 1;
  const familyId = args?.familyId ?? "SF-stable";
  return {
    id: `family:${familyId}`,
    kind: "signal",
    categories: ["signal"],
    title: args?.title ?? "Repeated verification gap",
    state: args?.state ?? "open",
    change: "changed",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastChangedAt: "2026-01-01T00:00:00.000Z",
    sourceLabels: args?.sourceLabels ?? ["Writeback"],
    evidence: {
      count: evidenceCount,
      types: ["session"],
      writebackIds: Array.from(
        { length: evidenceCount },
        (_, index) => `WB-${String(index + 1).padStart(5, "0")}`
      ),
    },
    observations: [],
    omittedObservations: 0,
    context: {
      scope: "global",
      targets: [],
      links: [],
    },
    decision: {
      disposition: args?.disposition,
      rationale: args?.rationale,
    },
    linkedWork: args?.linkedWork ?? [],
    approvalRequired: false,
    nextAction: "Review the signal",
    technical: {
      queueId: `family:${familyId}`,
      familyId,
    },
  };
}

function proposalItem(args: {
  id: string;
  status: NonNullable<ActivityItem["decision"]["proposalStatus"]>;
  state?: ActivityItem["state"];
  verification?: NonNullable<ActivityItem["verification"]>["state"];
}): ActivityItem {
  return {
    id: `proposal:${args.id}`,
    kind: "proposal",
    categories: ["evolution"],
    title: `Proposal ${args.id}`,
    state: args.state ?? "approval_needed",
    change: "changed",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastChangedAt: "2026-01-01T00:00:00.000Z",
    sourceLabels: [],
    evidence: { count: 1, types: ["writeback"], writebackIds: ["WB-00001"] },
    observations: [],
    omittedObservations: 0,
    context: { scope: "global", targets: [], links: [] },
    decision: { proposalStatus: args.status },
    linkedWork: [],
    approvalRequired: false,
    verification: args.verification
      ? { state: args.verification, attempts: 1 }
      : undefined,
    nextAction: "Review the proposal",
    technical: {
      queueId: `proposal:${args.id}`,
      proposalId: args.id,
    },
  };
}

function review(args: {
  rootDir: string;
  scope: "global" | "project";
  index: number;
  since?: string;
  until: string;
}): ReconciliationReview {
  return {
    version: 1,
    reviewId: `review-${args.index}`,
    generatedAt: args.until,
    window: {
      id: `window-${args.index}`,
      mode: "window",
      since: args.since ?? "2026-01-01T00:00:00.000Z",
      until: args.until,
      scope: args.scope,
      rootDir: args.rootDir,
      configDigest: "config-revision",
    },
    coverageComplete: true,
    degraded: false,
    freshness: {
      state: "current",
      staleSourceIds: [],
      unknownSourceIds: [],
      alertSourceIds: [],
    },
    coverage: [],
    decisions: [],
    evidence: [],
    signals: [],
    resolutionProofs: [],
    resolvedSignalFamilies: [],
    resolvedEvidenceKeys: [],
    unresolvedSignals: [],
    linkedWork: [],
    dispositionCounts: {
      propose: 0,
      "apply-local": 0,
      task: 0,
      "resolve-watch": 0,
      defer: 0,
    },
    artifactPath: "review-artifact",
  };
}

function report(args: {
  rootDir: string;
  scope: "global" | "project";
  index: number;
  recordedAt: string;
  items: ActivityItem[];
  status?: EvolutionLoopReport["status"];
}): EvolutionLoopReport {
  const status = args.status ?? "complete";
  const feed: ActivityFeed = {
    version: 1,
    mode: "latest",
    snapshot: "embedded",
    generatedAt: args.recordedAt,
    scope: args.scope,
    run: { id: `LR-${args.index}`, status },
    coverage: {
      complete: status === "complete",
      checked: 1,
      degraded: 0,
      sources: [],
    },
    counts: {
      total: args.items.length,
      needsAttention: args.items.length,
      new: 0,
      changed: args.items.length,
      resolved: 0,
      unchangedSuppressed: 0,
    },
    items: args.items,
  };
  return {
    version: 1,
    runId: `LR-${args.index}`,
    generatedAt: args.recordedAt,
    scope: args.scope,
    projectRoot:
      args.scope === "project" ? args.rootDir.slice(0, -4) : undefined,
    status,
    trigger: "manual",
    generationBefore: args.index - 1,
    generationAfter: args.index,
    reviewId: `review-${args.index}`,
    coverage: [],
    coverageComplete: status === "complete",
    freshness: {
      state: status === "complete" ? "current" : "unknown",
      staleSourceIds: [],
      unknownSourceIds: [],
      alertSourceIds: [],
    },
    queue: [],
    delta: {
      new: [],
      changed: [],
      resolved: [],
      notifiable: [],
      unchangedSuppressed: 0,
    },
    mutations: [],
    attempts: [{ attempt: 1, ok: true }],
    artifactPath: "loop-artifact",
    auditPath: "loop-audit",
    activity: feed,
  };
}

async function appendRun(args: {
  home: string;
  rootDir: string;
  scope?: "global" | "project";
  index: number;
  recordedAt: string;
  items: ActivityItem[];
  retention?: { maxAgeDays?: number; maxEvents?: number; maxHeads?: number };
}): Promise<Awaited<ReturnType<typeof appendActivityHistory>>> {
  const scope = args.scope ?? "global";
  const loopReport = report({
    rootDir: args.rootDir,
    scope,
    index: args.index,
    recordedAt: args.recordedAt,
    items: args.items,
  });
  return await appendActivityHistory({
    homeDir: args.home,
    rootDir: args.rootDir,
    report: loopReport,
    review: review({
      rootDir: args.rootDir,
      scope,
      index: args.index,
      until: args.recordedAt,
    }),
    configRevision: 3,
    retention: args.retention,
  });
}

describe("activity history", () => {
  test("records the complete lifecycle as deltas instead of repeated snapshots", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    await appendRun({
      home,
      rootDir,
      index: 1,
      recordedAt: "2026-01-01T01:00:00.000Z",
      items: [
        signalItem({
          state: "deferred",
          disposition: "defer",
          evidenceCount: 2,
          sourceLabels: ["Writeback", "Repository"],
        }),
        proposalItem({ id: "EV-alpha", status: "proposed" }),
        proposalItem({ id: "EV-beta", status: "proposed" }),
        proposalItem({ id: "EV-gamma", status: "proposed" }),
      ],
    });
    await appendRun({
      home,
      rootDir,
      index: 2,
      recordedAt: "2026-01-02T01:00:00.000Z",
      items: [
        signalItem({
          state: "approval_needed",
          disposition: "propose",
          evidenceCount: 3,
        }),
        proposalItem({ id: "EV-alpha", status: "rejected" }),
        proposalItem({
          id: "EV-beta",
          status: "applied",
          state: "verification_pending",
          verification: "pending",
        }),
        proposalItem({
          id: "EV-gamma",
          status: "superseded",
          state: "resolved",
        }),
      ],
    });
    await appendRun({
      home,
      rootDir,
      index: 3,
      recordedAt: "2026-01-03T01:00:00.000Z",
      items: [
        signalItem({
          state: "resolved",
          disposition: "resolve-watch",
          evidenceCount: 3,
        }),
        proposalItem({
          id: "EV-beta",
          status: "applied",
          state: "resolved",
          verification: "improved",
        }),
        proposalItem({
          id: "EV-delta",
          status: "applied",
          state: "regressed",
          verification: "regressed",
        }),
      ],
    });

    const result = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-01-01T01:00:00.000Z",
      limit: 200,
    });
    const actions = new Set(result.events.map((event) => event.action));
    for (const expected of [
      "discovered",
      "repeated",
      "correlated",
      "defer",
      "propose",
      "proposal-proposed",
      "rejected",
      "applied",
      "verification-pending",
      "verified",
      "improved",
      "regressed",
      "superseded",
      "watch",
      "resolved",
    ]) {
      expect(actions.has(expected as never)).toBe(true);
    }
    expect(result.coverage.complete).toBe(true);
    expect(result.runs[0]).toMatchObject({
      configRevision: 3,
      window: { since: "2026-01-01T00:00:00.000Z" },
      coverage: { complete: true },
    });
  });

  test("is idempotent across reruns and overlapping windows while preserving renamed lineage", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    const first = await appendRun({
      home,
      rootDir,
      index: 1,
      recordedAt: "2026-02-01T00:00:00.000Z",
      items: [
        signalItem({
          evidenceCount: 2,
          sourceLabels: ["Branch A", "Branch B"],
        }),
      ],
    });
    const duplicate = await appendRun({
      home,
      rootDir,
      index: 1,
      recordedAt: "2026-02-01T00:00:00.000Z",
      items: [
        signalItem({
          evidenceCount: 2,
          sourceLabels: ["Branch A", "Branch B"],
        }),
      ],
    });
    await appendRun({
      home,
      rootDir,
      index: 2,
      recordedAt: "2026-02-02T00:00:00.000Z",
      items: [
        signalItem({
          evidenceCount: 2,
          sourceLabels: ["Branch A", "Branch B"],
        }),
      ],
    });
    await appendRun({
      home,
      rootDir,
      index: 3,
      recordedAt: "2026-02-03T00:00:00.000Z",
      items: [
        signalItem({ title: "Renamed verification gap", evidenceCount: 2 }),
      ],
    });
    expect(first.appended).toBe(true);
    expect(duplicate.appended).toBe(false);

    const result = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-02-01T00:00:00.000Z",
      item: "family:SF-stable",
      limit: 200,
    });
    expect(
      result.events.filter((event) => event.action === "discovered")
    ).toHaveLength(1);
    expect(
      result.events.filter((event) => event.action === "correlated")
    ).toHaveLength(1);
    expect(
      result.events.some((event) => event.action === "metadata-updated")
    ).toBe(true);
    expect(result.lineage?.resources).toHaveLength(1);
  });

  test("keeps duplicate internal ids collision-safe across global and project scopes", async () => {
    const home = await tempHome();
    const globalRoot = join(home, ".ai");
    const projectRoot = join(home, "work", "sample", ".ai");
    await appendRun({
      home,
      rootDir: globalRoot,
      index: 1,
      recordedAt: "2026-03-01T00:00:00.000Z",
      items: [signalItem()],
    });
    await appendRun({
      home,
      rootDir: projectRoot,
      scope: "project",
      index: 1,
      recordedAt: "2026-03-01T00:00:00.000Z",
      items: [signalItem()],
    });

    const result = await queryActivityHistory({
      homeDir: home,
      rootDir: globalRoot,
      scope: "all",
      since: "2026-03-01T00:00:00.000Z",
      item: "family:SF-stable",
      limit: 200,
    });
    expect(result.lineage?.ambiguous).toBe(true);
    expect(result.lineage?.resources).toHaveLength(2);
    expect(
      new Set(result.lineage?.resources.map((entry) => entry.scopeId)).size
    ).toBe(2);
    expect(
      new Set(result.lineage?.resources.map((entry) => entry.resource.id)).size
    ).toBe(2);
    expect(result.runs).toHaveLength(2);
    expect(new Set(result.runs.map((run) => run.scopeId)).size).toBe(2);
    expect(new Set(result.runs.map((run) => run.id))).toEqual(
      new Set(["LR-1"])
    );

    const page = await queryActivityHistory({
      homeDir: home,
      rootDir: globalRoot,
      scope: "all",
      since: "2026-03-01T00:00:00.000Z",
      limit: 1,
    });
    expect(page.events).toHaveLength(1);
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]?.id).toBe("LR-1");
    expect(page.runs[0]?.scopeId).toBe(page.events[0]?.scopeId);
  });

  test("links a superseded correlation branch to its opaque successor", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    await appendRun({
      home,
      rootDir,
      index: 1,
      recordedAt: "2026-03-10T00:00:00.000Z",
      items: [
        signalItem({ familyId: "SF-primary" }),
        signalItem({ familyId: "SF-branch" }),
      ],
    });
    await appendRun({
      home,
      rootDir,
      index: 2,
      recordedAt: "2026-03-11T00:00:00.000Z",
      items: [
        signalItem({ familyId: "SF-primary", evidenceCount: 2 }),
        signalItem({
          familyId: "SF-branch",
          state: "resolved",
          linkedWork: ["merged:family:SF-primary"],
        }),
      ],
    });

    const result = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-03-10T00:00:00.000Z",
      limit: 200,
    });
    const primary = result.events.find(
      (event) => event.resource?.itemId === "family:SF-primary"
    )?.resource;
    const superseded = result.events.find(
      (event) =>
        event.action === "superseded" &&
        event.resource?.itemId === "family:SF-branch"
    );
    expect(primary).toBeDefined();
    expect(superseded?.relatedResourceIds).toEqual([primary!.id]);
  });

  test("paginates deterministic bounded queries with time, item, scope, and event filters", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    for (let index = 1; index <= 4; index += 1) {
      await appendRun({
        home,
        rootDir,
        index,
        recordedAt: `2026-04-0${index}T00:00:00.000Z`,
        items: [signalItem({ evidenceCount: index })],
      });
    }
    const first = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-04-01T00:00:00.000Z",
      until: "2026-04-04T00:00:00.000Z",
      item: "family:SF-stable",
      eventTypes: ["observation"],
      limit: 2,
    });
    expect(first.events).toHaveLength(2);
    expect(first.page.nextCursor).toBeDefined();
    expect(first.truncation.truncated).toBe(false);
    const second = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-04-01T00:00:00.000Z",
      until: "2026-04-04T00:00:00.000Z",
      item: "family:SF-stable",
      eventTypes: ["observation"],
      limit: 2,
      cursor: first.page.nextCursor,
    });
    expect(second.events.length).toBeGreaterThan(0);
    expect(
      second.events.some((event) =>
        first.events.some((prior) => prior.id === event.id)
      )
    ).toBe(false);
    const equivalentOffsets = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-04-01T01:00:00+01:00",
      until: "2026-04-01T00:00:00.000Z",
      eventTypes: ["run"],
    });
    expect(equivalentOffsets.events).toHaveLength(1);
    await expect(
      queryActivityHistory({
        homeDir: home,
        rootDir,
        scope: "global",
        cursor: "not-a-cursor",
      })
    ).rejects.toThrow("Invalid activity history cursor");
  });

  test("prunes whole immutable segments and reports the retained window explicitly", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    for (let index = 1; index <= 5; index += 1) {
      await appendRun({
        home,
        rootDir,
        index,
        recordedAt: `2026-05-0${index}T00:00:00.000Z`,
        items: [],
        retention: { maxAgeDays: 365, maxEvents: 2 },
      });
    }
    const partial = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-05-01T00:00:00.000Z",
    });
    expect(partial.coverage.complete).toBe(false);
    expect(partial.coverage.scopes[0]?.prunedEvents).toBe(3);
    expect(partial.events).toHaveLength(2);
    const retained = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-05-04T00:00:00.001Z",
    });
    expect(retained.coverage.complete).toBe(true);
  });

  test("keeps a committed run successful when pruned segment cleanup fails", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    await appendRun({
      home,
      rootDir,
      index: 1,
      recordedAt: "2026-05-01T00:00:00.000Z",
      items: [],
      retention: { maxAgeDays: 365, maxEvents: 100 },
    });
    const manifestPath = facultAiActivityHistoryManifestPath(home, rootDir);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      segments: Array<{ file: string }>;
    };
    const staleSegmentPath = join(
      facultAiActivityHistorySegmentDir(home, rootDir),
      manifest.segments[0]!.file
    );
    await rm(staleSegmentPath);
    await mkdir(staleSegmentPath);

    const appended = await appendRun({
      home,
      rootDir,
      index: 2,
      recordedAt: "2026-05-02T00:00:00.000Z",
      items: [],
      retention: { maxAgeDays: 365, maxEvents: 1 },
    });

    expect(appended.appended).toBe(true);
    const retry = await appendRun({
      home,
      rootDir,
      index: 2,
      recordedAt: "2026-05-02T00:00:00.000Z",
      items: [],
      retention: { maxAgeDays: 365, maxEvents: 1 },
    });
    expect(retry.appended).toBe(false);
    const timeline = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
    });
    expect(timeline.runs).toEqual([
      expect.objectContaining({ id: "LR-2", status: "complete" }),
    ]);
  });

  test("bounds lineage heads and reports item-lineage pruning separately", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    await appendRun({
      home,
      rootDir,
      index: 1,
      recordedAt: "2026-05-10T00:00:00.000Z",
      items: [
        signalItem({ familyId: "SF-primary" }),
        signalItem({ familyId: "SF-branch" }),
      ],
      retention: { maxAgeDays: 365, maxEvents: 100, maxHeads: 1 },
    });

    const timeline = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-05-10T00:00:00.000Z",
    });
    expect(timeline.coverage.complete).toBe(true);
    expect(timeline.coverage.scopes[0]?.prunedHeads).toBe(1);
    const lineage = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-05-10T00:00:00.000Z",
      item: "family:SF-primary",
    });
    expect(lineage.coverage.complete).toBe(false);
  });

  test("reports snapshot-only migration and corrupt history without reconstructing other runtime files", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    const configPath = facultAiEvolutionLoopConfigPath(home, rootDir);
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ version: 1, scope: "global" })}\n`,
      "utf8"
    );
    const snapshotOnly = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
    });
    expect(snapshotOnly.coverage.scopes[0]).toMatchObject({
      state: "snapshot-only",
      detail: "history-not-recorded",
    });
    expect(snapshotOnly.retention.migration).toBe(
      "no-backfill-from-snapshots-or-journals"
    );

    const manifestPath = facultAiActivityHistoryManifestPath(home, rootDir);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, "{malformed", "utf8");
    const corrupt = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
    });
    expect(corrupt.coverage.scopes[0]).toMatchObject({
      state: "degraded",
      detail: "history-manifest-invalid",
    });
  });

  test("redacts private payloads and unsafe links and declares no export or external mutation", async () => {
    const home = await tempHome();
    const rootDir = join(home, ".ai");
    const credentialValue = ["private", "token"].join("-");
    const credentialText = ["Authorization", `Bearer ${credentialValue}`].join(
      ": "
    );
    const item = signalItem({
      title: `Failure at ${join(home, "work", "source.ts")}`,
      rationale: `${credentialText} in ${rootDir}`,
    });
    item.context = {
      scope: "global",
      targets: [],
      links: [
        {
          label: "unsafe",
          url: `https://example.test/open?path=${encodeURIComponent(rootDir)}`,
          source: "evidence",
        },
      ],
    };
    await appendRun({
      home,
      rootDir,
      index: 1,
      recordedAt: "2026-06-01T00:00:00.000Z",
      items: [item],
    });
    const segmentDir = facultAiActivityHistorySegmentDir(home, rootDir);
    const [segmentName] = await readdir(segmentDir);
    const stored = await readFile(join(segmentDir, segmentName!), "utf8");
    expect(stored).not.toContain(home);
    expect(stored).not.toContain(credentialValue);
    expect(stored).not.toContain("?path=");

    const result = await queryActivityHistory({
      homeDir: home,
      rootDir,
      scope: "global",
      since: "2026-06-01T00:00:00.000Z",
    });
    expect(result.capabilities).toEqual({
      externalMutation: false,
      export: false,
      rawPayloads: false,
    });
    expect(JSON.stringify(result)).not.toContain(home);
  });

  test("isolates a corrupt segment and marks aggregate scope truncation", async () => {
    const home = await tempHome();
    const globalRoot = join(home, ".ai");
    await appendRun({
      home,
      rootDir: globalRoot,
      index: 1,
      recordedAt: "2026-07-01T00:00:00.000Z",
      items: [],
    });
    const segmentDir = facultAiActivityHistorySegmentDir(home, globalRoot);
    const [segmentName] = await readdir(segmentDir);
    const segmentPath = join(segmentDir, segmentName!);
    const segment = JSON.parse(await readFile(segmentPath, "utf8")) as {
      events: Array<{ action: string }>;
    };
    segment.events[0]!.action = "unrecognized-action";
    const segmentBody = `${JSON.stringify(segment, null, 2)}\n`;
    await writeFile(segmentPath, segmentBody, "utf8");
    const manifestPath = facultAiActivityHistoryManifestPath(home, globalRoot);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      segments: Array<{ checksum: string }>;
    };
    manifest.segments[0]!.checksum = createHash("sha256")
      .update(segmentBody)
      .digest("hex");
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    const corrupt = await queryActivityHistory({
      homeDir: home,
      rootDir: globalRoot,
      scope: "global",
      since: "2026-07-01T00:00:00.000Z",
    });
    expect(corrupt.coverage.scopes[0]).toMatchObject({
      state: "degraded",
      corruptSegments: 1,
    });

    await appendRun({
      home,
      rootDir: globalRoot,
      index: 2,
      recordedAt: "2026-07-01T01:00:00.000Z",
      items: [],
    });
    const segmentNames = await readdir(segmentDir);
    const linkedSegmentName = segmentNames.find((name) => name !== segmentName);
    const linkedSegmentPath = join(segmentDir, linkedSegmentName!);
    const linkedTargetPath = `${linkedSegmentPath}.target`;
    await rename(linkedSegmentPath, linkedTargetPath);
    await symlink(linkedTargetPath, linkedSegmentPath);
    const substituted = await queryActivityHistory({
      homeDir: home,
      rootDir: globalRoot,
      scope: "global",
      since: "2026-07-01T00:00:00.000Z",
    });
    expect(substituted.coverage.scopes[0]).toMatchObject({
      state: "degraded",
      corruptSegments: 2,
    });

    for (let index = 0; index < 51; index += 1) {
      const projectRoot = join(home, "work", `project-${index}`, ".ai");
      await appendRun({
        home,
        rootDir: projectRoot,
        scope: "project",
        index: 1,
        recordedAt: "2026-07-02T00:00:00.000Z",
        items: [],
      });
    }
    const aggregate = await queryActivityHistory({
      homeDir: home,
      rootDir: globalRoot,
      scope: "all",
      since: "2026-07-02T00:00:00.000Z",
      eventTypes: ["run"] as ActivityHistoryEventType[],
      limit: 200,
    });
    expect(aggregate.truncation.truncated).toBe(true);
    expect(aggregate.truncation.omittedScopes).toBe(2);
    expect(aggregate.coverage.complete).toBe(false);

    const omittedScope = aggregate.coverage.scopes.find(
      (scope) => scope.state === "omitted"
    );
    expect(omittedScope).toBeDefined();
    const targeted = await queryActivityHistory({
      homeDir: home,
      rootDir: globalRoot,
      scope: "all",
      scopeId: omittedScope!.id,
      since: "2026-07-02T00:00:00.000Z",
      eventTypes: ["run"],
    });
    expect(targeted.events).toHaveLength(1);
    expect(targeted.coverage.scopes[0]?.state).toBe("available");
    expect(targeted.truncation).toMatchObject({
      truncated: false,
      omittedScopes: 0,
    });
  });
});
