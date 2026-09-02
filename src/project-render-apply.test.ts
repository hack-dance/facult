import { describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildProjectRenderPlan } from "./project-render";
import {
  applyProjectRender,
  rollbackProjectRender,
} from "./project-render-apply";
import { createProjectRenderLock } from "./project-render-lock";

const MANIFEST = `schema_version = 1
exclusive_roots = [".agents/skills"]

[[targets]]
id = "root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["AGENTS.project.md"]

[[targets]]
id = "review-skill"
tool = "codex"
destination = ".agents/skills/review/SKILL.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["skills/review/SKILL.md"]
`;

interface ApplyFixture {
  canonicalRoot: string;
  projectRoot: string;
  stateRoot: string;
}

async function createFixture(): Promise<ApplyFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "fclt-project-apply-"));
  const canonicalRoot = join(projectRoot, ".ai");
  const stateRoot = await mkdtemp(join(tmpdir(), "fclt-project-state-"));
  await chmod(stateRoot, 0o700);
  await mkdir(join(canonicalRoot, "skills", "review"), { recursive: true });
  await writeFile(join(canonicalRoot, "project-render.toml"), MANIFEST);
  await writeFile(join(canonicalRoot, "AGENTS.project.md"), "# Agents\n");
  await writeFile(
    join(canonicalRoot, "skills", "review", "SKILL.md"),
    "# Review\n"
  );
  return { canonicalRoot, projectRoot, stateRoot };
}

function applyOptions(fixture: ApplyFixture) {
  return {
    canonicalRoot: fixture.canonicalRoot,
    projectRoot: fixture.projectRoot,
    stateRoot: fixture.stateRoot,
  };
}

async function stateEntries(fixture: ApplyFixture): Promise<string[]> {
  return (await readdir(fixture.stateRoot)).sort();
}

