import { describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildProjectRenderPlan,
  checkProjectRenderPlan,
  type ProjectRenderPlanV1,
} from "./project-render";

interface CheckFixture {
  canonicalRoot: string;
  projectRoot: string;
}

const SHA256_PREFIX_RE = /^sha256:/;

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

async function createFixture(): Promise<CheckFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "fclt-project-check-"));
  const canonicalRoot = join(projectRoot, ".ai");
  await mkdir(join(canonicalRoot, "skills", "review"), { recursive: true });
  await Bun.write(join(canonicalRoot, "project-render.toml"), MANIFEST);
  await Bun.write(join(canonicalRoot, "AGENTS.project.md"), "# Agents\n");
  await Bun.write(
    join(canonicalRoot, "skills", "review", "SKILL.md"),
    "# Review\n"
  );
  return { canonicalRoot, projectRoot };
}

async function materializePlan(args: {
  plan: Readonly<ProjectRenderPlanV1>;
  projectRoot: string;
}): Promise<void> {
  for (const target of args.plan.targets) {
    const targetPath = join(args.projectRoot, target.destination);
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, Buffer.from(target.content.data, "base64"));
    if (process.platform !== "win32") {
      await chmod(targetPath, Number.parseInt(target.mode, 8));
    }
  }
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
    snapshot[key] =
      `file:${stats.mode % 0o1000}:${(await readFile(pathValue)).toString("base64")}`;
  }

  await visit(root, "");
  return snapshot;
}

async function runCheckCli(
  fixture: CheckFixture
): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      join(import.meta.dir, "index.ts"),
      "project",
      "render",
      "--root",
      fixture.canonicalRoot,
      "--project-root",
      fixture.projectRoot,
      "--check",
      "--json",
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { code, stderr, stdout };
}

describe("read-only project render checks", () => {
  it("reports a clean exact tree without mutation", async () => {
    const fixture = await createFixture();
    const plan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });
    await materializePlan({ plan, projectRoot: fixture.projectRoot });
    const before = await snapshotTree(fixture.projectRoot);

    const result = await checkProjectRenderPlan({
      plan,
      projectRoot: fixture.projectRoot,
    });

    expect(result).toEqual({
      clean: true,
      differences: [],
      planId: plan.planId,
      schemaVersion: 1,
      summary: {
        changed: 0,
        matching: 2,
        missing: 0,
        totalDifferences: 0,
        typeConflicts: 0,
        unexpected: 0,
      },
      truncated: false,
    });
    expect(await snapshotTree(fixture.projectRoot)).toEqual(before);
  });

  it("separates missing, changed, type-conflict, and unexpected output", async () => {
    const fixture = await createFixture();
    const plan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });
    await materializePlan({ plan, projectRoot: fixture.projectRoot });
    await Bun.write(join(fixture.projectRoot, "AGENTS.md"), "changed\n");
    const skillPath = join(
      fixture.projectRoot,
      ".agents",
      "skills",
      "review",
      "SKILL.md"
    );
    await rm(skillPath);
    await mkdir(skillPath);
    const unexpectedPath = join(
      fixture.projectRoot,
      ".agents",
      "skills",
      "extra",
      "SKILL.md"
    );
    await mkdir(dirname(unexpectedPath), { recursive: true });
    await Bun.write(unexpectedPath, "# Extra\n");

    const result = await checkProjectRenderPlan({
      plan,
      projectRoot: fixture.projectRoot,
    });

    expect(result.clean).toBe(false);
    expect(result.summary).toEqual({
      changed: 1,
      matching: 0,
      missing: 0,
      totalDifferences: 3,
      typeConflicts: 1,
      unexpected: 1,
    });
    expect(
      result.differences.map(({ path, status }) => ({ path, status }))
    ).toEqual([
      { path: ".agents/skills/extra/SKILL.md", status: "unexpected" },
      { path: ".agents/skills/review/SKILL.md", status: "type-conflict" },
      { path: "AGENTS.md", status: "changed" },
    ]);
    expect(result.differences[0]?.actualHash).toMatch(SHA256_PREFIX_RE);
    expect(result.differences[2]?.actualHash).toMatch(SHA256_PREFIX_RE);
  });

  it("reports missing targets without treating absent exclusive roots as errors", async () => {
    const fixture = await createFixture();
    const plan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });

    const result = await checkProjectRenderPlan({
      plan,
      projectRoot: fixture.projectRoot,
    });

    expect(result.summary).toEqual({
      changed: 0,
      matching: 0,
      missing: 2,
      totalDifferences: 2,
      typeConflicts: 0,
      unexpected: 0,
    });
    expect(
      result.differences.every((difference) => difference.status === "missing")
    ).toBe(true);
  });

  it("bounds returned differences while preserving full summary counts", async () => {
    const fixture = await createFixture();
    const plan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });
    const unexpectedRoot = join(fixture.projectRoot, ".agents", "skills");
    await mkdir(unexpectedRoot, { recursive: true });
    for (const name of ["a", "b", "c"]) {
      await Bun.write(join(unexpectedRoot, `${name}.md`), name);
    }

    const result = await checkProjectRenderPlan({
      maxDifferences: 2,
      plan,
      projectRoot: fixture.projectRoot,
    });

    expect(result.differences).toHaveLength(2);
    expect(result.summary.totalDifferences).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("uses stable CLI output and clean/drift exit codes", async () => {
    const fixture = await createFixture();
    const plan = await buildProjectRenderPlan({
      canonicalRoot: fixture.canonicalRoot,
      projectRoot: fixture.projectRoot,
    });
    await materializePlan({ plan, projectRoot: fixture.projectRoot });

    const clean = await runCheckCli(fixture);
    expect(clean.code, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout).clean).toBe(true);

    await Bun.write(join(fixture.projectRoot, "AGENTS.md"), "drift\n");
    const drift = await runCheckCli(fixture);
    expect(drift.code, drift.stderr).toBe(1);
    expect(JSON.parse(drift.stdout).summary.changed).toBe(1);
  });

  it("applies through the CLI and leaves check mode clean", async () => {
    const fixture = await createFixture();
    const localState = await mkdtemp(join(tmpdir(), "fclt-project-cli-state-"));
    await chmod(localState, 0o700);
    const child = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "index.ts"),
        "project",
        "render",
        "--root",
        fixture.canonicalRoot,
        "--project-root",
        fixture.projectRoot,
      ],
      {
        env: { ...process.env, FACULT_LOCAL_STATE_DIR: localState },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const [code, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(code, stderr).toBe(0);
    expect(stdout).toBe("Project render applied 2 writes and 0 removals.\n");
    expect(await Bun.file(join(fixture.projectRoot, "AGENTS.md")).text()).toBe(
      "# Agents\n"
    );
    const clean = await runCheckCli(fixture);
    expect(clean.code, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout).clean).toBe(true);
  });
});
