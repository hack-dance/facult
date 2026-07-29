import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { facultAiIndexPath, facultMachineStateDir } from "./paths";
import {
  applyProjectEnrollment,
  buildProjectsStatus,
  discoverProjects,
  planProjectEnrollment,
  projectCommand,
  resolveRepositoryIdentity,
  rollbackProjectEnrollment,
} from "./projects";

const originalCwd = process.cwd();
const originalExitCode = process.exitCode;

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
});

async function makeFixture(): Promise<{
  root: string;
  home: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fclt-projects-")));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

async function createRepository(args: {
  path: string;
  home: string;
  files?: Record<string, string>;
}): Promise<void> {
  await mkdir(dirname(args.path), { recursive: true });
  await runFixtureGit({
    argv: ["init", "-b", "main", args.path],
    repoDir: args.path,
    homeDir: args.home,
  });
  for (const [relativePath, content] of Object.entries(
    args.files ?? { "README.md": "# Fixture\n" }
  )) {
    const pathValue = join(args.path, relativePath);
    await mkdir(dirname(pathValue), { recursive: true });
    await writeFile(pathValue, content, "utf8");
  }
  await runFixtureGit({
    argv: ["add", "."],
    repoDir: args.path,
    homeDir: args.home,
    cwd: args.path,
  });
  await runFixtureGit({
    argv: [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    ],
    repoDir: args.path,
    homeDir: args.home,
    cwd: args.path,
  });
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const pathValue = join(current, entry.name);
      out.push(pathValue.slice(root.length + 1));
      if (entry.isDirectory()) {
        await visit(pathValue);
      }
    }
  }
  await visit(root);
  return out.sort();
}

describe("project discovery", () => {
  it("requires explicit roots and performs no writes", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "portfolio", "alpha");
    await createRepository({ path: repo, home });
    const before = await listTree(root);

    await expect(discoverProjects({ roots: [] })).rejects.toThrow(
      "requires at least one explicit --root"
    );
    const discovery = await discoverProjects({
      roots: [join(root, "portfolio")],
      maxVisits: 100,
      maxResults: 10,
    });

    expect(discovery.projects).toHaveLength(1);
    expect(discovery.projects[0]?.root).toBe(repo);
    expect(discovery.bounds.truncated).toBe(false);
    expect(await listTree(root)).toEqual(before);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });

  it("correlates duplicate clones and worktrees by portable identity", async () => {
    const { root, home } = await makeFixture();
    const source = join(root, "source");
    const clone = join(root, "clone");
    const worktree = join(root, "worktree");
    await createRepository({ path: source, home });
    await runFixtureGit({
      argv: ["clone", source, clone],
      repoDir: clone,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: ["worktree", "add", "-b", "fixture-worktree", worktree],
      repoDir: source,
      homeDir: home,
      cwd: source,
    });

    const discovery = await discoverProjects({
      roots: [root],
      maxVisits: 100,
      maxResults: 10,
    });

    expect(discovery.projects).toHaveLength(3);
    expect(
      new Set(discovery.projects.map((item) => item.identity.id)).size
    ).toBe(1);
    expect(discovery.groups[0]?.locations).toEqual(
      [clone, source, worktree].sort()
    );
    expect(
      discovery.projects.every((item) => item.duplicateLocations === 3)
    ).toBe(true);
  });

  it("preserves identity when a checkout root is renamed", async () => {
    const { root, home } = await makeFixture();
    const initial = join(root, "before");
    const renamed = join(root, "after");
    await createRepository({ path: initial, home });
    const before = await resolveRepositoryIdentity(initial);

    await rename(initial, renamed);
    const after = await resolveRepositoryIdentity(renamed);

    expect(after.id).toBe(before.id);
    expect(after.kind).toBe("root-commit");
    expect(after.stability).toBe("portable");
  });

  it("normalizes HTTPS and SSH URLs for stable clone identity", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/project.git",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const httpsIdentity = await resolveRepositoryIdentity(repo);
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "git@github.com:example/project.git",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const sshIdentity = await resolveRepositoryIdentity(repo);

    expect(sshIdentity.id).toBe(httpsIdentity.id);
    expect(sshIdentity.fingerprint).toBe("github.com/example/project");
  });

  it("applies the since filter without mutating repositories", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });

    const discovery = await discoverProjects({
      roots: [root],
      since: "1h",
      now: new Date("2100-01-01T00:00:00.000Z"),
    });

    expect(discovery.projects).toEqual([]);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });
});

