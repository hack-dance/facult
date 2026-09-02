import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectRenderPlan,
  type ProjectRenderPlanV1,
} from "./project-render";

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

interface ProjectFixture {
  canonicalRoot: string;
  projectRoot: string;
}

const MANIFEST = `schema_version = 1
exclusive_roots = [".agents/skills"]

[[targets]]
id = "codex-root-agents"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "concat-text"
producer_version = 1
sources = ["fragments/header.md", "instructions/WORK.md"]
separator = "\\n"

[[targets]]
id = "codex-review-skill"
tool = "codex"
destination = ".agents/skills/review/SKILL.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["skills/review/SKILL.md"]
`;

async function createFixture(args?: {
  manifest?: string;
  prefix?: string;
  sourceLineEndings?: "crlf" | "lf";
}): Promise<ProjectFixture> {
  const projectRoot = await mkdtemp(
    join(tmpdir(), args?.prefix ?? "fclt-project-render-")
  );
  const canonicalRoot = join(projectRoot, ".ai");
  await mkdir(join(canonicalRoot, "fragments"), { recursive: true });
  await mkdir(join(canonicalRoot, "instructions"), { recursive: true });
  await mkdir(join(canonicalRoot, "skills", "review"), { recursive: true });
  await Bun.write(
    join(canonicalRoot, "project-render.toml"),
    args?.manifest ?? MANIFEST
  );
  const newline = args?.sourceLineEndings === "crlf" ? "\r\n" : "\n";
  await Bun.write(
    join(canonicalRoot, "fragments", "header.md"),
    `# Project agents${newline}`
  );
  await Bun.write(
    join(canonicalRoot, "instructions", "WORK.md"),
    `Keep work explicit.${newline}`
  );
  await Bun.write(
    join(canonicalRoot, "skills", "review", "SKILL.md"),
    `---${newline}description: Review carefully${newline}---${newline}${newline}# Review${newline}`
  );
  return { canonicalRoot, projectRoot };
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(pathValue: string, relativePath: string): Promise<void> {
    const stats = await lstat(pathValue).catch(() => null);
    if (!stats) {
      return;
    }
    const key = relativePath || ".";
    if (stats.isSymbolicLink()) {
      snapshot[key] = `symlink:${await readlink(pathValue)}`;
      return;
    }
    if (stats.isDirectory()) {
      snapshot[key] = "directory";
      for (const entry of (await readdir(pathValue)).sort()) {
        await visit(join(pathValue, entry), join(relativePath, entry));
      }
      return;
    }
    snapshot[key] = `file:${(await readFile(pathValue)).toString("base64")}`;
  }

  await visit(root, "");
  return snapshot;
}

function decodedTarget(
  plan: Readonly<ProjectRenderPlanV1>,
  destination: string
): string {
  const target = plan.targets.find(
    (candidate) => candidate.destination === destination
  );
  if (!target) {
    throw new Error(`Missing target: ${destination}`);
  }
  return Buffer.from(target.content.data, "base64").toString("utf8");
}

async function runCli(args: {
  cwd: string;
  env: Record<string, string | undefined>;
  fixture: ProjectFixture;
}): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      join(import.meta.dir, "index.ts"),
      "project",
      "render-plan",
      "--root",
      args.fixture.canonicalRoot,
      "--project-root",
      args.fixture.projectRoot,
      "--json",
    ],
    {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { code, stderr, stdout };
}

