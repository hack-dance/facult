import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  facultAiReconciliationLockPath,
  facultAiReconciliationReviewDir,
  facultAiReconciliationStatePath,
  facultAiWritebackQueuePath,
} from "./paths";
import {
  latestReconciliationReview,
  reconcileSources,
  reconciliationReviewById,
  reconciliationStatus,
} from "./reconciliation";
import {
  initializeReconciliationConfig,
  parseReconciliationConfig,
} from "./reconciliation-config";

let tempRoot: string | null = null;
const originalRootDir = process.env.FACULT_ROOT_DIR;
const originalRootScope = process.env.FACULT_ROOT_SCOPE;

async function makeFixture(): Promise<{
  homeDir: string;
  projectRoot: string;
  rootDir: string;
}> {
  tempRoot = join(
    tmpdir(),
    "fclt-reconciliation-tests",
    `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const homeDir = join(tempRoot, "home");
  const projectRoot = join(tempRoot, "cos");
  const rootDir = join(projectRoot, ".ai");
  await mkdir(rootDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  return { homeDir, projectRoot, rootDir };
}

async function writeQueue(args: {
  homeDir: string;
  rootDir: string;
}): Promise<void> {
  const path = facultAiWritebackQueuePath(args.homeDir, args.rootDir);
  await mkdir(join(path, ".."), { recursive: true });
  const records = [
    {
      id: "WB-00020",
      ts: "2026-07-10T15:51:00.000Z",
      updatedAt: "2026-07-10T15:54:00.000Z",
      kind: "capability_gap",
      summary: "Full-window source reconciliation is missing.",
      status: "recorded",
      assetRef: "@project/instructions/RECONCILIATION.md",
      issueLinks: ["TICKET-793"],
      disposition: "task",
      dispositionTarget: "TICKET-793",
    },
    {
      id: "WB-00021",
      ts: "2026-07-10T15:52:00.000Z",
      updatedAt: "2026-07-10T15:55:00.000Z",
      kind: "bad_default",
      summary: "Unchanged heartbeat blocker prose repeats.",
      status: "recorded",
      issueLinks: ["TICKET-794"],
      disposition: "resolve-watch",
      dispositionTarget: "TICKET-794",
    },
    {
      id: "WB-00022",
      ts: "2026-07-10T15:53:00.000Z",
      kind: "missing_context",
      summary: "Evolution needs outcome and effectiveness links.",
      status: "recorded",
      suggestedDestination: "@project/instructions/OUTCOMES.md",
      evidence: [{ type: "issue", ref: "TICKET-795" }],
      issueLinks: ["TICKET-791"],
      disposition: "resolve-watch",
      dispositionTarget: "TICKET-791",
    },
    {
      id: "WB-00023",
      ts: "2026-07-10T15:54:00.000Z",
      kind: "false_positive",
      summary: "EV-00006 draft lifecycle reported a false positive.",
      status: "recorded",
      issueLinks: ["TICKET-791"],
      disposition: "resolve-watch",
      dispositionTarget: "TICKET-791",
    },
  ];
  await Bun.write(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
}

function evidenceExport(
  events: Record<string, unknown>[],
  options?: { complete?: boolean; partialReasons?: string[] }
): Record<string, unknown> {
  return {
    version: 1,
    producer: "fixture-issue-exporter",
    generatedAt: "2026-07-11T01:00:00Z",
    coverage: {
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-11T00:00:00Z",
      complete: options?.complete ?? true,
      partialReasons: options?.partialReasons,
    },
    events,
  };
}

async function runFixtureGit(args: {
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

async function fixtureGitOutput(args: {
  projectRoot: string;
  argv: string[];
}): Promise<string> {
  const proc = Bun.spawn({
    cmd: [Bun.which("git") ?? "/usr/bin/git", ...args.argv],
    cwd: args.projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
  return stdout.trim();
}

afterEach(async () => {
  process.env.FACULT_ROOT_DIR = originalRootDir;
  process.env.FACULT_ROOT_SCOPE = originalRootScope;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = null;
});

describe("reconciliation config", () => {
  it("reports an enabled-source-free config as degraded before first review", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({ version: 1, sources: [] })
    );

    expect(await reconciliationStatus(fixture)).toMatchObject({
      configured: true,
      sourceCount: 0,
      coverageState: "degraded",
    });
  });

  it("seeds safe automatic defaults and rejects unknown or secret-shaped config", async () => {
    const fixture = await makeFixture();
    const initialized = await initializeReconciliationConfig(fixture);
    expect(initialized.created).toBe(true);
    expect(initialized.config.sources.map((source) => source.type)).toEqual([
      "writebacks",
      "git",
    ]);

    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [
          {
            id: "issues",
            type: "evidence-export",
            token: "inline-secret",
            path: "evidence.json",
          },
        ],
      })
    ).toThrow();
    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [{ id: "git", type: "git", paths: ["../outside"] }],
      })
    ).toThrow();
    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [{ id: "git", type: "git", paths: [] }],
      })
    ).toThrow();
    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [{ id: "git", type: "git", allBranches: "true" }],
      })
    ).toThrow("allBranches must be a boolean");
    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [{ id: "git", type: "git", freshnessThresholdHours: 0 }],
      })
    ).toThrow("freshnessThresholdHours");
    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [{ id: "git", type: "git", defaultBranch: "../main" }],
      })
    ).toThrow("defaultBranch");
    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [
          {
            id: "issues",
            type: "evidence-export",
            path: "../issues.json",
          },
        ],
      })
    ).toThrow();
    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [
          {
            id: "logs",
            type: "automation",
            root: "home",
            paths: ["../shared/*.jsonl"],
          },
        ],
      })
    ).toThrow();
  });

  it("does not seed project Git for an explicitly global custom root", async () => {
    const fixture = await makeFixture();
    const customGlobalRoot = join(fixture.projectRoot, "shared", ".ai");
    await mkdir(customGlobalRoot, { recursive: true });
    const initialized = await initializeReconciliationConfig({
      homeDir: fixture.homeDir,
      rootDir: customGlobalRoot,
      scope: "global",
    });
    expect(initialized.config.sources.map((source) => source.type)).toEqual([
      "writebacks",
    ]);
  });

  it("backs up an invalid config only through explicit force repair", async () => {
    const fixture = await makeFixture();
    const path = join(fixture.rootDir, "reconciliation.json");
    await Bun.write(path, "{invalid");
    await expect(initializeReconciliationConfig(fixture)).rejects.toThrow(
      "review init --force"
    );
    const repaired = await initializeReconciliationConfig({
      ...fixture,
      force: true,
    });
    expect(repaired.backupPath).toBeDefined();
    expect(await Bun.file(repaired.backupPath!).text()).toBe("{invalid");
    expect(JSON.parse(await Bun.file(path).text()).sources).toHaveLength(2);
  });
});

describe("source reconciliation", () => {
  it("rejects non-canonical review ids before resolving a window path", async () => {
    const fixture = await makeFixture();
    expect(
      await reconciliationReviewById({
        ...fixture,
        reviewId: "../../outside",
      })
    ).toBeNull();
  });

  it("scans current sources without persisting preview state or artifacts", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
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
    const reviewPath = join(fixture.projectRoot, "review.md");
    await Bun.write(
      reviewPath,
      "## Setup friction\n\nThe setup instructions need a reusable recovery step.\n"
    );
    const changedAt = new Date("2026-07-10T16:30:00.000Z");
    await utimes(reviewPath, changedAt, changedAt);

    const preview = await reconcileSources({
      ...fixture,
      since: "2026-07-10T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
      incremental: true,
      persist: false,
    });

    expect(preview.coverage[0]).toMatchObject({
      sourceId: "review-notes",
      state: "changed",
      recordsScanned: 1,
      watermarkAfter: changedAt.toISOString(),
    });
    expect(preview.signals.length).toBeGreaterThan(0);
    expect(
      await Bun.file(
        facultAiReconciliationStatePath(fixture.homeDir, fixture.rootDir)
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        facultAiReconciliationReviewDir(fixture.homeDir, fixture.rootDir)
      ).exists()
    ).toBe(false);
    expect(await latestReconciliationReview(fixture)).toBeNull();
  });

  it("recovers the writeback cluster without ticket proposal spam and is idempotent", async () => {
    const fixture = await makeFixture();
    await writeQueue(fixture);
    const evidenceExportPath = join(
      fixture.projectRoot,
      "fixtures",
      "issues-window.json"
    );
    const markdownPath = join(
      fixture.projectRoot,
      "notes",
      "evolution-runbook.md"
    );
    await mkdir(join(fixture.projectRoot, "fixtures"), { recursive: true });
    await mkdir(join(fixture.projectRoot, "notes"), { recursive: true });
    await Bun.write(
      evidenceExportPath,
      JSON.stringify(
        evidenceExport([
          {
            id: "issue-793",
            kind: "work-item",
            observedAt: "2026-07-10T16:15:45.198Z",
            title: "Add automatic source reconciliation",
            body: "Implementation target for WB-00020. Diagnostic: https://log-user:log-password@example.invalid/run/793",
            sourceUri:
              "https://user:password@example.invalid/work/793?token=source-uri-secret#fragment",
            refs: [
              "TICKET-793",
              "WB-00020",
              "@project/instructions/RECONCILIATION.md",
            ],
          },
          {
            id: "comment-793",
            kind: "comment",
            observedAt: "2026-07-10T16:20:00.000Z",
            body: "Preserve implementation tickets as evidence, not proposals.",
            refs: ["TICKET-793"],
          },
          {
            id: "history-793",
            kind: "status-change",
            observedAt: "2026-07-10T16:15:45.198Z",
            body: "Backlog -> In Progress",
            refs: ["TICKET-793"],
          },
        ])
      )
    );
    await Bun.write(
      markdownPath,
      [
        "# Full-window reconciliation",
        "",
        "WB-00020 requires TICKET-793 to harvest all configured sources.",
        "Never copy token=lin_api_abcdefghijklmnopqrstuvwxyz into review output.",
      ].join("\n")
    );
    const fixtureTime = new Date("2026-07-10T16:30:00.000Z");
    await utimes(markdownPath, fixtureTime, fixtureTime);
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify(
        {
          version: 1,
          sources: [
            { id: "writebacks", type: "writebacks" },
            {
              id: "issues",
              type: "evidence-export",
              path: "fixtures/issues-window.json",
            },
            {
              id: "runbooks",
              type: "markdown",
              root: "project",
              paths: ["notes/**/*.md"],
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const first = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
    });
    expect(first.coverageComplete).toBe(true);
    expect(first.degraded).toBe(false);
    expect(first.evidence.flatMap((entry) => entry.writebackRefs)).toEqual(
      expect.arrayContaining(["WB-00020", "WB-00021", "WB-00022", "WB-00023"])
    );
    expect(first.linkedWork).toEqual(
      expect.arrayContaining([
        "TICKET-791",
        "TICKET-793",
        "TICKET-794",
        "TICKET-795",
      ])
    );
    expect(
      first.signals.some((signal) => signal.disposition === "propose")
    ).toBe(false);
    expect(first.signals.flatMap((signal) => signal.assetRefs)).toContain(
      "@project/instructions/OUTCOMES.md"
    );
    expect(
      first.signals.some(
        (signal) =>
          signal.issueRefs.includes("TICKET-793") &&
          signal.sourceIds.includes("writebacks") &&
          signal.sourceIds.includes("issues")
      )
    ).toBe(true);
    expect(
      first.decisions
        .filter((decision) => decision.included)
        .every((decision) => decision.disposition)
    ).toBe(true);
    expect(first.evidence.every((entry) => entry.isNew)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(
      "lin_api_abcdefghijklmnopqrstuvwxyz"
    );
    expect(JSON.stringify(first)).not.toContain("source-uri-secret");
    expect(JSON.stringify(first)).not.toContain("password@example.invalid");
    expect(JSON.stringify(first)).not.toContain("log-password");

    const second = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
    });
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.evidence.map((entry) => entry.dedupeKey)).toEqual(
      first.evidence.map((entry) => entry.dedupeKey)
    );
    expect(second.signals.map((signal) => signal.id)).toEqual(
      first.signals.map((signal) => signal.id)
    );
    const state = JSON.parse(
      await readFile(
        facultAiReconciliationStatePath(fixture.homeDir, fixture.rootDir),
        "utf8"
      )
    ) as { reviews: Record<string, unknown> };
    expect(Object.keys(state.reviews)).toEqual([first.reviewId]);
    expect(
      await Bun.file(
        join(
          facultAiReconciliationReviewDir(fixture.homeDir, fixture.rootDir),
          "latest.md"
        )
      ).exists()
    ).toBe(true);
  });

  it("reports unavailable sources as degraded instead of a false empty review", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "automation-runs",
            type: "automation",
            root: "home",
            paths: [".codex/automations/**/runs/*.jsonl"],
          },
        ],
      })}\n`
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
    });
    expect(review.coverageComplete).toBe(false);
    expect(review.degraded).toBe(true);
    expect(review.coverage[0]?.state).toBe("unavailable");
    expect(review.emptyReason).toContain("not a proven empty review");
  });

  it("rescans explicit historical windows and selects the latest writeback state within the window", async () => {
    const fixture = await makeFixture();
    const queuePath = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(join(queuePath, ".."), { recursive: true });
    await Bun.write(
      queuePath,
      [
        JSON.stringify({
          id: "WB-00020",
          ts: "2026-07-05T12:00:00Z",
          summary: "Historical reconciliation capability signal",
          issueLinks: ["TICKET-793"],
          disposition: "task",
        }),
        JSON.stringify({
          id: "WB-00020",
          ts: "2026-07-05T12:00:00Z",
          updatedAt: "2026-07-11T12:00:00Z",
          summary: "Later state outside the historical window",
          issueLinks: ["TICKET-793"],
          disposition: "resolve-watch",
        }),
      ].join("\n")
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );

    const current = await reconcileSources({
      ...fixture,
      since: "2026-07-10T00:00:00Z",
      until: "2026-07-12T00:00:00Z",
    });
    const historical = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(historical.window.mode).toBe("window");
    expect(historical.evidence).toHaveLength(1);
    expect(historical.evidence[0]?.title).toContain("Historical");
    expect(historical.signals[0]?.disposition).toBe("task");
    expect((await latestReconciliationReview(fixture))?.reviewId).toBe(
      current.reviewId
    );
    const state = JSON.parse(
      await readFile(
        facultAiReconciliationStatePath(fixture.homeDir, fixture.rootDir),
        "utf8"
      )
    ) as { sources: Record<string, { watermark?: string }> };
    expect(state.sources.writebacks?.watermark).toBe("2026-07-11T12:00:00Z");
  });

  it("includes the full final day for date-only windows and rescans bounded reruns", async () => {
    const fixture = await makeFixture();
    const queuePath = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(join(queuePath, ".."), { recursive: true });
    await Bun.write(queuePath, "");
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const first = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(first.signals).toHaveLength(0);
    expect(first.window.until).toBe("2026-07-10T23:59:59.999Z");

    await Bun.write(
      queuePath,
      JSON.stringify({
        id: "WB-00020",
        ts: "2026-07-10T18:00:00Z",
        summary: "Signal added after the first bounded review",
      })
    );
    const rerun = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(rerun.reviewId).toBe(first.reviewId);
    expect(rerun.signals[0]?.writebackRefs).toEqual(["WB-00020"]);
  });

  it("keeps the readable latest mirror on the newest reviewed window", async () => {
    const fixture = await makeFixture();
    const logPath = join(fixture.projectRoot, "review.md");
    await Bun.write(logPath, "# Capability review\n");
    await utimes(
      logPath,
      new Date("2026-07-10T12:00:00Z"),
      new Date("2026-07-10T12:00:00Z")
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "review-log",
            type: "markdown",
            root: "project",
            paths: ["review.md"],
          },
        ],
      })
    );
    const current = await reconcileSources({
      ...fixture,
      since: "2026-07-09",
      until: "2026-07-10",
    });
    await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-04",
    });
    const latest = await readFile(
      join(
        facultAiReconciliationReviewDir(fixture.homeDir, fixture.rootDir),
        "latest.md"
      ),
      "utf8"
    );
    expect(latest).toContain(`reviewId: "${current.reviewId}"`);
    expect(latest).toContain('scope: "project"');
    expect(latest).toContain(`rootDir: ${JSON.stringify(fixture.rootDir)}`);
    expect(latest).toContain(
      `projectRoot: ${JSON.stringify(fixture.projectRoot)}`
    );
    expect(latest).toContain('until: "2026-07-10T23:59:59.999Z"');
    expect(await reconciliationStatus(fixture)).toMatchObject({
      lastReviewId: current.reviewId,
      coverageState: "complete",
    });
  });

  it("joins an unambiguous external WB reference to its source writeback", async () => {
    const fixture = await makeFixture();
    await writeQueue(fixture);
    await Bun.write(
      join(fixture.projectRoot, "evidence.json"),
      `${JSON.stringify(
        evidenceExport([
          {
            id: "external-comment",
            kind: "comment",
            observedAt: "2026-07-10T17:00:00Z",
            body: "Outcome proof recorded for WB-00020.",
            refs: ["WB-00020"],
          },
        ])
      )}\n`
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          { id: "external", type: "evidence-export", path: "evidence.json" },
        ],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    const signal = review.signals.find(
      (item) =>
        item.writebackRefs.includes("WB-00020") &&
        item.sourceIds.includes("external")
    );
    expect(signal?.sourceIds).toEqual(
      expect.arrayContaining(["writebacks", "external"])
    );
    expect(
      review.signals.filter((item) => item.writebackRefs.includes("WB-00020"))
    ).toHaveLength(1);
    expect(signal?.disposition).toBe("task");
  });

  it("identifies incremental reviews by their effective cursor-backed window", async () => {
    const fixture = await makeFixture();
    const queuePath = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(join(queuePath, ".."), { recursive: true });
    await Bun.write(
      queuePath,
      JSON.stringify({
        id: "WB-00020",
        ts: "2026-07-05T12:00:00Z",
        summary: "First incremental signal",
      })
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const first = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      incremental: true,
    });
    await Bun.write(
      queuePath,
      [
        JSON.stringify({
          id: "WB-00020",
          ts: "2026-07-05T12:00:00Z",
          summary: "First incremental signal",
        }),
        JSON.stringify({
          id: "WB-00021",
          ts: "2026-07-06T12:00:00Z",
          summary: "Second incremental signal",
        }),
      ].join("\n")
    );
    await mkdir(join(fixture.projectRoot, "notes"), { recursive: true });
    await Bun.write(
      join(fixture.projectRoot, "notes", "signals.md"),
      "# 2026-07-04 capability signal\n\nNew source evidence.\n"
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          { id: "notes", type: "markdown", paths: ["notes/*.md"] },
        ],
      })
    );

    const second = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      incremental: true,
    });

    expect(second.reviewId).not.toBe(first.reviewId);
    expect(first.window.since).toBe("2026-07-03T00:00:00.000Z");
    expect(second.window.since).toBe("2026-07-03T00:00:00.000Z");
    expect(
      second.signals.some((signal) => signal.title.includes("2026-07-04"))
    ).toBe(true);

    await Bun.write(
      queuePath,
      [
        JSON.stringify({
          id: "WB-00020",
          ts: "2026-07-05T12:00:00Z",
          summary: "First incremental signal",
        }),
        JSON.stringify({
          id: "WB-00021",
          ts: "2026-07-06T12:00:00Z",
          summary: "Second incremental signal",
        }),
        JSON.stringify({
          id: "WB-00022",
          ts: "2026-07-06T12:00:00Z",
          summary: "New signal sharing the watermark timestamp",
        }),
      ].join("\n")
    );
    const tied = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      incremental: true,
    });
    expect(tied.signals).toHaveLength(1);
    expect(tied.signals[0]?.writebackRefs).toEqual(["WB-00022"]);

    const quiet = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      incremental: true,
    });
    expect(quiet.coverageComplete).toBe(true);
    expect(quiet.signals).toHaveLength(0);
    expect(quiet.emptyReason).toContain("every configured source was checked");

    await Bun.write(
      queuePath,
      `${await readFile(queuePath, "utf8")}\n${JSON.stringify({
        id: "WB-00022",
        ts: "2026-07-06T12:00:00Z",
        updatedAt: "2026-07-07T12:00:00Z",
        summary: "New signal sharing the watermark timestamp",
        disposition: "task",
        dispositionTarget: "TICKET-222",
      })}\n`
    );
    const updated = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      incremental: true,
    });
    expect(updated.signals).toHaveLength(1);
    expect(updated.signals[0]?.writebackRefs).toEqual(["WB-00022"]);
    expect(updated.signals[0]?.disposition).toBe("task");
  });

  it("advances an empty incremental source from its covered-until boundary", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const first = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-05",
      incremental: true,
    });
    expect(first.signals).toHaveLength(0);
    const next = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      incremental: true,
    });
    expect(next.window.since).toBe("2026-07-05T23:59:59.998Z");
  });

  it("reconciles legacy writeback queues on upgraded installs", async () => {
    const fixture = await makeFixture();
    const legacyQueue = join(
      fixture.rootDir,
      ".facult",
      "ai",
      "project",
      "writeback",
      "queue.jsonl"
    );
    await mkdir(join(legacyQueue, ".."), { recursive: true });
    await Bun.write(
      legacyQueue,
      JSON.stringify({
        id: "WB-00020",
        ts: "2026-07-10T18:00:00Z",
        summary: "Legacy reconciliation signal",
      })
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(review.signals[0]?.writebackRefs).toEqual(["WB-00020"]);
  });

  it("does not reopen terminal writebacks during reconciliation", async () => {
    const fixture = await makeFixture();
    const queuePath = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(join(queuePath, ".."), { recursive: true });
    await Bun.write(
      queuePath,
      [
        JSON.stringify({
          id: "WB-00020",
          ts: "2026-07-04T12:00:00Z",
          summary: "Capability signal",
          status: "recorded",
        }),
        JSON.stringify({
          id: "WB-00020",
          ts: "2026-07-04T12:00:00Z",
          updatedAt: "2026-07-04T12:00:00.999Z",
          summary: "Capability signal",
          status: "resolved",
        }),
      ].join("\n")
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });

    expect(review.coverage[0]?.state).toBe("changed");
    expect(review.signals).toHaveLength(0);
    expect(review.resolvedEvidenceKeys).toEqual(["writeback:project:WB-00020"]);
    expect(review.decisions[0]).toMatchObject({
      included: false,
      reason:
        "Excluded as a terminal source state that resolves prior evidence",
    });
  });

  it("keeps identical global and project writeback ids distinct", async () => {
    const fixture = await makeFixture();
    const projectQueue = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    const globalRoot = join(fixture.homeDir, ".ai");
    const globalQueue = facultAiWritebackQueuePath(fixture.homeDir, globalRoot);
    await mkdir(join(projectQueue, ".."), { recursive: true });
    await mkdir(join(globalQueue, ".."), { recursive: true });
    await Bun.write(
      projectQueue,
      JSON.stringify({
        id: "WB-00001",
        ts: "2026-07-05T12:00:00Z",
        summary: "Project-specific capability signal",
      })
    );
    await Bun.write(
      globalQueue,
      JSON.stringify({
        id: "WB-00001",
        ts: "2026-07-06T12:00:00Z",
        summary: "Unrelated global capability signal",
      })
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "project-writebacks", type: "writebacks" },
          { id: "global-writebacks", type: "writebacks", scope: "global" },
        ],
      })
    );
    process.env.FACULT_ROOT_DIR = fixture.rootDir;
    process.env.FACULT_ROOT_SCOPE = "project";

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(review.evidence.map((item) => item.dedupeKey).sort()).toEqual([
      "writeback:global:WB-00001",
      "writeback:project:WB-00001",
    ]);
    expect(review.signals).toHaveLength(2);
    expect(
      review.signals.every((signal) => signal.writebackRefs[0] === "WB-00001")
    ).toBe(true);
  });

  it("degrades malformed writeback input and filtered coverage", async () => {
    const fixture = await makeFixture();
    const queuePath = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(join(queuePath, ".."), { recursive: true });
    await Bun.write(
      queuePath,
      `{malformed\n${JSON.stringify({ id: "WB-99999", summary: "missing timestamp" })}\n`
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          {
            id: "notes",
            type: "markdown",
            paths: ["notes/*.md"],
          },
        ],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
      sourceIds: ["writebacks"],
    });
    expect(review.coverageComplete).toBe(false);
    expect(review.degraded).toBe(true);
    expect(review.coverage[0]?.state).toBe("unavailable");
    expect(review.decisions).toHaveLength(2);
    expect(
      review.decisions.every(
        (decision) => !decision.included && decision.classification === "noise"
      )
    ).toBe(true);
    await expect(
      reconcileSources({
        ...fixture,
        since: "2026-07-03T00:00:00Z",
        until: "2026-07-10T00:00:00Z",
        sourceIds: ["unknown"],
      })
    ).rejects.toThrow("Unknown or disabled");
  });

  it("reports an unreadable writeback queue as unavailable coverage", async () => {
    const fixture = await makeFixture();
    const queuePath = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(join(queuePath, ".."), { recursive: true });
    await Bun.write(queuePath, '{"id":"WB-00001"}\n');
    await chmod(queuePath, 0);
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(review.degraded).toBe(true);
    expect(review.coverage[0]).toMatchObject({
      sourceId: "writebacks",
      state: "unavailable",
      recordsScanned: 0,
    });
    expect(review.coverage[0]?.unavailableReason).toContain(
      "could not be read"
    );
  });

  it("reports a filtered review as degraded even when checked sources pass", async () => {
    const fixture = await makeFixture();
    await writeQueue(fixture);
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          { id: "notes", type: "markdown", paths: ["notes/*.md"] },
        ],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-11T00:00:00Z",
      sourceIds: ["writebacks"],
    });
    expect(review.coverageComplete).toBe(false);
    expect(review.degraded).toBe(true);
    expect(review.coverage[0]?.state).toBe("changed");
    expect(await reconciliationStatus(fixture)).toMatchObject({
      lastReviewId: review.reviewId,
      coverageState: "degraded",
    });
  });

  it("ignores retired source state after complete active coverage", async () => {
    const fixture = await makeFixture();
    await writeQueue(fixture);
    const configPath = join(fixture.rootDir, "reconciliation.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          { id: "retired", type: "markdown", paths: ["missing/*.md"] },
        ],
      })
    );
    await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    await Bun.write(
      configPath,
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const activeReview = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });

    expect(activeReview.coverageComplete).toBe(true);
    expect(await reconciliationStatus(fixture)).toMatchObject({
      lastReviewId: activeReview.reviewId,
      coverageState: "complete",
    });
    await Bun.write(
      configPath,
      JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          { id: "new-source", type: "markdown", paths: ["notes/*.md"] },
        ],
      })
    );
    expect(await reconciliationStatus(fixture)).toMatchObject({
      lastReviewId: activeReview.reviewId,
      coverageState: "degraded",
    });
    await Bun.write(configPath, JSON.stringify({ version: 1, sources: [] }));
    expect(await reconciliationStatus(fixture)).toMatchObject({
      sourceCount: 0,
      coverageState: "degraded",
    });
  });

  it("uses automation record timestamps, exposes undated degradation, and redacts JSON secrets", async () => {
    const fixture = await makeFixture();
    const logPath = join(
      fixture.homeDir,
      ".codex",
      "automations",
      "review",
      "runs",
      "events.jsonl"
    );
    await mkdir(join(logPath, ".."), { recursive: true });
    await Bun.write(
      logPath,
      [
        JSON.stringify({
          ts: "2026-06-01T00:00:00Z",
          message: "Old capability signal TICKET-700",
        }),
        JSON.stringify({
          ts: "2026-07-05T00:00:00Z",
          message: "Reconciliation verified TICKET-793",
          asset: "@project/instructions/TESTING.md",
          token: "super-secret-json-token",
          OPENAI_API_KEY: "prefixed-secret-value",
          output: "accidentally logged sk-proj-abcdefghijklmnopqrstuv",
        }),
        JSON.stringify({
          ts: "2026-07-05T00:00:00.999Z",
          message: "Later reconciliation observation",
        }),
      ].join("\n")
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "runs",
            type: "automation",
            root: "home",
            paths: [".codex/automations/**/runs/*.jsonl"],
          },
        ],
      })
    );
    const datedReview = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(datedReview.coverage[0]?.watermarkAfter).toBe(
      "2026-07-05T00:00:00.999Z"
    );
    await Bun.write(
      logPath,
      `${await Bun.file(logPath).text()}\n${JSON.stringify({ message: "Undated reconciliation signal" })}`
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(review.coverage[0]).toMatchObject({
      state: "unavailable",
      recordsScanned: 3,
    });
    expect(review.coverage[0]?.watermarkAfter).toBe("2026-07-05T00:00:00.999Z");
    expect(JSON.stringify(review)).not.toContain("super-secret-json-token");
    expect(JSON.stringify(review)).not.toContain("prefixed-secret-value");
    expect(JSON.stringify(review)).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuv"
    );
    expect(JSON.stringify(review)).not.toContain("TICKET-700");
    expect(review.signals.flatMap((signal) => signal.assetRefs)).toContain(
      "@project/instructions/TESTING.md"
    );
  });

  it("marks incomplete evidence exports unavailable", async () => {
    const fixture = await makeFixture();
    const exportPath = join(fixture.projectRoot, "issues.json");
    await Bun.write(
      exportPath,
      JSON.stringify(
        evidenceExport(
          [
            {
              id: "issue-793",
              kind: "work-item",
              observedAt: "2026-07-05T00:00:00Z",
              title: "Reconciliation implementation",
              refs: ["TICKET-793"],
            },
          ],
          {
            complete: false,
            partialReasons: [
              "producer pagination incomplete token=partial-reason-secret",
            ],
          }
        )
      )
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "issues", type: "evidence-export", path: "issues.json" },
        ],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(review.coverage[0]?.state).toBe("unavailable");
    expect(review.coverage[0]?.unavailableReason).toContain(
      "pagination incomplete"
    );
    expect(JSON.stringify(review)).not.toContain("partial-reason-secret");
    expect(review.linkedWork).toContain("TICKET-793");
  });

  it("rejects unattested and narrower evidence exports as coverage proof", async () => {
    const fixture = await makeFixture();
    const exportPath = join(fixture.projectRoot, "evidence.json");
    await Bun.write(exportPath, JSON.stringify([]));
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "external", type: "evidence-export", path: "evidence.json" },
        ],
      })
    );
    const unattested = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(unattested.coverage[0]?.state).toBe("unavailable");
    expect(unattested.coverageComplete).toBe(false);

    await Bun.write(
      exportPath,
      JSON.stringify({
        ...evidenceExport([]),
        coverage: {
          since: "2026-07-05T00:00:00Z",
          until: "2026-07-06T00:00:00Z",
          complete: true,
        },
      })
    );
    const narrower = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(narrower.coverage[0]?.state).toBe("unavailable");
    expect(narrower.emptyReason).toContain("not a proven empty review");

    await Bun.write(
      exportPath,
      JSON.stringify({
        ...evidenceExport([]),
        generatedAt: "2026-07-05T00:00:00Z",
      })
    );
    const stale = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(stale.coverage[0]?.state).toBe("unavailable");
  });

  it("keeps non-terminal exported status changes as implementation evidence", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.projectRoot, "issues.json"),
      JSON.stringify(
        evidenceExport([
          {
            id: "history-1",
            kind: "status-change",
            observedAt: "2026-07-05T12:00:00Z",
            body: "Backlog -> In Progress",
            refs: ["TICKET-900"],
          },
          {
            id: "history-2",
            kind: "status-change",
            observedAt: "2026-07-05T13:00:00Z",
            body: "Backlog -> In Progress",
            refs: ["TICKET-901"],
          },
        ])
      )
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "issues", type: "evidence-export", path: "issues.json" },
        ],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(
      review.decisions.find(
        (decision) => decision.sourceRecordId === "history-1"
      )?.classification
    ).toBe("implementation-only");
    expect(
      review.signals.every((signal) => signal.disposition === "task")
    ).toBe(true);
    expect(review.signals).toHaveLength(2);
    expect(review.signals.map((signal) => signal.issueRefs)).toEqual(
      expect.arrayContaining([["TICKET-900"], ["TICKET-901"]])
    );
  });

  it("treats a terminal exported event as outcome proof", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.projectRoot, "issues.json"),
      JSON.stringify(
        evidenceExport([
          {
            id: "comment-901",
            kind: "comment",
            observedAt: "2026-07-05T12:00:00Z",
            body: "Published reconciliation outcome",
            refs: ["TICKET-901"],
            terminal: true,
          },
        ])
      )
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "issues", type: "evidence-export", path: "issues.json" },
        ],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });

    expect(review.decisions[0]?.classification).toBe("outcome-proof");
    expect(review.decisions[0]?.sourceRecordId).toBe("comment-901");
    expect(review.signals[0]?.disposition).toBe("resolve-watch");
  });

  it("keeps reopened linked work open after the reopen event leaves the window", async () => {
    const fixture = await makeFixture();
    const exportPath = join(fixture.projectRoot, "issues.json");
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "issues", type: "evidence-export", path: "issues.json" },
        ],
      })
    );
    const writeEvents = async (
      events: Record<string, unknown>[]
    ): Promise<void> => {
      await Bun.write(exportPath, JSON.stringify(evidenceExport(events)));
    };
    const run = () =>
      reconcileSources({
        ...fixture,
        since: "2026-07-03",
        until: "2026-07-10",
      });

    await writeEvents([
      {
        id: "open",
        kind: "status-change",
        observedAt: "2026-07-05T10:00:00Z",
        refs: ["HACK-1200"],
        status: "in_progress",
      },
    ]);
    const opened = await run();
    const familyId = opened.signals[0]?.familyId;
    if (!familyId) {
      throw new Error("expected a linked-work family");
    }

    await writeEvents([
      {
        id: "done",
        kind: "status-change",
        observedAt: "2026-07-06T10:00:00Z",
        refs: ["HACK-1200"],
        status: "done",
      },
    ]);
    expect((await run()).resolvedSignalFamilies).toContain(familyId);

    await writeEvents([
      {
        id: "reopened",
        kind: "status-change",
        observedAt: "2026-07-07T10:00:00Z",
        refs: ["HACK-1200"],
        status: "in_progress",
      },
    ]);
    expect((await run()).resolvedSignalFamilies).not.toContain(familyId);

    await writeEvents([]);
    expect((await run()).resolvedSignalFamilies).not.toContain(familyId);
  });

  it("migrates persisted terminal linked-work proof from pre-status state", async () => {
    const fixture = await makeFixture();
    const exportPath = join(fixture.projectRoot, "issues.json");
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "issues", type: "evidence-export", path: "issues.json" },
        ],
      })
    );
    const run = () =>
      reconcileSources({
        ...fixture,
        since: "2026-07-03",
        until: "2026-07-10",
      });
    await Bun.write(
      exportPath,
      JSON.stringify(
        evidenceExport([
          {
            id: "open",
            kind: "status-change",
            observedAt: "2026-07-05T10:00:00Z",
            refs: ["HACK-1202"],
            status: "in_progress",
          },
        ])
      )
    );
    const opened = await run();
    const familyId = opened.signals[0]?.familyId;
    if (!familyId) {
      throw new Error("expected a linked-work family");
    }
    await Bun.write(
      exportPath,
      JSON.stringify(
        evidenceExport([
          {
            id: "done",
            kind: "status-change",
            observedAt: "2026-07-06T10:00:00Z",
            refs: ["HACK-1202"],
            status: "done",
          },
        ])
      )
    );
    expect((await run()).resolvedSignalFamilies).toContain(familyId);

    const statePath = facultAiReconciliationStatePath(
      fixture.homeDir,
      fixture.rootDir
    );
    const legacyState = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    legacyState.linkedWorkStatuses = undefined;
    await Bun.write(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);
    await Bun.write(exportPath, JSON.stringify(evidenceExport([])));

    expect((await run()).resolvedSignalFamilies).toContain(familyId);
    const migratedState = JSON.parse(await readFile(statePath, "utf8")) as {
      linkedWorkStatuses?: Record<string, { sourceType?: string }>;
    };
    expect(migratedState.linkedWorkStatuses?.["HACK-1202"]).toMatchObject({
      sourceType: "evidence-export",
    });
  });

  it("resolves linked-work families from bounded terminal status readback", async () => {
    const fixture = await makeFixture();
    const linkedWork = [
      ["HACK-812", "done"],
      ["HACK-924", "completed"],
      ["HACK-934", "canceled"],
      ["HACK-939", "obsolete"],
      ["LNHACK-625", "duplicate"],
    ] as const;
    await Bun.write(
      join(fixture.projectRoot, "issues.json"),
      JSON.stringify(
        evidenceExport(
          linkedWork.map(([issue, status], index) => ({
            id: `status-${index + 1}`,
            kind: "status-change",
            observedAt: `2026-07-05T1${index}:00:00Z`,
            title: `${issue} is ${status}`,
            refs: [issue],
            status,
          }))
        )
      )
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "linear-export", type: "evidence-export", path: "issues.json" },
        ],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });

    expect(review.coverageComplete).toBe(true);
    expect(review.linkedWork).toEqual(linkedWork.map(([issue]) => issue));
    expect(review.signals).toHaveLength(linkedWork.length);
    expect(review.signals.every((signal) => !signal.unresolved)).toBe(true);
    expect(
      review.signals.every((signal) => signal.disposition === "resolve-watch")
    ).toBe(true);
    expect(review.resolutionProofs).toHaveLength(linkedWork.length);
    expect(review.resolutionProofs.map((proof) => proof.status).sort()).toEqual(
      linkedWork.map(([, status]) => status).sort()
    );
  });

  it("targets the project asset for apply-local dispositions", async () => {
    const fixture = await makeFixture();
    const notesDir = join(fixture.projectRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    await Bun.write(
      join(notesDir, "signal.md"),
      "# 2026-07-05 capability signal\n\n@ai/instructions/GLOBAL.md and @project/instructions/LOCAL.md\n"
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "notes", type: "markdown", paths: ["notes/*.md"] }],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(review.signals[0]).toMatchObject({
      disposition: "apply-local",
      dispositionTarget: "@project/instructions/LOCAL.md",
    });
    expect(review.unresolvedSignals).toContain(review.signals[0]!.id);
  });

  it("extracts canonical assets from Markdown links", async () => {
    const fixture = await makeFixture();
    const notesDir = join(fixture.projectRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    await Bun.write(
      join(notesDir, "signal.md"),
      "# 2026-07-05 capability signal\n\nSee [the rule](@project/instructions/TESTING.md) and [@project/instructions/TESTING.md](./target).\n"
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "notes", type: "markdown", paths: ["notes/*.md"] }],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });

    expect(review.signals[0]?.assetRefs).toEqual([
      "@project/instructions/TESTING.md",
    ]);
  });

  it("does not correlate unrelated Markdown sections by file path", async () => {
    const fixture = await makeFixture();
    const logPath = join(fixture.projectRoot, "notes", "review-log.md");
    await mkdir(join(logPath, ".."), { recursive: true });
    await Bun.write(
      logPath,
      [
        "## 2026-07-08 Verification gap",
        "Capability verification needs a packaged runtime check.",
        "",
        "## 2026-07-09 Runbook gap",
        "The deployment runbook needs an explicit rollback step.",
      ].join("\n")
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "review-log",
            type: "markdown",
            root: "project",
            paths: ["notes/review-log.md"],
          },
        ],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(review.signals).toHaveLength(2);
    expect(review.signals.map((signal) => signal.title).sort()).toEqual([
      "2026-07-08 Verification gap",
      "2026-07-09 Runbook gap",
    ]);
  });

  it("preserves invalid state and reports it separately from configuration", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const statePath = facultAiReconciliationStatePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(join(statePath, ".."), { recursive: true });
    await Bun.write(statePath, "{corrupt-state");
    const status = await reconciliationStatus(fixture);
    expect(status).toMatchObject({
      configured: true,
      configurationState: "ready",
      coverageState: "degraded",
    });
    expect(status.stateError).toContain("file was preserved");
    await expect(
      reconcileSources({
        ...fixture,
        since: "2026-07-03T00:00:00Z",
        until: "2026-07-10T00:00:00Z",
      })
    ).rejects.toThrow("Invalid reconciliation state");
    expect(await Bun.file(statePath).text()).toBe("{corrupt-state");
  });

  it("preserves multiline Git body evidence", async () => {
    const fixture = await makeFixture();
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["init", "--quiet"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["config", "user.email", "fixture@example.invalid"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["config", "user.name", "Fixture"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["config", "diff.fail.textconv", "false"],
    });
    await Bun.write(
      join(fixture.projectRoot, ".gitattributes"),
      "notes.txt diff=fail\n"
    );
    await Bun.write(join(fixture.projectRoot, "notes.txt"), "updated\n");
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "."],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: [
        "commit",
        "--quiet",
        "-m",
        "chore: update notes",
        "-m",
        "First body paragraph.",
        "-m",
        "Capability reconciliation evidence for TICKET-793.",
      ],
      date: "2026-07-05T12:00:00Z",
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "git", type: "git" }],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(review.linkedWork).toContain("TICKET-793");
    expect(review.decisions[0]?.classification).toBe("capability-source");
  });

  it("treats an unborn Git repository as checked empty", async () => {
    const fixture = await makeFixture();
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["init", "--quiet"],
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "git", type: "git" }],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(review.coverageComplete).toBe(true);
    expect(review.coverage[0]).toMatchObject({
      state: "checked",
      recordsScanned: 0,
    });
  });

  it("does not use a develop or feature HEAD as default-branch proof", async () => {
    const fixture = await makeFixture();
    for (const argv of [
      ["init", "--quiet", "--initial-branch=develop"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
      ["commit", "--allow-empty", "--quiet", "-m", "chore: develop base"],
      ["switch", "--quiet", "-c", "feature"],
    ]) {
      await runFixtureGit({ projectRoot: fixture.projectRoot, argv });
    }
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "git", type: "git" }],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      persist: false,
    });

    expect(review.coverageComplete).toBe(false);
    expect(review.coverage[0]).toMatchObject({
      state: "unavailable",
      recordsScanned: 0,
    });
    expect(review.coverage[0]?.unavailableReason).toContain(
      "Git default branch is unavailable"
    );
  });

  it("separates complete coverage from a cursor stale after newer repository activity", async () => {
    const fixture = await makeFixture();
    for (const argv of [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
    ]) {
      await runFixtureGit({ projectRoot: fixture.projectRoot, argv });
    }
    await mkdir(join(fixture.projectRoot, "docs"), { recursive: true });
    await Bun.write(
      join(fixture.projectRoot, "docs", "review.md"),
      "Capability review HACK-939.\n"
    );
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "docs"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "docs: record HACK-939 review"],
      date: "2026-07-23T18:12:45-04:00",
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
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
      })
    );
    const first = await reconcileSources({
      ...fixture,
      since: "2026-07-23T00:00:00-04:00",
      until: "2026-07-23T18:15:00-04:00",
      incremental: true,
    });
    expect(first.coverageComplete).toBe(true);
    expect(first.freshness.state).toBe("current");

    await Bun.write(join(fixture.projectRoot, "outside.txt"), "new activity\n");
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "outside.txt"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "fix: newer repository activity"],
      date: "2026-07-23T18:28:50-04:00",
    });
    const statePath = facultAiReconciliationStatePath(
      fixture.homeDir,
      fixture.rootDir
    );
    const stateBefore = await readFile(statePath, "utf8");
    const preview = await reconcileSources({
      ...fixture,
      since: "2026-07-23T00:00:00-04:00",
      until: "2026-07-27T23:04:10Z",
      incremental: true,
      persist: false,
    });

    expect(preview.coverageComplete).toBe(true);
    expect(preview.degraded).toBe(false);
    expect(preview.coverage[0]).toMatchObject({
      state: "checked",
      recordsScanned: 0,
      freshness: {
        state: "stale",
        reason: "newer_repository_activity",
        alert: true,
        cursorAt: "2026-07-23T18:12:45-04:00",
        latestSourceAt: "2026-07-23T18:28:50-04:00",
      },
    });
    expect(preview.freshness).toMatchObject({
      state: "stale",
      staleSourceIds: ["git"],
      alertSourceIds: ["git"],
    });
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  });

  it("bounds repository freshness activity to the review window", async () => {
    const fixture = await makeFixture();
    for (const argv of [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
    ]) {
      await runFixtureGit({ projectRoot: fixture.projectRoot, argv });
    }
    await mkdir(join(fixture.projectRoot, "docs"), { recursive: true });
    await Bun.write(
      join(fixture.projectRoot, "docs", "review.md"),
      "Capability cursor baseline.\n"
    );
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "docs"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "docs: establish cursor"],
      date: "2026-01-02T12:00:00.000Z",
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
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
      })
    );
    await reconcileSources({
      ...fixture,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T23:59:59.999Z",
      incremental: true,
    });

    await Bun.write(join(fixture.projectRoot, "jan-4.txt"), "activity\n");
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "jan-4.txt"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "chore: January 4 activity"],
      date: "2026-01-04T12:00:00.000Z",
    });
    await Bun.write(join(fixture.projectRoot, "jan-10.txt"), "later tip\n");
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "jan-10.txt"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "chore: January 10 tip"],
      date: "2026-01-10T12:00:00.000Z",
    });

    const review = await reconcileSources({
      ...fixture,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-05T23:59:59.999Z",
      incremental: true,
      persist: false,
    });

    expect(review.coverage[0]).toMatchObject({
      freshness: {
        state: "stale",
        reason: "newer_repository_activity",
        cursorAt: "2026-01-02T12:00:00Z",
        latestSourceAt: "2026-01-04T12:00:00Z",
      },
    });
  });

  it("checks exact Git evidence against the configured default branch", async () => {
    const fixture = await makeFixture();
    for (const argv of [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
      ["commit", "--allow-empty", "--quiet", "-m", "chore: base"],
      ["switch", "--quiet", "-c", "implementation"],
    ]) {
      await runFixtureGit({ projectRoot: fixture.projectRoot, argv });
    }
    await mkdir(join(fixture.projectRoot, "docs"), { recursive: true });
    await Bun.write(
      join(fixture.projectRoot, "docs", "setup.md"),
      "Setup safety implementation for HACK-934.\n"
    );
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "docs"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "fix: complete HACK-934 setup safety"],
      date: "2026-07-05T12:00:00Z",
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "git",
            type: "git",
            paths: ["docs"],
            defaultBranch: "main",
          },
        ],
      })
    );
    const beforeMerge = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      persist: false,
    });
    expect(beforeMerge.linkedWork).not.toContain("HACK-934");

    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["switch", "--quiet", "main"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["merge", "--ff-only", "implementation"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["switch", "--quiet", "implementation"],
    });
    const merged = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      persist: false,
    });

    expect(merged.linkedWork).toContain("HACK-934");
    expect(merged.signals[0]).toMatchObject({
      disposition: "resolve-watch",
      unresolved: false,
    });
    expect(merged.evidence[0]?.provenance).toContainEqual(
      expect.objectContaining({
        defaultBranch: "main",
        onDefaultBranch: true,
        terminal: true,
      })
    );
  });

  it("revalidates containment after a default-branch rewrite and tolerates a pruned commit", async () => {
    const fixture = await makeFixture();
    for (const argv of [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
      ["commit", "--allow-empty", "--quiet", "-m", "chore: base"],
    ]) {
      await runFixtureGit({ projectRoot: fixture.projectRoot, argv });
    }
    const base = await fixtureGitOutput({
      projectRoot: fixture.projectRoot,
      argv: ["rev-parse", "HEAD"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["switch", "--quiet", "-c", "implementation"],
    });
    await mkdir(join(fixture.projectRoot, "docs"), { recursive: true });
    await Bun.write(
      join(fixture.projectRoot, "docs", "fix.md"),
      "Capability reconciliation fix for HACK-1201.\n"
    );
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", "docs"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "fix: complete HACK-1201 capability"],
      date: "2026-07-05T12:00:00Z",
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "git",
            type: "git",
            allBranches: true,
            defaultBranch: "main",
          },
        ],
      })
    );
    const run = () =>
      reconcileSources({
        ...fixture,
        since: "2026-07-03",
        until: "2026-07-10",
      });
    const pending = await run();
    const familyId = pending.signals[0]?.familyId;
    if (!familyId) {
      throw new Error("expected a Git evidence family");
    }
    expect(pending.resolvedSignalFamilies).not.toContain(familyId);

    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["switch", "--quiet", "main"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["merge", "--ff-only", "implementation"],
    });
    expect((await run()).resolvedSignalFamilies).toContain(familyId);

    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["reset", "--hard", base],
    });
    expect((await run()).resolvedSignalFamilies).not.toContain(familyId);

    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["branch", "-D", "implementation"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["reflog", "expire", "--expire=now", "--all"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["gc", "--prune=now"],
    });
    const afterPrune = await run();
    expect(afterPrune.coverageComplete).toBe(true);
    expect(afterPrune.resolvedSignalFamilies).not.toContain(familyId);
  });

  it("recovers an abandoned reconciliation lock left by a crashed enrollment", async () => {
    const fixture = await makeFixture();
    await Bun.write(join(fixture.projectRoot, "quiet.md"), "No signal.\n");
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "notes", type: "markdown", paths: ["quiet.md"] }],
      })
    );
    const lockPath = facultAiReconciliationLockPath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(dirname(lockPath), { recursive: true });
    await Bun.write(
      lockPath,
      `${JSON.stringify({
        pid: 999_999,
        token: "abandoned-enrollment",
        startedAt: "2026-01-01T00:00:00.000Z",
        processStartedAt: "darwin:abandoned",
        operation: "project-enrollment-state-migration",
      })}\n`
    );
    const staleAt = new Date("2026-01-01T00:00:00.000Z");
    await utimes(lockPath, staleAt, staleAt);

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });

    expect(review.coverageComplete).toBe(true);
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  it("recovers an abandoned reconciliation takeover claim", async () => {
    const fixture = await makeFixture();
    await Bun.write(join(fixture.projectRoot, "quiet.md"), "No signal.\n");
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "notes", type: "markdown", paths: ["quiet.md"] }],
      })
    );
    const lockPath = facultAiReconciliationLockPath(
      fixture.homeDir,
      fixture.rootDir
    );
    const takeoverPath = `${lockPath}.takeover`;
    await mkdir(dirname(lockPath), { recursive: true });
    const abandoned = `${JSON.stringify({
      pid: 999_999,
      token: "abandoned",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartedAt: "darwin:abandoned",
    })}\n`;
    await Bun.write(lockPath, abandoned);
    await Bun.write(takeoverPath, abandoned);
    const staleAt = new Date("2026-01-01T00:00:00.000Z");
    await utimes(lockPath, staleAt, staleAt);
    await utimes(takeoverPath, staleAt, staleAt);

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });

    expect(review.coverageComplete).toBe(true);
    expect(await Bun.file(lockPath).exists()).toBe(false);
    expect(await Bun.file(takeoverPath).exists()).toBe(false);
    expect(
      (await readdir(dirname(lockPath))).some((name) =>
        name.startsWith(`${basename(takeoverPath)}.stale-`)
      )
    ).toBe(true);
  });

  it("reports unavailable cursor freshness without changing coverage semantics", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "missing", type: "markdown", paths: ["missing.md"] }],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
      persist: false,
    });

    expect(review.coverageComplete).toBe(false);
    expect(review.coverage[0]).toMatchObject({
      state: "unavailable",
      freshness: {
        state: "unknown",
        reason: "source_unavailable",
        alert: false,
      },
    });
    expect(review.freshness).toMatchObject({
      state: "unknown",
      unknownSourceIds: ["missing"],
      alertSourceIds: [],
    });
  });

  it("enforces the file scan cap across multiple patterns", async () => {
    const fixture = await makeFixture();
    const logDir = join(fixture.projectRoot, "logs");
    await mkdir(logDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        Bun.write(
          join(logDir, `${index < 500 ? "a" : "b"}-${index}.md`),
          `# Capability signal ${index}\n`
        )
      )
    );
    await Promise.all(
      (await readdir(logDir)).map((name) =>
        utimes(
          join(logDir, name),
          new Date("2026-07-10T00:00:00.000Z"),
          new Date("2026-07-10T00:00:00.000Z")
        )
      )
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "logs",
            type: "markdown",
            paths: ["logs/a-*.md", "logs/b-*.md"],
          },
        ],
      })
    );

    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-12",
    });
    expect(review.coverage[0]?.recordsScanned).toBe(500);
    expect(review.coverage[0]).toMatchObject({
      state: "stale",
      staleReason: "File scan truncated at the 500-file safety cap",
    });
    expect(review.coverageComplete).toBe(false);
  });

  it("deduplicates overlapping glob matches before the file cap", async () => {
    const fixture = await makeFixture();
    const logDir = join(fixture.projectRoot, "logs");
    await mkdir(logDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        Bun.write(join(logDir, `entry-${index}.md`), "No signal.\n")
      )
    );
    await Promise.all(
      (await readdir(logDir)).map((name) =>
        utimes(
          join(logDir, name),
          new Date("2026-07-10T00:00:00.000Z"),
          new Date("2026-07-10T00:00:00.000Z")
        )
      )
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "logs",
            type: "markdown",
            paths: ["logs/*.md", "logs/entry-*.md"],
          },
        ],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-12",
    });
    expect(review.coverage[0]).toMatchObject({
      state: "changed",
      recordsScanned: 300,
    });
  });

  it("deduplicates a renamed capability patch across branches and overlapping windows", async () => {
    const fixture = await makeFixture();
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["init", "--quiet"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["config", "user.email", "fixture@example.invalid"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["config", "user.name", "Fixture"],
    });
    const firstPath = join(fixture.rootDir, "instructions", "SOURCE.md");
    await mkdir(join(fixture.rootDir, "instructions"), { recursive: true });
    await Bun.write(
      firstPath,
      "# Source\n\nReconcile TICKET-793 capability signal.\n"
    );
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", ".ai"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: [
        "commit",
        "--quiet",
        "-m",
        "docs: add TICKET-793 capability source",
      ],
      date: "2026-07-04T12:00:00Z",
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: [
        "mv",
        ".ai/instructions/SOURCE.md",
        ".ai/instructions/RECONCILIATION.md",
      ],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: [
        "commit",
        "--quiet",
        "-m",
        "docs: rename TICKET-793 capability source",
      ],
      date: "2026-07-05T12:00:00Z",
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["branch", "duplicate-branch", "HEAD"],
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "git",
            type: "git",
            repository: "project",
            allBranches: true,
            paths: [".ai"],
          },
        ],
      })}\n`
    );

    const full = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(full.evidence).toHaveLength(2);
    expect(full.signals).toHaveLength(1);
    expect(full.signals[0]?.issueRefs).toEqual(["TICKET-793"]);

    const overlap = await reconcileSources({
      ...fixture,
      since: "2026-07-05T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(overlap.evidence).toHaveLength(1);
    expect(overlap.evidence[0]?.isNew).toBe(false);
  });

  it("deduplicates equivalent canonical patches from distinct branch commits", async () => {
    const fixture = await makeFixture();
    for (const argv of [
      ["init", "--quiet"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
    ]) {
      await runFixtureGit({ projectRoot: fixture.projectRoot, argv });
    }
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--allow-empty", "--quiet", "-m", "chore: base"],
      date: "2026-07-03T12:00:00Z",
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["branch", "branch-a"],
    });
    const capabilityPath = join(
      fixture.rootDir,
      "instructions",
      "RECONCILIATION.md"
    );
    await mkdir(join(capabilityPath, ".."), { recursive: true });
    await Bun.write(capabilityPath, "# Reconciliation\n\nTrack TICKET-793.\n");
    await Bun.write(join(fixture.projectRoot, "outside.txt"), "branch a\n");
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", ".ai", "outside.txt"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "feat: branch a reconciliation"],
      date: "2026-07-04T12:00:00Z",
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["switch", "--quiet", "-c", "branch-b", "HEAD~1"],
    });
    await mkdir(join(capabilityPath, ".."), { recursive: true });
    await Bun.write(capabilityPath, "# Reconciliation\n\nTrack TICKET-793.\n");
    await Bun.write(join(fixture.projectRoot, "outside.txt"), "branch b\n");
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", ".ai", "outside.txt"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "feat: branch b reconciliation"],
      date: "2026-07-05T12:00:00Z",
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "git",
            type: "git",
            allBranches: true,
            paths: [".ai/instructions"],
          },
        ],
      })
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(review.coverage[0]?.recordsScanned).toBe(2);
    expect(review.evidence).toHaveLength(1);
    expect(review.evidence[0]?.sourceRecordIds).toHaveLength(2);
  });

  it("permits a proven empty review only after every configured source is checked", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })}\n`
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(review.coverageComplete).toBe(true);
    expect(review.degraded).toBe(false);
    expect(review.signals).toHaveLength(0);
    expect(review.emptyReason).toContain("every configured source was checked");
  });

  it("windows dated memory sections and prevents high-fanout ledgers from merging signals", async () => {
    const fixture = await makeFixture();
    await writeQueue(fixture);
    const memoryPath = join(
      fixture.homeDir,
      ".codex",
      "automations",
      "weekly-review",
      "memory.md"
    );
    await mkdir(join(memoryPath, ".."), { recursive: true });
    await Bun.write(
      memoryPath,
      [
        "# Memory",
        "",
        "## 2026-06-19 12:00 EDT",
        "Old capability signal TICKET-700 WB-00001.",
        "",
        "## 2026-07-10 12:00 EDT",
        "Ledger links WB-00020 WB-00021 to TICKET-793 TICKET-794 without making them one signal.",
      ].join("\n")
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          {
            id: "memory",
            type: "automation",
            root: "home",
            paths: [".codex/automations/**/memory.md"],
          },
        ],
      })}\n`
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-11T00:00:00Z",
    });
    expect(
      review.coverage.find((entry) => entry.sourceId === "memory")
        ?.recordsScanned
    ).toBe(1);
    expect(
      review.coverage.find((entry) => entry.sourceId === "memory")?.state
    ).not.toBe("unavailable");
    const wb20 = review.signals.find(
      (signal) =>
        signal.writebackRefs.includes("WB-00020") &&
        signal.sourceIds.includes("writebacks")
    );
    const wb21 = review.signals.find(
      (signal) =>
        signal.writebackRefs.includes("WB-00021") &&
        signal.sourceIds.includes("writebacks")
    );
    expect(wb20?.id).not.toBe(wb21?.id);
    expect(wb20?.disposition).toBe("task");
    expect(wb21?.disposition).toBe("resolve-watch");
  });
});