describe("project enrollment planning", () => {
  it("is minimal, exact, no-write, and does not duplicate root guidance", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const guidance =
      "# Canonical repository rules\n\n- Run the project checks.\n";
    await createRepository({
      path: repo,
      home,
      files: {
        "AGENTS.md": guidance,
        "README.md": "# Public fixture\n",
      },
    });
    const before = await listTree(repo);

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      guidance: ["AGENTS.md"],
    });

    expect(plan.guidancePreview).toEqual([
      {
        path: "AGENTS.md",
        sha256: expect.any(String),
        content: guidance,
        gitState: "clean-tracked",
        adoption: "reference",
      },
    ]);
    expect(plan.canonicalWrites.map((write) => write.path)).toEqual([
      join(repo, ".ai", ".gitignore"),
      join(repo, ".ai", "config.toml"),
    ]);
    expect(
      plan.canonicalWrites.some((write) =>
        write.path.endsWith("AGENTS.global.md")
      )
    ).toBe(false);
    expect(plan.canonicalWrites[1]?.content).toContain(
      'guidance = ["AGENTS.md"]'
    );
    expect(plan.protections).toEqual({
      ignoreWrittenFirst: true,
      managedRendering: false,
      automaticGuidanceCopy: false,
      privacyFindings: [],
    });
    expect(await listTree(repo)).toEqual(before);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });

  it("does not adopt guidance unless explicitly selected", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({
      path: repo,
      home,
      files: { "AGENTS.md": "# Existing\n" },
    });

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    expect(plan.guidancePreview).toEqual([]);
    expect(plan.options.guidance).toEqual([]);
    expect(plan.warnings.join("\n")).toContain("not copied or adopted");
  });

  it("keeps scheduling outside minimal enrollment", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });

    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        cadence: "weekly",
        scheduling: true,
      })
    ).rejects.toThrow("does not install scheduling");
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });

  it("refuses dirty or untracked guidance without writing", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({
      path: repo,
      home,
      files: { "AGENTS.md": "# Reviewed\n" },
    });
    await writeFile(
      join(repo, "AGENTS.md"),
      "# Dirty local guidance\n",
      "utf8"
    );

    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["AGENTS.md"],
      })
    ).rejects.toThrow("source must be tracked and clean");
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);

    await writeFile(join(repo, "CLAUDE.md"), "# Untracked\n", "utf8");
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["CLAUDE.md"],
      })
    ).rejects.toThrow("source must be tracked and clean");
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });

  it("refuses secret-shaped and machine-local guidance in public fixtures", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "public-repo");
    await createRepository({
      path: repo,
      home,
      files: {
        "docs/safe.md":
          "# Safe public guidance\n\nRun the documented checks.\n",
        "docs/local.md":
          "# Local\n\nRead /Users/example/private/config.toml.\n",
        "docs/secret.md": "# Secret\n\napi_key = abcdefghijklmnop\n",
      },
    });

    const safe = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      guidance: ["docs/safe.md"],
    });
    expect(safe.guidancePreview[0]?.path).toBe("docs/safe.md");
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["docs/local.md"],
      })
    ).rejects.toThrow("machine-local absolute path");
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["docs/secret.md"],
      })
    ).rejects.toThrow("secret-shaped content");
  });

  it("preserves existing ignore rules and versioned canonical config", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    await mkdir(join(repo, ".ai"), { recursive: true });
    await writeFile(
      join(repo, ".ai", ".gitignore"),
      "/private.local\n",
      "utf8"
    );

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    expect(plan.canonicalWrites[0]?.content).toContain("/private.local");
    expect(plan.canonicalWrites[0]?.content).toContain("/.facult/");

    await writeFile(
      join(repo, ".ai", "config.toml"),
      "version = 1\n\n[custom]\nowned = true\n",
      "utf8"
    );
    const merged = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    expect(merged.canonicalWrites[1]?.content).toContain("[custom]");
    expect(merged.canonicalWrites[1]?.content).toContain("owned = true");
    expect(merged.canonicalWrites[1]?.content).toContain("[project]");

    await writeFile(
      join(repo, ".ai", "config.toml"),
      'version = 1\n\n[project]\nrepository_id = "repo_conflict"\n',
      "utf8"
    );
    await expect(
      planProjectEnrollment({ projectRoot: repo, homeDir: home })
    ).rejects.toThrow(
      "Refusing to replace existing canonical project enrollment config"
    );
  });

  it("refuses symlinked project state and guidance", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    await createRepository({ path: repo, home });
    await mkdir(outside, { recursive: true });
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(outside, "guidance.md"), "# Private\n", "utf8");
    await symlink(join(outside, "guidance.md"), join(repo, "docs", "link.md"));
    await runFixtureGit({
      argv: ["add", "docs/link.md"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "track symlink",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });

    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["docs/link.md"],
      })
    ).rejects.toThrow("source must be a regular file");

    await symlink(outside, join(repo, ".ai"));
    await expect(
      planProjectEnrollment({ projectRoot: repo, homeDir: home })
    ).rejects.toThrow("unsafe project AI root");
  });
});