describe("transactional project rendering", () => {
  it("materializes missing targets, records ownership, and becomes idempotent", async () => {
    const fixture = await createFixture();

    const first = await applyProjectRender(applyOptions(fixture));

    expect(first).toMatchObject({
      changed: true,
      recovered: false,
      removed: 0,
      schemaVersion: 1,
      written: 2,
    });
    expect(await readFile(join(fixture.projectRoot, "AGENTS.md"), "utf8")).toBe(
      "# Agents\n"
    );
    expect(
      await readFile(
        join(fixture.projectRoot, ".agents", "skills", "review", "SKILL.md"),
        "utf8"
      )
    ).toBe("# Review\n");
    expect(await stateEntries(fixture)).toEqual([
      "mutation.lock",
      "receipt.json",
    ]);

    const second = await applyProjectRender(applyOptions(fixture));
    expect(second).toEqual({
      ...first,
      changed: false,
      recovered: false,
      written: 0,
    });
  });

  it("updates only receipt-owned targets and rejects external target drift", async () => {
    const fixture = await createFixture();
    await applyProjectRender(applyOptions(fixture));
    await writeFile(
      join(fixture.canonicalRoot, "AGENTS.project.md"),
      "# Updated\n"
    );

    const update = await applyProjectRender(applyOptions(fixture));

    expect(update.written).toBe(1);
    expect(await readFile(join(fixture.projectRoot, "AGENTS.md"), "utf8")).toBe(
      "# Updated\n"
    );
    await writeFile(join(fixture.projectRoot, "AGENTS.md"), "human edit\n");
    await writeFile(
      join(fixture.canonicalRoot, "AGENTS.project.md"),
      "# Later\n"
    );
    await expect(applyProjectRender(applyOptions(fixture))).rejects.toThrow(
      "refuses to overwrite modified or unowned target"
    );
    expect(await readFile(join(fixture.projectRoot, "AGENTS.md"), "utf8")).toBe(
      "human edit\n"
    );
  });

  it("refuses exact and differing unowned targets without creating a receipt", async () => {
    for (const existing of ["# Agents\n", "different\n"]) {
      const fixture = await createFixture();
      await writeFile(join(fixture.projectRoot, "AGENTS.md"), existing);

      await expect(applyProjectRender(applyOptions(fixture))).rejects.toThrow(
        existing === "# Agents\n"
          ? "refuses to adopt unowned target"
          : "refuses to overwrite modified or unowned target"
      );

      expect(
        await readFile(join(fixture.projectRoot, "AGENTS.md"), "utf8")
      ).toBe(existing);
      expect(await stateEntries(fixture)).toEqual(["mutation.lock"]);
    }
  });

  it("removes only stale receipt-owned targets and preserves unrelated files", async () => {
    const fixture = await createFixture();
    await applyProjectRender(applyOptions(fixture));
    const unrelated = join(fixture.projectRoot, "notes.txt");
    await writeFile(unrelated, "keep\n");
    await writeFile(
      join(fixture.canonicalRoot, "project-render.toml"),
      `schema_version = 1
exclusive_roots = []

[[targets]]
id = "root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["AGENTS.project.md"]
`
    );

    const result = await applyProjectRender(applyOptions(fixture));

    expect(result.removed).toBe(1);
    expect(
      await lstat(
        join(fixture.projectRoot, ".agents", "skills", "review", "SKILL.md")
      ).catch(() => null)
    ).toBeNull();
    expect(await readFile(unrelated, "utf8")).toBe("keep\n");
  });

  it("commits ownership cleanup when a stale owned target is already absent", async () => {
    const fixture = await createFixture();
    await applyProjectRender(applyOptions(fixture));
    await unlink(
      join(fixture.projectRoot, ".agents", "skills", "review", "SKILL.md")
    );
    await writeFile(
      join(fixture.canonicalRoot, "project-render.toml"),
      `schema_version = 1
exclusive_roots = []

[[targets]]
id = "root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["AGENTS.project.md"]
`
    );

    const cleanup = await applyProjectRender(applyOptions(fixture));
    expect(cleanup).toMatchObject({
      changed: true,
      removed: 0,
      written: 0,
    });
    const receipt = JSON.parse(
      await readFile(join(fixture.stateRoot, "receipt.json"), "utf8")
    ) as { ownership: { targets: Array<{ path: string }> } };
    expect(receipt.ownership.targets.map((target) => target.path)).toEqual([
      "AGENTS.md",
    ]);
    expect(await applyProjectRender(applyOptions(fixture))).toMatchObject({
      changed: false,
    });
  });

  it("preserves custom required lock policy throughout apply revalidation", async () => {
    const fixture = await createFixture();
    const artifactPath = join(fixture.projectRoot, "fclt-artifact");
    await writeFile(artifactPath, "compiled-fclt-artifact-v1\n");
    const unlockedPlan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
      skipLockVerification: true,
    });
    await createProjectRenderLock({
      canonicalRoot: fixture.canonicalRoot,
      compilerArtifacts: { "darwin-arm64": artifactPath },
      compilerCompatibility: ">=2.28.0 <3.0.0",
      lock: "custom.lock.json",
      packSchemaVersion: 1,
      packVersion: "test-pack",
      plan: unlockedPlan,
    });
    const options = {
      ...applyOptions(fixture),
      compilerArtifactPath: artifactPath,
      compilerArtifactPlatform: "darwin-arm64",
      lock: "custom.lock.json",
      requireLock: true,
    };

    await expect(
      applyProjectRender({
        ...options,
        hooks: {
          beforeOperation: async ({ index }) => {
            if (index === 0) {
              await unlink(join(fixture.canonicalRoot, "custom.lock.json"));
            }
          },
        },
      })
    ).rejects.toThrow("lock does not exist: custom.lock.json");
    expect(await stateEntries(fixture)).toEqual([
      "mutation.lock",
      "transaction.json",
    ]);
  });

  it("refuses unexpected unowned files inside exclusive roots", async () => {
    const fixture = await createFixture();
    const unexpected = join(
      fixture.projectRoot,
      ".agents",
      "skills",
      "other",
      "SKILL.md"
    );
    await mkdir(dirname(unexpected), { recursive: true });
    await writeFile(unexpected, "unowned\n");

    await expect(applyProjectRender(applyOptions(fixture))).rejects.toThrow(
      "refuses unowned output"
    );
    expect(await readFile(unexpected, "utf8")).toBe("unowned\n");
  });

  it("recovers an interrupted partial apply before retrying the same plan", async () => {
    const fixture = await createFixture();
    await expect(
      applyProjectRender({
        ...applyOptions(fixture),
        hooks: {
          afterOperation: async ({ index }) => {
            await Promise.resolve();
            if (index === 0) {
              throw new Error("simulated interruption");
            }
          },
        },
      })
    ).rejects.toThrow("simulated interruption");
    expect(await stateEntries(fixture)).toEqual([
      "mutation.lock",
      "transaction.json",
    ]);

    const retry = await applyProjectRender(applyOptions(fixture));

    expect(retry).toMatchObject({ changed: true, recovered: true, written: 2 });
    expect(await stateEntries(fixture)).toEqual([
      "mutation.lock",
      "receipt.json",
    ]);
  });

  it("recovers when every target committed but the ownership receipt did not", async () => {
    const fixture = await createFixture();
    await expect(
      applyProjectRender({
        ...applyOptions(fixture),
        hooks: {
          beforeReceiptCommit: async () => {
            await Promise.resolve();
            throw new Error("receipt commit interruption");
          },
        },
      })
    ).rejects.toThrow("receipt commit interruption");
    expect(
      await Bun.file(join(fixture.projectRoot, "AGENTS.md")).exists()
    ).toBe(true);

    const retry = await applyProjectRender(applyOptions(fixture));

    expect(retry).toMatchObject({ changed: true, recovered: true, written: 2 });
    expect(await stateEntries(fixture)).toEqual([
      "mutation.lock",
      "receipt.json",
    ]);
  });

  it("fails recovery if an interrupted target was edited externally", async () => {
    const fixture = await createFixture();
    await expect(
      applyProjectRender({
        ...applyOptions(fixture),
        hooks: {
          afterOperation: async ({ index }) => {
            await Promise.resolve();
            if (index === 0) {
              throw new Error("simulated interruption");
            }
          },
        },
      })
    ).rejects.toThrow("simulated interruption");
    await writeFile(
      join(fixture.projectRoot, ".agents", "skills", "review", "SKILL.md"),
      "external\n"
    );

    await expect(applyProjectRender(applyOptions(fixture))).rejects.toThrow(
      "modified externally"
    );
  });

  it("rejects source drift and target races at the final commit boundary", async () => {
    const sourceFixture = await createFixture();
    await expect(
      applyProjectRender({
        ...applyOptions(sourceFixture),
        hooks: {
          beforeTargetCommit: async ({ index }) => {
            if (index === 0) {
              await writeFile(
                join(sourceFixture.canonicalRoot, "AGENTS.project.md"),
                "changed during apply\n"
              );
            }
          },
        },
      })
    ).rejects.toThrow("manifest or inputs changed during apply");

    const targetFixture = await createFixture();
    await expect(
      applyProjectRender({
        ...applyOptions(targetFixture),
        hooks: {
          beforeTargetCommit: async ({ index }) => {
            if (index === 0) {
              await writeFile(
                join(
                  targetFixture.projectRoot,
                  ".agents",
                  "skills",
                  "review",
                  "SKILL.md"
                ),
                "raced\n"
              );
            }
          },
        },
      })
    ).rejects.toThrow("changed before commit");
  });

  it("rejects a target parent replacement at the commit boundary", async () => {
    const fixture = await createFixture();
    const reviewParent = join(
      fixture.projectRoot,
      ".agents",
      "skills",
      "review"
    );
    await expect(
      applyProjectRender({
        ...applyOptions(fixture),
        hooks: {
          beforeTargetCommit: async ({ index }) => {
            if (index !== 0) {
              return;
            }
            await rename(reviewParent, `${reviewParent}-parked`);
            await mkdir(reviewParent);
          },
        },
      })
    ).rejects.toThrow("target parent changed before commit");
  });

  it("rejects concurrent mutations with a non-stale advisory lock", async () => {
    const fixture = await createFixture();
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = applyProjectRender({
      ...applyOptions(fixture),
      hooks: {
        beforeOperation: async ({ index }) => {
          if (index === 0) {
            entered?.();
            await blocked;
          }
        },
      },
    });
    await enteredPromise;

    await expect(applyProjectRender(applyOptions(fixture))).rejects.toThrow(
      "already running"
    );
    unblock?.();
    await first;
  });

  it("fails closed on a malformed ownership receipt", async () => {
    const fixture = await createFixture();
    await applyProjectRender(applyOptions(fixture));
    await writeFile(join(fixture.stateRoot, "receipt.json"), "{}\n");

    await expect(applyProjectRender(applyOptions(fixture))).rejects.toThrow(
      "unsupported schema"
    );
  });

  it("rolls back a completed apply and can recover an interrupted rollback", async () => {
    const firstApplyFixture = await createFixture();
    await applyProjectRender(applyOptions(firstApplyFixture));

    const firstRollback = await rollbackProjectRender(
      applyOptions(firstApplyFixture)
    );

    expect(firstRollback).toEqual({
      planId: null,
      restored: 2,
      schemaVersion: 1,
    });
    expect(
      await lstat(join(firstApplyFixture.projectRoot, "AGENTS.md")).catch(
        () => null
      )
    ).toBeNull();
    expect(await stateEntries(firstApplyFixture)).toEqual(["mutation.lock"]);

    const updateFixture = await createFixture();
    const initial = await applyProjectRender(applyOptions(updateFixture));
    await writeFile(
      join(updateFixture.canonicalRoot, "AGENTS.project.md"),
      "# Updated\n"
    );
    await applyProjectRender(applyOptions(updateFixture));
    await expect(
      rollbackProjectRender({
        ...applyOptions(updateFixture),
        hooks: {
          afterOperation: async ({ index }) => {
            await Promise.resolve();
            if (index === 0) {
              throw new Error("interrupted rollback");
            }
          },
        },
      })
    ).rejects.toThrow("interrupted rollback");

    const recovered = await rollbackProjectRender(applyOptions(updateFixture));

    expect(recovered.planId).toBe(initial.planId);
    expect(
      await readFile(join(updateFixture.projectRoot, "AGENTS.md"), "utf8")
    ).toBe("# Agents\n");
    expect(await stateEntries(updateFixture)).toEqual([
      "mutation.lock",
      "receipt.json",
    ]);
  });
});