describe("hermetic project desired-tree planning", () => {
  it("emits a deterministic content-addressed plan without mutating the project", async () => {
    const fixture = await createFixture();
    const before = await snapshotTree(fixture.projectRoot);

    const first = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });
    const second = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });

    expect(second).toEqual(first);
    expect(await snapshotTree(fixture.projectRoot)).toEqual(before);
    expect(first.schemaVersion).toBe(1);
    expect(first.planId).toMatch(SHA256_RE);
    expect(first.manifest).toEqual({
      path: ".ai/project-render.toml",
      hash: expect.stringMatching(SHA256_RE),
    });
    expect(first.targets.map((target) => target.destination)).toEqual([
      ".agents/skills/review/SKILL.md",
      "AGENTS.md",
    ]);
    expect(decodedTarget(first, "AGENTS.md")).toBe(
      "# Project agents\n\nKeep work explicit.\n"
    );
    expect(decodedTarget(first, ".agents/skills/review/SKILL.md")).toBe(
      "---\ndescription: Review carefully\n---\n\n# Review\n"
    );
    expect(JSON.stringify(first)).not.toContain(fixture.projectRoot);
    expect(JSON.stringify(first)).not.toContain(process.env.HOME ?? "");
  });

  it("produces byte-identical JSON across roots, cwd, home, locale, timezone, and line endings", async () => {
    const left = await createFixture({ prefix: "fclt-project-render-left-" });
    const right = await createFixture({
      prefix: "fclt-project-render-right-",
      sourceLineEndings: "crlf",
    });
    const leftHome = await mkdtemp(
      join(tmpdir(), "fclt-project-render-home-a-")
    );
    const rightHome = await mkdtemp(
      join(tmpdir(), "fclt-project-render-home-b-")
    );
    const [leftResult, rightResult] = await Promise.all([
      runCli({
        cwd: left.projectRoot,
        env: { HOME: leftHome, LANG: "en_US.UTF-8", TZ: "UTC" },
        fixture: left,
      }),
      runCli({
        cwd: tmpdir(),
        env: {
          HOME: rightHome,
          LANG: "tr_TR.UTF-8",
          TZ: "Pacific/Honolulu",
        },
        fixture: right,
      }),
    ]);

    expect(leftResult.code, leftResult.stderr).toBe(0);
    expect(rightResult.code, rightResult.stderr).toBe(0);
    expect(leftResult.stderr).toBe("");
    expect(rightResult.stderr).toBe("");
    expect(rightResult.stdout).toBe(leftResult.stdout);
  });

  it("treats manifest whitespace and target declaration order as non-semantic", async () => {
    const reordered = `exclusive_roots = [".agents/skills"]
schema_version = 1

[[targets]]
tool = "codex"
id = "codex-review-skill"
destination = ".agents/skills/review/SKILL.md"
sources = ["skills/review/SKILL.md"]
mode = "0644"
producer_version = 1
producer = "copy-text"

[[targets]]
separator = "\\n"
sources = ["fragments/header.md", "instructions/WORK.md"]
producer_version = 1
producer = "concat-text"
mode = "0644"
destination = "AGENTS.md"
tool = "codex"
id = "codex-root-agents"
`;
    const left = await createFixture();
    const right = await createFixture({ manifest: reordered });
    const [leftPlan, rightPlan] = await Promise.all([
      buildProjectRenderPlan({
        canonicalRoot: left.canonicalRoot,
        projectRoot: left.projectRoot,
      }),
      buildProjectRenderPlan({
        canonicalRoot: right.canonicalRoot,
        projectRoot: right.projectRoot,
      }),
    ]);

    expect(rightPlan).toEqual(leftPlan);
  });

  it("preserves concat source order while sorting inventory and targets", async () => {
    const fixture = await createFixture();
    const plan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });

    expect(plan.inputs.map((input) => input.path)).toEqual([
      ".ai/fragments/header.md",
      ".ai/instructions/WORK.md",
      ".ai/skills/review/SKILL.md",
    ]);
    expect(
      plan.targets.find((target) => target.id === "codex-root-agents")?.sources
    ).toEqual([".ai/fragments/header.md", ".ai/instructions/WORK.md"]);
  });

  it("fails closed on unknown fields, unsafe sources, and unsupported producer versions", async () => {
    const cases = [
      {
        message: "must contain exactly",
        manifest: MANIFEST.replace(
          "schema_version = 1",
          'schema_version = 1\nambient_home = "allowed"'
        ),
      },
      {
        message: "must be a safe relative path",
        manifest: MANIFEST.replace(
          'sources = ["skills/review/SKILL.md"]',
          'sources = ["../outside.md"]'
        ),
      },
      {
        message: "unsupported producer version",
        manifest: MANIFEST.replace(
          "producer_version = 1",
          "producer_version = 2"
        ),
      },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture({ manifest: testCase.manifest });
      await expect(
        buildProjectRenderPlan({
          canonicalRoot: fixture.canonicalRoot,
          projectRoot: fixture.projectRoot,
        })
      ).rejects.toThrow(testCase.message);
    }
  });

  it("rejects duplicate ids and portable destination collisions", async () => {
    const duplicateId = MANIFEST.replace(
      'id = "codex-review-skill"',
      'id = "codex-root-agents"'
    );
    const destinationCollision = MANIFEST.replace(
      'destination = ".agents/skills/review/SKILL.md"',
      'destination = "agents.md"'
    );
    const duplicateFixture = await createFixture({ manifest: duplicateId });
    const collisionFixture = await createFixture({
      manifest: destinationCollision,
    });

    await expect(
      buildProjectRenderPlan({
        canonicalRoot: duplicateFixture.canonicalRoot,
        projectRoot: duplicateFixture.projectRoot,
      })
    ).rejects.toThrow("Duplicate project render target id");
    await expect(
      buildProjectRenderPlan({
        canonicalRoot: collisionFixture.canonicalRoot,
        projectRoot: collisionFixture.projectRoot,
      })
    ).rejects.toThrow("Portable project render destination collision");
  });

  it("rejects symlinked canonical inputs", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createFixture();
    const outside = join(fixture.projectRoot, "outside.md");
    const source = join(fixture.canonicalRoot, "instructions", "WORK.md");
    await Bun.write(outside, "outside\n");
    await Bun.write(source, "replace-me\n");
    await rm(source);
    await symlink(outside, source);

    await expect(
      buildProjectRenderPlan({
        canonicalRoot: fixture.canonicalRoot,
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("must be openable as a regular non-symlink file");
  });

  it("rejects a canonical root outside the project root and mismatched compiler identity", async () => {
    const fixture = await createFixture();
    const other = await createFixture({ prefix: "fclt-project-render-other-" });

    await expect(
      buildProjectRenderPlan({
        canonicalRoot: other.canonicalRoot,
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("Canonical root must be inside the project root");
    await expect(
      buildProjectRenderPlan({
        canonicalRoot: fixture.canonicalRoot,
        compilerVersion: "0.0.0",
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("does not match the authoritative fclt version");
  });

  it("binds plan content hashes to the exact normalized desired bytes", async () => {
    const fixture = await createFixture();
    const plan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });

    for (const target of plan.targets) {
      const bytes = Buffer.from(target.content.data, "base64");
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      expect(target.content.bytes).toBe(bytes.byteLength);
      expect(target.content.hash).toBe(hash);
    }
  });

  it("bounds aggregate desired output even when many targets reuse one input", async () => {
    const targets = Array.from(
      { length: 330 },
      (_, index) => `[[targets]]
id = "target-${index}"
tool = "codex"
destination = "output/${index}.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["fragments/header.md"]
`
    ).join("\n");
    const fixture = await createFixture({
      manifest: `schema_version = 1
exclusive_roots = []

${targets}`,
    });
    await Bun.write(
      join(fixture.canonicalRoot, "fragments", "header.md"),
      "x".repeat(210 * 1024)
    );

    await expect(
      buildProjectRenderPlan({
        canonicalRoot: fixture.canonicalRoot,
        projectRoot: fixture.projectRoot,
      })
    ).rejects.toThrow("outputs exceed the 67108864-byte aggregate limit");
  });
});