describe("project enrollment lifecycle", () => {
  it("requires the reviewed hash and writes protection before generated state", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: "wrong",
        homeDir: home,
      })
    ).rejects.toThrow("exact plan SHA");
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);

    const result = await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });

    expect(result.changedPaths).toEqual([
      join(repo, ".ai", ".gitignore"),
      join(repo, ".ai", "config.toml"),
    ]);
    expect(await readFile(join(repo, ".ai", ".gitignore"), "utf8")).toContain(
      "/.facult/"
    );
    expect(await Bun.file(join(repo, ".ai", ".facult")).exists()).toBe(false);
    expect(await Bun.file(join(repo, ".ai", "AGENTS.global.md")).exists()).toBe(
      false
    );
    expect(
      await Bun.file(facultAiIndexPath(home, join(repo, ".ai"))).exists()
    ).toBe(true);
    expect(
      facultMachineStateDir(home, join(repo, ".ai")).endsWith(plan.identity.id)
    ).toBe(true);
    expect(await Bun.file(result.registryPath).exists()).toBe(true);
    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]?.generated).toEqual({
      index: true,
      graph: true,
      health: "ready",
    });
  });

  it("reports unenrolled discovered repositories without writing", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });

    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });

    expect(status.projects).toHaveLength(1);
    expect(status.projects[0]).toMatchObject({
      decision: "inactive",
      coverage: "inactive",
      health: "degraded",
      canonical: {
        exists: false,
        config: false,
        protectiveIgnore: false,
      },
      generated: { index: false, graph: false, health: "missing" },
    });
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
    expect(await Bun.file(status.registryPath).exists()).toBe(false);
  });

  it("refuses a stale plan before any write", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await mkdir(join(repo, ".ai"), { recursive: true });
    await writeFile(join(repo, ".ai", ".gitignore"), "/user-change\n", "utf8");

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
      })
    ).rejects.toThrow("plan is stale");
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      false
    );
    expect(await readFile(join(repo, ".ai", ".gitignore"), "utf8")).toBe(
      "/user-change\n"
    );
  });

  it("previews and applies rollback while preserving receipts and history", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const applied = await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });

    const preview = await rollbackProjectEnrollment({
      receiptId: applied.receiptId,
      homeDir: home,
    });
    expect(preview.applied).toBe(false);
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      true
    );

    const rolledBack = await rollbackProjectEnrollment({
      receiptId: applied.receiptId,
      homeDir: home,
      apply: true,
      now: new Date("2026-07-28T13:00:00.000Z"),
    });
    expect(rolledBack.applied).toBe(true);
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      false
    );
    expect(await Bun.file(join(repo, ".ai", ".gitignore")).exists()).toBe(
      false
    );
    for (const preserved of rolledBack.preserved) {
      expect(await Bun.file(preserved).exists()).toBe(true);
    }
    const status = await buildProjectsStatus({ homeDir: home });
    expect(status.projects[0]?.decision).toBe("disabled");
    expect(status.projects[0]?.coverage).toBe("inactive");
  });

  it("disable and remove preserve canonical files and review history", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });

    const previousLog = console.log;
    console.log = () => undefined;
    try {
      await projectCommand(["disable", "--project-root", repo, "--json"], {
        homeDir: home,
      });
      let statusResult = await buildProjectsStatus({ homeDir: home });
      expect(statusResult.projects[0]?.decision).toBe("disabled");
      expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
        true
      );

      await projectCommand(["remove", "--project-root", repo, "--json"], {
        homeDir: home,
      });
      statusResult = await buildProjectsStatus({ homeDir: home });
      expect(statusResult.projects[0]?.decision).toBe("removed");
      expect(statusResult.projects[0]?.canonical.exists).toBe(true);
      expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
        true
      );
    } finally {
      console.log = previousLog;
    }
  });

  it("uses one machine-state key after cloning an enrolled repository", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const clone = join(root, "clone");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });
    await runFixtureGit({
      argv: ["add", ".ai"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "enroll",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: ["clone", repo, clone],
      repoDir: clone,
      homeDir: home,
      cwd: root,
    });

    expect(facultMachineStateDir(home, join(repo, ".ai"))).toBe(
      facultMachineStateDir(home, join(clone, ".ai"))
    );
  });
});
