import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectRenderPlan } from "./project-render";
import {
  compilerVersionSatisfiesRange,
  createProjectRenderLock,
} from "./project-render-lock";

const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T/;

interface LockFixture {
  artifactPath: string;
  canonicalRoot: string;
  projectRoot: string;
  sourcePath: string;
}

async function createFixture(
  prefix = "fclt-project-lock-"
): Promise<LockFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), prefix));
  const canonicalRoot = join(projectRoot, ".ai");
  const sourcePath = join(canonicalRoot, "instructions", "ROOT.md");
  const artifactPath = join(projectRoot, "fclt-artifact");
  await mkdir(join(canonicalRoot, "instructions"), { recursive: true });
  await Bun.write(
    join(canonicalRoot, "project-render.toml"),
    `schema_version = 1
exclusive_roots = []

[[targets]]
id = "root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["instructions/ROOT.md"]
`
  );
  await Bun.write(sourcePath, "# Locked project\n");
  await Bun.write(artifactPath, "compiled-fclt-artifact-v1\n");
  return { artifactPath, canonicalRoot, projectRoot, sourcePath };
}

async function writeLock(args: {
  fixture: LockFixture;
  packVersion: string;
}): Promise<string> {
  const plan = await buildProjectRenderPlan({
    canonicalRoot: args.fixture.canonicalRoot,
    projectRoot: args.fixture.projectRoot,
    skipLockVerification: true,
  });
  await createProjectRenderLock({
    canonicalRoot: args.fixture.canonicalRoot,
    compilerArtifacts: { "darwin-arm64": args.fixture.artifactPath },
    compilerCompatibility: ">=2.28.0 <3.0.0",
    packSchemaVersion: 1,
    packVersion: args.packVersion,
    plan,
  });
  return await Bun.file(
    join(args.fixture.canonicalRoot, "project-render.lock.json")
  ).text();
}

describe("project render compiler and pack lock", () => {
  it("binds deterministic lock bytes and provenance to an exact artifact and input pack", async () => {
    const left = await createFixture("fclt-project-lock-left-");
    const right = await createFixture("fclt-project-lock-right-");
    const [leftLock, rightLock] = await Promise.all([
      writeLock({ fixture: left, packVersion: "hack-pack-1.0.0" }),
      writeLock({ fixture: right, packVersion: "hack-pack-1.0.0" }),
    ]);
    expect(rightLock).toBe(leftLock);

    const plan = await buildProjectRenderPlan({
      canonicalRoot: left.canonicalRoot,
      compilerArtifactPath: left.artifactPath,
      compilerArtifactPlatform: "darwin-arm64",
      projectRoot: left.projectRoot,
      requireLock: true,
    });
    expect(plan.lock?.path).toBe(".ai/project-render.lock.json");
    expect(plan.lock?.compilerArtifact.platform).toBe("darwin-arm64");
    expect(plan.lock?.pack.version).toBe("hack-pack-1.0.0");
    expect(plan.lock?.pack.digest).toBe(plan.hashes.inputs);
    expect(JSON.stringify(plan.lock)).not.toContain(left.projectRoot);
    expect(JSON.stringify(plan.lock)).not.toMatch(TIMESTAMP_RE);
  });

  it("rejects pack drift, artifact drift, and source execution without artifact identity", async () => {
    const fixture = await createFixture();
    await writeLock({ fixture, packVersion: "hack-pack-1.0.0" });

    await Bun.write(fixture.sourcePath, "# Drifted project\n");
    await expect(
      buildProjectRenderPlan({
        canonicalRoot: fixture.canonicalRoot,
        compilerArtifactPath: fixture.artifactPath,
        compilerArtifactPlatform: "darwin-arm64",
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("canonical inputs do not match");

    await Bun.write(fixture.sourcePath, "# Locked project\n");
    await Bun.write(fixture.artifactPath, "compiled-fclt-artifact-v2\n");
    await expect(
      buildProjectRenderPlan({
        canonicalRoot: fixture.canonicalRoot,
        compilerArtifactPath: fixture.artifactPath,
        compilerArtifactPlatform: "darwin-arm64",
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("artifact does not match");

    await expect(
      buildProjectRenderPlan({
        canonicalRoot: fixture.canonicalRoot,
        compilerArtifactPlatform: "darwin-arm64",
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("requires an exact compiled fclt artifact");
  });

  it("detects compiler-version skew before render", async () => {
    const fixture = await createFixture();
    const lockText = await writeLock({
      fixture,
      packVersion: "hack-pack-1.0.0",
    });
    const lock = JSON.parse(lockText) as {
      compiler: { version: string };
      pack: { compilerCompatibility: string };
    };
    lock.compiler.version = "2.29.2";
    lock.pack.compilerCompatibility = ">=2.29.0 <3.0.0";
    await Bun.write(
      join(fixture.canonicalRoot, "project-render.lock.json"),
      `${JSON.stringify(lock)}\n`
    );

    await expect(
      buildProjectRenderPlan({
        canonicalRoot: fixture.canonicalRoot,
        compilerArtifactPath: fixture.artifactPath,
        compilerArtifactPlatform: "darwin-arm64",
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("compiler or manifest schema does not match");
  });

  it("supports an offline rollback to a prior lock and input pack", async () => {
    const fixture = await createFixture();
    const originalSource = await Bun.file(fixture.sourcePath).text();
    const originalLock = await writeLock({
      fixture,
      packVersion: "hack-pack-1.0.0",
    });

    await Bun.write(fixture.sourcePath, "# Locked project v2\n");
    await writeLock({ fixture, packVersion: "hack-pack-2.0.0" });
    const upgraded = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      compilerArtifactPath: fixture.artifactPath,
      compilerArtifactPlatform: "darwin-arm64",
      projectRoot: fixture.projectRoot,
    });
    expect(upgraded.lock?.pack.version).toBe("hack-pack-2.0.0");

    await Bun.write(fixture.sourcePath, originalSource);
    await Bun.write(
      join(fixture.canonicalRoot, "project-render.lock.json"),
      originalLock
    );
    const rolledBack = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      compilerArtifactPath: fixture.artifactPath,
      compilerArtifactPlatform: "darwin-arm64",
      projectRoot: fixture.projectRoot,
    });
    expect(rolledBack.lock?.pack.version).toBe("hack-pack-1.0.0");
  });

  it("validates the declared compiler compatibility range", () => {
    expect(
      compilerVersionSatisfiesRange({
        range: ">=2.28.0 <3.0.0",
        version: "2.29.2",
      })
    ).toBe(true);
    expect(
      compilerVersionSatisfiesRange({
        range: ">=2.29.0 <3.0.0",
        version: "2.28.0",
      })
    ).toBe(false);
    expect(() =>
      compilerVersionSatisfiesRange({
        range: "^2.28.0",
        version: "2.28.0",
      })
    ).toThrow("supports whitespace-separated");
  });
});
